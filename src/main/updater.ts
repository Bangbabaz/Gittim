import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import { readSettings } from './settings'
import type { UpdateStatus } from '@shared/types'

let mainWindow: BrowserWindow | null = null
let initialized = false
let updateBusy = false
let currentStatus: UpdateStatus | null = null

function sendUpdateStatus(status: UpdateStatus): void {
  currentStatus = status
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', status)
  }
}

async function runUpdateCheck(): Promise<void> {
  // autoDownload 会让一次检查继续进入下载阶段。检查或下载尚未结束时，
  // 启动定时器和手动按钮都只复用当前状态，不能再发起第二次请求。
  if (updateBusy || currentStatus?.state === 'downloaded') {
    if (currentStatus) sendUpdateStatus(currentStatus)
    return
  }

  updateBusy = true
  sendUpdateStatus({ state: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    updateBusy = false
    sendUpdateStatus({
      state: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

export function initAutoUpdater(win: BrowserWindow): void {
  mainWindow = win
  if (!app.isPackaged || initialized) return
  initialized = true

  // 显式开启下载，不依赖 electron-updater 的默认配置。
  autoUpdater.autoDownload = true
  // 下载完成后，如果用户直接关闭应用，也在退出阶段自动安装。
  autoUpdater.autoInstallOnAppQuit = true
  // 显式安装时，安装完成后重新启动应用。
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.logger = {
    info: () => {},
    warn: console.warn,
    error: console.error
  }

  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    sendUpdateStatus({ state: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', (info) => {
    updateBusy = false
    sendUpdateStatus({ state: 'not-available', version: info.version })
  })
  autoUpdater.on('download-progress', (progress) =>
    sendUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => {
    updateBusy = false
    sendUpdateStatus({ state: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    updateBusy = false
    sendUpdateStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  })

  // 关闭“自动更新”只关闭后台检查；监听器必须保留，关于页的手动检查才可下载并反馈。
  if (readSettings().autoUpdate === false) return

  setTimeout(() => void runUpdateCheck(), 5000)
  setInterval(() => void runUpdateCheck(), 4 * 60 * 60 * 1000)
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    sendUpdateStatus({ state: 'error', message: '开发模式不支持更新检测' })
    return
  }
  await runUpdateCheck()
}

export function installUpdate(): void {
  // Windows 静默安装并强制重新启动；其它平台会按各自更新器的规则安装并重启。
  autoUpdater.quitAndInstall(true, true)
}
