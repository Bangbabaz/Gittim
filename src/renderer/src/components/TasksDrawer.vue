<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Play,
  Square,
  RotateCw,
  Pencil,
  Trash2,
  Plus,
  X,
  Terminal as TerminalIcon
} from 'lucide-vue-next'
import '@xterm/xterm/css/xterm.css'

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
  defaultCwd: string
  selectTaskId: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const tasks = ref<TaskMeta[]>([])
const selectedId = ref<string | null>(null)

// New-task / edit form
const formCommand = ref('')
const formCwd = ref('')
const formName = ref('')
const editingId = ref<string | null>(null)
const pkgScripts = ref<Record<string, string>>({})

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

function ensureTerm(): void {
  if (term || !logRef.value) return
  term = new Terminal({
    fontSize: 12,
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, Consolas, monospace",
    cursorBlink: false,
    disableStdin: true,
    convertEol: true,
    theme: {
      background: '#1b1b1f',
      foreground: '#d4d4d4',
      selectionBackground: '#264f78'
    }
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(logRef.value)
  logResizeObserver = new ResizeObserver(() => {
    try {
      fit?.fit()
    } catch {
      // element hidden / detached
    }
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
}

function selectTask(id: string): void {
  selectedId.value = id
  bindLog(id)
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
  unsubStatus = window.api.onTaskStatus((meta) => upsert(meta))
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
  }
)

// App passes the id of a task it just auto-opened for.
watch(
  () => props.selectTaskId,
  (id) => {
    if (id && props.modelValue) selectTask(id)
  }
)

// Prefill the new-task cwd from the active pane whenever the drawer's
// defaultCwd changes and we're not mid-edit.
watch(
  () => props.defaultCwd,
  (c) => {
    if (!editingId.value && !formCwd.value) formCwd.value = c
  },
  { immediate: true }
)

// Load package.json scripts for the form cwd (debounced-ish via watch).
watch(
  formCwd,
  async (c) => {
    pkgScripts.value = c ? await window.api.readPackageScripts(c) : {}
  },
  { immediate: true }
)

const pkgScriptNames = computed(() => Object.keys(pkgScripts.value))

function applyScript(name: string): void {
  formCommand.value = `npm run ${name}`
  if (!formName.value) formName.value = name
}

function resetForm(): void {
  editingId.value = null
  formCommand.value = ''
  formName.value = ''
  formCwd.value = props.defaultCwd || ''
}

async function submitForm(): Promise<void> {
  const command = formCommand.value.trim()
  if (!command) {
    ElMessage.error('请输入命令')
    return
  }
  const cwd = formCwd.value.trim()
  if (!cwd) {
    ElMessage.error('请输入工作目录')
    return
  }
  const name = formName.value.trim() || command

  if (editingId.value) {
    await window.api.taskUpdate(editingId.value, { name, command, cwd })
    ElMessage.success('已保存')
    resetForm()
    await reload()
    return
  }
  const meta = await window.api.taskStart({ name, command, cwd })
  resetForm()
  await reload()
  selectTask(meta.id)
}

function editTask(t: TaskMeta): void {
  editingId.value = t.id
  formCommand.value = t.command
  formName.value = t.name
  formCwd.value = t.cwd
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
  if (editingId.value === t.id) resetForm()
}

async function stopSelected(): Promise<void> {
  if (selectedTask.value) await window.api.taskStop(selectedTask.value.id)
}

function clearLog(): void {
  term?.reset()
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    direction="rtl"
    size="860px"
    :with-header="false"
    class="tasks-drawer"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="tasks-layout">
      <!-- Left: form + list -->
      <aside class="tasks-side">
        <div class="tasks-side-head">
          <span class="tasks-title">任务</span>
          <button class="icon-btn" title="关闭" @click="emit('update:modelValue', false)">
            <X :size="15" />
          </button>
        </div>

        <div class="task-form">
          <div class="tf-title">{{ editingId ? '编辑任务' : '新建任务' }}</div>
          <input v-model="formCommand" class="tf-input" placeholder="命令，如 npm run dev" />
          <input v-model="formCwd" class="tf-input" placeholder="工作目录" />
          <input v-model="formName" class="tf-input" placeholder="名称（可选）" />
          <div v-if="pkgScriptNames.length" class="tf-scripts">
            <span class="tf-scripts-label">package.json：</span>
            <button
              v-for="s in pkgScriptNames"
              :key="s"
              class="tf-chip"
              :title="pkgScripts[s]"
              @click="applyScript(s)"
            >
              {{ s }}
            </button>
          </div>
          <div class="tf-actions">
            <button class="tf-submit" @click="submitForm">
              <Plus v-if="!editingId" :size="13" />
              <span>{{ editingId ? '保存修改' : '创建并运行' }}</span>
            </button>
            <button v-if="editingId" class="tf-cancel" @click="resetForm">取消</button>
          </div>
        </div>

        <div class="task-list">
          <div v-if="!tasks.length" class="task-empty">暂无任务</div>
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
            </div>
            <div class="task-ops" @click.stop>
              <button
                class="op-btn"
                :title="t.status === 'running' ? '停止' : '运行'"
                @click="toggleTask(t)"
              >
                <Square v-if="t.status === 'running'" :size="13" />
                <Play v-else :size="13" />
              </button>
              <button class="op-btn" title="重启" @click="restartTask(t)">
                <RotateCw :size="13" />
              </button>
              <button class="op-btn" title="编辑" @click="editTask(t)">
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
          <div class="log-head-ops">
            <button
              v-if="selectedTask"
              class="op-btn"
              title="重启"
              @click="restartTask(selectedTask)"
            >
              <RotateCw :size="13" />
            </button>
            <button
              v-if="selectedTask && selectedTask.status === 'running'"
              class="op-btn"
              title="停止"
              @click="stopSelected"
            >
              <Square :size="13" />
            </button>
            <button class="op-btn" title="清空显示" @click="clearLog">清空</button>
          </div>
        </div>
        <div ref="logRef" class="log-body"></div>
      </section>
    </div>
  </el-drawer>
</template>

<style scoped>
.tasks-layout {
  display: flex;
  height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.tasks-side {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #252526;
  border-right: 1px solid #3e3e42;
}

.tasks-side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid #3e3e42;
}

.tasks-title {
  font-size: 13px;
  font-weight: 600;
  color: #d4d4d4;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: none;
  color: #9d9d9d;
  cursor: pointer;
  border-radius: 4px;
}

.icon-btn:hover {
  background: #3e3e42;
  color: #fff;
}

.task-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-bottom: 1px solid #3e3e42;
}

.tf-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #858585;
}

.tf-input {
  background: #1e1e1e;
  border: 1px solid #3e3e42;
  border-radius: 4px;
  color: #d4d4d4;
  font-size: 12px;
  padding: 6px 8px;
  outline: none;
  font-family: inherit;
}

.tf-input:focus {
  border-color: #094771;
}

.tf-scripts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.tf-scripts-label {
  font-size: 11px;
  color: #858585;
}

.tf-chip {
  background: #0e639c33;
  border: 1px solid #0e639c66;
  color: #6cb6ff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  cursor: pointer;
  font-family: inherit;
}

.tf-chip:hover {
  background: #0e639c55;
}

.tf-actions {
  display: flex;
  gap: 8px;
}

.tf-submit {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  background: #0e639c;
  border: none;
  color: #fff;
  font-size: 12px;
  padding: 7px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}

.tf-submit:hover {
  background: #1177bb;
}

.tf-cancel {
  background: transparent;
  border: 1px solid #3e3e42;
  color: #ccc;
  font-size: 12px;
  padding: 7px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}

.tf-cancel:hover {
  background: #3e3e42;
}

.task-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.task-empty {
  color: #6b6b6b;
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
  background: #2d2d30;
}

.task-row.active {
  background: #04395e;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #6b6b6b;
}

.status-dot.running {
  background: #3fb950;
  box-shadow: 0 0 4px #3fb95088;
}

.status-dot.failed {
  background: #f14c4c;
}

.status-dot.exited {
  background: #6b6b6b;
}

.task-meta {
  flex: 1;
  min-width: 0;
}

.task-name {
  font-size: 12.5px;
  color: #d4d4d4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-cmd {
  font-size: 11px;
  color: #858585;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
}

.task-ops {
  display: flex;
  gap: 1px;
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
  color: #b5b5b5;
  cursor: pointer;
  border-radius: 3px;
  font-size: 11px;
  font-family: inherit;
}

.op-btn:hover {
  background: #ffffff1a;
  color: #fff;
}

.op-btn.danger:hover {
  background: #c42b1c44;
  color: #f14c4c;
}

.tasks-log {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #1b1b1f;
}

.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid #3e3e42;
}

.log-head-icon {
  color: #858585;
}

.log-head-title {
  font-size: 12.5px;
  color: #d4d4d4;
  flex-shrink: 0;
}

.log-head-status {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 3px;
  background: #6b6b6b33;
  color: #9d9d9d;
}

.log-head-status.running {
  background: #3fb95022;
  color: #3fb950;
}

.log-head-status.failed {
  background: #f14c4c22;
  color: #f14c4c;
}

.log-head-ops {
  margin-left: auto;
  display: flex;
  gap: 2px;
}

.log-body {
  flex: 1;
  min-height: 0;
  padding: 6px 8px;
}
</style>

<style>
.tasks-drawer .el-drawer__body {
  padding: 0;
  background: #1b1b1f;
}

.tasks-drawer.el-drawer {
  background: #1b1b1f;
}
</style>
