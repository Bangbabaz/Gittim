import { app, shell, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  startPty,
  writePty,
  resizePty,
  killPty,
  getCurrentDir,
  getGitInfo,
  getGitBranches,
  checkoutGitBranch,
  gitAddWorktree,
  gitHasUncommittedChanges
} from './shell'
import icon from '../../resources/icon.png?asset'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    title: 'Gittim',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
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
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('maximize', () => win.webContents.send('window-state-changed', true))
  win.on('unmaximize', () => win.webContents.send('window-state-changed', false))

  mainWindow = win
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC handlers
  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.handle('get-cwd', () => getCurrentDir())
  ipcMain.handle('get-git-info', (_event, cwd: string) => getGitInfo(cwd))
  ipcMain.handle(
    'get-git-branches',
    (_event, cwd: string): { name: string; type: 'local' | 'remote' }[] => {
      return getGitBranches(cwd)
    }
  )
  ipcMain.handle('git-has-changes', (_event, cwd: string): boolean => {
    return gitHasUncommittedChanges(cwd)
  })

  ipcMain.handle(
    'git-checkout',
    (
      _event,
      cwd: string,
      branchName: string,
      isRemote?: boolean
    ): { success: boolean; error?: string } => {
      return checkoutGitBranch(cwd, branchName, isRemote)
    }
  )

  ipcMain.handle(
    'git-worktree-add',
    (
      _event,
      cwd: string,
      opts: { path: string; newBranch?: string; fromBranch?: string }
    ): { success: boolean; error?: string; warning?: string } => {
      return gitAddWorktree(cwd, opts)
    }
  )

  ipcMain.handle('select-directory', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.on('win-minimize', () => mainWindow?.minimize())
  ipcMain.on('win-maximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('win-close', () => mainWindow?.close())
  ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false)

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

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
