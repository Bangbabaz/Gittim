<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Play, RotateCw, Square, ListChecks, ChevronDown } from 'lucide-vue-next'
import { useTasks } from '../../composables/useTasks'
import type { TaskMeta } from '@shared/types'

// 工具栏的命令运行入口。**不依赖 git** —— 任何 cwd 都能用,所以本组件在
// PaneToolbar 里始终渲染(无论 isRepo)。
//
// 任务定义本身是全局的(跨所有 cwd 的命令都在同一份 allTasks 里),但本组件只
// 展示和控制当前 pane cwd 下的命令。"npm run dev in folder A" 和 "in folder B"
// 各自独立。
//
// 共享数据来自 useTasks() —— 模块级单例。之前每个 TaskRunner 各自维护 allTasks
// ref + 各自订阅 onTaskStatus / onTaskRemoved,N 个 pane 就触发 N 次 upsert,
// task 状态变化时主线程被重复广播打到。现在所有 pane 读同一份 reactive ref。

const props = defineProps<{
  cwd: string
}>()

const emit = defineEmits<{
  openTasks: []
  /** cwd 默认 = 当前 pane;newDraft 表示"为此文件夹新建命令"快捷入口。 */
  manageTasks: [cwd?: string, newDraft?: boolean]
}>()

const { allTasks } = useTasks()
const selectedId = ref<string | null>(null)

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

<style scoped lang="scss" src="@renderer/assets/style/components/toolbar/TaskRunner.scss"></style>
