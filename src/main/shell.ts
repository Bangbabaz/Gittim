import { spawn, IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { WebContents } from 'electron'

const isWindows = process.platform === 'win32'

interface Session {
  pty: IPty
  webContents: WebContents
  disposed: boolean
}

const sessions = new Map<number, Session>()

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
  opts: { cols?: number; rows?: number; cwd?: string } = {}
): void {
  const id = webContents.id
  killPty(id)

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

  const session: Session = { pty, webContents, disposed: false }
  sessions.set(id, session)

  pty.onData((data) => {
    if (!session.disposed && !webContents.isDestroyed()) {
      webContents.send('pty-data', data)
    }
  })

  pty.onExit(({ exitCode }) => {
    if (!session.disposed && !webContents.isDestroyed()) {
      webContents.send('pty-exit', exitCode)
    }
    sessions.delete(id)
  })

  webContents.once('destroyed', () => killPty(id))
}

export function writePty(webContentsId: number, data: string): void {
  const session = sessions.get(webContentsId)
  if (session && !session.disposed) {
    session.pty.write(data)
  }
}

export function resizePty(webContentsId: number, cols: number, rows: number): void {
  const session = sessions.get(webContentsId)
  if (session && !session.disposed) {
    try {
      session.pty.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      // pty may have already exited
    }
  }
}

export function killPty(webContentsId: number): void {
  const session = sessions.get(webContentsId)
  if (!session) return
  session.disposed = true
  try {
    session.pty.kill()
  } catch {
    // ignore
  }
  sessions.delete(webContentsId)
}
