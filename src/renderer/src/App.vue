<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import TerminalView from './components/Terminal.vue'

type Pane = { type: 'pane'; id: string }
type Split = {
  type: 'split'
  direction: 'row' | 'column'
  ratio: number
  a: LayoutNode
  b: LayoutNode
}
type LayoutNode = Pane | Split

// Persisted form of LayoutNode. Pane IDs are session-scoped (regenerated each
// launch), so the saved form stores cwd directly instead.
type SavedLayout =
  | { type: 'pane'; cwd: string }
  | {
      type: 'split'
      direction: 'row' | 'column'
      ratio: number
      a: SavedLayout
      b: SavedLayout
    }

type Rect = { left: number; top: number; width: number; height: number }

const DIVIDER = 4
const MIN_PANE = 60 // px; below this we don't split further
const MIN_RATIO = 0.05
const MAX_RATIO = 0.95

const cwd = ref<string | null>(null)
const paneCwd = ref<Record<string, string>>({})
const layout = ref<LayoutNode | null>(null)
const activeId = ref<string | null>(null)
const containerRef = ref<HTMLDivElement>()
const containerSize = ref({ width: 0, height: 0 })
const isMaximized = ref(false)
const isMac = ref(false)

function winMinimize(): void {
  window.api.winMinimize()
}
function winMaximize(): void {
  window.api.winMaximize()
}
function winClose(): void {
  window.api.winClose()
}

let paneCounter = 0
const newPaneId = (): string => `pane-${Date.now().toString(36)}-${++paneCounter}`

type DragState = {
  path: string[]
  direction: 'row' | 'column'
  startX: number
  startY: number
  startRatio: number
  totalSize: number
}
const dragState = ref<DragState | null>(null)

const updateRatio = (node: LayoutNode, path: string[], ratio: number): LayoutNode => {
  if (path.length === 0) {
    if (node.type === 'split') return { ...node, ratio }
    return node
  }
  if (node.type === 'pane') return node
  const [dir, ...rest] = path
  if (dir === 'a') return { ...node, a: updateRatio(node.a, rest, ratio) }
  return { ...node, b: updateRatio(node.b, rest, ratio) }
}

const insertSplit = (
  node: LayoutNode,
  targetId: string,
  newId: string,
  direction: 'row' | 'column'
): LayoutNode => {
  if (node.type === 'pane') {
    if (node.id !== targetId) return node
    return {
      type: 'split',
      direction,
      ratio: 0.5,
      a: node,
      b: { type: 'pane', id: newId }
    }
  }
  const a = insertSplit(node.a, targetId, newId, direction)
  const b = insertSplit(node.b, targetId, newId, direction)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

/**
 * Remove a leaf from the tree. If a split ends up with only one surviving
 * child, collapse it — the survivor replaces the split. Returns null if
 * removing the target empties the whole tree.
 */
const removePane = (node: LayoutNode, targetId: string): LayoutNode | null => {
  if (node.type === 'pane') {
    return node.id === targetId ? null : node
  }
  const a = removePane(node.a, targetId)
  const b = removePane(node.b, targetId)
  if (a === null && b === null) return null
  if (a === null) return b
  if (b === null) return a
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

const firstLeafId = (node: LayoutNode): string => {
  return node.type === 'pane' ? node.id : firstLeafId(node.a)
}

const serializeLayout = (node: LayoutNode): SavedLayout => {
  if (node.type === 'pane') {
    return { type: 'pane', cwd: paneCwd.value[node.id] || cwd.value || '' }
  }
  return {
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    a: serializeLayout(node.a),
    b: serializeLayout(node.b)
  }
}

// Rebuild a LayoutNode tree with fresh pane IDs, populating `paneCwdAcc` so
// each new pane spawns with its saved cwd. Returns the new root.
const deserializeLayout = (
  saved: SavedLayout,
  paneCwdAcc: Record<string, string>
): LayoutNode => {
  if (saved.type === 'pane') {
    const id = newPaneId()
    if (saved.cwd) paneCwdAcc[id] = saved.cwd
    return { type: 'pane', id }
  }
  return {
    type: 'split',
    direction: saved.direction,
    ratio: saved.ratio,
    a: deserializeLayout(saved.a, paneCwdAcc),
    b: deserializeLayout(saved.b, paneCwdAcc)
  }
}

/**
 * Walk the tree and produce absolute rects for every pane plus the dividers
 * between them. Renderer paints these flat — keeping each pane's DOM stable
 * across splits, so existing xterm instances aren't unmounted.
 */
type DividerItem = {
  rect: Rect
  direction: 'row' | 'column'
  path: string[]
  ratio: number
  totalSize: number
}

const collect = (
  node: LayoutNode,
  rect: Rect,
  panes: Array<{ id: string; rect: Rect }>,
  dividers: Array<DividerItem>,
  path: string[] = []
): void => {
  if (node.type === 'pane') {
    panes.push({ id: node.id, rect })
    return
  }
  if (node.direction === 'row') {
    const usable = Math.max(0, rect.width - DIVIDER)
    const aW = Math.max(0, Math.floor(usable * node.ratio))
    const bW = Math.max(0, usable - aW)
    collect(
      node.a,
      { left: rect.left, top: rect.top, width: aW, height: rect.height },
      panes,
      dividers,
      [...path, 'a']
    )
    dividers.push({
      rect: { left: rect.left + aW, top: rect.top, width: DIVIDER, height: rect.height },
      direction: 'row',
      path: [...path],
      ratio: node.ratio,
      totalSize: rect.width
    })
    collect(
      node.b,
      { left: rect.left + aW + DIVIDER, top: rect.top, width: bW, height: rect.height },
      panes,
      dividers,
      [...path, 'b']
    )
  } else {
    const usable = Math.max(0, rect.height - DIVIDER)
    const aH = Math.max(0, Math.floor(usable * node.ratio))
    const bH = Math.max(0, usable - aH)
    collect(
      node.a,
      { left: rect.left, top: rect.top, width: rect.width, height: aH },
      panes,
      dividers,
      [...path, 'a']
    )
    dividers.push({
      rect: { left: rect.left, top: rect.top + aH, width: rect.width, height: DIVIDER },
      direction: 'column',
      path: [...path],
      ratio: node.ratio,
      totalSize: rect.height
    })
    collect(
      node.b,
      { left: rect.left, top: rect.top + aH + DIVIDER, width: rect.width, height: bH },
      panes,
      dividers,
      [...path, 'b']
    )
  }
}

const layoutResult = computed(() => {
  const panes: Array<{ id: string; rect: Rect }> = []
  const dividers: Array<DividerItem> = []
  if (layout.value && containerSize.value.width > 0 && containerSize.value.height > 0) {
    collect(
      layout.value,
      { left: 0, top: 0, width: containerSize.value.width, height: containerSize.value.height },
      panes,
      dividers
    )
  }
  return { panes, dividers }
})

const findPaneRect = (id: string): Rect | null => {
  const found = layoutResult.value.panes.find((p) => p.id === id)
  return found ? found.rect : null
}

const onSplit = (paneId: string, direction: 'row' | 'column'): void => {
  if (!layout.value) return
  // Refuse to split when the target pane is already too small to halve.
  const rect = findPaneRect(paneId)
  if (rect) {
    const dim = direction === 'row' ? rect.width : rect.height
    if (dim < MIN_PANE * 2 + DIVIDER) return
  }
  const newId = newPaneId()
  layout.value = insertSplit(layout.value, paneId, newId, direction)
  if (paneCwd.value[paneId]) {
    paneCwd.value = { ...paneCwd.value, [newId]: paneCwd.value[paneId] }
  }
  activeId.value = newId
}

const onClose = (paneId: string): void => {
  if (!layout.value) return
  const next = removePane(layout.value, paneId)
  if (next === null) {
    // Closed the last pane → close the window.
    window.close()
    return
  }
  layout.value = next
  // Free the cwd override so closed-pane IDs don't accumulate over time.
  if (paneCwd.value[paneId]) {
    const rest = { ...paneCwd.value }
    delete rest[paneId]
    paneCwd.value = rest
  }
  if (activeId.value === paneId) {
    activeId.value = firstLeafId(next)
  }
}

const onCreateWorktree = (paneId: string, worktreePath: string): void => {
  if (!layout.value) return
  const newId = newPaneId()
  layout.value = insertSplit(layout.value, paneId, newId, 'row')
  paneCwd.value = { ...paneCwd.value, [newId]: worktreePath }
  activeId.value = newId
}

const setActive = (id: string): void => {
  activeId.value = id
}

// Terminal.vue emits whenever its shell's cwd changes (OSC 7 / OSC 9;9 /
// PID-based focus query). Mirror into paneCwd so saved layouts capture the
// shell's actual current directory, not the launch dir.
const onCwdChange = (paneId: string, newCwd: string): void => {
  if (paneCwd.value[paneId] === newCwd) return
  paneCwd.value = { ...paneCwd.value, [paneId]: newCwd }
}

const onDividerDown = (e: MouseEvent, idx: number): void => {
  const d = layoutResult.value.dividers[idx]
  if (!d) return
  dragState.value = {
    path: d.path,
    direction: d.direction,
    startX: e.clientX,
    startY: e.clientY,
    startRatio: d.ratio,
    totalSize: d.totalSize
  }
  e.preventDefault()
}

const onDividerMove = (e: MouseEvent): void => {
  if (!dragState.value || !layout.value) return
  const ds = dragState.value
  const delta = ds.direction === 'row' ? e.clientX - ds.startX : e.clientY - ds.startY
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ds.startRatio + delta / ds.totalSize))
  layout.value = updateRatio(layout.value, ds.path, ratio)
}

const onDividerUp = (): void => {
  dragState.value = null
}

const rectStyle = (rect: Rect): Record<string, string> => ({
  left: rect.left + 'px',
  top: rect.top + 'px',
  width: rect.width + 'px',
  height: rect.height + 'px'
})

let resizeObserver: ResizeObserver | null = null
let unsubscribeWinState: (() => void) | null = null

// Debounced layout persistence. Layout/cwd changes are frequent during normal
// use (every `cd` emits a cwdChange); 500ms coalesces bursts.
let saveTimer: ReturnType<typeof setTimeout> | null = null
const flushSave = (): void => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (layout.value) {
    window.api.settingsSet({ paneLayout: serializeLayout(layout.value) })
  }
}
const scheduleSave = (): void => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 500)
}

const flushSaveOnUnload = (): void => flushSave()

onMounted(async () => {
  cwd.value = await window.api.getCwd()
  isMac.value = (await window.api.getPlatform()) === 'darwin'
  isMaximized.value = await window.api.winIsMaximized()
  unsubscribeWinState = window.api.onWindowStateChanged((maximized) => {
    isMaximized.value = maximized
  })

  // Restore previously saved layout if there is one. Each pane gets a fresh
  // id; its saved cwd is seeded into paneCwd so the PTY spawns there.
  // shell.ts validates the dir and falls back to ~ if it's been deleted.
  const settings = await window.api.settingsGet()
  if (settings.paneLayout) {
    const restoredPaneCwd: Record<string, string> = {}
    const restored = deserializeLayout(settings.paneLayout, restoredPaneCwd)
    layout.value = restored
    paneCwd.value = restoredPaneCwd
    activeId.value = firstLeafId(restored)
  } else {
    const firstId = newPaneId()
    layout.value = { type: 'pane', id: firstId }
    activeId.value = firstId
  }

  // Persist on every layout/cwd change. The watch fires after the initial
  // restore too, which is harmless (writes the same content back).
  watch([layout, paneCwd], scheduleSave, { deep: true })

  // Save synchronously on window close so the last edit isn't lost. The
  // electron-side debounce in settings.ts gets flushed by app's before-quit.
  window.addEventListener('beforeunload', flushSaveOnUnload)

  window.addEventListener('mousemove', onDividerMove)
  window.addEventListener('mouseup', onDividerUp)

  if (containerRef.value) {
    const update = (): void => {
      const el = containerRef.value
      if (!el) return
      containerSize.value = { width: el.clientWidth, height: el.clientHeight }
    }
    update()
    resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(containerRef.value)
  }
})

onUnmounted(() => {
  flushSave()
  unsubscribeWinState?.()
  resizeObserver?.disconnect()
  window.removeEventListener('mousemove', onDividerMove)
  window.removeEventListener('mouseup', onDividerUp)
  window.removeEventListener('beforeunload', flushSaveOnUnload)
})
</script>

<template>
  <div class="title-bar" :class="{ mac: isMac }">
    <span class="title-bar-text">Gittim</span>
    <div v-if="!isMac" class="title-bar-controls">
      <button class="tb-btn tb-min" title="最小化" @click="winMinimize">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect y="4" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button class="tb-btn tb-max" title="最大化" @click="winMaximize">
        <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10">
          <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
        </svg>
        <svg v-else width="10" height="10" viewBox="0 0 10 10">
          <rect x="2" y="0" width="8" height="8" fill="none" stroke="currentColor" />
          <rect x="0" y="3" width="8" height="7" fill="#2d2d30" stroke="currentColor" />
        </svg>
      </button>
      <button class="tb-btn tb-close" title="关闭" @click="winClose">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
    </div>
  </div>
  <div ref="containerRef" class="layout-root" :class="{ dragging: !!dragState }">
    <template v-if="cwd !== null && layout">
      <div
        v-for="pane in layoutResult.panes"
        :key="pane.id"
        class="pane-slot"
        :class="{ active: pane.id === activeId }"
        :style="rectStyle(pane.rect)"
      >
        <TerminalView
          :pane-id="pane.id"
          :cwd="paneCwd[pane.id] ?? cwd"
          @focus="setActive"
          @split="onSplit"
          @close="onClose"
          @create-worktree="onCreateWorktree"
          @cwd-change="onCwdChange"
        />
      </div>
      <div
        v-for="(d, i) in layoutResult.dividers"
        :key="`divider-${i}`"
        class="divider"
        :class="d.direction"
        :style="rectStyle(d.rect)"
        @mousedown="(e) => onDividerDown(e, i)"
      ></div>
    </template>
  </div>
</template>

<style>
body {
  margin: 0;
  padding: 0;
  overflow: hidden;
}

.title-bar {
  height: 32px;
  background: #1e1e1e;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  -webkit-app-region: drag;
  user-select: none;
}

/* macOS hiddenInset places the traffic-light buttons in the top-left.
   Pad the bar so our title text and any future left-aligned content clears them. */
.title-bar.mac {
  padding-left: 78px;
  justify-content: center;
}

.title-bar-text {
  color: #999;
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.title-bar-controls {
  display: flex;
  -webkit-app-region: no-drag;
}

.tb-btn {
  width: 34px;
  height: 24px;
  border: none;
  background: none;
  color: #ccc;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.tb-btn:hover {
  background: #3e3e42;
}

.tb-close:hover {
  background: #c42b1c;
  color: #fff;
}

.layout-root {
  position: relative;
  width: 100vw;
  height: calc(100vh - 32px);
  background: #1b1b1f;
}

.layout-root.dragging {
  user-select: none;
  cursor: inherit;
}

.pane-slot {
  position: absolute;
  overflow: hidden;
  box-sizing: border-box;
  border: 1px solid transparent;
  transition: border-color 0.08s;
}

.pane-slot.active {
  border-color: #094771;
}

.divider {
  position: absolute;
  background: #3e3e42;
  z-index: 1;
}

.divider.row {
  cursor: col-resize;
}

.divider.column {
  cursor: row-resize;
}
</style>
