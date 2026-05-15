import { spawn, IPty } from 'node-pty'
import { WebContents } from 'electron'
import { statSync } from 'fs'
import { readSettings, updateSettings, TaskDef } from './settings'

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
}

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
      outputBytes: 0
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
  // and `npm run x` resolves from node_modules/.bin.
  const args = isWindows ? ['/d', '/s', '/c', t.command] : ['-c', t.command]

  const pty = spawn(shell, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: process.env as { [key: string]: string },
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

export function startTask(opts: {
  id?: string
  name?: string
  command?: string
  cwd?: string
}): TaskMeta {
  // Existing task (re-run): reuse the record, reset output.
  let t = opts.id ? tasks.get(opts.id) : undefined
  if (t) {
    if (t.pty) {
      try {
        t.pty.kill()
      } catch {
        // already gone
      }
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
      outputBytes: 0
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
    outputBytes: 0
  }
  tasks.set(t.id, t)
  persistDefs()
  broadcast('task-status', toMeta(t))
  return toMeta(t)
}

export function stopTask(id: string): void {
  const t = tasks.get(id)
  if (!t || !t.pty) return
  try {
    t.pty.kill()
  } catch {
    // already gone — onExit may not fire, settle status manually
    t.pty = null
    t.status = 'exited'
    broadcast('task-status', toMeta(t))
  }
}

export function restartTask(id: string): TaskMeta | null {
  const t = tasks.get(id)
  if (!t) return null
  return startTask({ id: t.id })
}

export function removeTask(id: string): void {
  const t = tasks.get(id)
  if (!t) return
  if (t.pty) {
    try {
      t.pty.kill()
    } catch {
      // ignore
    }
  }
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

/** Kill every running task — called on app quit so no orphans linger. */
export function killAllTasks(): void {
  for (const t of tasks.values()) {
    if (t.pty) {
      try {
        t.pty.kill()
      } catch {
        // ignore
      }
    }
  }
}
