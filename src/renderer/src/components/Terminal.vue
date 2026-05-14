<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import PaneToolbar from './PaneToolbar.vue'
import '@xterm/xterm/css/xterm.css'

const props = withDefaults(
  defineProps<{
    paneId: string
    options?: Record<string, unknown>
    cwd?: string
  }>(),
  {
    options: () => ({}),
    cwd: ''
  }
)

const emit = defineEmits<{
  (e: 'focus', paneId: string): void
  (e: 'split', paneId: string, direction: 'row' | 'column'): void
  (e: 'close', paneId: string): void
  (e: 'createWorktree', paneId: string, cwd: string): void
}>()

const terminalRef = ref<HTMLDivElement>()
const toolbarRef = ref<InstanceType<typeof PaneToolbar>>()
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)

// Tracks the shell's actual cwd. Initialized from the prop; updated by
// OSC 7 / OSC 9;9 escape sequences emitted by the shell, and by a PID-based
// query on focus (Linux/macOS only). PaneToolbar reads this instead of props.cwd
// so the toolbar follows `cd` commands inside the shell.
const currentCwd = ref(props.cwd)

// Search overlay state
const showSearch = ref(false)
const searchTerm = ref('')
const searchInputRef = ref<HTMLInputElement>()

const DEFAULT_FONT_SIZE = 14
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
const fontSize = ref(DEFAULT_FONT_SIZE)

const terminal = new Terminal({
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, Consolas, monospace",
  cursorBlink: true,
  rightClickSelectsWord: false,
  allowProposedApi: true,
  theme: {
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
  },
  ...props.options
})

const fitAddon = new FitAddon()
const searchAddon = new SearchAddon()
const webLinksAddon = new WebLinksAddon()
const unicode11Addon = new Unicode11Addon()
terminal.loadAddon(fitAddon)
terminal.loadAddon(searchAddon)
terminal.loadAddon(webLinksAddon)
terminal.loadAddon(unicode11Addon)
terminal.unicode.activeVersion = '11'

// OSC 7 — `\e]7;file://host/path\a`. Bash/zsh emit this when configured
// (and many distros configure it by default). We parse and update currentCwd.
terminal.parser.registerOscHandler(7, (data) => {
  const m = data.match(/^file:\/\/[^/]*(.+)$/)
  if (m) {
    let path = decodeURIComponent(m[1])
    // Windows comes through as "/C:/Users/..." — drop the leading slash.
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
    currentCwd.value = path
  }
  return true
})

// OSC 9;9 — Windows Terminal / PowerShell-style cwd notification.
// Payload: `9;C:\path` or `9;"C:\path"`.
terminal.parser.registerOscHandler(9, (data) => {
  const m = data.match(/^9;"?([^"]+)"?\s*$/)
  if (m) currentCwd.value = m[1]
  return true
})

/**
 * xterm.getSelection() returns rendered text with two problems for "copy":
 *   1. Cells past the last printed char in each row are padded with spaces and
 *      end up in the selection as trailing whitespace.
 *   2. Soft-wrapped lines (one logical line wrapped across multiple visual
 *      rows) get a "\n" inserted between rows when really they're one line.
 *
 * Note on coordinates: getSelectionPosition() returns 1-based positions with
 * end exclusive (in 1-based numbering). buf.getLine(y) and
 * line.translateToString(trim, startCol, endCol) take 0-based positions.
 */
const getCleanSelection = (): string => {
  const sel = terminal.getSelectionPosition()
  if (!sel) return ''

  const buf = terminal.buffer.active
  const startY = sel.start.y - 1
  const endY = sel.end.y - 1
  const out: string[] = []

  for (let y = startY; y <= endY; y++) {
    const line = buf.getLine(y)
    if (!line) continue

    const xStart = y === startY ? sel.start.x - 1 : 0
    const xEnd = y === endY ? sel.end.x - 1 : undefined

    const next = buf.getLine(y + 1)
    const continuesToNext = !!(next && next.isWrapped)

    const text = line.translateToString(!continuesToNext, xStart, xEnd)
    out.push(text)
    if (!continuesToNext && y < endY) out.push('\n')
  }
  return out.join('')
}

const copySelection = async (): Promise<void> => {
  const text = getCleanSelection()
  if (text) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // clipboard write denied
    }
    terminal.clearSelection()
  }
}

const pasteFromClipboard = async (): Promise<void> => {
  try {
    const text = await navigator.clipboard.readText()
    if (text) terminal.paste(text)
  } catch {
    // clipboard read denied or empty
  }
}

// Apply a new font size and reflow. Returns true if it actually changed.
const applyFontSize = (size: number): boolean => {
  const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size))
  if (clamped === fontSize.value) return false
  fontSize.value = clamped
  terminal.options.fontSize = clamped
  try {
    fitAddon.fit()
  } catch {
    // ignore — element may be detached/hidden
  }
  return true
}

const persistFontSize = (): void => {
  window.api.settingsSet({ fontSize: fontSize.value })
}

const openSearch = (): void => {
  showSearch.value = true
  nextTick(() => searchInputRef.value?.focus())
}

const closeSearch = (): void => {
  showSearch.value = false
  searchTerm.value = ''
  terminal.clearSelection()
  terminal.focus()
}

const findNext = (): void => {
  if (searchTerm.value) searchAddon.findNext(searchTerm.value)
}

const findPrev = (): void => {
  if (searchTerm.value) searchAddon.findPrevious(searchTerm.value)
}

const onSearchKey = (e: KeyboardEvent): void => {
  if (e.key === 'Enter') {
    e.preventDefault()
    e.shiftKey ? findPrev() : findNext()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeSearch()
  }
}

// Intercept hotkeys BEFORE xterm processes them. Return false to suppress
// xterm's default handling. Also call preventDefault() on shortcuts that the
// browser/Electron might otherwise grab (Ctrl+D bookmark, etc).
terminal.attachCustomKeyEventHandler((e): boolean => {
  if (e.type !== 'keydown') return true

  // Ctrl+Shift+D → split right
  if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'D' || e.key === 'd')) {
    e.preventDefault()
    emit('split', props.paneId, 'row')
    return false
  }
  // Ctrl+Shift+S → split down
  if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'S' || e.key === 's')) {
    e.preventDefault()
    emit('split', props.paneId, 'column')
    return false
  }
  // Ctrl+Shift+W → close current pane
  if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'W' || e.key === 'w')) {
    e.preventDefault()
    emit('close', props.paneId)
    return false
  }
  // Ctrl+Shift+C → always copy
  if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
    e.preventDefault()
    copySelection()
    return false
  }
  // Ctrl+Shift+V → paste
  if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
    e.preventDefault()
    pasteFromClipboard()
    return false
  }
  // Ctrl+F → open search overlay
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'F' || e.key === 'f')) {
    e.preventDefault()
    openSearch()
    return false
  }
  // Ctrl+= or Ctrl++ → font size up. `=` (no shift) is the bare key on most
  // QWERTY layouts; `+` arrives when shift IS held (also accept it).
  if (e.ctrlKey && !e.altKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault()
    if (applyFontSize(fontSize.value + 1)) persistFontSize()
    return false
  }
  // Ctrl+- → font size down
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === '-') {
    e.preventDefault()
    if (applyFontSize(fontSize.value - 1)) persistFontSize()
    return false
  }
  // Ctrl+0 → reset font size
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === '0') {
    e.preventDefault()
    if (applyFontSize(DEFAULT_FONT_SIZE)) persistFontSize()
    return false
  }
  // Ctrl+C → copy if there's a selection; otherwise pass through (send \x03 to pty)
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'C' || e.key === 'c')) {
    if (terminal.hasSelection()) {
      e.preventDefault()
      copySelection()
      return false
    }
    return true
  }
  // Ctrl+V → paste
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'V' || e.key === 'v')) {
    e.preventDefault()
    pasteFromClipboard()
    return false
  }
  return true
})

// All other input → forward to PTY
terminal.onData((data) => {
  window.api.ptyWrite(props.paneId, data)
})

const onContextMenu = (e: MouseEvent): void => {
  e.preventDefault()
  contextMenuX.value = e.clientX
  contextMenuY.value = e.clientY
  contextMenuVisible.value = true
}

const onCopy = async (): Promise<void> => {
  await copySelection()
  contextMenuVisible.value = false
  terminal.textarea?.focus()
}

const onPaste = async (): Promise<void> => {
  await pasteFromClipboard()
  contextMenuVisible.value = false
  terminal.textarea?.focus()
}

const closeContextMenu = (): void => {
  contextMenuVisible.value = false
}

const onTerminalFocus = async (): Promise<void> => {
  emit('focus', props.paneId)
  // Best-effort cwd refresh from the PTY's PID (Linux/macOS). OSC sequences
  // are the primary path; this just covers shells that don't emit them.
  try {
    const pidCwd = await window.api.ptyGetCwd(props.paneId)
    if (pidCwd) currentCwd.value = pidCwd
  } catch {
    // ignore
  }
  toolbarRef.value?.refresh()
}

defineExpose({ terminal, fitAddon })

let unsubscribeData: (() => void) | null = null
let unsubscribeExit: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let lastCols = 0
let lastRows = 0

const sendResize = (): void => {
  try {
    fitAddon.fit()
  } catch {
    // fit can throw if the element is detached / zero-sized — ignore
    return
  }
  const cols = terminal.cols
  const rows = terminal.rows
  if (cols > 0 && rows > 0 && (cols !== lastCols || rows !== lastRows)) {
    lastCols = cols
    lastRows = rows
    window.api.ptyResize(props.paneId, cols, rows)
  }
}

onMounted(async () => {
  if (!terminalRef.value) return

  // Load saved font size before opening so the first render uses the right
  // metrics — avoids a layout shift on initial mount.
  try {
    const settings = await window.api.settingsGet()
    if (typeof settings.fontSize === 'number') {
      fontSize.value = settings.fontSize
      terminal.options.fontSize = settings.fontSize
    }
  } catch {
    // settings module unavailable — keep default
  }

  terminal.open(terminalRef.value)
  try {
    fitAddon.fit()
  } catch {
    // ignore — first layout may not be ready
  }
  lastCols = terminal.cols
  lastRows = terminal.rows
  terminal.element?.addEventListener('contextmenu', onContextMenu)
  terminal.textarea?.addEventListener('focus', onTerminalFocus)

  unsubscribeData = window.api.onPtyData(props.paneId, (chunk) => terminal.write(chunk))
  unsubscribeExit = window.api.onPtyExit(props.paneId, (code) => {
    terminal.writeln(`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m`)
  })

  await window.api.ptyStart({
    paneId: props.paneId,
    cols: terminal.cols,
    rows: terminal.rows,
    cwd: props.cwd || undefined
  })

  // Watch the container — splits/window resizes/drags all change its size.
  resizeObserver = new ResizeObserver(() => sendResize())
  resizeObserver.observe(terminalRef.value)

  terminal.focus()
})

document.addEventListener('click', closeContextMenu)

onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
  resizeObserver?.disconnect()
  unsubscribeData?.()
  unsubscribeExit?.()
  window.api.ptyKill(props.paneId)
  terminal.dispose()
})
</script>

<template>
  <div class="terminal-wrapper" @click="() => terminal.textarea?.focus()">
    <PaneToolbar
      ref="toolbarRef"
      :cwd="currentCwd"
      @worktree-created="(path) => emit('createWorktree', props.paneId, path)"
    />
    <div ref="terminalRef" class="terminal-container"></div>
    <div v-if="showSearch" class="search-overlay" @click.stop>
      <input
        ref="searchInputRef"
        v-model="searchTerm"
        class="search-input"
        placeholder="搜索 (Enter 下一个 / Shift+Enter 上一个 / Esc 关闭)"
        @keydown="onSearchKey"
      />
      <button class="search-btn" title="上一个 (Shift+Enter)" @click="findPrev">↑</button>
      <button class="search-btn" title="下一个 (Enter)" @click="findNext">↓</button>
      <button class="search-btn" title="关闭 (Esc)" @click="closeSearch">×</button>
    </div>
    <Teleport to="body">
      <div
        v-if="contextMenuVisible"
        class="context-menu"
        :style="{ left: contextMenuX + 'px', top: contextMenuY + 'px' }"
        @click.stop
      >
        <div v-if="terminal.hasSelection()" class="context-menu-item" @click="onCopy">Copy</div>
        <div class="context-menu-item" @click="onPaste">Paste</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.terminal-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 0;
  background-color: #1b1b1f;
  box-sizing: border-box;
  position: relative;
}

.terminal-container {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.search-overlay {
  position: absolute;
  top: 32px;
  right: 12px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
  background: #2d2d30;
  border: 1px solid #3e3e42;
  border-radius: 4px;
  padding: 4px 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.search-input {
  width: 240px;
  background: #1e1e1e;
  border: 1px solid #3e3e42;
  border-radius: 3px;
  color: #d4d4d4;
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  padding: 3px 6px;
  outline: none;
}

.search-input:focus {
  border-color: #094771;
}

.search-btn {
  background: none;
  border: 1px solid transparent;
  color: #ccc;
  width: 22px;
  height: 22px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.search-btn:hover {
  background: #3e3e42;
  border-color: #555;
}
</style>

<style>
.context-menu {
  position: fixed;
  z-index: 9999;
  background: #2d2d30;
  border: 1px solid #3e3e42;
  border-radius: 4px;
  padding: 4px 0;
  min-width: 120px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.context-menu-item {
  padding: 6px 16px;
  cursor: pointer;
  color: #cccccc;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.context-menu-item:hover {
  background: #094771;
}
</style>
