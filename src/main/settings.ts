import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
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
  theme: 'system'
}

let cache: Settings | null = null
let writeTimer: NodeJS.Timeout | null = null

// Store under ~/.Gittim/ instead of Electron's userData. userData lives at
// %APPDATA%/<productName> / ~/Library/Application Support/<productName> /
// ~/.config/<productName>, which is per-installation and gets clobbered if
// productName ever changes or another app picks the same name. A dot-dir in
// $HOME is portable, predictable, and easy for the user to back up or wipe.
function settingsDir(): string {
  return join(app.getPath('home'), '.Gittim')
}

function settingsPath(): string {
  return join(settingsDir(), 'settings.json')
}

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
