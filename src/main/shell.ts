import { spawn, IPty } from 'node-pty'
import { WebContents, app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readlinkSync, statSync } from 'fs'
import { shellIntegration } from './shell-integration'

const execFileP = promisify(execFile)

const isWindows = process.platform === 'win32'

interface Session {
  pty: IPty
  webContents: WebContents
  // Cached at creation: reading webContents.id after the wc is destroyed throws.
  wcId: number
  paneId: string
  disposed: boolean
}

// One session per pane. Multiple panes can live on a single webContents.
const sessions = new Map<string, Session>()
// webContents.id → set of paneIds that belong to it. Used to clean up every
// pane when the renderer goes away.
const sessionsByWebContents = new Map<number, Set<string>>()
// webContents.id we've already wired a 'destroyed' handler on, so we don't
// stack duplicate handlers when multiple panes spawn on the same renderer.
const destroyHandlerInstalled = new Set<number>()

// Common options for synchronous-style git invocations. encoding:'utf8' makes
// stdout/stderr come back as strings instead of Buffers.
const GIT_OPTS = { encoding: 'utf8' as const, timeout: 10_000, windowsHide: true }

interface ExecFailure {
  stdout?: string
  stderr?: string
  message: string
}

function cleanGitError(err: unknown): string {
  const e = err as ExecFailure
  // execFile rejects with an Error that has stderr/stdout attached
  const msg = (e?.stderr || e?.stdout || e?.message || String(err)).toString()
  return msg.replace(/^Command failed:[^\n]*\n?/, '').trim()
}

function defaultShell(): string {
  if (isWindows) {
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

export function getCurrentDir(): string {
  // Default to the user's home directory. `process.cwd()` is whatever
  // directory the Electron process was launched from — in a packaged build
  // that's the install location, which is never what the user wants.
  return app.getPath('home')
}

function isValidDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function startPty(
  webContents: WebContents,
  opts: { paneId: string; cols?: number; rows?: number; cwd?: string }
): void {
  const { paneId } = opts
  if (!paneId) throw new Error('startPty requires a paneId')

  // If a stale session exists for this paneId (shouldn't happen, but defensive), kill it.
  killPty(paneId)

  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24
  // Validate the requested cwd. A persisted layout can reference a folder
  // that's since been deleted — silently fall back to the user's home dir
  // rather than failing the spawn.
  const cwd = opts.cwd && isValidDir(opts.cwd) ? opts.cwd : getCurrentDir()

  // Shell integration injects an OSC 7 cwd-notification hook so PaneToolbar
  // can follow `cd` commands. Falls back to passthrough for unknown shells.
  const { shell, args, env } = shellIntegration(defaultShell())

  const pty = spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: env as { [key: string]: string },
    ...(isWindows ? { useConpty: true } : {})
  })

  const wcId = webContents.id
  const session: Session = { pty, webContents, wcId, paneId, disposed: false }
  sessions.set(paneId, session)

  let set = sessionsByWebContents.get(wcId)
  if (!set) {
    set = new Set()
    sessionsByWebContents.set(wcId, set)
  }
  set.add(paneId)

  // Install destroy handler once per webContents — when the renderer dies,
  // kill every pane that belongs to it.
  if (!destroyHandlerInstalled.has(wcId)) {
    destroyHandlerInstalled.add(wcId)
    webContents.once('destroyed', () => {
      const ids = sessionsByWebContents.get(wcId)
      if (ids) {
        for (const id of Array.from(ids)) killPty(id)
        sessionsByWebContents.delete(wcId)
      }
      destroyHandlerInstalled.delete(wcId)
    })
  }

  pty.onData((data) => {
    if (!session.disposed && !webContents.isDestroyed()) {
      webContents.send('pty-data', { paneId, data })
    }
  })

  pty.onExit(({ exitCode }) => {
    if (!session.disposed && !webContents.isDestroyed()) {
      webContents.send('pty-exit', { paneId, exitCode })
    }
    session.disposed = true
    sessions.delete(paneId)
    sessionsByWebContents.get(wcId)?.delete(paneId)
  })
}

export function writePty(paneId: string, data: string): void {
  const session = sessions.get(paneId)
  if (session && !session.disposed) {
    session.pty.write(data)
  }
}

export function resizePty(paneId: string, cols: number, rows: number): void {
  const session = sessions.get(paneId)
  if (session && !session.disposed) {
    try {
      session.pty.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      // pty may have already exited
    }
  }
}

export function killPty(paneId: string): void {
  const session = sessions.get(paneId)
  if (!session) return
  session.disposed = true
  try {
    session.pty.kill()
  } catch {
    // ignore
  }
  sessions.delete(paneId)
  sessionsByWebContents.get(session.wcId)?.delete(paneId)
}

/**
 * Best-effort lookup of the PTY shell's current working directory by PID.
 * Used to keep the toolbar in sync when the user `cd`s in the shell
 * (the toolbar's cwd prop is set at pane creation and stays stale otherwise).
 *
 * - Linux: read /proc/<pid>/cwd symlink (instant)
 * - macOS: `lsof -a -d cwd -p <pid> -Fn` parses one line of output
 * - Windows: no portable way without external tools — return null and let
 *   the renderer fall back to OSC 7 / the initial cwd.
 */
export async function getPtyCwd(paneId: string): Promise<string | null> {
  const session = sessions.get(paneId)
  if (!session || session.disposed) return null
  const pid = session.pty.pid
  if (!pid) return null

  try {
    if (process.platform === 'linux') {
      return readlinkSync(`/proc/${pid}/cwd`)
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileP('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
        encoding: 'utf8',
        timeout: 2000
      })
      // -Fn output: lines like "p<pid>\nfcwd\nn/abs/path"
      const match = stdout.match(/^n(.+)$/m)
      return match ? match[1] : null
    }
  } catch {
    // PID gone, permissions denied, lsof missing — silently fall back
  }
  return null
}

export async function getGitInfo(cwd: string): Promise<{ isRepo: boolean; branch: string | null }> {
  try {
    const { stdout: inside } = await execFileP('git', ['rev-parse', '--is-inside-work-tree'], {
      ...GIT_OPTS,
      cwd,
      timeout: 3000
    })
    if (inside.trim() === 'true') {
      const { stdout: branch } = await execFileP('git', ['branch', '--show-current'], {
        ...GIT_OPTS,
        cwd,
        timeout: 3000
      })
      return { isRepo: true, branch: branch.trim() || null }
    }
  } catch {
    // not a git repo, or git not installed
  }
  return { isRepo: false, branch: null }
}

export interface BranchInfo {
  name: string
  /** Exists as a local branch. */
  local: boolean
  /** Exists on the remote (origin). A branch can be both local and remote. */
  remote: boolean
  /** True when `git branch` shows `+` — checked out in another linked worktree. */
  worktree?: boolean
}

export async function getGitBranches(cwd: string): Promise<BranchInfo[]> {
  const map = new Map<string, BranchInfo>()

  try {
    const { stdout: local } = await execFileP('git', ['branch'], { ...GIT_OPTS, cwd })
    // `git branch` lines look like:
    //   `* master`            current branch
    //   `+ feature/foo`       checked out in another worktree
    //   `  develop`           neither
    // The first column is `*`, `+`, or space; tag `+` as a worktree-linked branch.
    for (const line of local.split('\n')) {
      const m = line.match(/^([+*]?)\s*(.+)$/)
      if (!m) continue
      const name = m[2].trim()
      if (!name || name.startsWith('(')) continue
      map.set(name, { name, local: true, remote: false, worktree: m[1] === '+' })
    }
  } catch {
    return []
  }

  try {
    const { stdout: remote } = await execFileP('git', ['branch', '-r'], { ...GIT_OPTS, cwd })
    for (const line of remote.split('\n')) {
      const raw = line.replace(/^\*?\s+/, '').trim()
      // Skip empty lines and the `origin/HEAD -> origin/master` alias line.
      if (!raw || raw.includes('HEAD')) continue
      const short = raw.replace(/^origin\//, '')
      const existing = map.get(short)
      if (existing) {
        // Local branch with the same name — annotate the existing row rather
        // than producing a duplicate. This is how the user sees that a local
        // branch is also tracked on the remote.
        existing.remote = true
      } else {
        map.set(short, { name: short, local: false, remote: true })
      }
    }
  } catch {
    // no remote, or git not available
  }

  const branches = Array.from(map.values())
  // Local-containing branches first (most likely target for checkout), then
  // remote-only. Alphabetical within each group.
  branches.sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return branches
}

export async function getGitDiffStats(cwd: string): Promise<{ added: number; deleted: number }> {
  try {
    const { stdout } = await execFileP('git', ['diff', '--shortstat'], { ...GIT_OPTS, cwd })
    const added = (stdout.match(/(\d+) insertion/) || [])[1]
    const deleted = (stdout.match(/(\d+) deletion/) || [])[1]
    return { added: added ? parseInt(added) : 0, deleted: deleted ? parseInt(deleted) : 0 }
  } catch {
    return { added: 0, deleted: 0 }
  }
}

export async function checkoutGitBranch(
  cwd: string,
  branchName: string,
  isRemote?: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const args = isRemote
      ? ['checkout', '--track', `origin/${branchName}`]
      : ['checkout', branchName]
    await execFileP('git', args, { ...GIT_OPTS, cwd })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

export async function gitHasUncommittedChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain'], { ...GIT_OPTS, cwd })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

export async function gitAddWorktree(
  cwd: string,
  opts: { path: string; newBranch?: string; fromBranch?: string }
): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    const args = ['worktree', 'add']
    if (opts.newBranch) args.push('-b', opts.newBranch)
    args.push(opts.path)
    if (opts.fromBranch) args.push(opts.fromBranch)
    await execFileP('git', args, { ...GIT_OPTS, cwd, timeout: 15_000 })

    if (opts.newBranch) {
      try {
        await execFileP('git', ['push', '-u', 'origin', opts.newBranch], {
          ...GIT_OPTS,
          cwd: opts.path,
          timeout: 15_000
        })
      } catch {
        return {
          success: true,
          warning: `分支 "${opts.newBranch}" 已创建，但推送失败，请手动执行 git push -u origin "${opts.newBranch}"`
        }
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}
