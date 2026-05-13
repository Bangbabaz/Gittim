<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
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

type Rect = { left: number; top: number; width: number; height: number }

const DIVIDER = 4
const MIN_PANE = 60 // px; below this we don't split further
const MIN_RATIO = 0.05
const MAX_RATIO = 0.95

const cwd = ref<string | null>(null)
const layout = ref<LayoutNode | null>(null)
const activeId = ref<string | null>(null)
const containerRef = ref<HTMLDivElement>()
const containerSize = ref({ width: 0, height: 0 })

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
    collect(node.a, { left: rect.left, top: rect.top, width: aW, height: rect.height }, panes, dividers, [...path, 'a'])
    dividers.push({
      rect: { left: rect.left + aW, top: rect.top, width: DIVIDER, height: rect.height },
      direction: 'row',
      path: [...path],
      ratio: node.ratio,
      totalSize: rect.width
    })
    collect(node.b, { left: rect.left + aW + DIVIDER, top: rect.top, width: bW, height: rect.height }, panes, dividers, [...path, 'b'])
  } else {
    const usable = Math.max(0, rect.height - DIVIDER)
    const aH = Math.max(0, Math.floor(usable * node.ratio))
    const bH = Math.max(0, usable - aH)
    collect(node.a, { left: rect.left, top: rect.top, width: rect.width, height: aH }, panes, dividers, [...path, 'a'])
    dividers.push({
      rect: { left: rect.left, top: rect.top + aH, width: rect.width, height: DIVIDER },
      direction: 'column',
      path: [...path],
      ratio: node.ratio,
      totalSize: rect.height
    })
    collect(node.b, { left: rect.left, top: rect.top + aH + DIVIDER, width: rect.width, height: bH }, panes, dividers, [...path, 'b'])
  }
}

const layoutResult = computed(() => {
  const panes: Array<{ id: string; rect: Rect }> = []
  const dividers: Array<DividerItem> = []
  if (
    layout.value &&
    containerSize.value.width > 0 &&
    containerSize.value.height > 0
  ) {
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
  if (activeId.value === paneId) {
    activeId.value = firstLeafId(next)
  }
}

const setActive = (id: string): void => {
  activeId.value = id
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

onMounted(async () => {
  cwd.value = await window.api.getCwd()

  const firstId = newPaneId()
  layout.value = { type: 'pane', id: firstId }
  activeId.value = firstId

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
  resizeObserver?.disconnect()
  window.removeEventListener('mousemove', onDividerMove)
  window.removeEventListener('mouseup', onDividerUp)
})
</script>

<template>
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
          :cwd="cwd"
          @focus="setActive"
          @split="onSplit"
          @close="onClose"
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

.layout-root {
  position: relative;
  width: 100vw;
  height: 100vh;
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
