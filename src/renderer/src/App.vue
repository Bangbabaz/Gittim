<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Settings as SettingsIcon, Type, Layout, Info, RotateCcw } from 'lucide-vue-next'
import TerminalView from './components/Terminal.vue'
import TasksDrawer from './components/TasksDrawer.vue'
import TaskManagerDialog from './components/TaskManagerDialog.vue'

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

const DEFAULT_FONT_SIZE = 14
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
// Global font size — single source of truth so the drawer and every open
// pane stay in sync. Loaded from settings on mount, persisted on change.
const appFontSize = ref(DEFAULT_FONT_SIZE)
const showSettings = ref(false)
const settingsTab = ref<'general' | 'about'>('general')
const electronVersion = ref('')

// Background tasks drawer + manager dialog
const showTasks = ref(false)
const taskSelectId = ref<string | null>(null)
const showTaskMgr = ref(false)
const taskMgrFocusId = ref<string | null>(null)
const autoOpenTasksOnRun = ref(true)
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

const onClearSavedLayout = async (): Promise<void> => {
  try {
    await ElMessageBox.confirm(
      '下次启动时将不再恢复已保存的面板和工作目录。当前打开的面板不受影响。',
      '清除保存的布局？',
      {
        confirmButtonText: '清除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    window.api.settingsSet({ paneLayout: null })
    ElMessage.success('已清除保存的布局')
  } catch {
    // user cancelled — nothing to do
  }
}

const onToggleAutoOpenTasks = (val: boolean): void => {
  autoOpenTasksOnRun.value = val
  window.api.settingsSet({ autoOpenTasksOnRun: val })
}

const openTasksDrawer = (): void => {
  taskSelectId.value = null
  showTasks.value = true
}

const openTaskManager = (focusId: string | null = null): void => {
  taskMgrFocusId.value = focusId
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
  cwd.value = await window.api.getCwd()
  isMac.value = (await window.api.getPlatform()) === 'darwin'
  isMaximized.value = await window.api.winIsMaximized()
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
  if (typeof settings.autoOpenTasksOnRun === 'boolean') {
    autoOpenTasksOnRun.value = settings.autoOpenTasksOnRun
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
                  >−</button>
                  <span class="fs-value">{{ appFontSize }}</span>
                  <button
                    class="fs-btn"
                    :disabled="appFontSize >= MAX_FONT_SIZE"
                    @click="increaseFontSize"
                  >+</button>
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
                终端字体大小，{{ MIN_FONT_SIZE }}–{{ MAX_FONT_SIZE }}。也可以用 Ctrl+= / Ctrl+- 调整。
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
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">已保存的窗口布局</label>
                <button class="danger-btn" @click="onClearSavedLayout">清除</button>
              </div>
              <p class="settings-item-desc">
                清除后下次启动不再恢复之前的面板和工作目录，从主目录单面板开始。
              </p>
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
                <dd>v1.0.0</dd>
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
    @manage-tasks="openTaskManager()"
    @edit-task="(id: string) => openTaskManager(id)"
  />
  <TaskManagerDialog
    v-model="showTaskMgr"
    :focus-id="taskMgrFocusId"
    :default-cwd="activeCwd"
  />
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
          :font-size="appFontSize"
          @focus="setActive"
          @split="onSplit"
          @close="onClose"
          @create-worktree="onCreateWorktree"
          @cwd-change="onCwdChange"
          @font-size-change="onFontSizeChange"
          @open-settings="showSettings = true"
          @open-tasks="openTasksDrawer"
          @manage-tasks="openTaskManager()"
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
  border-left: 1px solid #3e3e42;
}

.tb-settings {
  color: #9d9d9d;
}

.tb-settings:hover {
  color: #fff;
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

/* --- Settings drawer ----------------------------------------------------- */

.settings-drawer .el-drawer__body {
  padding: 0;
  background: #1b1b1f;
}

.settings-drawer.el-drawer {
  background: #1b1b1f;
}

.settings-layout {
  display: flex;
  height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.settings-sidebar {
  width: 168px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #252526;
  border-right: 1px solid #3e3e42;
  padding: 14px 0 14px 0;
}

.settings-sidebar-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #858585;
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
  color: #cccccc;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
}

.settings-nav-item:hover {
  background: #2d2d30;
}

.settings-nav-item.active {
  background: #094771;
  color: #ffffff;
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
  border-bottom: 1px solid #3e3e42;
}

.settings-section-icon {
  color: #858585;
}

.settings-section-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #858585;
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
  color: #d4d4d4;
}

.settings-item-desc {
  margin: 0;
  font-size: 11.5px;
  color: #858585;
  line-height: 1.55;
}

/* Font-size segmented control */
.font-size-control {
  display: flex;
  align-items: center;
  background: #1e1e1e;
  border: 1px solid #3e3e42;
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
  color: #d4d4d4;
  font-size: 14px;
  cursor: pointer;
  border-radius: 3px;
  padding: 0;
}

.fs-btn:hover:not(:disabled) {
  background: #3e3e42;
}

.fs-btn:disabled {
  color: #555;
  cursor: not-allowed;
}

.fs-value {
  min-width: 28px;
  text-align: center;
  font-size: 12px;
  color: #d4d4d4;
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
  color: #858585;
  cursor: pointer;
  border-radius: 3px;
  padding: 0;
  margin-left: 4px;
}

.fs-reset:hover {
  background: #3e3e42;
  color: #d4d4d4;
}

/* Destructive button (clear layout) */
.danger-btn {
  background: transparent;
  border: 1px solid #c42b1c66;
  color: #f14c4c;
  font-size: 12px;
  padding: 4px 14px;
  border-radius: 3px;
  cursor: pointer;
  line-height: 1.4;
  font-family: inherit;
}

.danger-btn:hover {
  background: #c42b1c22;
  border-color: #c42b1c;
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
  color: #d4d4d4;
  font-weight: 600;
  letter-spacing: 1px;
}

.about-tagline {
  color: #858585;
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
  color: #d4d4d4;
  font-weight: normal;
}

.about-row dd {
  margin: 0;
  color: #858585;
}

.about-row .mono {
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
  font-size: 11px;
}
</style>
