import { app, shell, BrowserWindow, dialog, ipcMain, screen } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  startPty,
  writePty,
  resizePty,
  killPty,
  getCurrentDir,
  getPtyCwd,
  getGitInfo,
  getGitBranches,
  checkoutGitBranch,
  gitAddWorktree,
  gitHasUncommittedChanges,
  getGitDiffStats
} from './shell'
import { readSettings, updateSettings, flushSettings } from './settings'
import {
  registerTaskSubscriber,
  loadPersistedTasks,
  listTasks,
  getTaskOutput,
  startTask,
  stopTask,
  restartTask,
  removeTask,
  updateTask,
  createTask,
  killAllTasks
} from './tasks'
import { readFileSync } from 'fs'
import { join as joinPath } from 'path'
import icon from '../../resources/icon.png?asset'

let mainWindow: BrowserWindow | null = null

function clampBoundsToDisplay(b: { x?: number; y?: number; width: number; height: number }): {
  x?: number
  y?: number
  width: number
  height: number
} {
  // If a saved position lands off-screen (display unplugged, resolution change),
  // drop x/y so Electron centers the window on the primary display.
  if (b.x === undefined || b.y === undefined) return b
  const displays = screen.getAllDisplays()
  const onScreen = displays.some((d) => {
    const a = d.workArea
    return b.x! >= a.x && b.y! >= a.y && b.x! < a.x + a.width && b.y! < a.y + a.height
  })
  return onScreen ? b : { width: b.width, height: b.height }
}

function createWindow(): void {
  const settings = readSettings()
  const bounds = clampBoundsToDisplay(settings.windowBounds ?? { width: 1100, height: 720 })

  const win = new BrowserWindow({
    ...bounds,
    show: false,
    title: 'Gittim',
    autoHideMenuBar: true,
    // macOS gets the system traffic-light buttons; win/linux gets our custom
    // HTML buttons rendered in App.vue.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    if (settings.windowMaximized) win.maximize()
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // PTY cleanup happens via webContents.once('destroyed') inside startPty —
  // don't touch mainWindow on 'closed' (the BrowserWindow is already destroyed
  // and accessing .webContents throws "Object has been destroyed").

  // HMR for renderer base on electron-vite cli.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Persist window state. Resize/move fire continuously during drag — settings
  // module debounces, so this is safe.
  const persistBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
    const b = win.getBounds()
    updateSettings({ windowBounds: b })
  }
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('maximize', () => {
    updateSettings({ windowMaximized: true })
    win.webContents.send('window-state-changed', true)
  })
  win.on('unmaximize', () => {
    updateSettings({ windowMaximized: false })
    win.webContents.send('window-state-changed', false)
  })

  mainWindow = win
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.gittim.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC handlers
  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.handle('get-cwd', () => getCurrentDir())
  ipcMain.handle('get-platform', () => process.platform)
  ipcMain.handle('get-git-info', (_event, cwd: string) => getGitInfo(cwd))
  ipcMain.handle('get-git-branches', (_event, cwd: string) => getGitBranches(cwd))
  ipcMain.handle('git-diff-stats', (_event, cwd: string) => getGitDiffStats(cwd))
  ipcMain.handle('git-has-changes', (_event, cwd: string) => gitHasUncommittedChanges(cwd))

  ipcMain.handle('git-checkout', (_event, cwd: string, branchName: string, isRemote?: boolean) => {
    return checkoutGitBranch(cwd, branchName, isRemote)
  })

  ipcMain.handle(
    'git-worktree-add',
    (_event, cwd: string, opts: { path: string; newBranch?: string; fromBranch?: string }) => {
      return gitAddWorktree(cwd, opts)
    }
  )

  ipcMain.handle('select-directory', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.on('win-minimize', () => mainWindow?.minimize())
  ipcMain.on('win-maximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('win-close', () => mainWindow?.close())
  ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false)

  // Settings IPC
  ipcMain.handle('settings-get', () => readSettings())
  ipcMain.on('settings-set', (_event, patch: Record<string, unknown>) => {
    updateSettings(patch)
  })

  ipcMain.handle(
    'pty-start',
    (event, opts: { paneId: string; cols?: number; rows?: number; cwd?: string }) => {
      startPty(event.sender, opts)
    }
  )

  ipcMain.on('pty-write', (_event, paneId: string, data: string) => {
    writePty(paneId, data)
  })

  ipcMain.on('pty-resize', (_event, paneId: string, cols: number, rows: number) => {
    resizePty(paneId, cols, rows)
  })

  ipcMain.on('pty-kill', (_event, paneId: string) => {
    killPty(paneId)
  })

  ipcMain.handle('pty-get-cwd', (_event, paneId: string) => getPtyCwd(paneId))

  // Background tasks
  loadPersistedTasks()
  ipcMain.handle('task-subscribe', (event) => {
    registerTaskSubscriber(event.sender)
    return listTasks()
  })
  ipcMain.handle('task-list', () => listTasks())
  ipcMain.handle('task-output', (_event, id: string) => getTaskOutput(id))
  ipcMain.handle(
    'task-start',
    (_event, opts: { id?: string; name?: string; command: string; cwd: string }) => {
      return startTask(opts)
    }
  )
  ipcMain.handle('task-create', (_event, opts: { name?: string; command: string; cwd: string }) => {
    return createTask(opts)
  })
  ipcMain.handle('task-stop', (_event, id: string) => stopTask(id))
  ipcMain.handle('task-restart', (_event, id: string) => restartTask(id))
  ipcMain.handle('task-remove', (_event, id: string) => removeTask(id))
  ipcMain.handle(
    'task-update',
    (_event, id: string, patch: { name?: string; command?: string; cwd?: string }) => {
      return updateTask(id, patch)
    }
  )

  // Read `scripts` from a directory's package.json for one-click task chips.
  ipcMain.handle('read-package-scripts', (_event, cwd: string): Record<string, string> => {
    try {
      const raw = readFileSync(joinPath(cwd, 'package.json'), 'utf8')
      const pkg = JSON.parse(raw)
      return pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {}
    } catch {
      return {}
    }
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  killAllTasks()
  flushSettings()
})

app.on('window-all-closed', () => {
  killAllTasks()
  flushSettings()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
