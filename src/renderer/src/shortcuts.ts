export type ShortcutAction =
  | 'splitRight'
  | 'splitDown'
  | 'openDirectory'
  | 'closePane'
  | 'search'
  | 'fontSizeUp'
  | 'fontSizeDown'
  | 'fontSizeReset'
  | 'copy'
  | 'paste'
  | 'focusUp'
  | 'focusDown'
  | 'focusLeft'
  | 'focusRight'

export interface ShortcutDef {
  action: ShortcutAction
  label: string
  defaultKeys: string
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { action: 'splitRight', label: '向右拆分', defaultKeys: 'Ctrl+Shift+D' },
  { action: 'splitDown', label: '向下拆分', defaultKeys: 'Ctrl+Shift+S' },
  { action: 'openDirectory', label: '打开目录为新面板', defaultKeys: 'Ctrl+Shift+O' },
  { action: 'closePane', label: '关闭面板', defaultKeys: 'Ctrl+Shift+W' },
  { action: 'search', label: '搜索', defaultKeys: 'Ctrl+F' },
  { action: 'fontSizeUp', label: '字体放大', defaultKeys: 'Ctrl+=' },
  { action: 'fontSizeDown', label: '字体缩小', defaultKeys: 'Ctrl+-' },
  { action: 'fontSizeReset', label: '字体重置', defaultKeys: 'Ctrl+0' },
  { action: 'copy', label: '复制', defaultKeys: 'Ctrl+C' },
  { action: 'paste', label: '粘贴', defaultKeys: 'Ctrl+V' },
  // tmux 风格切焦:Alt+方向键 / Alt+H J K L 都行,默认走方向键(易记)。
  // Alt 而非 Ctrl 是为了不和 readline Ctrl+P/N、shell history Ctrl+→ 冲突。
  { action: 'focusUp', label: '焦点上移', defaultKeys: 'Alt+ArrowUp' },
  { action: 'focusDown', label: '焦点下移', defaultKeys: 'Alt+ArrowDown' },
  { action: 'focusLeft', label: '焦点左移', defaultKeys: 'Alt+ArrowLeft' },
  { action: 'focusRight', label: '焦点右移', defaultKeys: 'Alt+ArrowRight' }
]

export const DEFAULT_SHORTCUTS: Record<string, string> = Object.fromEntries(
  SHORTCUT_DEFS.map((d) => [d.action, d.defaultKeys])
)

/** Map physical key codes to canonical key names. */
function codeToKey(code: string): string | null {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  const map: Record<string, string> = {
    Minus: '-',
    Equal: '=',
    Space: 'Space',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    // 方向键和功能键的 code 直接就是名字 —— 显式映射只是为了让 default 中
    // 'Alt+ArrowUp' 这种字符串与 eventToShortcut 的输出严格一致。
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight'
  }
  return map[code] || null
}

export function eventToShortcut(e: KeyboardEvent): string {
  const parts: string[] = []
  // macOS 的 Cmd（metaKey）等价于 win/linux 的 Ctrl —— 统一报告为 'Ctrl'，
  // 跨平台共享同一套 binding：mac 用户按 Cmd+F 也能匹配 default 的 'Ctrl+F'，
  // win/linux 用户按 Ctrl+F 同样匹配。mac 上的 Control 键也仍然能触发同一组
  // 快捷键，兼容习惯 win 风格的 mac 用户。
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  // The =/+ key shares one physical key — ignore Shift for it so both Ctrl+=
  // and Ctrl+Shift+= match the same binding. (Old behaviour accepted both.)
  if (e.shiftKey && e.code !== 'Equal') parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(codeToKey(e.code) || e.key)
  return parts.join('+')
}

export function shortcutMatches(shortcut: string, e: KeyboardEvent): boolean {
  return eventToShortcut(e) === shortcut
}
