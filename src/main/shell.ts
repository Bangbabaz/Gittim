import { spawn, IPty } from 'node-pty'
import { WebContents, app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readlinkSync, statSync, readFileSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { shellIntegration } from './shell-integration'
import { killProcessTree } from './proc'

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
    // Default to Windows PowerShell on Windows. PowerShell ships with every
    // modern Windows install (5.1 in System32, 7+ as `pwsh` if installed) and
    // gives users a richer prompt + tab-completion than cmd.exe. The user can
    // override via GITTIM_SHELL if they prefer cmd, pwsh, or git-bash.
    return process.env.GITTIM_SHELL || 'powershell.exe'
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

export async function killPty(paneId: string): Promise<void> {
  const session = sessions.get(paneId)
  if (!session) return
  session.disposed = true
  const pid = session.pty.pid
  // Reap the descendant tree FIRST. On Windows we need a live snapshot of
  // the process tree before pty.kill() reparents detached grandchildren
  // (Nx workers, vite/esbuild helpers, dev servers) to the system process,
  // at which point taskkill /T can no longer reach them.
  if (pid) {
    try {
      await killProcessTree(pid)
    } catch {
      // never let a stuck snapshot block PTY teardown
    }
  }
  try {
    session.pty.kill()
  } catch {
    // ignore — process may have exited during the snapshot
  }
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

/**
 * Returns the name of the repository's main working tree (the folder
 * containing the real `.git` directory), regardless of whether `cwd` is the
 * main repo or a linked worktree. Used by the new-worktree dialog so the
 * default project name is `<repo>-<branch>`, not `<currentFolder>-<branch>`
 * — which would compound (`repo-master-test`) when creating worktrees from
 * inside an existing worktree.
 *
 * Strategy: `git rev-parse --git-common-dir` returns the path to the shared
 * `.git` directory; its parent is the main working tree, and its basename
 * is the repo name. Returns null when cwd is not inside a git repo.
 */
export async function getRepoName(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { ...GIT_OPTS, cwd, timeout: 3000 }
    )
    const gitDir = stdout.trim()
    if (!gitDir) return null
    // Two shapes to handle:
    //   1) Normal repo:  D:/project/myrepo/.git → parent = myrepo, basename of
    //      gitDir is literally ".git" (or "" on some platforms after trim).
    //   2) Bare repo:    D:/project/myrepo.git  → no `.git` segment as parent;
    //      basename of gitDir is "myrepo.git" — strip the suffix.
    //
    // Detecting bare by "the basename of gitDir IS .git" (case 1) vs anything
    // else (case 2) avoids the old bug where `basename(parent)` returned a
    // generic parent folder like "repos" for a bare repo at `D:/repos/x.git`.
    const base = basename(gitDir)
    if (base === '.git') {
      const name = basename(dirname(gitDir))
      return name && name !== '.' ? name : null
    }
    return base.replace(/\.git$/, '') || null
  } catch {
    return null
  }
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

// ---------------------------------------------------------------------------
// Merge / rebase / cherry-pick / revert conflict state
// ---------------------------------------------------------------------------

export type MergeOpKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

export interface ConflictedFile {
  /** Repo-relative path. */
  path: string
  /** Two-char index/worktree status from `git status -z --porcelain=v2 -u` for unmerged rows. */
  status: string
  /** Human-readable Chinese description of `status`. */
  description: string
}

export interface MergeStatus {
  /** null = no operation in progress. */
  inProgress: MergeOpKind
  /**
   * For merge: the branch or ref being merged in (decoded from MERGE_MSG).
   * For rebase: the source branch (head-name without refs/heads/ prefix).
   * For cherry-pick / revert: short hash of the commit being applied.
   */
  target: string | null
  /**
   * For rebase: short hash of the commit we're replaying onto (rebase-merge/onto).
   * Null for other operation kinds.
   */
  onto: string | null
  conflicts: ConflictedFile[]
}

/**
 * Resolve a git-internal path (e.g. `MERGE_HEAD`, `rebase-merge`) to an
 * absolute filesystem path. `git rev-parse --git-path` handles worktrees (where
 * the per-worktree state lives under `<main>/.git/worktrees/<name>/`) correctly,
 * whereas naively joining `<cwd>/.git/...` does not.
 */
async function gitInternalPath(cwd: string, internal: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--git-path', internal], {
      ...GIT_OPTS,
      cwd,
      timeout: 3000
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Two-char status from porcelain v2 → Chinese description. Same vocabulary as
 * Git's own documentation, just translated. Unrecognised codes fall back to
 * the raw code so the UI still shows something.
 */
function describeConflictStatus(xy: string): string {
  switch (xy) {
    case 'DD':
      return '双方删除'
    case 'AU':
      return '我方新增'
    case 'UD':
      return '对方删除'
    case 'UA':
      return '对方新增'
    case 'DU':
      return '我方删除'
    case 'AA':
      return '双方新增'
    case 'UU':
      return '双方修改'
    default:
      return xy
  }
}

/**
 * Detect any in-progress merge/rebase/cherry-pick/revert and list every
 * unmerged path. Strategy:
 *
 *   1. Probe the per-worktree state files (MERGE_HEAD, rebase-merge/,
 *      rebase-apply/, CHERRY_PICK_HEAD, REVERT_HEAD) via `git rev-parse
 *      --git-path` so worktrees work correctly.
 *   2. Decode the "target" of the operation from the most useful source for
 *      each kind — MERGE_MSG's first line for merge, head-name for rebase,
 *      the head hash for cherry-pick/revert.
 *   3. Parse `git status -z --porcelain=v2 -u` for `u ` rows (unmerged) — the
 *      -z form is NUL-separated, so paths with spaces / quotes / newlines
 *      pass through intact.
 */
export async function getMergeStatus(cwd: string): Promise<MergeStatus> {
  const empty: MergeStatus = { inProgress: null, target: null, onto: null, conflicts: [] }

  // Cheap up-front check — if git can't even tell us this is a repo, bail.
  try {
    const { stdout: inside } = await execFileP('git', ['rev-parse', '--is-inside-work-tree'], {
      ...GIT_OPTS,
      cwd,
      timeout: 3000
    })
    if (inside.trim() !== 'true') return empty
  } catch {
    return empty
  }

  // --- detect operation kind --------------------------------------------
  const [mergeHead, rebaseMerge, rebaseApply, cherryHead, revertHead] = await Promise.all([
    gitInternalPath(cwd, 'MERGE_HEAD'),
    gitInternalPath(cwd, 'rebase-merge'),
    gitInternalPath(cwd, 'rebase-apply'),
    gitInternalPath(cwd, 'CHERRY_PICK_HEAD'),
    gitInternalPath(cwd, 'REVERT_HEAD')
  ])

  let kind: MergeOpKind = null
  let target: string | null = null
  let onto: string | null = null

  const readFirstLine = (p: string | null): string | null => {
    if (!p) return null
    try {
      const raw = readFileSync(p, 'utf8')
      const first = raw.split(/\r?\n/, 1)[0]
      return first.trim() || null
    } catch {
      return null
    }
  }

  if (mergeHead && existsSync(mergeHead)) {
    kind = 'merge'
    // MERGE_MSG first line is conventionally `Merge branch 'feature/x'` or
    // `Merge remote-tracking branch 'origin/main'`. Strip the boilerplate.
    const mergeMsg = await gitInternalPath(cwd, 'MERGE_MSG')
    const firstLine = readFirstLine(mergeMsg)
    if (firstLine) {
      const m = firstLine.match(/^Merge (?:remote-tracking )?branch '([^']+)'/)
      target = m ? m[1] : firstLine
    } else {
      target = readFirstLine(mergeHead) // fallback: the SHA
    }
  } else if (rebaseMerge && existsSync(rebaseMerge)) {
    kind = 'rebase'
    target = readFirstLine(`${rebaseMerge}/head-name`)?.replace(/^refs\/heads\//, '') || null
    onto = readFirstLine(`${rebaseMerge}/onto`)
    if (onto) onto = onto.slice(0, 7)
  } else if (rebaseApply && existsSync(rebaseApply)) {
    kind = 'rebase'
    target = readFirstLine(`${rebaseApply}/head-name`)?.replace(/^refs\/heads\//, '') || null
    onto = readFirstLine(`${rebaseApply}/onto`)
    if (onto) onto = onto.slice(0, 7)
  } else if (cherryHead && existsSync(cherryHead)) {
    kind = 'cherry-pick'
    const sha = readFirstLine(cherryHead)
    target = sha ? sha.slice(0, 7) : null
  } else if (revertHead && existsSync(revertHead)) {
    kind = 'revert'
    const sha = readFirstLine(revertHead)
    target = sha ? sha.slice(0, 7) : null
  }

  // --- enumerate unmerged paths ----------------------------------------
  // `git status -z --porcelain=v2 -u` rows are NUL-terminated. Format spec at
  // https://git-scm.com/docs/git-status#_porcelain_format_version_2 — `u` rows
  // start with `u ` and the path is the 11th whitespace-separated token.
  const conflicts: ConflictedFile[] = []
  try {
    const { stdout } = await execFileP('git', ['status', '-z', '--porcelain=v2', '-u'], {
      ...GIT_OPTS,
      cwd,
      maxBuffer: 4 * 1024 * 1024
    })
    // NUL splits records. The last "record" after a trailing NUL is empty —
    // filter it out. Rename/copy entries (type `2`) span TWO NUL chunks (new
    // path, then orig path); we skip them since conflicts can't be renames.
    const records = stdout.split('\0').filter(Boolean)
    for (const rec of records) {
      if (!rec.startsWith('u ')) continue
      // Layout: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`.
      // We split into 11 max so the path's spaces (Windows-style names like
      // `My Documents/foo.txt` exist) survive intact in the last token.
      const parts = rec.split(' ')
      if (parts.length < 11) continue
      const xy = parts[1]
      const path = parts.slice(10).join(' ')
      if (!path) continue
      conflicts.push({ path, status: xy, description: describeConflictStatus(xy) })
    }
  } catch {
    // status failed for some reason; report op kind without file list.
  }

  if (!kind && !conflicts.length) return empty
  return { inProgress: kind, target, onto, conflicts }
}

/**
 * Resolve a conflicted file by picking one side and staging it.
 *   ours   = the branch we were on when the operation started
 *   theirs = the incoming branch / commit
 *
 * Note: during a rebase, "ours" and "theirs" are swapped relative to a merge —
 * `--ours` in rebase means the commit being replayed (the branch you rebased),
 * NOT the branch you started on. We pass the flag through verbatim and the UI
 * labels reflect the operation kind.
 */
export async function resolveConflictBySide(
  cwd: string,
  file: string,
  side: 'ours' | 'theirs'
): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileP('git', ['checkout', `--${side}`, '--', file], { ...GIT_OPTS, cwd })
    await execFileP('git', ['add', '--', file], { ...GIT_OPTS, cwd })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Mark a conflicted file as resolved (user edited it externally — e.g. in
 * their IDE — and wants Gittim to `git add` it). No checkout, just add.
 */
export async function markConflictResolved(
  cwd: string,
  file: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileP('git', ['add', '--', file], { ...GIT_OPTS, cwd })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Abort the in-progress operation. The caller's `kind` is normally derived
 * from the most recent `getMergeStatus()` call; we trust it rather than
 * re-detecting, so a stale UI state doesn't drive the wrong git command.
 */
export async function abortMergeOp(
  cwd: string,
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert'
): Promise<{ success: boolean; error?: string }> {
  const subCmd =
    kind === 'merge'
      ? ['merge', '--abort']
      : kind === 'rebase'
        ? ['rebase', '--abort']
        : kind === 'cherry-pick'
          ? ['cherry-pick', '--abort']
          : ['revert', '--abort']
  try {
    await execFileP('git', subCmd, { ...GIT_OPTS, cwd, timeout: 15_000 })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Continue the in-progress operation. Git refuses if conflicts remain — we
 * surface the error verbatim so the user sees which path still has markers.
 *
 * `--no-edit` keeps Git from popping an editor in the middle of the IPC call
 * (we have no TTY here). For merge/cherry-pick/revert that means "reuse the
 * default commit message"; for rebase --continue it's a no-op (still safe).
 */
export async function continueMergeOp(
  cwd: string,
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert'
): Promise<{ success: boolean; error?: string }> {
  const subCmd =
    kind === 'merge'
      ? ['merge', '--continue', '--no-edit']
      : kind === 'rebase'
        ? ['rebase', '--continue']
        : kind === 'cherry-pick'
          ? ['cherry-pick', '--continue', '--no-edit']
          : ['revert', '--continue', '--no-edit']
  // For rebase, GIT_EDITOR=true makes any editor invocation succeed silently
  // (rebase --continue may want to amend the message on each step). Same trick
  // git's own `--no-edit` flag uses internally for the other ops.
  const env = { ...process.env, GIT_EDITOR: 'true' }
  try {
    await execFileP('git', subCmd, { ...GIT_OPTS, cwd, timeout: 30_000, env })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Full unified diff of one path against HEAD. Used by the conflict panel's
 * inline preview so the user can eyeball the marker blocks without opening
 * their editor. Includes the leading `diff --git` header so diff2html can
 * parse it.
 */
/**
 * 拉取某 ref 下的文件内容，供 DiffViewer 做整文件级语法高亮。
 *
 * - `ref === null`：读工作区文件
 * - `ref` 是 hash / 分支 / 'HEAD'：走 `git show <ref>:<path>`
 *
 * 超过 2 MB、文件不存在、git show 失败、内容含 NUL（二进制）一律返回 null，
 * 让前端 fallback 到无高亮的纯文本渲染。
 */
export async function gitShowFile(
  cwd: string,
  ref: string | null,
  path: string
): Promise<string | null> {
  if (!path) return null
  const MAX = 2 * 1024 * 1024
  try {
    let content: string
    if (ref === null) {
      const full = join(cwd, path)
      let size: number
      try {
        size = statSync(full).size
      } catch {
        return null
      }
      if (size > MAX) return null
      content = await readFile(full, 'utf-8')
    } else {
      const { stdout } = await execFileP('git', ['show', `${ref}:${path}`], {
        ...GIT_OPTS,
        cwd,
        maxBuffer: MAX,
        timeout: 5000
      })
      content = stdout
    }
    if (content.includes('\0')) return null
    return content
  } catch {
    return null
  }
}

export async function getFileDiff(
  cwd: string,
  file: string
): Promise<{ diff: string; truncated: boolean }> {
  const opts = { ...GIT_OPTS, cwd, maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }
  try {
    const { stdout } = await execFileP('git', ['diff', '--', file], opts)
    return { diff: stdout, truncated: false }
  } catch (err) {
    const e = err as { code?: string; stdout?: string }
    if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && e.stdout) {
      return { diff: e.stdout, truncated: true }
    }
    return { diff: '', truncated: false }
  }
}

// ---------------------------------------------------------------------------
// Commit history (git log + show)
// ---------------------------------------------------------------------------

export interface CommitInfo {
  hash: string
  shortHash: string
  author: string
  email: string
  /** ISO 8601 author date. */
  date: string
  parents: string[]
  /** Decoration refs, e.g. ['HEAD -> main', 'origin/main', 'tag: v1.0']. */
  refs: string[]
  subject: string
}

export interface CommitDetail extends CommitInfo {
  body: string
  /** Unified patch (may be huge — caller decides what to render). */
  diff: string
  /** True when the patch exceeded the buffer cap and was truncated. */
  truncated: boolean
}

// ASCII Unit Separator (0x1F) between fields; Record Separator (0x1E) between
// commits. Both are extremely rare in real commit messages and immune to
// quoting issues from arbitrary author names / subjects.
const LOG_FIELD_SEP = '\x1f'
const LOG_RECORD_SEP = '\x1e'
const LOG_FORMAT = ['%H', '%h', '%an', '%ae', '%aI', '%P', '%D', '%s'].join(LOG_FIELD_SEP)

function parseRefs(raw: string): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * List commits reachable from HEAD (or from every ref when `all` is true),
 * paginated via `--skip` + `--max-count`. Each commit lands on a single
 * record separated by 0x1E; fields inside are separated by 0x1F so commit
 * subjects with commas/quotes/newlines remain intact.
 *
 * `--no-decorate` is omitted on purpose so `%D` returns the ref decorations
 * (HEAD pointer, branch/tag names) we render as chips in the UI.
 */
export async function getCommitLog(
  cwd: string,
  opts: {
    skip?: number
    limit?: number
    /** Branch / tag / arbitrary ref to walk from. Empty → HEAD. */
    ref?: string
    /** Filter `git log --grep` (case-insensitive regex on subject + body). */
    grep?: string
    /** Filter `git log --author` (case-insensitive regex on name + email). */
    author?: string
  }
): Promise<CommitInfo[]> {
  const args = [
    'log',
    `--pretty=format:${LOG_RECORD_SEP}${LOG_FORMAT}`,
    `--max-count=${Math.max(1, Math.min(opts.limit ?? 200, 1000))}`,
    `--skip=${Math.max(0, opts.skip ?? 0)}`
  ]
  if (opts.grep) {
    args.push('-i', `--grep=${opts.grep}`)
  }
  if (opts.author) {
    // --author also accepts a regex; -i is shared with --grep above.
    if (!opts.grep) args.push('-i')
    args.push(`--author=${opts.author}`)
  }
  // Refs that look like flags can't be valid git refs, but reject them
  // defensively so a malformed UI state can't slip a flag past argv.
  if (opts.ref && !opts.ref.startsWith('-')) {
    args.push(opts.ref)
  }
  try {
    const { stdout } = await execFileP('git', args, {
      ...GIT_OPTS,
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000
    })
    const records = stdout.split(LOG_RECORD_SEP).filter((r) => r.length > 0)
    const out: CommitInfo[] = []
    for (const rec of records) {
      const fields = rec.split(LOG_FIELD_SEP)
      if (fields.length < 8) continue
      const [hash, shortHash, author, email, date, parents, refs, subject] = fields
      out.push({
        hash,
        shortHash,
        author,
        email,
        date,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        refs: parseRefs(refs),
        subject: (subject || '').replace(/\r?\n$/, '')
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Full detail for one commit: same metadata as the list row, plus the body
 * (lines after the subject) and the unified patch. Capped at 10 MB so a
 * monster commit (vendored dependency, generated lockfile) can't pin the
 * IPC channel.
 */
export async function getCommitDetail(cwd: string, hash: string): Promise<CommitDetail | null> {
  // Sanitize: only accept hash-like input. Branch names / refs could end up
  // here from an out-of-date UI; require hex so we never feed an attacker-
  // controlled --flag-shaped string into `git show`.
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) return null
  try {
    const headArgs = ['log', '-1', `--pretty=format:${LOG_FORMAT}${LOG_FIELD_SEP}%b`, hash]
    const { stdout: headOut } = await execFileP('git', headArgs, {
      ...GIT_OPTS,
      cwd,
      timeout: 5_000
    })
    const fields = headOut.split(LOG_FIELD_SEP)
    if (fields.length < 9) return null
    const [h, shortHash, author, email, date, parents, refs, subject, ...bodyParts] = fields
    const body = bodyParts.join(LOG_FIELD_SEP).replace(/\r?\n$/, '')

    let diff = ''
    let truncated = false
    try {
      const { stdout } = await execFileP('git', ['show', '--format=', '--patch', hash], {
        ...GIT_OPTS,
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 15_000
      })
      diff = stdout
    } catch (err) {
      const e = err as { code?: string; stdout?: string }
      if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && e.stdout) {
        diff = e.stdout
        truncated = true
      }
    }

    return {
      hash: h,
      shortHash,
      author,
      email,
      date,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      refs: parseRefs(refs),
      subject: (subject || '').replace(/\r?\n$/, ''),
      body,
      diff,
      truncated
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Branch operations (merge / rebase / push / pull / delete)
// ---------------------------------------------------------------------------

/**
 * `GIT_EDITOR=true` makes any editor invocation succeed silently so merge
 * commit messages, rebase todo lists, etc. don't block on an absent TTY.
 * Shared env for every long-running ref-mutating command below.
 */
function nonInteractiveEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_EDITOR: 'true' }
}

/** Reject obvious flag-shaped strings before passing user-picked refs to git. */
function isSafeRef(ref: string): boolean {
  return !!ref && !ref.startsWith('-')
}

/**
 * Merge `ref` into the current branch (`git merge --no-edit <ref>`). Conflicts
 * leave the worktree in a merging state — the PaneToolbar refresh that follows
 * picks that up via getMergeStatus and the badge appears automatically.
 */
export async function gitMerge(
  cwd: string,
  ref: string
): Promise<{ success: boolean; error?: string }> {
  if (!isSafeRef(ref)) return { success: false, error: '无效的分支引用' }
  try {
    await execFileP('git', ['merge', '--no-edit', ref], {
      ...GIT_OPTS,
      cwd,
      timeout: 60_000,
      env: nonInteractiveEnv()
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Rebase the current branch onto `ref`. Same conflict-recovery story as
 * gitMerge — leaves a rebase-in-progress state on conflict.
 */
export async function gitRebase(
  cwd: string,
  ref: string
): Promise<{ success: boolean; error?: string }> {
  if (!isSafeRef(ref)) return { success: false, error: '无效的分支引用' }
  try {
    await execFileP('git', ['rebase', ref], {
      ...GIT_OPTS,
      cwd,
      timeout: 60_000,
      env: nonInteractiveEnv()
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Push a branch to its default remote. Uses `-u` unconditionally — git accepts
 * it as a no-op if the upstream is already set. No `--force` exposure: a
 * dedicated UI affordance is safer than smuggling it through a context-menu
 * "推送" entry.
 */
export async function gitPush(
  cwd: string,
  branch: string
): Promise<{ success: boolean; error?: string }> {
  if (!isSafeRef(branch)) return { success: false, error: '无效的分支名' }
  try {
    const remote = await getDefaultRemote(cwd)
    if (!remote) return { success: false, error: '仓库未配置远程' }
    await execFileP('git', ['push', '-u', remote, branch], {
      ...GIT_OPTS,
      cwd,
      timeout: 60_000
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Fast-forward only `git pull` on the current branch. We never auto-merge or
 * auto-rebase a divergent pull — the user should make that call explicitly via
 * the merge/rebase entries.
 */
export async function gitPull(cwd: string): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileP('git', ['pull', '--ff-only'], {
      ...GIT_OPTS,
      cwd,
      timeout: 60_000,
      env: nonInteractiveEnv()
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
  }
}

/**
 * Delete a local branch. Tries `-d` first (refuses unmerged); the caller can
 * retry with `force=true` (`-D`) after confirming.
 */
export async function gitDeleteBranch(
  cwd: string,
  branch: string,
  force?: boolean
): Promise<{ success: boolean; error?: string }> {
  if (!isSafeRef(branch)) return { success: false, error: '无效的分支名' }
  try {
    await execFileP('git', ['branch', force ? '-D' : '-d', branch], { ...GIT_OPTS, cwd })
    return { success: true }
  } catch (err) {
    return { success: false, error: cleanGitError(err) }
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
