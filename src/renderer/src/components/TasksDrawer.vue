<script setup lang="ts">
import { ref, shallowRef, watch, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { ElMessageBox } from 'element-plus'
import {
  Play,
  Square,
  RotateCw,
  Pencil,
  Trash2,
  Search,
  Settings2,
  X,
  FolderOpen,
  Terminal as TerminalIcon
} from 'lucide-vue-next'
import SearchOverlay from './SearchOverlay.vue'
import { useTheme } from '../composables/useTheme'
import '@xterm/xterm/css/xterm.css'

const { xtermTheme } = useTheme()

type TaskMeta = {
  id: string
  name: string
  command: string
  cwd: string
  status: 'idle' | 'running' | 'exited' | 'failed'
  exitCode: number | null
  startedAt: number | null
}

const props = defineProps<{
  modelValue: boolean
  selectTaskId: string | null
  width: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'editTask', id: string, cwd: string): void
  (e: 'manageTasks', cwd?: string): void
  (e: 'widthChange', width: number): void
}>()

// el-drawer (Element Plus 2.14) drag-to-resize: it emits the final px size on
// resize-end; App owns the value, clamps + persists it, and feeds it back via
// the `width` prop.
function onResizeEnd(_e: MouseEvent, size: number): void {
  emit('widthChange', size)
}

const tasks = ref<TaskMeta[]>([])
const selectedId = ref<string | null>(null)

const selectedTask = computed(() => tasks.value.find((t) => t.id === selectedId.value) || null)

const statusText: Record<TaskMeta['status'], string> = {
  idle: '未运行',
  running: '运行中',
  exited: '已退出',
  failed: '失败'
}

// --- Log viewer (one shared xterm, re-bound on selection) -----------------
const logRef = ref<HTMLDivElement>()
let term: Terminal | null = null
let fit: FitAddon | null = null
let logResizeObserver: ResizeObserver | null = null

// Log search overlay. The box, query, count and highlight logic live in the
// shared SearchOverlay; here we only own the visibility and the addon ref it
// drives (shallow — it's a class instance, no deep reactivity wanted).
const showLogSearch = ref(false)
const searchAddon = shallowRef<SearchAddon | null>(null)

// Push the viewer's grid size to the selected *running* task's PTY so
// full-screen TUIs (Next.js overlay, vite menu, prompts) render aligned.
function syncTaskSize(): void {
  if (!term) return
  const id = selectedId.value
  if (!id) return
  const t = tasks.value.find((x) => x.id === id)
  if (t && t.status === 'running' && term.cols > 0 && term.rows > 0) {
    window.api.taskResize(id, term.cols, term.rows)
  }
}

function focusTerm(): void {
  term?.focus()
}

function ensureTerm(): void {
  if (term || !logRef.value) return
  term = new Terminal({
    fontSize: 12,
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, Consolas, monospace",
    cursorBlink: false,
    convertEol: true,
    // Required for SearchAddon match decorations (the highlight background)
    // to render — same as the terminal panes.
    allowProposedApi: true,
    theme: xtermTheme.value
  })
  fit = new FitAddon()
  const sa = new SearchAddon()
  searchAddon.value = sa
  term.loadAddon(fit)
  term.loadAddon(sa)
  term.open(logRef.value)
  // Interactive: forward keystrokes/paste to whichever task is selected AND
  // running. The one terminal is reused across tasks, so resolve the target
  // at call time; idle/exited tasks are no-ops (backend guards too).
  term.onData((d) => {
    const id = selectedId.value
    if (!id) return
    const t = tasks.value.find((x) => x.id === id)
    if (t && t.status === 'running') window.api.taskInput(id, d)
  })
  logResizeObserver = new ResizeObserver(() => {
    try {
      fit?.fit()
    } catch {
      return // element hidden / detached
    }
    syncTaskSize()
  })
  logResizeObserver.observe(logRef.value)
}

async function bindLog(id: string | null): Promise<void> {
  ensureTerm()
  if (!term) return
  term.reset()
  if (!id) return
  const out = await window.api.taskOutput(id)
  if (selectedId.value !== id) return // selection changed while awaiting
  if (out) term.write(out)
  await nextTick()
  try {
    fit?.fit()
  } catch {
    // ignore
  }
  syncTaskSize()
}

function selectTask(id: string): void {
  selectedId.value = id
  bindLog(id)
}

// Fired after the drawer's open transition finishes (so the log element has
// real dimensions). Element Plus's focus trap auto-focuses a header button on
// every open and nothing else ever moves focus into the xterm, so on the
// 2nd+ open the terminal stayed unfocused and keystrokes never reached the
// task. Refit to the now-correct size and explicitly focus the terminal so it
// is interactive immediately, every open.
function onDrawerOpened(): void {
  ensureTerm()
  if (!term) return
  try {
    fit?.fit()
  } catch {
    // element not measurable yet — harmless
  }
  syncTaskSize()
  term.focus()
}

// --- Task data refresh ----------------------------------------------------
async function reload(): Promise<void> {
  tasks.value = await window.api.taskList()
  if (selectedId.value && !tasks.value.some((t) => t.id === selectedId.value)) {
    selectedId.value = null
  }
}

let unsubData: (() => void) | null = null
let unsubStatus: (() => void) | null = null
let unsubCleared: (() => void) | null = null
let unsubRemoved: (() => void) | null = null

function upsert(meta: TaskMeta): void {
  const i = tasks.value.findIndex((t) => t.id === meta.id)
  if (i >= 0) tasks.value[i] = meta
  else tasks.value.push(meta)
}

onMounted(async () => {
  tasks.value = await window.api.taskSubscribe()
  unsubData = window.api.onTaskData(({ id, chunk }) => {
    if (id === selectedId.value && term) term.write(chunk)
  })
  unsubStatus = window.api.onTaskStatus((meta) => {
    upsert(meta)
    // A task we're viewing just started — match its PTY to the viewer size.
    if (meta.id === selectedId.value && meta.status === 'running') syncTaskSize()
  })
  unsubCleared = window.api.onTaskCleared(({ id }) => {
    if (id === selectedId.value && term) term.reset()
  })
  unsubRemoved = window.api.onTaskRemoved(({ id }) => {
    tasks.value = tasks.value.filter((t) => t.id !== id)
    if (selectedId.value === id) {
      selectedId.value = null
      bindLog(null)
    }
  })
})

onUnmounted(() => {
  unsubData?.()
  unsubStatus?.()
  unsubCleared?.()
  unsubRemoved?.()
  logResizeObserver?.disconnect()
  term?.dispose()
})

// Drawer opened → init term, fit, refresh list, honor an external selection.
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    await reload()
    await nextTick()
    ensureTerm()
    if (props.selectTaskId) {
      selectTask(props.selectTaskId)
    } else if (selectedId.value) {
      bindLog(selectedId.value)
    }
    try {
      fit?.fit()
    } catch {
      // ignore
    }
    syncTaskSize()
  }
)

// App passes the id of a task it just auto-opened for.
watch(
  () => props.selectTaskId,
  (id) => {
    if (id && props.modelValue) selectTask(id)
  }
)

// Re-theme the shared log terminal when the app theme changes.
watch(xtermTheme, (t) => {
  if (term) term.options.theme = t
})

// Command CRUD lives in the manager dialog (App-owned). The drawer just
// surfaces entry points and per-row run/stop controls.
function editTask(t: TaskMeta): void {
  emit('editTask', t.id, t.cwd)
}

async function toggleTask(t: TaskMeta): Promise<void> {
  if (t.status === 'running') {
    await window.api.taskStop(t.id)
  } else {
    await window.api.taskStart({ id: t.id })
    selectTask(t.id)
  }
}

async function restartTask(t: TaskMeta): Promise<void> {
  await window.api.taskRestart(t.id)
  selectTask(t.id)
}

async function removeTask(t: TaskMeta): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除任务 "${t.name}"？运行中的进程会被结束。`, '删除任务', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  await window.api.taskRemove(t.id)
}

function clearLog(): void {
  term?.reset()
}

// --- Log search -----------------------------------------------------------
// SearchOverlay owns query/count/highlight; it clears its decorations on
// unmount, so close is just a visibility toggle.
function openLogSearch(): void {
  showLogSearch.value = true
}

function closeLogSearch(): void {
  showLogSearch.value = false
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    direction="rtl"
    :size="width"
    resizable
    :with-header="false"
    class="tasks-drawer"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @opened="onDrawerOpened"
    @resize-end="onResizeEnd"
  >
    <div class="tasks-shell">
      <!-- Top header bar — kept visually consistent with the app title bar
           (shared $titlebar-h + --bg-titlebar token). `no-drag` so the area
           that overlaps the OS title-bar strip stays clickable. -->
      <header class="tasks-header">
        <span class="tasks-header-title">任务</span>
        <div class="tasks-header-ops">
          <button class="hdr-btn" title="管理命令" @click="emit('manageTasks', selectedTask?.cwd)">
            <Settings2 :size="15" />
          </button>
          <button class="hdr-btn" title="关闭" @click="emit('update:modelValue', false)">
            <X :size="15" />
          </button>
        </div>
      </header>

      <div class="tasks-layout">
        <!-- Left: task list -->
        <aside class="tasks-side">
          <div class="task-list">
            <div v-if="!tasks.length" class="task-empty">
              还没有命令，点上方
              <Settings2 :size="12" style="vertical-align: -2px" />
              新建
            </div>
            <div
              v-for="t in tasks"
              :key="t.id"
              class="task-row"
              :class="{ active: t.id === selectedId }"
              @click="selectTask(t.id)"
            >
              <span class="status-dot" :class="t.status" :title="statusText[t.status]" />
              <div class="task-meta">
                <div class="task-name">{{ t.name }}</div>
                <div class="task-cmd">{{ t.command }}</div>
                <div class="task-cwd" :title="t.cwd || '未指定工作目录'">
                  <FolderOpen :size="11" class="task-cwd-icon" />
                  <span class="task-cwd-text">{{ t.cwd || '未指定工作目录' }}</span>
                </div>
              </div>
              <div class="task-ops" @click.stop>
                <button
                  class="op-btn"
                  :class="t.status === 'running' ? 'stop' : 'run'"
                  :title="t.status === 'running' ? '停止' : '运行'"
                  @click="toggleTask(t)"
                >
                  <Square v-if="t.status === 'running'" :size="13" />
                  <Play v-else :size="13" />
                </button>
                <button
                  v-if="t.status === 'running'"
                  class="op-btn run"
                  title="重新运行"
                  @click="restartTask(t)"
                >
                  <RotateCw :size="13" />
                </button>
                <button class="op-btn edit" title="编辑" @click="editTask(t)">
                  <Pencil :size="13" />
                </button>
                <button class="op-btn danger" title="删除" @click="removeTask(t)">
                  <Trash2 :size="13" />
                </button>
              </div>
            </div>
          </div>
        </aside>

        <!-- Right: log viewer -->
        <section class="tasks-log">
          <div class="log-head">
            <TerminalIcon :size="14" class="log-head-icon" />
            <span class="log-head-title">
              {{ selectedTask ? selectedTask.name : '选择任务查看日志' }}
            </span>
            <span v-if="selectedTask" class="log-head-status" :class="selectedTask.status">
              {{ statusText[selectedTask.status]
              }}{{
                selectedTask.status === 'failed' && selectedTask.exitCode !== null
                  ? ` (${selectedTask.exitCode})`
                  : ''
              }}
            </span>
            <span
              v-if="selectedTask"
              class="log-head-cwd"
              :title="selectedTask.cwd || '未指定工作目录'"
            >
              <FolderOpen :size="12" class="log-head-cwd-icon" />
              {{ selectedTask.cwd || '未指定工作目录' }}
            </span>
            <div class="log-head-ops">
              <button class="op-btn" title="搜索" @click="openLogSearch">
                <Search :size="13" />
              </button>
              <button class="op-btn" title="清空显示" @click="clearLog">清空</button>
            </div>
          </div>
          <div class="log-wrap">
            <div v-if="showLogSearch && searchAddon" class="log-search-pos">
              <SearchOverlay :search-addon="searchAddon" @close="closeLogSearch" />
            </div>
            <div ref="logRef" class="log-body" @click="focusTerm"></div>
          </div>
        </section>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped lang="scss">
.tasks-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  @include ui-font;
  /* The drawer overlaps the OS title-bar strip; without no-drag the buttons
     under that strip get hijacked by the window-drag region. */
  -webkit-app-region: no-drag;
}

/* Header bar — same height/background as the app title bar so the two read
   as one continuous chrome, and (like the title bar) draggable to move the
   window. The shell is no-drag; this re-enables drag just for the header. */
.tasks-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: $titlebar-h;
  flex-shrink: 0;
  padding: 0 6px 0 14px;
  background: var(--bg-titlebar);
  border-bottom: 1px solid var(--border);
  user-select: none;
  -webkit-app-region: drag;
}

.tasks-header-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-regular);
}

.tasks-header-ops {
  display: flex;
  gap: 2px;
}

.hdr-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 22px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: $radius;
  -webkit-app-region: no-drag;
}

.hdr-btn:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}

.tasks-layout {
  flex: 1;
  min-height: 0;
  display: flex;
}

.tasks-side {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border-right: 1px solid var(--border);
}

.task-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.task-empty {
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
  padding: 24px 0;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 5px;
  cursor: pointer;
}

.task-row:hover {
  background: var(--bg-hover);
}

.task-row.active {
  background: var(--bg-selected);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--dot-idle);
}

.status-dot.running {
  background: var(--success);
  box-shadow: 0 0 4px color-mix(in srgb, var(--success) 53%, transparent);
}

.status-dot.failed {
  background: var(--danger);
}

.status-dot.exited {
  background: var(--dot-idle);
}

.task-meta {
  flex: 1;
  min-width: 0;
}

.task-name {
  font-size: 12.5px;
  color: var(--text-primary);
  @include ellipsis;
}

.task-cmd {
  font-size: 11px;
  color: var(--text-muted);
  @include ellipsis;
  font-family: $font-mono;
}

.task-cwd {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  color: var(--text-faint);
}

.task-cwd-icon {
  flex-shrink: 0;
}

.task-cwd-text {
  font-size: 10.5px;
  @include ellipsis;
  font-family: $font-mono;
}

.task-ops {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.1s;
}

.task-row:hover .task-ops,
.task-row.active .task-ops {
  opacity: 1;
}

.op-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  background: transparent;
  border: none;
  color: var(--text-regular);
  cursor: pointer;
  border-radius: $radius-sm;
  font-size: 11px;
  font-family: inherit;
}

.op-btn:hover {
  background: color-mix(in srgb, var(--text-bright) 10%, transparent);
  color: var(--text-bright);
}

.op-btn.danger:hover {
  background: color-mix(in srgb, var(--danger-strong) 27%, transparent);
  color: var(--danger);
}

/* Per-row command buttons: unified white icons on semantic filled
   backgrounds (run=green, stop/delete=red, restart=amber, edit=neutral). */
/* Neutral default (the edit button): outlined like the worktree button so
   the icon stays readable in both themes (a filled neutral chip with the
   base white icon is invisible in the light theme). The semantic variants
   below stay filled with white icons on their saturated fills. */
.task-ops .op-btn {
  background: none;
  border: 1px solid var(--border-strong);
  color: var(--text-regular);
}

.task-ops .op-btn:hover {
  background: var(--bg-hover);
  border-color: var(--text-muted);
  color: var(--text-bright);
}

.task-ops .op-btn.run,
.task-ops .op-btn.run:hover,
.task-ops .op-btn.stop,
.task-ops .op-btn.danger,
.task-ops .op-btn.stop:hover,
.task-ops .op-btn.danger:hover {
  border: none;
  color: var(--text-on-accent);
}

.task-ops .op-btn.run {
  background: var(--success-solid);
}

.task-ops .op-btn.run:hover {
  background: var(--success-solid-hover);
}

.task-ops .op-btn.stop,
.task-ops .op-btn.danger {
  background: var(--danger-solid);
}

.task-ops .op-btn.stop:hover,
.task-ops .op-btn.danger:hover {
  background: var(--danger-solid-hover);
}

.tasks-log {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
}

.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.log-head-icon {
  color: var(--text-muted);
}

.log-head-title {
  font-size: 12.5px;
  color: var(--text-primary);
  flex-shrink: 0;
}

.log-head-status {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: $radius-sm;
  background: color-mix(in srgb, var(--dot-idle) 20%, transparent);
  color: var(--text-muted);
}

.log-head-cwd {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-faint);
  font-family: $font-mono;
  @include ellipsis;
}

.log-head-cwd-icon {
  flex-shrink: 0;
}

.log-head-status.running {
  background: color-mix(in srgb, var(--success) 13%, transparent);
  color: var(--success);
}

.log-head-status.failed {
  background: color-mix(in srgb, var(--danger) 13%, transparent);
  color: var(--danger);
}

.log-head-ops {
  margin-left: auto;
  display: flex;
  gap: 2px;
}

.log-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.log-body {
  flex: 1;
  min-height: 0;
  padding: 6px 8px;
}

.log-search-pos {
  position: absolute;
  top: 8px;
  right: 14px;
  z-index: 5;
}
</style>
