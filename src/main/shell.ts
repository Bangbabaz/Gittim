import { spawn, IPty } from 'node-pty'
import { WebContents, app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readlinkSync, statSync, readFileSync } from 'fs'
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

/**
 * Kill a process and every descendant it spawned. `pty.kill()` alone only
 * signals the shell; long-running children (dev servers, watchers) get
 * reparented and linger. node-pty starts the shell as a session/group leader
 * on POSIX, so signalling the negative PID hits the whole group; on Windows
 * `taskkill /T` walks the process tree.
 */
function killProcessTree(pid: number): void {
  if (!pid) return
  if (isWindows) {
    // Fire-and-forget; /T = tree, /F = force. Errors (already gone) ignored.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try {
    // Negative pid → the whole process group (node-pty calls setsid).
    process.kill(-pid, 'SIGTERM')
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // group already gone
      }
    }, 2000)
  } catch {
    // group already gone, or pid invalid
  }
}

export function killPty(paneId: string): void {
  const session = sessions.get(paneId)
  if (!session) return
  session.disposed = true
  const pid = session.pty.pid
  try {
    session.pty.kill()
  } catch {
    // ignore
  }
  // Also tear down any descendants the shell spawned (servers, watchers, …).
  if (pid) killProcessTree(pid)
  sessions.delete(paneId)
  sessionsByWebContents.get(session.wcId)?.delete(paneId)
}

/**
 * Best-effort check: does the pane's shell have any child process running
 * (i.e. is a command currently executing in it)? Used to warn before closing
 * a pane that's mid-task. node-pty's pid is the shell itself, so any child
 * means something is running.
 *
 * - Linux: /proc/<pid>/task/<pid>/children (space-separated child PIDs)
 * - macOS: `pgrep -P <pid>` (exit 0 ⇒ has children)
 * - Windows: CIM query for processes whose ParentProcessId is the shell
 */
export async function ptyHasRunningProcess(paneId: string): Promise<boolean> {
  const session = sessions.get(paneId)
  if (!session || session.disposed) return false
  const pid = session.pty.pid
  if (!pid) return false

  try {
    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      return raw.trim().length > 0
    }
    if (process.platform === 'darwin') {
      await execFileP('pgrep', ['-P', String(pid)], { timeout: 2000 })
      return true // pgrep exits 0 only when a match exists
    }
    if (isWindows) {
      const { stdout } = await execFileP(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Measure-Object).Count`
        ],
        { timeout: 5000, windowsHide: true }
      )
      return parseInt(stdout.trim(), 10) > 0
    }
  } catch {
    // pgrep exits 1 (no children), /proc race, powershell missing, timeout —
    // treat as "nothing running" so we never block close on a flaky probe.
  }
  return false
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
  /** Exists on at least one remote. A branch can be both local and remote. */
  remote: boolean
  /**
   * The remote this branch lives on (e.g. `origin`, `upstream`). When several
   * remotes carry the same branch name, `origin` is preferred, else the first
   * seen. Undefined for purely local branches.
   */
  remoteName?: string
  /** True when `git branch` shows `+` — checked out in another linked worktree. */
  worktree?: boolean
}

/**
 * Pick a sensible default remote: `origin` if it exists, otherwise the first
 * configured remote, otherwise '' (no remotes at all).
 */
export async function getDefaultRemote(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['remote'], { ...GIT_OPTS, cwd })
    const remotes = stdout
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
    if (remotes.includes('origin')) return 'origin'
    return remotes[0] ?? ''
  } catch {
    return ''
  }
}

export async function getGitBranches(cwd: string): Promise<BranchInfo[]> {
  const map = new Map<string, BranchInfo>()
  const remoteNames = new Set<string>()
  try {
    const { stdout } = await execFileP('git', ['remote'], { ...GIT_OPTS, cwd })
    for (const r of stdout
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean))
      remoteNames.add(r)
  } catch {
    // no remotes configured
  }

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
      // Skip empty lines and any `<remote>/HEAD -> <remote>/master` alias line.
      if (!raw || raw.includes('HEAD ->') || raw.includes(' -> ')) continue
      // Split into `<remote>/<branch>`. The remote is the first path segment
      // that matches a configured remote name; the rest (which may itself
      // contain slashes, e.g. `feature/x`) is the branch.
      let remoteName = ''
      let short = raw
      const slash = raw.indexOf('/')
      if (slash > 0) {
        const candidate = raw.slice(0, slash)
        if (remoteNames.size === 0 || remoteNames.has(candidate)) {
          remoteName = candidate
          short = raw.slice(slash + 1)
        }
      }
      if (!short) continue
      const existing = map.get(short)
      if (existing) {
        // Local branch with the same name — annotate the existing row rather
        // than producing a duplicate. Prefer `origin` as the recorded remote.
        existing.remote = true
        if (!existing.remoteName || remoteName === 'origin') existing.remoteName = remoteName
      } else {
        // First remote to carry this name. A later `origin/<name>` line will
        // fall into the branch above and upgrade remoteName to `origin`.
        map.set(short, { name: short, local: false, remote: true, remoteName })
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

// Stats must match the diff viewer (getGitDiff), which diffs vs HEAD —
// staged + unstaged. Plain `git diff --shortstat` only counts unstaged
// changes, so the badge undercounted once anything was `git add`ed. Same
// unborn-HEAD fallback as getGitDiff.
function parseShortstat(stdout: string): { added: number; deleted: number } {
  const added = (stdout.match(/(\d+) insertion/) || [])[1]
  const deleted = (stdout.match(/(\d+) deletion/) || [])[1]
  return { added: added ? parseInt(added) : 0, deleted: deleted ? parseInt(deleted) : 0 }
}

export async function getGitDiffStats(cwd: string): Promise<{ added: number; deleted: number }> {
  try {
    const { stdout } = await execFileP('git', ['diff', 'HEAD', '--shortstat'], { ...GIT_OPTS, cwd })
    return parseShortstat(stdout)
  } catch {
    try {
      const { stdout } = await execFileP('git', ['diff', '--shortstat'], { ...GIT_OPTS, cwd })
      return parseShortstat(stdout)
    } catch {
      return { added: 0, deleted: 0 }
    }
  }
}

export async function checkoutGitBranch(
  cwd: string,
  branchName: string,
  isRemote?: boolean,
  remoteName?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    let args: string[]
    if (isRemote) {
      const remote = remoteName || (await getDefaultRemote(cwd)) || 'origin'
      args = ['checkout', '--track', `${remote}/${branchName}`]
    } else {
      args = ['checkout', branchName]
    }
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

/**
 * Stash tracked + staged changes (no `-u`: untracked files are left alone so
 * we don't sweep up build artifacts). Used by the "stash & switch" flow.
 */
export async function gitStash(cwd: string): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileP('git', ['stash', 'push', '-m', 'Gittim: 切换分支前自动暂存'], {
      ...GIT_OPTS,
      cwd
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

export interface WorktreeInfo {
  path: string
  branch: string | null
  head: string | null
  /** This is the main working tree (the repo root), not a linked worktree. */
  isMain: boolean
  /** Detached HEAD (no branch). */
  detached: boolean
  /** `git worktree lock`-ed — removal needs --force. */
  locked: boolean
}

/**
 * Parse `git worktree list --porcelain`. The first record is always the main
 * working tree. Records are blank-line separated; keys: worktree/HEAD/branch/
 * bare/detached/locked.
 */
export async function getGitWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  try {
    const { stdout } = await execFileP('git', ['worktree', 'list', '--porcelain'], {
      ...GIT_OPTS,
      cwd
    })
    const out: WorktreeInfo[] = []
    let cur: Partial<WorktreeInfo> & { _seen?: boolean } = {}
    const flush = (): void => {
      if (cur.path) {
        out.push({
          path: cur.path,
          branch: cur.branch ?? null,
          head: cur.head ?? null,
          isMain: out.length === 0,
          detached: !!cur.detached,
          locked: !!cur.locked
        })
      }
      cur = {}
    }
    for (const line of stdout.split('\n')) {
      const l = line.trimEnd()
      if (l === '') {
        flush()
        continue
      }
      if (l.startsWith('worktree ')) cur.path = l.slice('worktree '.length)
      else if (l.startsWith('HEAD ')) cur.head = l.slice('HEAD '.length)
      else if (l.startsWith('branch '))
        cur.branch = l.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (l === 'detached') cur.detached = true
      else if (l.startsWith('locked')) cur.locked = true
    }
    flush()
    return out
  } catch {
    return []
  }
}

export async function gitRemoveWorktree(
  cwd: string,
  worktreePath: string,
  force?: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const args = ['worktree', 'remove']
    if (force) args.push('--force')
    args.push(worktreePath)
    await execFileP('git', args, { ...GIT_OPTS, cwd, timeout: 15_000 })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Full working-tree diff vs HEAD (staged + unstaged) for the read-only viewer.
 * Falls back to `git diff` when there's no commit yet (unborn HEAD). Capped at
 * 10 MB so a huge diff can't blow up the IPC payload / renderer.
 */
export async function getGitDiff(cwd: string): Promise<{ diff: string; truncated: boolean }> {
  const opts = { ...GIT_OPTS, cwd, maxBuffer: 10 * 1024 * 1024, timeout: 15_000 }
  try {
    const { stdout } = await execFileP('git', ['diff', 'HEAD'], opts)
    return { diff: stdout, truncated: false }
  } catch (err) {
    const e = err as { code?: string; stdout?: string }
    // maxBuffer exceeded still yields partial stdout — show what we have.
    if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && e.stdout) {
      return { diff: e.stdout, truncated: true }
    }
    // Unborn branch (no HEAD yet): fall back to the plain working-tree diff.
    try {
      const { stdout } = await execFileP('git', ['diff'], opts)
      return { diff: stdout, truncated: false }
    } catch {
      return { diff: '', truncated: false }
    }
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
      const remote = await getDefaultRemote(cwd)
      if (!remote) {
        return {
          success: true,
          warning: `分支 "${opts.newBranch}" 已创建（仓库未配置远程，已跳过推送）`
        }
      }
      try {
        await execFileP('git', ['push', '-u', remote, opts.newBranch], {
          ...GIT_OPTS,
          cwd: opts.path,
          timeout: 15_000
        })
      } catch {
        return {
          success: true,
          warning: `分支 "${opts.newBranch}" 已创建，但推送失败，请手动执行 git push -u ${remote} "${opts.newBranch}"`
        }
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}
