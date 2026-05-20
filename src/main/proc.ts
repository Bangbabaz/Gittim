import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileP = promisify(execFile)
const isWindows = process.platform === 'win32'

/**
 * Kill a process and every descendant it spawned. `pty.kill()` alone only
 * signals the shell, so long-running grandchildren (dev servers, watchers,
 * `npm`→`node`→`vite`/`esbuild`/`nx-executor`) get reparented and linger
 * after the task is stopped. node-pty starts the shell as a session/group
 * leader on POSIX, so signalling the negative PID hits the whole group;
 * on Windows we snapshot the descendant tree *before* killing — once the
 * root dies, Windows reparents the grandchildren to the system, breaking
 * the parent chain so a plain `taskkill /T` can no longer find them.
 *
 * Shared by shell.ts (pane PTYs) and tasks.ts (background tasks) so the
 * tree-reaping behaviour can't drift between the two.
 *
 * Returns a promise that resolves once the kill commands have been issued.
 * Callers may fire-and-forget; awaiting is only useful when you need a
 * (best-effort) guarantee the descendants were signalled.
 */
export function killProcessTree(pid: number | undefined | null): Promise<void> {
  if (!pid) return Promise.resolve()
  if (isWindows) {
    return killTreeWindows(pid)
  }
  try {
    // Negative pid → the whole process group (node-pty calls setsid).
    process.kill(-pid, 'SIGTERM')
    // Escalate to SIGKILL only if the group is still alive after 2 s. Probing
    // with signal 0 first avoids racing against PID reuse: if the original
    // group is gone, we don't try to kill whatever process took its PID.
    setTimeout(() => {
      try {
        process.kill(-pid, 0)
      } catch {
        return // group already exited; nothing to escalate
      }
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // group exited between the probe and the kill
      }
    }, 2000).unref()
  } catch {
    // group already gone, or pid invalid
  }
  return Promise.resolve()
}

/**
 * Walk the live process table once via CIM and return every descendant PID
 * of `rootPid` (children, grandchildren, …). Snapshotting the whole graph
 * in one query is dramatically faster than recursive PowerShell calls and
 * — critically — sees the tree as it currently is, *before* we start
 * killing anything. Once a parent dies the OS reparents its survivors to
 * the system process and that ancestry is lost forever.
 */
async function snapshotDescendantsWindows(rootPid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileP(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // CSV: "ProcessId","ParentProcessId" rows. ConvertTo-Csv is more
        // reliable to parse than Format-Table (which word-wraps).
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation'
      ],
      { timeout: 5_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    )
    const children = new Map<number, number[]>()
    // skip the CSV header line
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const m = line.match(/^"?(\d+)"?,"?(\d+)"?$/)
      if (!m) continue
      const child = parseInt(m[1], 10)
      const parent = parseInt(m[2], 10)
      if (!Number.isFinite(child) || !Number.isFinite(parent)) continue
      let arr = children.get(parent)
      if (!arr) {
        arr = []
        children.set(parent, arr)
      }
      arr.push(child)
    }
    const result: number[] = []
    const seen = new Set<number>([rootPid])
    const queue: number[] = [rootPid]
    while (queue.length) {
      const cur = queue.shift()!
      const kids = children.get(cur)
      if (!kids) continue
      for (const k of kids) {
        if (seen.has(k)) continue
        seen.add(k)
        result.push(k)
        queue.push(k)
      }
    }
    return result
  } catch {
    return []
  }
}

async function killTreeWindows(pid: number): Promise<void> {
  // 1) Snapshot the descendant tree before issuing any kill, otherwise
  //    reparented grandchildren (especially Nx/webpack/vite workers that
  //    detach themselves from the shell) become unreachable.
  const descendants = await snapshotDescendantsWindows(pid)

  // 2) Best-effort tree kill from the root. /T walks the LIVE parent chain
  //    so it catches anything still connected.
  await new Promise<void>((resolve) => {
    execFile(
      'taskkill',
      ['/pid', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 5_000 },
      () => resolve()
    )
  })

  // 3) Kill each snapshotted descendant individually. If /T already reaped
  //    them the second taskkill is a harmless no-op (exits non-zero, which
  //    we ignore). This is what actually catches detached workers.
  if (descendants.length) {
    await Promise.all(
      descendants.map(
        (p) =>
          new Promise<void>((resolve) => {
            execFile(
              'taskkill',
              ['/pid', String(p), '/F'],
              { windowsHide: true, timeout: 5_000 },
              () => resolve()
            )
          })
      )
    )
  }
}
