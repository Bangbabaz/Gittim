import { spawn, IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { WebContents } from 'electron'

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

function defaultShell(): string {
  if (isWindows) {
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

export function getCurrentDir(): string {
  return process.cwd()
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
  const cwd = opts.cwd || process.cwd()

  const pty = spawn(defaultShell(), [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as { [key: string]: string },
    useConpty: true
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
