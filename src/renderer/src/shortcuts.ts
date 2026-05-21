export type ShortcutAction =
  | 'splitRight'
  | 'splitDown'
  | 'closePane'
  | 'search'
  | 'fontSizeUp'
  | 'fontSizeDown'
  | 'fontSizeReset'
  | 'copy'
  | 'paste'

export interface ShortcutDef {
  action: ShortcutAction
  label: string
  defaultKeys: string
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { action: 'splitRight', label: '向右拆分', defaultKeys: 'Ctrl+Shift+D' },
  { action: 'splitDown', label: '向下拆分', defaultKeys: 'Ctrl+Shift+S' },
  { action: 'closePane', label: '关闭面板', defaultKeys: 'Ctrl+Shift+W' },
  { action: 'search', label: '搜索', defaultKeys: 'Ctrl+F' },
  { action: 'fontSizeUp', label: '字体放大', defaultKeys: 'Ctrl+=' },
  { action: 'fontSizeDown', label: '字体缩小', defaultKeys: 'Ctrl+-' },
  { action: 'fontSizeReset', label: '字体重置', defaultKeys: 'Ctrl+0' },
  { action: 'copy', label: '复制', defaultKeys: 'Ctrl+C' },
  { action: 'paste', label: '粘贴', defaultKeys: 'Ctrl+V' }
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
    Backquote: '`'
  }
  return map[code] || null
}

export function eventToShortcut(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
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
