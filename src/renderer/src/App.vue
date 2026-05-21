<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import {
  Settings as SettingsIcon,
  Type,
  Layout,
  Info,
  RotateCcw,
  Keyboard
} from 'lucide-vue-next'
import TerminalView from './components/Terminal.vue'
import TasksDrawer from './components/TasksDrawer.vue'
import TaskManagerDialog from './components/TaskManagerDialog.vue'
import { useTheme, type ThemePref } from './composables/useTheme'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFS,
  eventToShortcut
} from './shortcuts'

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
// Read platform synchronously from the preload bridge so the title-bar
// renders the correct controls on the very first paint. The async
// `window.api.getPlatform()` IPC was making macOS briefly flash the
// Windows-style buttons over the system traffic lights.
const isMac = ref(
  ((window.electron as unknown as { process?: { platform?: string } }).process?.platform ?? '') ===
    'darwin'
)

const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
// Global font size — single source of truth so the drawer and every open
// pane stay in sync. Loaded from settings on mount, persisted on change.
const appFontSize = ref(DEFAULT_FONT_SIZE)

const DEFAULT_SCROLLBACK = 10000
const MIN_SCROLLBACK = 1000
const MAX_SCROLLBACK = 200000
// Global terminal scrollback (lines). Same single-source-of-truth pattern as
// font size: every pane reads it via prop, changes persist to settings.
const appScrollback = ref(DEFAULT_SCROLLBACK)

const showSettings = ref(false)
const settingsTab = ref<'general' | 'shortcuts' | 'about'>('general')
const electronVersion = ref('')
const appVersion = ref('')

// Background tasks drawer + manager dialog
const showTasks = ref(false)
const taskSelectId = ref<string | null>(null)
const showTaskMgr = ref(false)
const taskMgrFocusId = ref<string | null>(null)
// The manager is scoped to one folder (the entry point it was opened from);
// null = legacy flat list. newDraft also starts a fresh draft on open.
const taskMgrScopeCwd = ref<string | null>(null)
const taskMgrNewDraft = ref(false)
const autoOpenTasksOnRun = ref(true)

// Shortcut overrides — only non-default bindings are stored. Passed to every
// TerminalView as a prop; merged with DEFAULT_SHORTCUTS inside the key handler.
const shortcutOverrides = ref<Record<string, string>>({})
const recordingAction = ref<string | null>(null)

// Effective shortcuts (defaults merged with user overrides)
const effectiveShortcuts = computed(() => ({
  ...DEFAULT_SHORTCUTS,
  ...shortcutOverrides.value
}))

const startRecording = (action: string): void => {
  recordingAction.value = action
}

const resetShortcut = (action: string): void => {
  const next = { ...shortcutOverrides.value }
  delete next[action]
  shortcutOverrides.value = next
  window.api.settingsSet({ shortcutOverrides: next })
}

const onRecordingKeydown = (e: KeyboardEvent): void => {
  if (!recordingAction.value) return
  e.preventDefault()
  e.stopPropagation()

  if (e.key === 'Escape') {
    recordingAction.value = null
    return
  }

  // Ignore standalone modifier presses
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return

  // Require at least Ctrl or Alt
  if (!e.ctrlKey && !e.altKey) return

  const shortcut = eventToShortcut(e)
  const targetAction = recordingAction.value
  recordingAction.value = null

  // Check for conflicts — if another action already uses this combo, swap.
  const conflict = SHORTCUT_DEFS.find(
    (d) => d.action !== targetAction && effectiveShortcuts.value[d.action] === shortcut
  )

  const next = { ...shortcutOverrides.value }

  if (conflict) {
    // Swap: the conflicting action gets this one's old binding
    next[conflict.action] = effectiveShortcuts.value[targetAction]
  }

  if (shortcut === DEFAULT_SHORTCUTS[targetAction]) {
    delete next[targetAction]
  } else {
    next[targetAction] = shortcut
  }

  // Clean up any that became default
  for (const a of Object.keys(next)) {
    if (next[a] === DEFAULT_SHORTCUTS[a]) delete next[a]
  }

  shortcutOverrides.value = next
  window.api.settingsSet({ shortcutOverrides: next })
}

// Watch recording state to attach/remove the global keydown listener
const watchRecording = (): void => {
  if (recordingAction.value) {
    window.addEventListener('keydown', onRecordingKeydown, true)
  } else {
    window.removeEventListener('keydown', onRecordingKeydown, true)
  }
}

// Cancel recording when settings drawer closes
watch(showSettings, (open) => {
  if (!open) recordingAction.value = null
})

watch(recordingAction, watchRecording)

// Tasks drawer width (drag-to-resize, persisted). Clamp keeps it usable: the
// task list is a fixed 320px, so a too-narrow drawer leaves no log space.
const DEFAULT_TASKS_DRAWER_WIDTH = 860
const MIN_TASKS_DRAWER_WIDTH = 480
const MAX_TASKS_DRAWER_WIDTH = 2000
const tasksDrawerWidth = ref(DEFAULT_TASKS_DRAWER_WIDTH)

const clampDrawerWidth = (w: number): number =>
  Math.round(Math.max(MIN_TASKS_DRAWER_WIDTH, Math.min(MAX_TASKS_DRAWER_WIDTH, w)))

const onTasksDrawerWidthChange = (w: number): void => {
  const clamped = clampDrawerWidth(w)
  if (tasksDrawerWidth.value === clamped) return
  tasksDrawerWidth.value = clamped
  window.api.settingsSet({ tasksDrawerWidth: clamped })
}

// Theme is a singleton composable: it owns the html[data-theme] / .dark swap
// and keeps Electron's nativeTheme in sync. The select binds to `themePref`.
const { preference: themePref, setPreference: setThemePref, init: initTheme } = useTheme()
const onThemeChange = (v: ThemePref): void => {
  setThemePref(v)
}
// cwd handed to the tasks drawer's "new task" form — the active pane's dir.
const activeCwd = computed(() => {
  const id = activeId.value
  return (id && paneCwd.value[id]) || cwd.value || ''
})

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
 * Insert `newNode` next to the pane `targetId`, choosing the split direction
 * and which side the new node lands on. `newFirst` puts it before the target
 * (left / top); otherwise after (right / bottom). Used by worktree placement
 * and pane drag-and-drop.
 */
const insertAdjacent = (
  node: LayoutNode,
  targetId: string,
  newNode: LayoutNode,
  direction: 'row' | 'column',
  newFirst: boolean
): LayoutNode => {
  if (node.type === 'pane') {
    if (node.id !== targetId) return node
    return {
      type: 'split',
      direction,
      ratio: 0.5,
      a: newFirst ? newNode : node,
      b: newFirst ? node : newNode
    }
  }
  const a = insertAdjacent(node.a, targetId, newNode, direction, newFirst)
  const b = insertAdjacent(node.b, targetId, newNode, direction, newFirst)
  if (a === node.a && b === node.b) return node
  return { ...node, a, b }
}

const PLACEMENT_MAP: Record<
  'top' | 'bottom' | 'left' | 'right',
  { direction: 'row' | 'column'; newFirst: boolean }
> = {
  right: { direction: 'row', newFirst: false },
  left: { direction: 'row', newFirst: true },
  bottom: { direction: 'column', newFirst: false },
  top: { direction: 'column', newFirst: true }
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
const deserializeLayout = (saved: SavedLayout, paneCwdAcc: Record<string, string>): LayoutNode => {
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

const onCreateWorktree = (
  paneId: string,
  worktreePath: string,
  placement: 'top' | 'bottom' | 'left' | 'right' = 'right'
): void => {
  if (!layout.value) return
  const newId = newPaneId()
  const { direction, newFirst } = PLACEMENT_MAP[placement] ?? PLACEMENT_MAP.right
  layout.value = insertAdjacent(
    layout.value,
    paneId,
    { type: 'pane', id: newId },
    direction,
    newFirst
  )
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

// A terminal pane (or the settings drawer) changed font size. Update the
// shared ref so every other terminal picks it up via prop, and persist.
const onFontSizeChange = (size: number): void => {
  const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size))
  if (appFontSize.value === clamped) return
  appFontSize.value = clamped
  window.api.settingsSet({ fontSize: clamped })
}

const decreaseFontSize = (): void => onFontSizeChange(appFontSize.value - 1)
const increaseFontSize = (): void => onFontSizeChange(appFontSize.value + 1)
const resetFontSize = (): void => onFontSizeChange(DEFAULT_FONT_SIZE)

const onScrollbackChange = (size: number | undefined): void => {
  const n = typeof size === 'number' && !Number.isNaN(size) ? size : DEFAULT_SCROLLBACK
  const clamped = Math.max(MIN_SCROLLBACK, Math.min(MAX_SCROLLBACK, Math.round(n)))
  if (appScrollback.value === clamped) return
  appScrollback.value = clamped
  window.api.settingsSet({ scrollback: clamped })
}

const onToggleAutoOpenTasks = (val: boolean): void => {
  autoOpenTasksOnRun.value = val
  window.api.settingsSet({ autoOpenTasksOnRun: val })
}

const openTasksDrawer = (): void => {
  taskSelectId.value = null
  showTasks.value = true
}

const openTaskManager = (
  focusId: string | null = null,
  scopeCwd: string | null = null,
  newDraft = false
): void => {
  taskMgrFocusId.value = focusId
  taskMgrScopeCwd.value = scopeCwd
  taskMgrNewDraft.value = newDraft
  showTaskMgr.value = true
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

// --- Pane drag-and-drop reorder -------------------------------------------
// Grab a pane by its top strip and drop it onto another pane's edge to
// re-split the layout. Pane IDs are preserved across the tree rewrite, so the
// xterm DOM (keyed by id) survives — the moved terminal keeps its session.
type DropZone = 'left' | 'right' | 'top' | 'bottom'
const paneDrag = ref<{ id: string } | null>(null)
const dropTarget = ref<{ id: string; zone: DropZone } | null>(null)

const onPaneDragStart = (paneId: string): void => {
  paneDrag.value = { id: paneId }
  dropTarget.value = null
}

// Split the target pane into 4 triangular zones along its diagonals; the
// dropped pane lands on whichever side the cursor is nearest.
const zoneForPoint = (rect: Rect, mx: number, my: number): DropZone => {
  const fx = (mx - rect.left) / rect.width - 0.5
  const fy = (my - rect.top) / rect.height - 0.5
  if (Math.abs(fx) >= Math.abs(fy)) return fx < 0 ? 'left' : 'right'
  return fy < 0 ? 'top' : 'bottom'
}

const onPaneDragMove = (e: MouseEvent): void => {
  if (!paneDrag.value || !containerRef.value) return
  const root = containerRef.value.getBoundingClientRect()
  const mx = e.clientX - root.left
  const my = e.clientY - root.top
  const hit = layoutResult.value.panes.find(
    (p) =>
      mx >= p.rect.left &&
      mx <= p.rect.left + p.rect.width &&
      my >= p.rect.top &&
      my <= p.rect.top + p.rect.height
  )
  if (!hit || hit.id === paneDrag.value.id) {
    dropTarget.value = null
    return
  }
  dropTarget.value = { id: hit.id, zone: zoneForPoint(hit.rect, mx, my) }
}

const ZONE_MAP: Record<DropZone, { direction: 'row' | 'column'; newFirst: boolean }> = {
  left: { direction: 'row', newFirst: true },
  right: { direction: 'row', newFirst: false },
  top: { direction: 'column', newFirst: true },
  bottom: { direction: 'column', newFirst: false }
}

const onPaneDragUp = (): void => {
  const drag = paneDrag.value
  const target = dropTarget.value
  paneDrag.value = null
  dropTarget.value = null
  if (!drag || !target || !layout.value || drag.id === target.id) return
  const removed = removePane(layout.value, drag.id)
  if (!removed) return
  const { direction, newFirst } = ZONE_MAP[target.zone]
  const next = insertAdjacent(
    removed,
    target.id,
    { type: 'pane', id: drag.id },
    direction,
    newFirst
  )
  // insertAdjacent returns the same ref when targetId wasn't found — bail
  // instead of committing a tree that lost the dragged pane.
  if (next === removed) return
  layout.value = next
  activeId.value = drag.id
}

const onPaneDragKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && paneDrag.value) {
    paneDrag.value = null
    dropTarget.value = null
  }
}

const draggedRect = computed(() => (paneDrag.value ? findPaneRect(paneDrag.value.id) : null))
const dropIndicatorRect = computed<Rect | null>(() => {
  const t = dropTarget.value
  if (!t) return null
  const r = findPaneRect(t.id)
  if (!r) return null
  if (t.zone === 'left') return { left: r.left, top: r.top, width: r.width / 2, height: r.height }
  if (t.zone === 'right')
    return { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height }
  if (t.zone === 'top') return { left: r.left, top: r.top, width: r.width, height: r.height / 2 }
  return { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 }
})

const rectStyle = (rect: Rect): Record<string, string> => ({
  left: rect.left + 'px',
  top: rect.top + 'px',
  width: rect.width + 'px',
  height: rect.height + 'px'
})

let resizeObserver: ResizeObserver | null = null
let unsubscribeWinState: (() => void) | null = null
let unsubscribeTaskStatus: (() => void) | null = null

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
  // Resolve + apply the saved theme ASAP (async; doesn't block the rest).
  initTheme()
  cwd.value = await window.api.getCwd()
  isMaximized.value = await window.api.winIsMaximized()
  appVersion.value = await window.api.getAppVersion()
  unsubscribeWinState = window.api.onWindowStateChanged((maximized) => {
    isMaximized.value = maximized
  })

  // electronAPI exposes process.versions on the renderer side via preload.
  const versions = (
    window.electron as unknown as { process?: { versions?: Record<string, string> } }
  ).process?.versions
  if (versions?.electron) electronVersion.value = versions.electron

  // Restore previously saved layout if there is one. Each pane gets a fresh
  // id; its saved cwd is seeded into paneCwd so the PTY spawns there.
  // shell.ts validates the dir and falls back to ~ if it's been deleted.
  const settings = await window.api.settingsGet()
  if (typeof settings.fontSize === 'number') {
    appFontSize.value = settings.fontSize
  }
  if (typeof settings.scrollback === 'number') {
    appScrollback.value = settings.scrollback
  }
  if (typeof settings.autoOpenTasksOnRun === 'boolean') {
    autoOpenTasksOnRun.value = settings.autoOpenTasksOnRun
  }
  if (typeof settings.tasksDrawerWidth === 'number') {
    tasksDrawerWidth.value = clampDrawerWidth(settings.tasksDrawerWidth)
  }
  if (settings.shortcutOverrides && typeof settings.shortcutOverrides === 'object') {
    shortcutOverrides.value = settings.shortcutOverrides as Record<string, string>
  }
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

  // Auto-open the tasks drawer when a task starts running (if enabled).
  // App owns this (not the toolbar) so it works regardless of which pane
  // started the task and stays decoupled from the toolbar's event plumbing.
  unsubscribeTaskStatus = window.api.onTaskStatus((meta) => {
    if (meta.status === 'running' && autoOpenTasksOnRun.value) {
      taskSelectId.value = meta.id
      showTasks.value = true
    }
  })

  // Save synchronously on window close so the last edit isn't lost. The
  // electron-side debounce in settings.ts gets flushed by app's before-quit.
  window.addEventListener('beforeunload', flushSaveOnUnload)

  window.addEventListener('mousemove', onDividerMove)
  window.addEventListener('mouseup', onDividerUp)
  window.addEventListener('mousemove', onPaneDragMove)
  window.addEventListener('mouseup', onPaneDragUp)
  window.addEventListener('keydown', onPaneDragKey)

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
  unsubscribeTaskStatus?.()
  resizeObserver?.disconnect()
  window.removeEventListener('mousemove', onDividerMove)
  window.removeEventListener('mouseup', onDividerUp)
  window.removeEventListener('mousemove', onPaneDragMove)
  window.removeEventListener('mouseup', onPaneDragUp)
  window.removeEventListener('keydown', onPaneDragKey)
  window.removeEventListener('keydown', onRecordingKeydown, true)
  window.removeEventListener('beforeunload', flushSaveOnUnload)
})
</script>

<template>
  <div class="title-bar" :class="{ mac: isMac }">
    <span class="title-bar-text">Gittim</span>
    <div class="title-bar-right">
      <button class="tb-btn tb-settings" title="设置" @click="showSettings = true">
        <SettingsIcon :size="14" />
      </button>
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
            <rect
              x="0"
              y="3"
              width="8"
              height="7"
              fill="var(--el-bg-color)"
              stroke="currentColor"
            />
          </svg>
        </button>
        <button class="tb-btn tb-close" title="关闭" @click="winClose">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
      </div>
    </div>
  </div>
  <el-drawer
    v-model="showSettings"
    direction="rtl"
    size="560px"
    :with-header="false"
    class="settings-drawer"
  >
    <div class="settings-layout">
      <aside class="settings-sidebar">
        <div class="settings-sidebar-title">设置</div>
        <nav class="settings-nav">
          <button
            class="settings-nav-item"
            :class="{ active: settingsTab === 'general' }"
            @click="settingsTab = 'general'"
          >
            <Layout :size="14" class="settings-nav-icon" />
            <span>通用</span>
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: settingsTab === 'shortcuts' }"
            @click="settingsTab = 'shortcuts'"
          >
            <Keyboard :size="14" class="settings-nav-icon" />
            <span>快捷键</span>
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: settingsTab === 'about' }"
            @click="settingsTab = 'about'"
          >
            <Info :size="14" class="settings-nav-icon" />
            <span>关于</span>
          </button>
        </nav>
      </aside>

      <div class="settings-panel">
        <template v-if="settingsTab === 'general'">
          <section class="settings-section">
            <header class="settings-section-header">
              <Type :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">外观</h3>
            </header>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">字号</label>
                <div class="font-size-control">
                  <button
                    class="fs-btn"
                    :disabled="appFontSize <= MIN_FONT_SIZE"
                    @click="decreaseFontSize"
                  >
                    −
                  </button>
                  <span class="fs-value">{{ appFontSize }}</span>
                  <button
                    class="fs-btn"
                    :disabled="appFontSize >= MAX_FONT_SIZE"
                    @click="increaseFontSize"
                  >
                    +
                  </button>
                  <button
                    v-if="appFontSize !== DEFAULT_FONT_SIZE"
                    class="fs-reset"
                    title="重置为默认"
                    @click="resetFontSize"
                  >
                    <RotateCcw :size="12" />
                  </button>
                </div>
              </div>
              <p class="settings-item-desc">
                终端字体大小，{{ MIN_FONT_SIZE }}–{{ MAX_FONT_SIZE }}。也可以用 Ctrl+= / Ctrl+-
                调整。
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">回滚行数</label>
                <el-input-number
                  :model-value="appScrollback"
                  :min="MIN_SCROLLBACK"
                  :max="MAX_SCROLLBACK"
                  :step="1000"
                  size="small"
                  controls-position="right"
                  @change="(v: number | undefined) => onScrollbackChange(v)"
                />
              </div>
              <p class="settings-item-desc">
                终端保留的历史输出行数（{{ MIN_SCROLLBACK }}–{{
                  MAX_SCROLLBACK
                }}）。调大可向上翻看更多构建/日志输出，过大略增内存占用。
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">主题</label>
                <el-select
                  :model-value="themePref"
                  size="small"
                  style="width: 140px"
                  @update:model-value="(v: ThemePref) => onThemeChange(v)"
                >
                  <el-option label="跟随系统" value="system" />
                  <el-option label="黑色" value="dark" />
                  <el-option label="白色" value="light" />
                </el-select>
              </div>
              <p class="settings-item-desc">
                选择界面主题。“跟随系统”会随操作系统的浅色 / 深色外观自动切换。
              </p>
            </div>
          </section>

          <section class="settings-section">
            <header class="settings-section-header">
              <Layout :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">会话</h3>
            </header>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">运行任务时自动打开任务面板</label>
                <el-switch
                  :model-value="autoOpenTasksOnRun"
                  size="small"
                  @update:model-value="(v: string | number | boolean) => onToggleAutoOpenTasks(!!v)"
                />
              </div>
              <p class="settings-item-desc">
                关闭后，后台任务启动时不会自动弹出任务抽屉，需手动点工具栏的查看按钮。
              </p>
            </div>
          </section>
        </template>

        <template v-if="settingsTab === 'shortcuts'">
          <section class="settings-section">
            <header class="settings-section-header">
              <Keyboard :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">快捷键</h3>
            </header>
            <p class="settings-item-desc" style="margin-top: -8px">
              点击快捷键进入录制模式，按下组合键即可更改。录制时按 Esc 取消。
            </p>
            <div class="shortcut-list">
              <div v-for="def in SHORTCUT_DEFS" :key="def.action" class="shortcut-row">
                <span class="shortcut-label">{{ def.label }}</span>
                <div class="shortcut-keys">
                  <template v-if="recordingAction === def.action">
                    <span class="shortcut-recording">按下组合键...</span>
                  </template>
                  <template v-else>
                    <span
                      class="shortcut-kbd"
                      :class="{
                        modified: effectiveShortcuts[def.action] !== def.defaultKeys
                      }"
                      @click="startRecording(def.action)"
                    >
                      <span
                        v-for="(part, i) in effectiveShortcuts[def.action].split('+')"
                        :key="i"
                        class="shortcut-key-chip"
                      >
                        {{ part }}
                      </span>
                    </span>
                  </template>
                  <button
                    v-if="effectiveShortcuts[def.action] !== def.defaultKeys"
                    class="shortcut-reset"
                    title="恢复默认"
                    @click="resetShortcut(def.action)"
                  >
                    <RotateCcw :size="12" />
                  </button>
                </div>
              </div>
            </div>
          </section>
        </template>

        <template v-else>
          <section class="settings-section">
            <header class="settings-section-header">
              <Info :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">关于</h3>
            </header>
            <div class="about-block">
              <div class="about-logo">Gittim</div>
              <div class="about-tagline">Git + tmux 风格的终端模拟器</div>
            </div>
            <dl class="about-list">
              <div class="about-row">
                <dt>版本</dt>
                <dd>{{ appVersion ? `v${appVersion}` : '—' }}</dd>
              </div>
              <div class="about-row">
                <dt>Electron</dt>
                <dd>{{ electronVersion || '—' }}</dd>
              </div>
              <div class="about-row">
                <dt>配置文件</dt>
                <dd class="mono">~/.Gittim/settings.json</dd>
              </div>
            </dl>
          </section>
        </template>
      </div>
    </div>
  </el-drawer>
  <TasksDrawer
    v-model="showTasks"
    :select-task-id="taskSelectId"
    :width="tasksDrawerWidth"
    @width-change="onTasksDrawerWidthChange"
    @manage-tasks="(cwd?: string) => openTaskManager(null, cwd ?? null)"
    @edit-task="(id: string, cwd?: string) => openTaskManager(id, cwd ?? null)"
  />
  <TaskManagerDialog
    v-model="showTaskMgr"
    :focus-id="taskMgrFocusId"
    :default-cwd="activeCwd"
    :scope-cwd="taskMgrScopeCwd"
    :new-draft="taskMgrNewDraft"
  />
  <div
    ref="containerRef"
    class="layout-root"
    :class="{ dragging: !!dragState, 'pane-dragging': !!paneDrag }"
  >
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
          :font-size="appFontSize"
          :scrollback="appScrollback"
          :shortcuts="shortcutOverrides"
          @focus="setActive"
          @split="onSplit"
          @close="onClose"
          @pane-drag-start="onPaneDragStart"
          @create-worktree="onCreateWorktree"
          @cwd-change="onCwdChange"
          @font-size-change="onFontSizeChange"
          @open-settings="showSettings = true"
          @open-tasks="openTasksDrawer"
          @manage-tasks="(cwd?: string, nd?: boolean) => openTaskManager(null, cwd ?? null, !!nd)"
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
      <template v-if="paneDrag">
        <div v-if="draggedRect" class="pane-drag-source" :style="rectStyle(draggedRect)"></div>
        <div
          v-if="dropIndicatorRect"
          class="pane-drop-indicator"
          :style="rectStyle(dropIndicatorRect)"
        ></div>
      </template>
    </template>
  </div>
</template>

<style lang="scss">
.title-bar {
  height: 32px;
  background: var(--el-bg-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  -webkit-app-region: drag;
  user-select: none;
}

/* macOS hiddenInset places the traffic-light buttons in the top-left.
   Pad the bar so the title text clears them; keep space-between (inherited
   from .title-bar) so the settings button still pins to the far right. */
.title-bar.mac {
  padding-left: 78px;
}

.title-bar-text {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-family: $font-ui;
}

.title-bar-right {
  display: flex;
  align-items: center;
  gap: 2px;
  -webkit-app-region: no-drag;
}

.title-bar-controls {
  display: flex;
  margin-left: 4px;
  padding-left: 4px;
  border-left: 1px solid var(--el-border-color);
}

.tb-settings {
  color: var(--el-text-color-secondary);
}

.tb-settings:hover {
  color: var(--el-text-color-primary);
}

.tb-btn {
  width: 34px;
  height: 24px;
  border: none;
  background: none;
  color: var(--el-text-color-regular);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.tb-btn:hover {
  background: var(--el-fill-color);
}

.tb-close:hover {
  background: var(--el-color-danger);
  color: #fff;
}

.layout-root {
  position: relative;
  width: 100vw;
  height: calc(100vh - #{$titlebar-h});
  background: var(--el-bg-color);
}

.layout-root.dragging {
  user-select: none;
  cursor: inherit;
}

.layout-root.pane-dragging,
.layout-root.pane-dragging * {
  cursor: grabbing !important;
  user-select: none;
}

.pane-drag-source {
  position: absolute;
  z-index: 2;
  background: var(--el-bg-color);
  opacity: 0.45;
  pointer-events: none;
}

.pane-drop-indicator {
  position: absolute;
  z-index: 3;
  background: color-mix(in srgb, var(--el-color-primary) 28%, transparent);
  border: 2px solid var(--el-color-primary);
  border-radius: 4px;
  pointer-events: none;
  transition:
    left 0.08s,
    top 0.08s,
    width 0.08s,
    height 0.08s;
}

.pane-slot {
  position: absolute;
  overflow: hidden;
  box-sizing: border-box;
  border: 1px solid transparent;
  transition: border-color 0.08s;
}

.pane-slot.active {
  border-color: var(--el-color-primary);
}

.divider {
  position: absolute;
  background: var(--el-border-color);
  z-index: 1;
}

.divider.row {
  cursor: col-resize;
}

.divider.column {
  cursor: row-resize;
}

/* --- Settings drawer ----------------------------------------------------- */

.settings-drawer .el-drawer__body {
  padding: 0;
  background: var(--el-bg-color);
}

.settings-drawer.el-drawer {
  background: var(--el-bg-color);
}

.settings-layout {
  display: flex;
  height: 100%;
  font-family: $font-ui;
}

.settings-sidebar {
  width: 168px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color-overlay);
  border-right: 1px solid var(--el-border-color);
  padding: 14px 0 14px 0;
}

.settings-sidebar-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
  padding: 0 18px 12px 18px;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 6px;
}

.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: none;
  color: var(--el-text-color-regular);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
}

.settings-nav-item:hover {
  background: var(--el-fill-color);
}

.settings-nav-item.active {
  background: var(--el-color-primary);
  color: #fff;
}

.settings-nav-icon {
  flex-shrink: 0;
  opacity: 0.85;
}

.settings-panel {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.settings-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--el-border-color);
}

.settings-section-icon {
  color: var(--el-text-color-secondary);
}

.settings-section-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
}

.settings-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.settings-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 28px;
}

.settings-item-label {
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.settings-item-desc {
  margin: 0;
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  line-height: 1.55;
}

/* Font-size segmented control */
.font-size-control {
  display: flex;
  align-items: center;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  padding: 2px;
  gap: 2px;
}

.fs-btn {
  width: 24px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--el-text-color-primary);
  font-size: 14px;
  cursor: pointer;
  border-radius: 3px;
  padding: 0;
}

.fs-btn:hover:not(:disabled) {
  background: var(--el-fill-color);
}

.fs-btn:disabled {
  color: var(--el-text-color-disabled);
  cursor: not-allowed;
}

.fs-value {
  min-width: 28px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.fs-reset {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  border-radius: 3px;
  padding: 0;
  margin-left: 4px;
}

.fs-reset:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}

/* About tab */
.about-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 8px;
}

.about-logo {
  font-size: 22px;
  color: var(--el-text-color-primary);
  font-weight: 600;
  letter-spacing: 1px;
}

.about-tagline {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.about-list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.about-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 12px;
  margin: 0;
}

.about-row dt {
  color: var(--el-text-color-primary);
  font-weight: normal;
}

.about-row dd {
  margin: 0;
  color: var(--el-text-color-secondary);
}

.about-row .mono {
  font-family: $font-mono;
  font-size: 11px;
}

/* Shortcut list */
.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  min-height: 32px;
}

.shortcut-row + .shortcut-row {
  border-top: 1px solid var(--el-border-color-light);
}

.shortcut-label {
  font-size: 13px;
  color: var(--el-text-color-primary);
  flex-shrink: 0;
}

.shortcut-keys {
  display: flex;
  align-items: center;
  gap: 6px;
}

.shortcut-kbd {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  padding: 2px 3px;
  border-radius: 4px;
  border: 1px solid transparent;
  transition:
    border-color 0.12s,
    background 0.12s;
}

.shortcut-kbd:hover {
  border-color: var(--el-border-color);
  background: var(--el-fill-color);
}

.shortcut-kbd.modified .shortcut-key-chip {
  border-color: var(--el-color-primary);
}

.shortcut-key-chip {
  display: inline-block;
  font-size: 11px;
  font-family: $font-mono;
  background: var(--el-fill-color);
  border: 1px solid var(--el-border-color);
  border-radius: 3px;
  padding: 1px 6px;
  color: var(--el-text-color-primary);
}

.shortcut-recording {
  font-size: 12px;
  color: var(--el-color-primary);
  animation: shortcut-pulse 1.2s ease-in-out infinite;
}

@keyframes shortcut-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.shortcut-reset {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}

.shortcut-reset:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}
</style>
