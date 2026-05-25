<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import {
  Copy,
  ClipboardPaste,
  TextSelect,
  Search,
  Eraser,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
  Settings as SettingsIcon
} from 'lucide-vue-next'
import PaneToolbar from './PaneToolbar.vue'
import SearchOverlay from './SearchOverlay.vue'
import { useTheme } from '../composables/useTheme'
import { DEFAULT_SHORTCUTS, shortcutMatches } from '../shortcuts'
import type { ShortcutAction } from '../shortcuts'
import '@xterm/xterm/css/xterm.css'

const { xtermTheme } = useTheme()

const DEFAULT_FONT_SIZE = 13
const DEFAULT_SCROLLBACK = 10000

const props = withDefaults(
  defineProps<{
    paneId: string
    options?: Record<string, unknown>
    cwd?: string
    fontSize?: number
    scrollback?: number
    shortcuts?: Record<string, string>
    /**
     * 父级 layout 中本 pane 是否为 active。activeId 变化(Alt+方向键切焦、点击其它
     * pane、新建 worktree 自动 active 新 pane)会让这个 prop 翻转 —— 翻 true 时
     * 我们补一次 terminal.focus() 把 DOM 焦点真正切过来,否则视觉 active 了但
     * 键盘事件还在原 pane。首次 mount 不依赖这条:onMounted 末尾已经 focus 过一次。
     */
    isActive?: boolean
  }>(),
  {
    options: () => ({}),
    cwd: '',
    fontSize: DEFAULT_FONT_SIZE,
    scrollback: DEFAULT_SCROLLBACK,
    shortcuts: () => ({}),
    isActive: false
  }
)

const emit = defineEmits<{
  (e: 'focus', paneId: string): void
  (e: 'split', paneId: string, direction: 'row' | 'column'): void
  (e: 'close', paneId: string): void
  (
    e: 'createWorktree',
    paneId: string,
    cwd: string,
    placement: 'top' | 'bottom' | 'left' | 'right'
  ): void
  (e: 'cwdChange', paneId: string, cwd: string): void
  (e: 'fontSizeChange', size: number): void
  (e: 'paneDragStart', paneId: string): void
  (e: 'focusNeighbor', dir: 'up' | 'down' | 'left' | 'right'): void
  (e: 'openSettings'): void
  (e: 'openTasks'): void
  (e: 'manageTasks', cwd?: string, newDraft?: boolean): void
}>()

const terminalRef = ref<HTMLDivElement>()
const toolbarRef = ref<InstanceType<typeof PaneToolbar>>()
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
// Captured when the menu opens so "复制" can be enabled/disabled correctly
// (the selection is cleared the moment the menu steals focus otherwise).
const menuHasSelection = ref(false)

// Tracks the shell's actual cwd. Initialized from the prop; updated by
// OSC 7 / OSC 9;9 escape sequences emitted by the shell, and by a PID-based
// query on focus (Linux/macOS only). PaneToolbar reads this instead of props.cwd
// so the toolbar follows `cd` commands inside the shell.
const currentCwd = ref(props.cwd)

// Search overlay state (the box itself lives in the shared SearchOverlay).
const showSearch = ref(false)

const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
// Local mirror of the effective font size. Named distinctly from the
// `fontSize` prop to avoid a props/state key collision (vue/no-dupe-keys).
const currentFontSize = ref(DEFAULT_FONT_SIZE)

const terminal = new Terminal({
  fontSize: DEFAULT_FONT_SIZE,
  scrollback: typeof props.scrollback === 'number' ? props.scrollback : DEFAULT_SCROLLBACK,
  fontFamily:
    "'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, Consolas, monospace",
  cursorBlink: true,
  rightClickSelectsWord: false,
  allowProposedApi: true,
  theme: xtermTheme.value,
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

// Propagate cwd changes up so App.vue can persist them in paneCwd / settings.
// Fires for every distinct value, including the initial sync from props.cwd.
watch(currentCwd, (newCwd) => {
  if (newCwd) emit('cwdChange', props.paneId, newCwd)
})

// OSC 7 — `\e]7;file://host/path\a`. Emitted by bash/zsh/pwsh/cmd thanks to
// the shell-integration hook in main; we parse and update currentCwd.
terminal.parser.registerOscHandler(7, (data) => {
  const m = data.match(/^file:\/\/[^/]*(.+)$/)
  if (m) {
    let path = m[1]
    // Best-effort percent-decode; cmd.exe emits raw paths with no encoding
    // (e.g. `/C:\Users\foo`) which decodeURIComponent leaves alone, but a
    // stray `%` inside a path would throw — fall back to the raw string.
    try {
      path = decodeURIComponent(path)
    } catch {
      // keep raw
    }
    // Windows comes through as "/C:/Users/..." or "/C:\Users\..." — drop the leading slash.
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
    currentCwd.value = path
  }
  return true
})

// OSC 9 has several conflicting sub-protocols sharing the same identifier:
//   - `OSC 9 ; <message>`            ConEmu / iTerm2 desktop notification
//   - `OSC 9 ; 1 ; <state> ; <pct>`  Windows Terminal progress
//   - `OSC 9 ; 9 ; <path>`           Windows Terminal / ConEmu cwd notification
// Only the third one is what we want; the old `^9;"?([^"]+)"?$` pattern was
// too permissive — a notification like `9;Build complete` would be parsed as
// cwd and jump the toolbar branch indicator to a nonexistent path. Lock the
// regex to the `9;9;` sub-code and let xterm's default handlers see anything
// else (notifications, progress) untouched.
terminal.parser.registerOscHandler(9, (data) => {
  // 严格匹配 `9;9;<path>`(允许可选引号包裹路径)。其它子代码(`9;<msg>`、
  // `9;1;<state>;<pct>`、`9;4;…`)一律 return false 让 xterm 默认处理。
  const m = data.match(/^9;9;"?([^"]+?)"?\s*$/)
  if (m) {
    currentCwd.value = m[1]
    return true
  }
  return false
})

const copySelection = async (): Promise<void> => {
  // xterm's own getSelection() yields the user-visible text with trailing
  // padding trimmed and soft-wrapped rows joined — matches the OS terminal.
  const text = terminal.getSelection()
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
  if (clamped === currentFontSize.value) return false
  currentFontSize.value = clamped
  terminal.options.fontSize = clamped
  try {
    fitAddon.fit()
  } catch {
    // ignore — element may be detached/hidden
  }
  return true
}

const persistFontSize = (): void => {
  emit('fontSizeChange', currentFontSize.value)
}

watch(
  () => props.fontSize,
  (n) => {
    if (typeof n === 'number') applyFontSize(n)
  }
)

// Live-apply scrollback changes from the settings drawer. xterm reflows its
// buffer in place; no remount needed.
watch(
  () => props.scrollback,
  (n) => {
    if (typeof n === 'number' && n > 0) terminal.options.scrollback = n
  }
)

// Re-theme live when the app theme changes (user toggle or, in "follow
// system" mode, an OS appearance change). xterm applies it in place.
watch(xtermTheme, (t) => {
  terminal.options.theme = t
})

// active 翻 true → 把 DOM 焦点真正切到本 pane 的 xterm。这是 Alt+方向键切焦 +
// 编程式 setActive(新建 worktree / drag-drop) 共同的尾巴 —— activeId 改了视觉
// 高亮,但浏览器键盘事件去向只有 .focus() 才会变。下一帧 focus 是为了避开
// xterm 本身可能正在处理上一次按键 emit 的同步流。
watch(
  () => props.isActive,
  (now) => {
    if (now) {
      // 多个 pane 同时翻 true 不会出现(activeId 是单值);这里直接 focus 不需要去重。
      requestAnimationFrame(() => terminal.focus())
    }
  }
)

const openSearch = (): void => {
  showSearch.value = true
}

const closeSearch = (): void => {
  showSearch.value = false
  terminal.clearSelection()
  terminal.focus()
}

// Intercept hotkeys BEFORE xterm processes them. Return false to suppress
// xterm's default handling. Also call preventDefault() on shortcuts that the
// browser/Electron might otherwise grab (Ctrl+D bookmark, etc).
terminal.attachCustomKeyEventHandler((e): boolean => {
  if (e.type !== 'keydown') return true

  const effective = { ...DEFAULT_SHORTCUTS, ...props.shortcuts }

  for (const [action, keys] of Object.entries(effective)) {
    if (!shortcutMatches(keys, e)) continue

    switch (action as ShortcutAction) {
      case 'splitRight':
        e.preventDefault()
        emit('split', props.paneId, 'row')
        return false
      case 'splitDown':
        e.preventDefault()
        emit('split', props.paneId, 'column')
        return false
      case 'closePane':
        e.preventDefault()
        requestClose()
        return false
      case 'search':
        e.preventDefault()
        openSearch()
        return false
      case 'fontSizeUp':
        e.preventDefault()
        if (applyFontSize(currentFontSize.value + 1)) persistFontSize()
        return false
      case 'fontSizeDown':
        e.preventDefault()
        if (applyFontSize(currentFontSize.value - 1)) persistFontSize()
        return false
      case 'fontSizeReset':
        e.preventDefault()
        if (applyFontSize(DEFAULT_FONT_SIZE)) persistFontSize()
        return false
      case 'copy':
        if (terminal.hasSelection()) {
          e.preventDefault()
          copySelection()
          return false
        }
        return true
      case 'paste':
        e.preventDefault()
        pasteFromClipboard()
        return false
      case 'focusUp':
        e.preventDefault()
        emit('focusNeighbor', 'up')
        return false
      case 'focusDown':
        e.preventDefault()
        emit('focusNeighbor', 'down')
        return false
      case 'focusLeft':
        e.preventDefault()
        emit('focusNeighbor', 'left')
        return false
      case 'focusRight':
        e.preventDefault()
        emit('focusNeighbor', 'right')
        return false
    }
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
  menuHasSelection.value = terminal.hasSelection()
  contextMenuVisible.value = true
}

const onBackdropContextMenu = (e: MouseEvent): void => {
  e.preventDefault()
  contextMenuX.value = e.clientX
  contextMenuY.value = e.clientY
}

const onCopy = async (): Promise<void> => {
  if (!menuHasSelection.value) return
  await copySelection()
  contextMenuVisible.value = false
  terminal.textarea?.focus()
}

const onPaste = async (): Promise<void> => {
  await pasteFromClipboard()
  contextMenuVisible.value = false
  terminal.textarea?.focus()
}

const onSelectAll = (): void => {
  terminal.selectAll()
  contextMenuVisible.value = false
}

const onClear = (): void => {
  terminal.clear()
  contextMenuVisible.value = false
  terminal.focus()
}

const onFind = (): void => {
  contextMenuVisible.value = false
  openSearch()
}

const onSplitRight = (): void => {
  contextMenuVisible.value = false
  emit('split', props.paneId, 'row')
}

const onSplitDown = (): void => {
  contextMenuVisible.value = false
  emit('split', props.paneId, 'column')
}

// Closing a pane kills its shell and every child (dev servers, editors).
// If something is actively running, confirm first so a stray Ctrl+Shift+W
// doesn't nuke a long task.
const requestClose = async (): Promise<void> => {
  let running = false
  try {
    running = await window.api.ptyHasRunningProcess(props.paneId)
  } catch {
    running = false
  }
  if (running) {
    try {
      await ElMessageBox.confirm(
        '该面板中有正在运行的进程，关闭会一并结束它们。确定关闭？',
        '关闭面板',
        { confirmButtonText: '关闭', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return // cancelled
    }
  }
  emit('close', props.paneId)
}

const onClosePane = (): void => {
  contextMenuVisible.value = false
  requestClose()
}

const onOpenSettings = (): void => {
  contextMenuVisible.value = false
  emit('openSettings')
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
// Captured at open() so we can explicitly removeEventListener on unmount.
// terminal.dispose() also tears down its DOM, but binding to the captured
// node directly makes the cleanup explicit and HMR-safe.
let termElement: HTMLElement | null = null
let termTextarea: HTMLTextAreaElement | null = null
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

// 拖 divider / 窗口边缘时 ResizeObserver 每帧会触发,fit() 内部要扫整张测量
// canvas,连续 IPC 也会让 main 一直在 ptyResize。把多次回调合并到下一帧执行 —
// 用户拖动结束后只跑一次 sendResize,体感无差别但 CPU 大幅下降。
let resizeRafId: number | null = null
const scheduleResize = (): void => {
  if (resizeRafId !== null) return
  resizeRafId = requestAnimationFrame(() => {
    resizeRafId = null
    sendResize()
  })
}

onMounted(async () => {
  if (!terminalRef.value) return

  // Apply font size from prop before opening so the first render uses the
  // right metrics — avoids a layout shift on initial mount.
  if (typeof props.fontSize === 'number') {
    currentFontSize.value = props.fontSize
    terminal.options.fontSize = props.fontSize
  }

  terminal.open(terminalRef.value)
  try {
    fitAddon.fit()
  } catch {
    // ignore — first layout may not be ready
  }
  lastCols = terminal.cols
  lastRows = terminal.rows
  termElement = terminal.element ?? null
  termTextarea = terminal.textarea ?? null
  termElement?.addEventListener('contextmenu', onContextMenu)
  termTextarea?.addEventListener('focus', onTerminalFocus)

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
  // 通过 rAF 合并连续触发,避免拖拽时高频 fit() + ptyResize IPC。
  resizeObserver = new ResizeObserver(() => scheduleResize())
  resizeObserver.observe(terminalRef.value)

  terminal.focus()
})

window.addEventListener('blur', closeContextMenu)

onUnmounted(() => {
  window.removeEventListener('blur', closeContextMenu)
  termElement?.removeEventListener('contextmenu', onContextMenu)
  termTextarea?.removeEventListener('focus', onTerminalFocus)
  termElement = null
  termTextarea = null
  resizeObserver?.disconnect()
  if (resizeRafId !== null) {
    cancelAnimationFrame(resizeRafId)
    resizeRafId = null
  }
  unsubscribeData?.()
  unsubscribeExit?.()
  window.api.ptyKill(props.paneId)
  terminal.dispose()
})
</script>

<template>
  <div class="terminal-wrapper" @click="() => terminal.textarea?.focus()">
    <div
      class="pane-drag-strip"
      title="拖拽以重排面板"
      @mousedown.left.prevent="emit('paneDragStart', props.paneId)"
    >
      <span class="pds-grip" />
    </div>
    <PaneToolbar
      ref="toolbarRef"
      :cwd="currentCwd"
      @worktree-created="(path, placement) => emit('createWorktree', props.paneId, path, placement)"
      @open-tasks="emit('openTasks')"
      @manage-tasks="(cwd?: string, nd?: boolean) => emit('manageTasks', cwd, nd)"
    />
    <div ref="terminalRef" class="terminal-container"></div>
    <div v-if="showSearch" class="search-pos">
      <SearchOverlay :search-addon="searchAddon" @close="closeSearch" />
    </div>
    <Teleport to="body">
      <div
        v-if="contextMenuVisible"
        class="context-menu-backdrop"
        @click="closeContextMenu"
        @contextmenu="onBackdropContextMenu"
      >
        <div
          class="context-menu"
          :style="{ left: contextMenuX + 'px', top: contextMenuY + 'px' }"
          @click.stop
        >
          <div class="cm-item" :class="{ disabled: !menuHasSelection }" @click="onCopy">
            <Copy :size="14" class="cm-icon" />
            <span class="cm-label">复制</span>
            <span class="cm-shortcut">Ctrl+C</span>
          </div>
          <div class="cm-item" @click="onPaste">
            <ClipboardPaste :size="14" class="cm-icon" />
            <span class="cm-label">粘贴</span>
            <span class="cm-shortcut">Ctrl+V</span>
          </div>
          <div class="cm-item" @click="onSelectAll">
            <TextSelect :size="14" class="cm-icon" />
            <span class="cm-label">全选</span>
          </div>

          <div class="cm-divider" />

          <div class="cm-item" @click="onFind">
            <Search :size="14" class="cm-icon" />
            <span class="cm-label">查找</span>
            <span class="cm-shortcut">Ctrl+F</span>
          </div>
          <div class="cm-item" @click="onClear">
            <Eraser :size="14" class="cm-icon" />
            <span class="cm-label">清屏</span>
          </div>

          <div class="cm-divider" />

          <div class="cm-item" @click="onSplitRight">
            <SplitSquareHorizontal :size="14" class="cm-icon" />
            <span class="cm-label">向右拆分</span>
            <span class="cm-shortcut">Ctrl+Shift+D</span>
          </div>
          <div class="cm-item" @click="onSplitDown">
            <SplitSquareVertical :size="14" class="cm-icon" />
            <span class="cm-label">向下拆分</span>
            <span class="cm-shortcut">Ctrl+Shift+S</span>
          </div>
          <div class="cm-item" @click="onClosePane">
            <X :size="14" class="cm-icon" />
            <span class="cm-label">关闭面板</span>
            <span class="cm-shortcut">Ctrl+Shift+W</span>
          </div>

          <div class="cm-divider" />

          <div class="cm-item" @click="onOpenSettings">
            <SettingsIcon :size="14" class="cm-icon" />
            <span class="cm-label">设置…</span>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped lang="scss">
.terminal-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 0;
  background-color: var(--el-bg-color);
  box-sizing: border-box;
  position: relative;
}

/* Always-present grab strip at the very top of every pane (repo or not) so
   the pane can be dragged onto another to re-split the layout. */
.pane-drag-strip {
  height: 7px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-fill-color-light);
  cursor: grab;
  -webkit-app-region: no-drag;
}

.pane-drag-strip:hover {
  background: var(--el-fill-color);
}

.pane-drag-strip:active {
  cursor: grabbing;
}

.pds-grip {
  width: 26px;
  height: 3px;
  border-radius: 2px;
  background: var(--el-border-color);
  opacity: 0.5;
  transition: opacity 0.1s;
}

.pane-drag-strip:hover .pds-grip {
  opacity: 0.95;
}

.terminal-container {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.search-pos {
  position: absolute;
  top: $titlebar-h;
  right: 12px;
  z-index: 10;
}
</style>
