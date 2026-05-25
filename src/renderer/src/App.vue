<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { Settings as SettingsIcon, Type, Layout, Info, RotateCcw, Keyboard } from 'lucide-vue-next'
import TerminalView from './components/Terminal.vue'
import TasksDrawer from './components/TasksDrawer.vue'
import TaskManagerDialog from './components/TaskManagerDialog.vue'
import { useTheme, type ThemePref } from './composables/useTheme'
import { useLayout } from './composables/useLayout'
import { DEFAULT_SHORTCUTS, SHORTCUT_DEFS, eventToShortcut } from './shortcuts'

// App.vue 作为"屋顶":标题栏 + 设置抽屉 + 任务抽屉 / 管理对话框 + Layout 渲染。
// 布局算法、pane tree、divider 拖拽、pane 拖拽都搬到 useLayout —— App 这里只
// 负责"持久化时机"和"把 Terminal 事件接回 useLayout"。

const containerRef = ref<HTMLDivElement>()
const containerSize = ref({ width: 0, height: 0 })
const cwd = ref<string | null>(null)
const isMaximized = ref(false)
// 同步取 platform,首次 paint 就用对应的 title-bar layout —— 异步的
// getPlatform() 会让 mac 上短暂闪过 win 风格 traffic light。
const isMac = ref(
  ((window.electron as unknown as { process?: { platform?: string } }).process?.platform ?? '') ===
    'darwin'
)

const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
const appFontSize = ref(DEFAULT_FONT_SIZE)

const DEFAULT_SCROLLBACK = 10000
const MIN_SCROLLBACK = 1000
const MAX_SCROLLBACK = 200000
const appScrollback = ref(DEFAULT_SCROLLBACK)

const showSettings = ref(false)
const settingsTab = ref<'general' | 'shortcuts' | 'about'>('general')
const electronVersion = ref('')
const appVersion = ref('')

// Tasks drawer + manager dialog
const showTasks = ref(false)
const taskSelectId = ref<string | null>(null)
const showTaskMgr = ref(false)
const taskMgrFocusId = ref<string | null>(null)
// 任务管理对话框不再"作用域到单一文件夹",现在按 cwd 分组渲染全部任务。
// scopeCwd 仅作为"打开时滚到这个分组"的提示。
const taskMgrScopeCwd = ref<string | null>(null)
const taskMgrNewDraft = ref(false)
const autoOpenTasksOnRun = ref(true)

// 用户覆盖的快捷键(仅非默认值落盘)。下发给每个 Terminal,在 key handler 内
// 与 DEFAULT_SHORTCUTS 合并。
const shortcutOverrides = ref<Record<string, string>>({})
const recordingAction = ref<string | null>(null)
const effectiveShortcuts = computed(() => ({
  ...DEFAULT_SHORTCUTS,
  ...shortcutOverrides.value
}))

// 内部 binding 字符串统一用 'Ctrl' 表达"主修饰键",UI 显示按平台翻译。mac 上
// 用 ⌘⇧⌥ 更符合习惯且更省横向空间。
const displayShortcutParts = (combo: string): string[] => {
  const parts = combo.split('+')
  if (!isMac.value) return parts
  return parts.map((p) => {
    if (p === 'Ctrl') return '⌘'
    if (p === 'Shift') return '⇧'
    if (p === 'Alt') return '⌥'
    return p
  })
}

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

  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return

  // mac 上的 Cmd 在 eventToShortcut 里折叠成 'Ctrl',所以让 metaKey 也算修饰。
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return

  const shortcut = eventToShortcut(e)
  const targetAction = recordingAction.value
  recordingAction.value = null

  const conflict = SHORTCUT_DEFS.find(
    (d) => d.action !== targetAction && effectiveShortcuts.value[d.action] === shortcut
  )

  const next = { ...shortcutOverrides.value }
  if (conflict) {
    next[conflict.action] = effectiveShortcuts.value[targetAction]
  }
  if (shortcut === DEFAULT_SHORTCUTS[targetAction]) {
    delete next[targetAction]
  } else {
    next[targetAction] = shortcut
  }
  for (const a of Object.keys(next)) {
    if (next[a] === DEFAULT_SHORTCUTS[a]) delete next[a]
  }

  shortcutOverrides.value = next
  window.api.settingsSet({ shortcutOverrides: next })
}

const watchRecording = (): void => {
  if (recordingAction.value) {
    window.addEventListener('keydown', onRecordingKeydown, true)
  } else {
    window.removeEventListener('keydown', onRecordingKeydown, true)
  }
}

watch(showSettings, (open) => {
  if (!open) recordingAction.value = null
})

watch(recordingAction, watchRecording)

// Tasks drawer 宽度
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

// 主题
const { preference: themePref, setPreference: setThemePref, init: initTheme } = useTheme()
const onThemeChange = (v: ThemePref): void => {
  setThemePref(v)
}

// ----------- Layout(全部委托给 useLayout)-----------
// containerRef 在 App.vue 持有,模板 `ref="containerRef"` 把它绑到真正的 DOM;
// useLayout 接收同一个 ref —— pane 拖拽的鼠标坐标计算依赖它指向真实容器。
const {
  layout,
  activeId,
  paneCwd,
  layoutResult,
  dragState,
  paneDrag,
  draggedRect,
  dropIndicatorRect,
  onSplit,
  onClose,
  onCreateWorktree,
  setActive,
  onCwdChange,
  focusNeighbor,
  onDividerDown,
  onPaneDragStart,
  serializeLayout,
  restoreFromSaved
} = useLayout({
  containerSize,
  containerRef,
  defaultCwd: cwd
})

const activeCwd = computed(() => {
  const id = activeId.value
  return (id && paneCwd.value[id]) || cwd.value || ''
})

// ----------- 字号 / 滚动行数 -----------
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

// ----------- 标题栏 -----------
function winMinimize(): void {
  window.api.winMinimize()
}
function winMaximize(): void {
  window.api.winMaximize()
}
function winClose(): void {
  window.api.winClose()
}

const rectStyle = (rect: {
  left: number
  top: number
  width: number
  height: number
}): Record<string, string> => ({
  left: rect.left + 'px',
  top: rect.top + 'px',
  width: rect.width + 'px',
  height: rect.height + 'px'
})

// ----------- 持久化 -----------
let resizeObserver: ResizeObserver | null = null
let unsubscribeWinState: (() => void) | null = null
let unsubscribeTaskStatus: (() => void) | null = null

let saveTimer: ReturnType<typeof setTimeout> | null = null
const flushSave = (): void => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const saved = serializeLayout()
  if (saved) window.api.settingsSet({ paneLayout: saved })
}
const scheduleSave = (): void => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 500)
}
const flushSaveOnUnload = (): void => flushSave()

onMounted(async () => {
  initTheme()
  cwd.value = await window.api.getCwd()
  isMaximized.value = await window.api.winIsMaximized()
  appVersion.value = await window.api.getAppVersion()
  unsubscribeWinState = window.api.onWindowStateChanged((maximized) => {
    isMaximized.value = maximized
  })

  const versions = (
    window.electron as unknown as { process?: { versions?: Record<string, string> } }
  ).process?.versions
  if (versions?.electron) electronVersion.value = versions.electron

  const settings = await window.api.settingsGet()
  if (typeof settings.fontSize === 'number') appFontSize.value = settings.fontSize
  if (typeof settings.scrollback === 'number') appScrollback.value = settings.scrollback
  if (typeof settings.autoOpenTasksOnRun === 'boolean')
    autoOpenTasksOnRun.value = settings.autoOpenTasksOnRun
  if (typeof settings.tasksDrawerWidth === 'number')
    tasksDrawerWidth.value = clampDrawerWidth(settings.tasksDrawerWidth)
  if (settings.shortcutOverrides && typeof settings.shortcutOverrides === 'object') {
    shortcutOverrides.value = settings.shortcutOverrides as Record<string, string>
  }

  restoreFromSaved(settings.paneLayout)

  watch([layout, paneCwd], scheduleSave, { deep: true })

  unsubscribeTaskStatus = window.api.onTaskStatus((meta) => {
    if (meta.status === 'running' && autoOpenTasksOnRun.value) {
      taskSelectId.value = meta.id
      showTasks.value = true
    }
  })

  window.addEventListener('beforeunload', flushSaveOnUnload)

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
                终端字体大小,{{ MIN_FONT_SIZE }}–{{ MAX_FONT_SIZE }}。也可以用 Ctrl+= / Ctrl+-
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
                终端保留的历史输出行数({{ MIN_SCROLLBACK }}–{{
                  MAX_SCROLLBACK
                }})。调大可向上翻看更多构建/日志输出,过大略增内存占用。
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
                选择界面主题。"跟随系统"会随操作系统的浅色 / 深色外观自动切换。
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
                关闭后,后台任务启动时不会自动弹出任务抽屉,需手动点工具栏的查看按钮。
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
              点击快捷键进入录制模式,按下组合键即可更改。录制时按 Esc 取消。
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
                        v-for="(part, i) in displayShortcutParts(effectiveShortcuts[def.action])"
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
          :is-active="pane.id === activeId"
          @focus="setActive"
          @split="onSplit"
          @close="onClose"
          @pane-drag-start="onPaneDragStart"
          @focus-neighbor="focusNeighbor"
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
