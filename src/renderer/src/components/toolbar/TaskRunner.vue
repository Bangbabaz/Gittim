<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Play, RotateCw, Square, ListChecks, ChevronDown } from 'lucide-vue-next'
import type { TaskMeta } from '@shared/types'

// 工具栏的命令运行入口。**不依赖 git** —— 任何 cwd 都能用,所以本组件在
// PaneToolbar 里始终渲染(无论 isRepo)。
//
// 任务定义本身是全局的(`window.api.taskList` 不分文件夹),但本组件只展示和
// 控制当前 pane cwd 下的命令。"npm run dev in folder A" 和 "in folder B" 各自
// 独立。

const props = defineProps<{
  cwd: string
}>()

const emit = defineEmits<{
  openTasks: []
  /** cwd 默认 = 当前 pane;newDraft 表示"为此文件夹新建命令"快捷入口。 */
  manageTasks: [cwd?: string, newDraft?: boolean]
}>()

const allTasks = ref<TaskMeta[]>([])
const selectedId = ref<string | null>(null)
let unsubTaskStatus: (() => void) | null = null
let unsubTaskRemoved: (() => void) | null = null

const normPath = (p: string | undefined): string => {
  if (!p) return ''
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase()
  return s
}
const samePath = (a: string | undefined, b: string | undefined): boolean => {
  const na = normPath(a)
  return na !== '' && na === normPath(b)
}

const paneTasks = computed(() =>
  props.cwd ? allTasks.value.filter((t) => samePath(t.cwd, props.cwd)) : []
)
const selectedTask = computed<TaskMeta | null>(
  () => paneTasks.value.find((t) => t.id === selectedId.value) || null
)
const runningTasks = computed(() => paneTasks.value.filter((t) => t.status === 'running'))

const upsertTask = (m: TaskMeta): void => {
  const i = allTasks.value.findIndex((t) => t.id === m.id)
  if (i >= 0) allTasks.value[i] = m
  else allTasks.value.push(m)
}

watch(
  paneTasks,
  (list) => {
    if (selectedId.value && !list.some((t) => t.id === selectedId.value)) {
      selectedId.value = list[0]?.id ?? null
    } else if (!selectedId.value && list.length) {
      selectedId.value = list[0].id
    }
  },
  { immediate: true }
)

onMounted(async () => {
  allTasks.value = await window.api.taskList()
  unsubTaskStatus = window.api.onTaskStatus(upsertTask)
  unsubTaskRemoved = window.api.onTaskRemoved(({ id }) => {
    allTasks.value = allTasks.value.filter((t) => t.id !== id)
  })
})

onUnmounted(() => {
  unsubTaskStatus?.()
  unsubTaskRemoved?.()
})

const onPickCommand = (cmd: string): void => {
  if (cmd === '__manage__') {
    emit('manageTasks', props.cwd)
    return
  }
  if (cmd === '__new_here__') {
    emit('manageTasks', props.cwd, true)
    return
  }
  selectedId.value = cmd
}

const runSelected = async (): Promise<void> => {
  if (selectedTask.value) await window.api.taskStart({ id: selectedTask.value.id })
}

const stopTask = async (id: string): Promise<void> => {
  await window.api.taskStop(id)
}
</script>

<template>
  <el-dropdown
    trigger="click"
    placement="bottom-start"
    popper-class="task-pick-dropdown"
    @command="onPickCommand"
  >
    <button class="cmd-pick" :title="selectedTask?.command || '选择命令'">
      <span class="status-dot" :class="selectedTask?.status || 'none'" />
      <span class="cmd-pick-name">{{
        selectedTask ? selectedTask.name || selectedTask.command : '选择命令'
      }}</span>
      <ChevronDown :size="12" class="cmd-pick-caret" />
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="t in paneTasks"
          :key="t.id"
          :command="t.id"
          :class="{ picked: t.id === selectedId }"
        >
          <span class="status-dot" :class="t.status" />
          <span class="td-label">{{ t.name || t.command }}</span>
        </el-dropdown-item>
        <el-dropdown-item v-if="!paneTasks.length" disabled class="cmd-empty">
          该文件夹暂无命令
        </el-dropdown-item>
        <el-dropdown-item divided command="__new_here__">为此文件夹新建命令…</el-dropdown-item>
        <el-dropdown-item command="__manage__">管理命令…</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>

  <el-tooltip
    v-if="selectedTask"
    :content="
      selectedTask.status === 'running' ? `重启:${selectedTask.name}` : `运行:${selectedTask.name}`
    "
    placement="bottom"
    :show-after="300"
  >
    <button class="run-btn" @click="runSelected">
      <RotateCw v-if="selectedTask.status === 'running'" :size="13" />
      <Play v-else :size="13" />
    </button>
  </el-tooltip>

  <el-tooltip
    v-if="runningTasks.length === 1"
    :content="`停止:${runningTasks[0].name}`"
    placement="bottom"
    :show-after="300"
  >
    <button class="run-btn stop" @click="stopTask(runningTasks[0].id)">
      <Square :size="12" />
    </button>
  </el-tooltip>
  <el-dropdown
    v-else-if="runningTasks.length > 1"
    trigger="click"
    placement="bottom-start"
    popper-class="task-pick-dropdown"
    @command="stopTask"
  >
    <button class="run-btn stop" title="停止运行中的命令">
      <Square :size="12" />
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item v-for="t in runningTasks" :key="t.id" :command="t.id">
          <span class="status-dot running" />
          <span class="td-label">{{ t.name || t.command }}</span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>

  <el-tooltip content="查看任务" placement="bottom" :show-after="300">
    <button class="run-btn view" @click="emit('openTasks')">
      <ListChecks :size="13" />
    </button>
  </el-tooltip>
</template>

<style scoped lang="scss">
.cmd-pick {
  @include btn-reset;
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 150px;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--el-border-color);
  border-radius: $radius-sm;
  color: var(--el-text-color-regular);
  font-size: 12px;
  margin-left: 2px;
  flex-shrink: 0;
}

.cmd-pick:hover {
  border-color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
}

.cmd-pick-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-pick-caret {
  opacity: 0.65;
  flex-shrink: 0;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
  flex-shrink: 0;
}

.status-dot.running {
  background: var(--el-color-success);
  box-shadow: 0 0 4px color-mix(in srgb, var(--el-color-success) 53%, transparent);
}

.status-dot.failed {
  background: var(--el-color-danger);
}

.status-dot.none {
  background: transparent;
  border: 1px solid var(--el-text-color-placeholder);
}

// run/stop 按钮:基础语义色(success / danger)做 fill,白色 icon。基础色而非
// light-3 是为了 light 主题下也能保证 WCAG AA 对比度 —— light-3 在浅色背景上
// 是几乎不可见的极淡填充。
.run-btn {
  @include btn-reset;
  background: var(--el-color-success);
  color: #fff;
  width: 20px;
  height: 20px;
  border-radius: $radius-sm;
  font-size: 10px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: 2px;
  flex-shrink: 0;
}

.run-btn:hover {
  background: var(--el-color-success-light-3);
  color: #fff;
}

.run-btn.stop {
  background: var(--el-color-danger);
}

.run-btn.stop:hover {
  background: var(--el-color-danger-light-3);
}

// view 按钮中性 —— 不是 run/stop 这种语义动作,跟随中性 outlined 风格,在浅色
// 主题下白色 icon 不可读时也能可见。
.run-btn.view {
  @include neutral-outlined-btn;
}
</style>
