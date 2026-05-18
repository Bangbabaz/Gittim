import { ref, computed, type Ref, type ComputedRef } from 'vue'
import type { ITheme } from '@xterm/xterm'

// Singleton theme state shared across every component (module-scoped refs).
// The renderer owns the CSS-token swap (html[data-theme] + the `.dark` class
// Element Plus keys off); Electron's nativeTheme is the source of truth for
// "follow system" and is kept in sync via the preload bridge.

export type ThemePref = 'system' | 'dark' | 'light'
export type ThemeMode = 'dark' | 'light'

const preference = ref<ThemePref>('system')
const mode = ref<ThemeMode>('dark') // effective, resolved theme

// xterm has its own JS theme object (not CSS), so it can't read our CSS vars.
// Keep two palettes here and hand the active one to every Terminal instance.
const XTERM_DARK: ITheme = {
  background: '#1b1b1f',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: '#264f78',
  black: '#0c0c0c',
  red: '#c50f1f',
  green: '#13a10e',
  yellow: '#c19c00',
  blue: '#0037da',
  magenta: '#881798',
  cyan: '#3a96dd',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#e74856',
  brightGreen: '#16c60c',
  brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff',
  brightMagenta: '#b4009e',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2'
}

const XTERM_LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1f1f1f',
  cursor: '#1f1f1f',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#15803d',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#8c8c8c',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
}

const xtermTheme = computed<ITheme>(() => (mode.value === 'dark' ? XTERM_DARK : XTERM_LIGHT))

function applyMode(next: ThemeMode): void {
  mode.value = next
  const el = document.documentElement
  el.dataset.theme = next
  // Element Plus dark mode keys off the `.dark` class on <html>.
  el.classList.toggle('dark', next === 'dark')
}

async function resolveEffective(): Promise<void> {
  if (preference.value === 'system') {
    let dark = true
    try {
      dark = await window.api.themeShouldUseDark()
    } catch {
      // bridge unavailable — keep dark default
    }
    applyMode(dark ? 'dark' : 'light')
  } else {
    applyMode(preference.value)
  }
}

let initialized = false

async function init(): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    const s = await window.api.settingsGet()
    if (s.theme === 'dark' || s.theme === 'light' || s.theme === 'system') {
      preference.value = s.theme
    }
  } catch {
    // keep default 'system'
  }
  // Push the preference to the main process so nativeTheme (and thus
  // shouldUseDark + native chrome) reflects it before we resolve.
  window.api.themeSetSource(preference.value)
  await resolveEffective()
  // OS appearance changes only matter while following the system.
  window.api.onNativeThemeUpdated((dark) => {
    if (preference.value === 'system') applyMode(dark ? 'dark' : 'light')
  })
}

async function setPreference(pref: ThemePref): Promise<void> {
  preference.value = pref
  window.api.settingsSet({ theme: pref })
  window.api.themeSetSource(pref)
  await resolveEffective()
}

export function useTheme(): {
  preference: Ref<ThemePref>
  mode: Ref<ThemeMode>
  xtermTheme: ComputedRef<ITheme>
  init: () => Promise<void>
  setPreference: (p: ThemePref) => Promise<void>
} {
  return { preference, mode, xtermTheme, init, setPreference }
}
