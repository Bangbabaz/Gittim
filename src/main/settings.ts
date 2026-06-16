import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { Settings, TaskDef, SavedLayout } from '@shared/types'

// 共享类型 re-export,方便 main/tasks.ts 这种本来从 settings.ts 拿 TaskDef 的旧
// import 不必再到处改路径。
export type { Settings, TaskDef, SavedLayout }

const DEFAULTS: Settings = {
  windowBounds: { width: 1100, height: 720 },
  windowMaximized: false,
  fontSize: 13,
  scrollback: 10000,
  taskOutputCapKB: 4096,
  autoOpenTasksOnRun: true,
  tasksDrawerWidth: 860,
  browserDrawerWidth: 480,
  theme: 'system',
  sttLanguage: 'zh',
  sttDeviceId: '',
  voiceShortcut: 'F2',
  autoUpdate: true
}

let cache: Settings | null = null
let writeTimer: NodeJS.Timeout | null = null

const home = app.getPath('home')
const NEW_DIR = '.gittim'
const OLD_DIR = '.Gittim'

// Store under ~/.gittim/ instead of Electron's userData. userData lives at
// %APPDATA%/<productName> / ~/Library/Application Support/<productName> /
// ~/.config/<productName>, which is per-installation and gets clobbered if
// productName ever changes or another app picks the same name. A dot-dir in
// $HOME is portable, predictable, and easy for the user to back up or wipe.
function settingsDir(): string {
  return join(home, NEW_DIR)
}

function settingsPath(): string {
  return join(settingsDir(), 'settings.json')
}

/**
 * 迁移旧的大写目录到小写。模块加载时执行一次 —— 在 readSettings() 之前。
 * 如果旧目录 ~/.Gittim/ 存在且新目录 ~/.gittim/ 不存在,直接 rename;
 * 如果两者都存在,不覆盖(用户可能手动创建了新的),只在日志里提示。
 */
function migrateOldConfigDir(): void {
  try {
    const oldPath = join(home, OLD_DIR)
    const newPath = join(home, NEW_DIR)
    if (!existsSync(oldPath)) return
    if (existsSync(newPath)) {
      // 新旧目录并存 —— rename 会失败(EISDIR/ENOTEMPTY 取决于平台)。
      // 用户可能已手动迁移,或者旧目录是残留的空壳。不做破坏性操作。
      console.warn(
        `[Gittim] 新旧配置目录并存: ${oldPath}, ${newPath} —— 请手动检查并删除旧目录`
      )
      return
    }
    renameSync(oldPath, newPath)
    console.info(`[Gittim] 配置目录已迁移: ${oldPath} → ${newPath}`)
  } catch (err) {
    console.error('[Gittim] 配置目录迁移失败:', err)
  }
}

// 模块加载时执行迁移。readSettings() / shell-integration 都在这之后才访问
// 目录,所以 rename 是安全的。
migrateOldConfigDir()

export function readSettings(): Settings {
  if (cache) return cache
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    cache = { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    // File missing on first run, or unreadable — start from defaults.
    cache = { ...DEFAULTS }
  }
  return cache!
}

function flush(): void {
  if (!cache) return
  try {
    mkdirSync(settingsDir(), { recursive: true })
    // Atomic write: a crash mid-write would otherwise leave a truncated
    // settings.json and lose the saved layout + every task definition.
    const tmp = settingsPath() + '.tmp'
    writeFileSync(tmp, JSON.stringify(cache, null, 2))
    renameSync(tmp, settingsPath())
  } catch {
    // disk full / permissions — settings will simply not persist
  }
}

// Debounce: window-resize/move fire dozens of events per drag. We only need
// the final state, so coalesce writes within a short window.
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
