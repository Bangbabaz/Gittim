import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import { readSettings } from './settings'
import type { UpdateStatus } from '@shared/types'

// 更新状态,通过 webContents.send 广播到 renderer。

let mainWindow: BrowserWindow | null = null

function sendUpdateStatus(status: UpdateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', status)
  }
}

export function initAutoUpdater(win: BrowserWindow): void {
  mainWindow = win

  // 开发模式不检查更新 —— electron-updater 在 dev 模式下的行为不可预测,
  // 且 dev-app-update.yml 已被排除在打包文件之外。
  if (!app.isPackaged) {
    console.log('[updater] 开发模式,跳过自动更新')
    return
  }

  // 配置日志级别：生产环境只输出 warn/error,避免 update.ejs 模板每次
  // 启动都打印一大段 "Skip checkForUpdates because application is not packed".
  // 读取用户设置，关闭自动更新则完全不启动检查
  const settings = readSettings()
  if (settings.autoUpdate === false) {
    console.log('[updater] autoUpdate 已关闭')
    return
  }

  // 生产环境关闭 info/debug 日志,避免每次启动打印无意义的 "Skip checkForUpdates".
  autoUpdater.logger = {
    info: () => {},
    warn: console.warn,
    error: console.error
  }

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatus({ state: 'not-available', version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({ state: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    sendUpdateStatus({ state: 'error', message: msg })
  })

  // 启动后 5 秒静默检查一次更新，避免阻塞首帧渲染。
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // 网络不通 / 未配置 GitHub token 属于预期场景,不打扰用户。
    })
  }, 5000)

  // 每 4 小时再检查一次（用户可能长时间开着）。
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 4 * 60 * 60 * 1000)
}

/** 手动触发更新检查（renderer 菜单/按钮）。 */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return
  await autoUpdater.checkForUpdates()
}

/** 退出并安装更新。 */
export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}
