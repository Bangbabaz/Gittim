<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import {
  Settings as SettingsIcon,
  Type,
  Layout,
  Info,
  RotateCcw,
  Keyboard,
  Mic,
  Globe,
  Copy,
  Check,
  FolderOpen,
  ListChecks,
  Zap
} from 'lucide-vue-next'
import TerminalView from './components/Terminal.vue'
import TasksDrawer from './components/TasksDrawer.vue'
import TaskManagerDialog from './components/TaskManagerDialog.vue'
import QuickCommandMenu from './components/QuickCommandMenu.vue'
import QuickCommandsSettings from './components/QuickCommandsSettings.vue'
import { useTheme, type ThemePref } from './composables/useTheme'
import { useLayout } from './composables/useLayout'
import { DEFAULT_SHORTCUTS, SHORTCUT_DEFS, eventToShortcut } from './shortcuts'
import type { QuickCommand } from '@shared/types'

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
const settingsTab = ref<'general' | 'commands' | 'mcp' | 'shortcuts' | 'about'>('general')
const electronVersion = ref('')
const appVersion = ref('')
const quickCommands = ref<QuickCommand[]>([])

// Tasks drawer + manager dialog
const showTasks = ref(false)
const showTaskMgr = ref(false)
const taskMgrFocusId = ref<string | null>(null)
// 任务管理对话框不再"作用域到单一文件夹",现在按 cwd 分组渲染全部任务。
// scopeCwd 仅作为"打开时滚到这个分组"的提示。
const taskMgrScopeCwd = ref<string | null>(null)
const taskMgrNewDraft = ref(false)
const autoOpenTasksOnRun = ref(true)
const autoUpdate = ref(true)

// 用户覆盖的快捷键(仅非默认值落盘)。下发给每个 Terminal,在 key handler 内
// 与 DEFAULT_SHORTCUTS 合并。
const shortcutOverrides = ref<Record<string, string>>({})
const recordingAction = ref<string | null>(null)
const effectiveShortcuts = computed(() => ({
  ...DEFAULT_SHORTCUTS,
  ...shortcutOverrides.value
}))

// ---- 语音输入设置 ---------------------------------------------------------
const sttLanguage = ref('zh')
const sttDeviceId = ref('')
const voiceShortcut = ref('F2')
const audioInputDevices = ref<MediaDeviceInfo[]>([])
const recordingVoice = ref(false)
// 手动更新检查
const updateChecking = ref(false)
const updateResult = ref<string | null>(null)
const updateProgress = ref<number | null>(null)
// 后台自动下载完成后显示按钮
const updateReady = ref<string | null>(null)
let unsubscribeUpdateStatus: (() => void) | null = null

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

// ---- 语音输入设置 handlers ------------------------------------------------
const onSttLanguageChange = (v: string): void => {
  sttLanguage.value = v
  window.api.settingsSet({ sttLanguage: v })
}

const refreshAudioDevices = async (): Promise<void> => {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    audioInputDevices.value = all.filter((d) => d.kind === 'audioinput')
  } catch {
    audioInputDevices.value = []
  }
}

const onSttDeviceIdChange = (v: string): void => {
  // sentinel '__default__' 表示系统默认，落盘存空字符串方便 getUserMedia 判断。
  const id = v === '__default__' ? '' : v
  sttDeviceId.value = id
  window.api.settingsSet({ sttDeviceId: id })
}

const onVoiceShortcutChange = (v: string): void => {
  voiceShortcut.value = v
  window.api.settingsSet({ voiceShortcut: v })
}

const startVoiceRecording = (): void => {
  recordingVoice.value = true
}

const onVoiceRecordingKeydown = (e: KeyboardEvent): void => {
  if (!recordingVoice.value) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    recordingVoice.value = false
    return
  }
  // 语音快捷键允许无修饰键(F1-F12 等),与常规快捷键不同。
  const shortcut = eventToShortcut(e)
  recordingVoice.value = false
  onVoiceShortcutChange(shortcut)
}

const watchVoiceRecording = (): void => {
  if (recordingVoice.value) {
    window.addEventListener('keydown', onVoiceRecordingKeydown, true)
  } else {
    window.removeEventListener('keydown', onVoiceRecordingKeydown, true)
  }
}

watch(recordingVoice, watchVoiceRecording)

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
  if (open) {
    void refreshAudioDevices()
  } else {
    recordingAction.value = null
    recordingVoice.value = false
  }
})

watch(recordingAction, watchRecording)

// 浏览器自动化与 Agent 协作使用两个独立 MCP，避免无关工具进入同一个上下文。
const BROWSER_MCP_URL = 'http://127.0.0.1:9876/sse'
const AGENT_MCP_URL = 'http://127.0.0.1:9877/sse'
const MCP_CONFIGS = {
  browserClaude: `claude mcp add -s user -t sse gittim-browser ${BROWSER_MCP_URL}`,
  browserCodex: `codex mcp add gittim-browser --url ${BROWSER_MCP_URL}`,
  agentClaude: `claude mcp add -s user -t sse gittim-agent ${AGENT_MCP_URL}`,
  agentCodex: `codex mcp add gittim-agent --url ${AGENT_MCP_URL}`
} as const
type McpCopyTarget = keyof typeof MCP_CONFIGS
const mcpCopied = ref<McpCopyTarget | null>(null)

async function copyMcpConfig(which: McpCopyTarget): Promise<void> {
  const content = MCP_CONFIGS[which]
  try {
    await navigator.clipboard.writeText(content)
    mcpCopied.value = which
    setTimeout(() => {
      if (mcpCopied.value === which) mcpCopied.value = null
    }, 2000)
  } catch {
    // ignore
  }
}

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

type TerminalViewInstance = InstanceType<typeof TerminalView>
const terminalRefs = new Map<string, TerminalViewInstance>()

const setTerminalRef = (paneId: string, instance: unknown): void => {
  if (instance) terminalRefs.set(paneId, instance as TerminalViewInstance)
  else terminalRefs.delete(paneId)
}

const runQuickCommand = (command: QuickCommand, execute: boolean): void => {
  if (!command.command.trim()) return
  const id = activeId.value
  if (!id) return
  terminalRefs.get(id)?.runQuickCommand(command.command, execute)
}

const updateQuickCommands = (commands: QuickCommand[]): void => {
  quickCommands.value = commands
  void window.api.settingsSetNow({ quickCommands: commands })
}

const openQuickCommandSettings = (): void => {
  settingsTab.value = 'commands'
  showSettings.value = true
}

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

async function checkForUpdate(): Promise<void> {
  if (updateChecking.value || updateProgress.value !== null) return
  updateChecking.value = true
  updateResult.value = null
  try {
    await window.api.updateCheck()
  } catch (e: unknown) {
    updateResult.value = e instanceof Error ? e.message : String(e)
    updateChecking.value = false
  }
}

function installUpdate(): void {
  window.api.updateInstall()
}

const onToggleAutoOpenTasks = (val: boolean): void => {
  autoOpenTasksOnRun.value = val
  window.api.settingsSet({ autoOpenTasksOnRun: val })
}

const onToggleAutoUpdate = (val: boolean): void => {
  autoUpdate.value = val
  window.api.settingsSet({ autoUpdate: val })
}

const openTasksDrawer = (): void => {
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

async function onOpenDirectory(): Promise<void> {
  const dir = await window.api.selectDirectory()
  if (dir && activeId.value) {
    onSplit(activeId.value, 'row', dir)
  }
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
  if (typeof settings.autoUpdate === 'boolean') autoUpdate.value = settings.autoUpdate
  if (typeof settings.tasksDrawerWidth === 'number')
    tasksDrawerWidth.value = clampDrawerWidth(settings.tasksDrawerWidth)
  if (settings.shortcutOverrides && typeof settings.shortcutOverrides === 'object') {
    shortcutOverrides.value = settings.shortcutOverrides as Record<string, string>
  }
  if (typeof settings.sttLanguage === 'string') sttLanguage.value = settings.sttLanguage
  if (typeof settings.sttDeviceId === 'string') sttDeviceId.value = settings.sttDeviceId
  if (typeof settings.voiceShortcut === 'string') voiceShortcut.value = settings.voiceShortcut
  if (Array.isArray(settings.quickCommands)) {
    quickCommands.value = settings.quickCommands.filter(
      (item): item is QuickCommand =>
        !!item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.command === 'string'
    )
  }

  restoreFromSaved(settings.paneLayout)

  watch([layout, paneCwd], scheduleSave, { deep: true })

  unsubscribeTaskStatus = window.api.onTaskStatus((meta) => {
    // 任务开始运行时自动打开抽屉。selectedId 在启动前已被
    // TaskRunner/TasksDrawer 设置,这里只负责展示抽屉。
    if (meta.status === 'running' && autoOpenTasksOnRun.value) {
      showTasks.value = true
    }
  })

  // 自动检查和手动检查共用同一条持续状态流，下载进度同步显示在标题栏和关于页。
  unsubscribeUpdateStatus = window.api.onUpdateStatus((status) => {
    switch (status.state) {
      case 'checking':
        updateChecking.value = true
        updateResult.value = null
        break
      case 'available':
        updateChecking.value = false
        updateProgress.value = 0
        updateResult.value = `发现新版本 ${status.version}`
        break
      case 'downloading':
        updateChecking.value = false
        updateProgress.value = status.percent
        updateResult.value = null
        break
      case 'not-available':
        updateChecking.value = false
        updateProgress.value = null
        updateResult.value = '已是最新版本'
        break
      case 'downloaded':
        updateChecking.value = false
        updateProgress.value = null
        updateReady.value = status.version || null
        updateResult.value = `新版本 ${status.version} 已就绪，重启以安装`
        break
      case 'error':
        updateChecking.value = false
        updateProgress.value = null
        updateResult.value = status.message || '检查失败'
        break
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
  unsubscribeUpdateStatus?.()
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onRecordingKeydown, true)
  window.removeEventListener('keydown', onVoiceRecordingKeydown, true)
  window.removeEventListener('beforeunload', flushSaveOnUnload)
})
</script>

<template>
  <div class="title-bar" :class="{ mac: isMac }">
    <div class="title-bar-heading">
      <span class="title-bar-text">Gittim</span>
      <span v-if="updateProgress !== null" class="title-update-progress">
        下载中 {{ updateProgress }}%
      </span>
      <button
        v-else-if="updateReady"
        class="title-install-update"
        title="重启并安装新版本"
        @click="installUpdate"
      >
        安装新版本
      </button>
    </div>
    <div class="title-bar-right">
      <QuickCommandMenu
        :commands="quickCommands"
        :disabled="!activeId"
        @run="runQuickCommand"
        @manage="openQuickCommandSettings"
      />
      <button class="tb-btn" title="查看任务" @click="openTasksDrawer">
        <ListChecks :size="14" />
      </button>
      <button class="tb-btn tb-folder" title="打开目录为新面板" @click="onOpenDirectory">
        <FolderOpen :size="14" />
      </button>
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
            :class="{ active: settingsTab === 'commands' }"
            @click="settingsTab = 'commands'"
          >
            <Zap :size="14" class="settings-nav-icon" />
            <span>快捷指令</span>
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: settingsTab === 'mcp' }"
            @click="settingsTab = 'mcp'"
          >
            <Globe :size="14" class="settings-nav-icon" />
            <span>MCP</span>
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
                  popper-class="settings-select-popper"
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
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">自动更新</label>
                <el-switch
                  :model-value="autoUpdate"
                  size="small"
                  @update:model-value="(v: string | number | boolean) => onToggleAutoUpdate(!!v)"
                />
              </div>
              <p class="settings-item-desc">
                开启后启动时自动检查并下载新版本。关闭后不再检查更新，但可手动在"关于"页检测。
              </p>
            </div>
          </section>

          <section class="settings-section">
            <header class="settings-section-header">
              <Mic :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">语音输入</h3>
            </header>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">识别语言</label>
                <el-select
                  :model-value="sttLanguage"
                  size="small"
                  popper-class="settings-select-popper"
                  style="width: 140px"
                  @update:model-value="onSttLanguageChange"
                >
                  <el-option label="中文" value="zh" />
                  <el-option label="英文" value="en" />
                  <el-option label="自动检测" value="auto" />
                </el-select>
              </div>
              <p class="settings-item-desc">语音识别目标语言。"自动检测"让模型自动判断语种。</p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">麦克风</label>
                <el-select
                  :model-value="sttDeviceId || '__default__'"
                  size="small"
                  popper-class="settings-select-popper"
                  style="width: 180px"
                  @update:model-value="onSttDeviceIdChange"
                  @visible-change="(v: boolean) => v && refreshAudioDevices()"
                >
                  <el-option label="系统默认" value="__default__" />
                  <el-option
                    v-for="d in audioInputDevices"
                    :key="d.deviceId"
                    :label="d.label || `设备 ${d.deviceId.slice(0, 8)}`"
                    :value="d.deviceId"
                  />
                </el-select>
              </div>
              <p class="settings-item-desc">
                用于语音输入的录音设备,可在耳机、内置麦克风等之间切换。
              </p>
            </div>
          </section>
        </template>

        <QuickCommandsSettings
          v-else-if="settingsTab === 'commands'"
          :model-value="quickCommands"
          @update:model-value="updateQuickCommands"
        />

        <template v-else-if="settingsTab === 'mcp'">
          <section class="settings-section">
            <header class="settings-section-header">
              <Globe :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">MCP</h3>
            </header>
            <p class="settings-item-desc" style="margin-bottom: 10px">
              浏览器自动化和 Agent 协作已拆成两个独立服务，可按需注册。
            </p>
            <div class="settings-item-label" style="margin-bottom: 6px">浏览器 MCP · 9876</div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">Claude Code</label>
                <button
                  class="settings-copy-btn"
                  title="复制注册命令"
                  @click="copyMcpConfig('browserClaude')"
                >
                  <Check v-if="mcpCopied === 'browserClaude'" :size="12" />
                  <Copy v-else :size="12" />
                </button>
              </div>
              <p class="settings-item-desc">
                <code class="settings-cmd">{{ MCP_CONFIGS.browserClaude }}</code>
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">Codex</label>
                <button
                  class="settings-copy-btn"
                  title="复制注册命令"
                  @click="copyMcpConfig('browserCodex')"
                >
                  <Check v-if="mcpCopied === 'browserCodex'" :size="12" />
                  <Copy v-else :size="12" />
                </button>
              </div>
              <p class="settings-item-desc">
                <code class="settings-cmd">{{ MCP_CONFIGS.browserCodex }}</code>
              </p>
            </div>
            <div class="settings-item-label" style="margin: 12px 0 6px">Agent 协作 MCP · 9877</div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">Claude Code</label>
                <button
                  class="settings-copy-btn"
                  title="复制注册命令"
                  @click="copyMcpConfig('agentClaude')"
                >
                  <Check v-if="mcpCopied === 'agentClaude'" :size="12" />
                  <Copy v-else :size="12" />
                </button>
              </div>
              <p class="settings-item-desc">
                <code class="settings-cmd">{{ MCP_CONFIGS.agentClaude }}</code>
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">Codex</label>
                <button
                  class="settings-copy-btn"
                  title="复制注册命令"
                  @click="copyMcpConfig('agentCodex')"
                >
                  <Check v-if="mcpCopied === 'agentCodex'" :size="12" />
                  <Copy v-else :size="12" />
                </button>
              </div>
              <p class="settings-item-desc">
                <code class="settings-cmd">{{ MCP_CONFIGS.agentCodex }}</code>
              </p>
            </div>
            <p class="settings-item-desc">
              注册完成后，请重新启动或刷新 Agent，使其重新加载 MCP 工具列表。Agent 先从环境变量
              GITTIM_PANE_ID 读取当前面板 ID，并调用 agent_register({ name, paneId })
              注册名称；之后用 agent_list、agent_send 和 agent_reply 协作，消息会直接唤醒目标
              Agent。
            </p>
          </section>
        </template>

        <template v-else-if="settingsTab === 'shortcuts'">
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

            <header class="settings-section-header" style="margin-top: 20px">
              <Mic :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">语音输入</h3>
            </header>
            <p class="settings-item-desc" style="margin-top: -8px">
              按住该键说话,松开后自动识别并粘贴文本。建议设置为 F2-F12 等不与终端交互冲突的按键。
            </p>
            <div class="shortcut-list">
              <div class="shortcut-row">
                <span class="shortcut-label">按下说话</span>
                <div class="shortcut-keys">
                  <template v-if="recordingVoice">
                    <span class="shortcut-recording">按下按键...</span>
                  </template>
                  <template v-else>
                    <span
                      class="shortcut-kbd"
                      :class="{ modified: voiceShortcut !== 'F2' }"
                      @click="startVoiceRecording"
                    >
                      <span
                        v-for="(part, i) in displayShortcutParts(voiceShortcut)"
                        :key="i"
                        class="shortcut-key-chip"
                      >
                        {{ part }}
                      </span>
                    </span>
                    <button
                      v-if="voiceShortcut !== 'F2'"
                      class="shortcut-reset"
                      title="恢复默认"
                      @click="onVoiceShortcutChange('F2')"
                    >
                      <RotateCcw :size="12" />
                    </button>
                  </template>
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
                <dd class="mono">~/.gittim/settings.json</dd>
              </div>
            </dl>
            <div class="about-update">
              <button
                class="about-update-btn"
                :disabled="updateChecking || updateProgress !== null"
                @click="updateReady ? installUpdate() : checkForUpdate()"
              >
                {{ updateReady ? '安装新版本' : updateChecking ? '检查中…' : '检查更新' }}
              </button>
              <span v-if="updateProgress !== null" class="about-update-progress">
                下载中 {{ updateProgress }}%
              </span>
              <span v-if="updateResult" class="about-update-result">{{ updateResult }}</span>
            </div>
          </section>
        </template>
      </div>
    </div>
  </el-drawer>
  <TasksDrawer
    v-model="showTasks"
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
          :ref="(instance: unknown) => setTerminalRef(pane.id, instance)"
          :pane-id="pane.id"
          :cwd="paneCwd[pane.id] ?? cwd"
          :font-size="appFontSize"
          :scrollback="appScrollback"
          :shortcuts="shortcutOverrides"
          :stt-language="sttLanguage"
          :stt-device-id="sttDeviceId"
          :voice-shortcut="voiceShortcut"
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
  height: $titlebar-h;
  background: var(--el-bg-color-page);
  border-bottom: 1px solid var(--el-border-color-light);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  -webkit-app-region: drag;
  user-select: none;

  &.mac {
    padding-left: 78px;
  }
}

.title-bar-text {
  color: var(--el-text-color-primary);
  font-size: 12.5px;
  font-weight: 600;
  @include ui-font;
}

.title-bar-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title-update-progress,
.about-update-progress {
  color: var(--el-color-primary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  @include ui-font;
}

.title-install-update {
  @include btn-reset;
  height: 22px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--el-color-success) 55%, transparent);
  border-radius: $radius;
  background: color-mix(in srgb, var(--el-color-success) 10%, transparent);
  color: var(--el-color-success);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  -webkit-app-region: no-drag;
  @include ui-font;

  &:hover {
    background: color-mix(in srgb, var(--el-color-success) 18%, transparent);
  }
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

.tb-folder,
.tb-settings {
  color: var(--el-text-color-secondary);

  &:hover {
    color: var(--el-text-color-primary);
  }
}

.tb-btn {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 28px;
  color: var(--el-text-color-regular);
  border-radius: $radius;

  &:hover {
    background: var(--el-fill-color);
  }
}

.tb-close:hover {
  background: var(--el-color-danger);
  color: #fff;
}

.layout-root {
  position: relative;
  width: 100%;
  height: calc(100vh - #{$titlebar-h});
  background: var(--el-bg-color-page);

  &.dragging {
    user-select: none;
    cursor: inherit;
  }

  &.pane-dragging,
  &.pane-dragging * {
    cursor: grabbing !important;
    user-select: none;
  }
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
  border-radius: $radius;
  pointer-events: none;
  transition:
    left 0.08s,
    top 0.08s,
    width 0.08s,
    height 0.08s;
}

.pane-slot {
  position: absolute;
  overflow: clip;
  box-sizing: border-box;
  background: var(--el-bg-color);
  box-shadow: inset 0 0 0 1px transparent;
  transition: box-shadow 0.1s;

  &.active {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--el-color-primary) 58%, transparent);

    .pane-toolbar {
      background: color-mix(in srgb, var(--el-color-primary) 7%, var(--el-fill-color-light));
      box-shadow: inset 0 2px 0 var(--el-color-primary);
    }
  }
}

.divider {
  position: absolute;
  background: var(--el-bg-color-page);
  z-index: 1;
  transition: background-color 0.12s ease;

  &:hover {
    background: var(--el-color-primary);
  }

  .dragging & {
    background: var(--el-color-primary);
  }

  &.row {
    cursor: col-resize;
  }

  &.column {
    cursor: row-resize;
  }
}

/* --- Update check (关于页) ----------------------------------------------- */

.about-update {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}

.about-update-btn {
  @include btn-reset;
  padding: 4px 14px;
  font-size: 12px;
  border-radius: $radius;
  color: var(--el-color-primary);
  border: 1px solid var(--el-color-primary);
  background: transparent;
  cursor: pointer;
  transition: background 0.1s;

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--el-color-primary) 8%, transparent);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.about-update-result {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* --- Settings drawer ----------------------------------------------------- */

.settings-drawer {
  &.el-drawer {
    background: var(--el-bg-color);
  }

  .el-drawer__body {
    padding: 0;
    background: var(--el-bg-color);
  }
}

.settings-layout {
  display: flex;
  height: 100%;
  @include ui-font;
}

.settings-sidebar {
  width: 168px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color-overlay);
  border-right: 1px solid var(--el-border-color);
  padding: 14px 0;
}

.settings-sidebar-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
  padding: 0 18px 12px;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 6px;
}

.settings-nav-item {
  @include btn-reset;
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  width: 100%;
  padding: 6px 12px;
  color: var(--el-text-color-regular);
  font-size: 13px;
  border-radius: $radius;

  &:hover {
    background: var(--el-fill-color);
  }

  &.active {
    background: var(--el-color-primary);
    color: #fff;
  }
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

  /* 设置面板下拉框:统一小号字体、紧凑间距 */
  .el-select {
    --el-font-size-base: 12px;

    .el-input__inner {
      font-size: 12px;
      height: 26px;
      line-height: 26px;
    }
  }
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

.settings-copy-btn {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: $radius-sm;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;

  &:hover {
    background: var(--el-fill-color);
    color: var(--el-color-primary);
  }
}

.settings-cmd {
  @include mono-font;
  display: block;
  margin-top: 2px;
  padding: 6px 8px;
  background: var(--el-fill-color-lighter);
  border-radius: $radius-sm;
  font-size: 11px;
  color: var(--el-text-color-regular);
  word-break: break-all;
  line-height: 1.5;
  user-select: all;
}

/* 下拉选项 popper(el-select 默认 append-to-body,必须全局命中) */
.el-popper.settings-select-popper .el-select-dropdown__item {
  font-size: 12px;
  padding: 4px 12px;
  height: auto;
  line-height: 1.5;
}

.font-size-control {
  display: flex;
  align-items: center;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: $radius;
  padding: 2px;
  gap: 2px;
}

.fs-btn {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  color: var(--el-text-color-primary);
  font-size: 14px;
  border-radius: $radius-sm;

  &:hover:not(:disabled) {
    background: var(--el-fill-color);
  }

  &:disabled {
    color: var(--el-text-color-disabled);
    cursor: not-allowed;
  }
}

.fs-value {
  min-width: 28px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.fs-reset {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--el-text-color-secondary);
  border-radius: $radius-sm;
  margin-left: 4px;

  &:hover {
    background: var(--el-fill-color);
    color: var(--el-text-color-primary);
  }
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

  dt {
    color: var(--el-text-color-primary);
    font-weight: normal;
  }

  dd {
    margin: 0;
    color: var(--el-text-color-secondary);
  }

  .mono {
    @include mono-font;
    font-size: 11px;
  }
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

  & + & {
    border-top: 1px solid var(--el-border-color-light);
  }
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
  border-radius: $radius;
  border: 1px solid transparent;
  transition:
    border-color 0.12s,
    background 0.12s;

  &:hover {
    border-color: var(--el-border-color);
    background: var(--el-fill-color);
  }

  &.modified .shortcut-key-chip {
    border-color: var(--el-color-primary);
  }
}

.shortcut-key-chip {
  display: inline-block;
  font-size: 11px;
  @include mono-font;
  background: var(--el-fill-color);
  border: 1px solid var(--el-border-color);
  border-radius: $radius-sm;
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
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--el-text-color-secondary);
  border-radius: $radius-sm;
  flex-shrink: 0;

  &:hover {
    background: var(--el-fill-color);
    color: var(--el-text-color-primary);
  }
}
</style>
