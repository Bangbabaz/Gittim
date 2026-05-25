import { ref, computed, type Ref, type ComputedRef } from 'vue'
import type { ITheme } from '@xterm/xterm'
import type { ThemePref } from '@shared/types'

// 单例 theme state(模块级 ref),全 app 共享:
//   - renderer 负责 html[data-theme] / .dark 类切换 → Element Plus 全部用 EL CSS
//     var 跟着变;
//   - main 端 nativeTheme 是"跟随系统"的 source of truth,通过 preload bridge 同步。
//
// xterm 用自己的 JS theme(canvas 上画 ANSI / 背景),不能直接读 CSS var。这里
// 走"应用 mode → 读 EL CSS var 解析为真实色"的折中:background / foreground /
// selection 等"主题相关色"从 EL var 提取,ANSI 16 色仍然硬编码(它们是终端
// 标准对应,不该跟 EL primary 等业务色挂钩)。

export type { ThemePref }
export type ThemeMode = 'dark' | 'light'

const preference = ref<ThemePref>('system')
const mode = ref<ThemeMode>('dark')

// ANSI 16 色 —— 终端"原色",跟主题无关,两套各自固定。这部分**故意不**用
// EL token:user 的脚本输出的红色字符不该跟 UI 报错色绑定。
const ANSI_DARK = {
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
const ANSI_LIGHT = {
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

/**
 * 用 mode 当前值,从 EL CSS var 读出 xterm 的"主题相关色"(背景 / 文字 / 光标 /
 * 选区)。配合 mode 默认 ANSI 表,组成完整 ITheme。
 *
 * `cssVar()` 在 SSR / 测试环境里可能拿不到 documentElement;给一份对应主题的
 * fallback 色,保证返回值始终合法。
 */
function readXtermPalette(m: ThemeMode): ITheme {
  // applyMode() 已经把 .dark / data-theme 设到 html 上,EL CSS var 这一刻生效。
  // 不需要 nextTick —— CSS var 是同步更新的。
  const style = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null
  const cssVar = (name: string, fallback: string): string => {
    if (!style) return fallback
    const v = style.getPropertyValue(name).trim()
    return v || fallback
  }
  const ansi = m === 'dark' ? ANSI_DARK : ANSI_LIGHT
  return {
    background: cssVar('--el-bg-color', m === 'dark' ? '#141414' : '#ffffff'),
    foreground: cssVar('--el-text-color-primary', m === 'dark' ? '#e5eaf3' : '#303133'),
    cursor: cssVar('--el-text-color-primary', m === 'dark' ? '#e5eaf3' : '#303133'),
    cursorAccent: cssVar('--el-bg-color', m === 'dark' ? '#141414' : '#ffffff'),
    selectionBackground: cssVar('--el-color-primary-light-5', m === 'dark' ? '#264f78' : '#add6ff'),
    ...ansi
  }
}

// 主题切换会改变 EL CSS var → readXtermPalette 结果不同。computed 依赖 mode,
// 所以 mode 变更即触发重算;Terminal.vue 的 watch(xtermTheme) 也会跟着应用。
const xtermTheme = computed<ITheme>(() => readXtermPalette(mode.value))

function applyMode(next: ThemeMode): void {
  mode.value = next
  const el = document.documentElement
  el.dataset.theme = next
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
  window.api.themeSetSource(preference.value)
  await resolveEffective()
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
