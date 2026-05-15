import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Saved layout tree. Mirrors the renderer's LayoutNode but stores cwd (not
 * pane IDs, which are regenerated on every launch). Restored on startup by
 * App.vue's deserialize() with fresh IDs.
 */
export type SavedLayout =
  | { type: 'pane'; cwd: string }
  | {
      type: 'split'
      direction: 'row' | 'column'
      ratio: number
      a: SavedLayout
      b: SavedLayout
    }

/**
 * Persisted background-task definition. Lives here (not tasks.ts) so settings.ts
 * has no import cycle with tasks.ts — tasks.ts imports this, not vice-versa.
 */
export interface TaskDef {
  id: string
  name: string
  command: string
  cwd: string
}

export interface Settings {
  windowBounds?: { x?: number; y?: number; width: number; height: number }
  windowMaximized?: boolean
  fontSize?: number
  /** null means "explicitly cleared" — used by the settings drawer's reset action. */
  paneLayout?: SavedLayout | null
  tasks?: TaskDef[]
  /** Auto-open the tasks drawer when a task starts. Default true. */
  autoOpenTasksOnRun?: boolean
}

const DEFAULTS: Settings = {
  windowBounds: { width: 1100, height: 720 },
  windowMaximized: false,
  fontSize: 14,
  autoOpenTasksOnRun: true
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
    writeFileSync(settingsPath(), JSON.stringify(cache, null, 2))
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
