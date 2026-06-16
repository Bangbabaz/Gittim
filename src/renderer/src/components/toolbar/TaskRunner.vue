<script setup lang="ts">
import { computed } from 'vue'
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
// 共享数据来自 useTasks() —— 模块级单例。selectedId 也是共享的,所以一端选中
// 任务后另一端(TasksDrawer)自动看到同一选中。本组件只在当前 cwd 的任务中寻找
// 全局 selectedId,找不到就显示"选择命令"。

const props = defineProps<{
  cwd: string
}>()

const emit = defineEmits<{
  openTasks: []
  /** cwd 默认 = 当前 pane;newDraft 表示"为此文件夹新建命令"快捷入口。 */
  manageTasks: [cwd?: string, newDraft?: boolean]
}>()

const { allTasks, selectedId, selectTask } = useTasks()

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
// 只在当前 pane 的 paneTasks 中查找全局 selectedId。跨 cwd 的全局选中的任务
// 不在本 cwd 内时返回 null —— 下拉显示"选择命令",不抢占全局选择。
const selectedTask = computed<TaskMeta | null>(
  () => paneTasks.value.find((t) => t.id === selectedId.value) || null
)
const runningTasks = computed(() => paneTasks.value.filter((t) => t.status === 'running'))

const onPickCommand = (cmd: string): void => {
  if (cmd === '__manage__') {
    emit('manageTasks', props.cwd)
    return
  }
  if (cmd === '__new_here__') {
    emit('manageTasks', props.cwd, true)
    return
  }
  selectTask(cmd)
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
