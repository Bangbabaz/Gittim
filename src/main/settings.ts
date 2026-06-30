import { app } from 'electron'
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Settings, TaskDef, SavedLayout } from '@shared/types'

export type { Settings, TaskDef, SavedLayout }

const DEFAULTS: Settings = {
  windowBounds: { width: 1100, height: 720 },
  windowMaximized: false,
  fontSize: 13,
  scrollback: 10000,
  taskOutputCapKB: 4096,
  autoOpenTasksOnRun: true,
  unifiedAgentSessions: false,
  tasksDrawerWidth: 860,
  browserDrawerWidth: 480,
  theme: 'system',
  sttLanguage: 'zh',
  sttDeviceId: '',
  voiceShortcut: 'F2',
  autoUpdate: true,
  quickCommands: []
}

let cache: Settings | null = null
let writeTimer: NodeJS.Timeout | null = null

const home = app.getPath('home')
const NEW_DIR = '.gittim'
const OLD_DIR = '.Gittim'

// 配置使用固定的用户目录，而不是 Electron userData。这样产品名变化或重装应用时，
// 布局、任务和偏好仍然位于可预测、便于备份的 ~/.gittim/settings.json。
function settingsDir(): string {
  return join(home, NEW_DIR)
}

function settingsPath(): string {
  return join(settingsDir(), 'settings.json')
}

/**
 * 将旧的 ~/.Gittim 迁移为 ~/.gittim。
 *
 * Windows 默认不区分文件名大小写，直接检查两个路径会把同一个目录误判成
 * “新旧目录并存”。这里枚举 HOME 下的真实目录名，并通过临时目录完成大小写改名。
 *
 * 在大小写敏感的文件系统上，如果新旧目录确实同时存在，则将旧配置合并到新目录，
 * 复制成功后再删除旧目录。旧配置优先，避免升级时生成的默认值覆盖用户数据。
 */
function migrateOldConfigDir(): void {
  const oldPath = join(home, OLD_DIR)
  const newPath = join(home, NEW_DIR)

  try {
    const dirs = readdirSync(home, { withFileTypes: true })
    const hasOld = dirs.some((entry) => entry.isDirectory() && entry.name === OLD_DIR)
    const hasNew = dirs.some((entry) => entry.isDirectory() && entry.name === NEW_DIR)
    if (!hasOld) return

    if (hasNew) {
      cpSync(oldPath, newPath, { recursive: true, force: true })
      rmSync(oldPath, { recursive: true, force: true })
      console.info(`[Gittim] 已合并并删除旧配置目录: ${oldPath} → ${newPath}`)
      return
    }

    const tempPath = join(home, `.gittim-migrate-${process.pid}-${Date.now()}`)
    renameSync(oldPath, tempPath)
    try {
      renameSync(tempPath, newPath)
    } catch (err) {
      renameSync(tempPath, oldPath)
      throw err
    }
    console.info(`[Gittim] 配置目录已迁移: ${oldPath} → ${newPath}`)
  } catch (err) {
    console.error('[Gittim] 配置目录迁移失败:', err)
  }
}

migrateOldConfigDir()

export function readSettings(): Settings {
  if (cache) return cache
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    cache = { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache!
}

function flush(): void {
  if (!cache) return
  try {
    mkdirSync(settingsDir(), { recursive: true })
    // 先写临时文件再重命名，避免异常退出留下半截 JSON。
    const tmp = settingsPath() + '.tmp'
    writeFileSync(tmp, JSON.stringify(cache, null, 2))
    renameSync(tmp, settingsPath())
  } catch {
    // 磁盘已满或无写入权限时保留内存状态，本次运行仍可继续。
  }
}

export function updateSettings(patch: Partial<Settings>): void {
  cache = { ...readSettings(), ...patch }
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(flush, 250)
}

export function flushSettings(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  flush()
}
