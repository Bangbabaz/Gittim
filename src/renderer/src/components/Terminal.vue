<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
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
}>()

const terminalRef = ref<HTMLDivElement>()
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)

const terminal = new Terminal({
  fontSize: 14,
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
terminal.loadAddon(fitAddon)

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
    if (text) window.api.ptyWrite(props.paneId, text)
  } catch {
    // clipboard read denied or empty
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
    copySelection()
    return false
  }
  // Ctrl+Shift+V → paste
  if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
    pasteFromClipboard()
    return false
  }
  // Ctrl+C → copy if there's a selection; otherwise pass through (send \x03 to pty)
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'C' || e.key === 'c')) {
    if (terminal.hasSelection()) {
      copySelection()
      return false
    }
    return true
  }
  // Ctrl+V → paste
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'V' || e.key === 'v')) {
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

const onTerminalFocus = (): void => {
  emit('focus', props.paneId)
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
    <div ref="terminalRef" class="terminal-container"></div>
    <Teleport to="body">
      <div
        v-if="contextMenuVisible"
        class="context-menu"
        :style="{ left: contextMenuX + 'px', top: contextMenuY + 'px' }"
        @click.stop
      >
        <div
          v-if="terminal.hasSelection()"
          class="context-menu-item"
          @click="onCopy"
        >
          Copy
        </div>
        <div class="context-menu-item" @click="onPaste">Paste</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.terminal-wrapper {
  width: 100%;
  height: 100%;
  padding: 4px;
  background-color: #1b1b1f;
  box-sizing: border-box;
}

.terminal-container {
  width: 100%;
  height: 100%;
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
