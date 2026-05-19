import { execFile } from 'child_process'

const isWindows = process.platform === 'win32'

/**
 * Kill a process and every descendant it spawned. `pty.kill()` alone only
 * signals the shell, so long-running grandchildren (dev servers, watchers,
 * `npm`→`node`→`vite`/`esbuild`) get reparented and linger after the task is
 * stopped. node-pty starts the shell as a session/group leader on POSIX, so
 * signalling the negative PID hits the whole group; on Windows `taskkill /T`
 * walks the process tree.
 *
 * Shared by shell.ts (pane PTYs) and tasks.ts (background tasks) so the
 * tree-reaping behaviour can't drift between the two.
 */
export function killProcessTree(pid: number | undefined | null): void {
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
