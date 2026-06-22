import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import { readSettings } from './settings'
import type { UpdateStatus } from '@shared/types'

let mainWindow: BrowserWindow | null = null
let initialized = false

function sendUpdateStatus(status: UpdateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', status)
  }
}

export function initAutoUpdater(win: BrowserWindow): void {
  mainWindow = win
  if (!app.isPackaged || initialized) return
  initialized = true

  // 显式开启下载，不依赖 electron-updater 的默认配置。
  autoUpdater.autoDownload = true
  autoUpdater.logger = {
    info: () => {},
    warn: console.warn,
    error: console.error
  }

  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    sendUpdateStatus({ state: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', (info) =>
    sendUpdateStatus({ state: 'not-available', version: info.version })
  )
  autoUpdater.on('download-progress', (progress) =>
    sendUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    sendUpdateStatus({ state: 'downloaded', version: info.version })
  )
  autoUpdater.on('error', (err) =>
    sendUpdateStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  )

  // 关闭“自动更新”只关闭后台检查；监听器必须保留，关于页的手动检查才可下载并反馈。
  if (readSettings().autoUpdate === false) return

  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000)
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000)
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    sendUpdateStatus({ state: 'error', message: '开发模式不支持更新检测' })
    return
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    sendUpdateStatus({
      state: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}
