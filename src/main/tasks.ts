import { spawn, IPty } from 'node-pty'
import { WebContents } from 'electron'
import { statSync } from 'fs'
import { readSettings, updateSettings, TaskDef } from './settings'
import { killProcessTree } from './proc'

const isWindows = process.platform === 'win32'

export type TaskStatus = 'idle' | 'running' | 'exited' | 'failed'

/** Sent to the renderer — definition + runtime status, never the pty handle. */
export interface TaskMeta extends TaskDef {
  status: TaskStatus
  exitCode: number | null
  startedAt: number | null
}

interface Task extends TaskMeta {
  pty: IPty | null
  // Ring buffer of raw output chunks (ANSI preserved). Capped by byte size so
  // a chatty dev server can't grow memory unbounded.
  output: string[]
  outputBytes: number
  // Last known PTY grid size. Tracks the log viewer so full-screen TUIs
  // (Next.js overlay, vite menu) render aligned, and a re-run respawns at the
  // same size instead of the 120×30 default.
  cols: number
  rows: number
}

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

const OUTPUT_BYTE_CAP = 512 * 1024

const tasks = new Map<string, Task>()
// Renderers that want task stream/status events. Tasks outlive any single
// pane, so we broadcast to every live webContents that registered.
const subscribers = new Set<WebContents>()

function genId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function defaultShell(): string {
  if (isWindows) return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/bash'
}

function isValidDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function toMeta(t: Task): TaskMeta {
  return {
    id: t.id,
    name: t.name,
    command: t.command,
    cwd: t.cwd,
    status: t.status,
    exitCode: t.exitCode,
    startedAt: t.startedAt
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of Array.from(subscribers)) {
    if (wc.isDestroyed()) {
      subscribers.delete(wc)
      continue
    }
    wc.send(channel, payload)
  }
}

function persistDefs(): void {
  const defs: TaskDef[] = Array.from(tasks.values()).map((t) => ({
    id: t.id,
    name: t.name,
    command: t.command,
    cwd: t.cwd
  }))
  updateSettings({ tasks: defs })
}

export function registerTaskSubscriber(wc: WebContents): void {
  subscribers.add(wc)
  wc.once('destroyed', () => subscribers.delete(wc))
}

/** Load persisted task definitions on startup. Nothing is auto-run. */
export function loadPersistedTasks(): void {
  const defs = readSettings().tasks
  if (!Array.isArray(defs)) return
  for (const d of defs) {
    if (!d || !d.id || !d.command) continue
    tasks.set(d.id, {
      id: d.id,
      name: d.name || d.command,
      command: d.command,
      cwd: d.cwd || '',
      status: 'idle',
      exitCode: null,
      startedAt: null,
      pty: null,
      output: [],
      outputBytes: 0,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS
    })
  }
}

export function listTasks(): TaskMeta[] {
  return Array.from(tasks.values()).map(toMeta)
}

export function getTaskOutput(id: string): string {
  const t = tasks.get(id)
  return t ? t.output.join('') : ''
}

/**
 * Stop a task's PTY *and* every descendant it spawned. `pty.kill()` only
 * signals the shell wrapping the command, so `npm run dev`-style trees
 * (npm → node → vite/esbuild, or `nx run` → many worker processes) outlive
 * it and keep holding the port. We must snapshot + tear down the descendant
 * tree BEFORE killing the PTY — once the shell dies the OS reparents any
 * detached grandchildren to the system process and they become unreachable.
 */
async function killTaskTree(t: Task): Promise<void> {
  const pty = t.pty
  if (!pty) return
  const pid = pty.pid
  if (pid) {
    try {
      await killProcessTree(pid)
    } catch {
      // never let snapshot failure block the kill
    }
  }
  try {
    pty.kill()
  } catch {
    // already gone
  }
}

function appendOutput(t: Task, chunk: string): void {
  t.output.push(chunk)
  t.outputBytes += chunk.length
  while (t.outputBytes > OUTPUT_BYTE_CAP && t.output.length > 1) {
    const dropped = t.output.shift()!
    t.outputBytes -= dropped.length
  }
}

function spawnPty(t: Task): void {
  const cwd = t.cwd && isValidDir(t.cwd) ? t.cwd : process.env.HOME || process.cwd()
  const shell = defaultShell()
  // Run the command through the shell so users can use pipes, &&, env vars,
  // and `npm run x` resolves from node_modules/.bin. Login + interactive on
  // POSIX so the user's full PATH (nvm/homebrew/…) is sourced.
  const args = isWindows ? ['/d', '/s', '/c', t.command] : ['-l', '-i', '-c', t.command]

  // Per-task environment: a fresh copy (never the shared live process.env) with
  // PWD pinned to this task's cwd and the stale INIT_CWD dropped. Without this,
  // tools that trust $PWD/$INIT_CWD (npm) inherit whatever dir Electron was
  // launched from, so the same `npm run dev` in two folders looks identical.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  env.PWD = cwd
  delete env.INIT_CWD

  const pty = spawn(shell, args, {
    name: 'xterm-256color',
    cols: t.cols || DEFAULT_COLS,
    rows: t.rows || DEFAULT_ROWS,
    cwd,
    env,
    ...(isWindows ? { useConpty: true } : {})
  })

  t.pty = pty
  t.status = 'running'
  t.exitCode = null
  t.startedAt = Date.now()
  broadcast('task-status', toMeta(t))

  pty.onData((data) => {
    appendOutput(t, data)
    broadcast('task-data', { id: t.id, chunk: data })
  })

  pty.onExit(({ exitCode }) => {
    t.pty = null
    t.exitCode = exitCode
    t.status = exitCode === 0 ? 'exited' : 'failed'
    broadcast('task-status', toMeta(t))
  })
}

export async function startTask(opts: {
  id?: string
  name?: string
  command?: string
  cwd?: string
}): Promise<TaskMeta> {
  // Existing task (re-run): reuse the record, reset output.
  let t = opts.id ? tasks.get(opts.id) : undefined
  if (t) {
    if (t.pty) {
      await killTaskTree(t)
      t.pty = null
    }
    if (opts.command) t.command = opts.command
    if (opts.name) t.name = opts.name
    if (opts.cwd) t.cwd = opts.cwd
    t.output = []
    t.outputBytes = 0
  } else {
    const command = opts.command || ''
    t = {
      id: opts.id || genId(),
      name: opts.name || command,
      command,
      cwd: opts.cwd || '',
      status: 'idle',
      exitCode: null,
      startedAt: null,
      pty: null,
      output: [],
      outputBytes: 0,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS
    }
    tasks.set(t.id, t)
  }
  broadcast('task-cleared', { id: t.id })
  spawnPty(t)
  persistDefs()
  return toMeta(t)
}

/** Create a task *definition* without running it (used by the manager dialog). */
export function createTask(opts: { name?: string; command: string; cwd: string }): TaskMeta {
  const t: Task = {
    id: genId(),
    name: opts.name?.trim() || opts.command,
    command: opts.command,
    cwd: opts.cwd,
    status: 'idle',
    exitCode: null,
    startedAt: null,
    pty: null,
    output: [],
    outputBytes: 0,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS
  }
  tasks.set(t.id, t)
  persistDefs()
  broadcast('task-status', toMeta(t))
  return toMeta(t)
}

export async function stopTask(id: string): Promise<void> {
  const t = tasks.get(id)
  if (!t || !t.pty) return
  const pid = t.pty.pid
  // Snapshot + reap the descendant tree BEFORE pty.kill() — otherwise the
  // shell's children (dev servers, watchers, Nx executor workers) get
  // reparented and survive. Awaiting here costs ~300ms (PowerShell start)
  // but is what actually catches detached survivors.
  if (pid) {
    try {
      await killProcessTree(pid)
    } catch {
      // never let snapshot failure block the kill
    }
  }
  let threw = false
  try {
    t.pty.kill()
  } catch {
    threw = true
  }
  if (threw) {
    // kill() threw → the process was already gone; onExit won't fire, so
    // settle the status manually.
    t.pty = null
    t.status = 'exited'
    broadcast('task-status', toMeta(t))
  }
}

/** Forward keystrokes/paste from the log viewer to a running task's PTY. */
export function writeTask(id: string, data: string): void {
  const t = tasks.get(id)
  if (t && t.pty) t.pty.write(data)
}

/**
 * Resize a task's PTY to match the log viewer. Stored on the task so a later
 * re-run respawns at the same size. No-op for non-positive dims.
 */
export function resizeTask(id: string, cols: number, rows: number): void {
  if (!(cols > 0 && rows > 0)) return
  const t = tasks.get(id)
  if (!t) return
  t.cols = cols
  t.rows = rows
  if (t.pty) {
    try {
      t.pty.resize(cols, rows)
    } catch {
      // pty may have exited between the check and the resize
    }
  }
}

export async function restartTask(id: string): Promise<TaskMeta | null> {
  const t = tasks.get(id)
  if (!t) return null
  return startTask({ id: t.id })
}

export async function removeTask(id: string): Promise<void> {
  const t = tasks.get(id)
  if (!t) return
  if (t.pty) await killTaskTree(t)
  tasks.delete(id)
  persistDefs()
  broadcast('task-removed', { id })
}

export function updateTask(
  id: string,
  patch: { name?: string; command?: string; cwd?: string }
): TaskMeta | null {
  const t = tasks.get(id)
  if (!t) return null
  if (typeof patch.name === 'string') t.name = patch.name
  if (typeof patch.command === 'string') t.command = patch.command
  if (typeof patch.cwd === 'string') t.cwd = patch.cwd
  persistDefs()
  broadcast('task-status', toMeta(t))
  return toMeta(t)
}

/**
 * Kill every running task — called on app quit so no orphans linger.
 * Awaiting here gives the descendant-tree snapshot time to finish before
 * Electron tears the main process down (otherwise the snapshot's child
 * PowerShell would be reaped mid-query and survivors would be left behind).
 */
export async function killAllTasks(): Promise<void> {
  await Promise.all(
    Array.from(tasks.values())
      .filter((t) => t.pty)
      .map((t) => killTaskTree(t))
  )
}
