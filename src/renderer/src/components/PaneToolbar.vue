<script setup lang="ts">
import { ref, watch } from 'vue'
import BranchSelector from './toolbar/BranchSelector.vue'
import WorktreePanel from './toolbar/WorktreePanel.vue'
import GitOpsButtons from './toolbar/GitOpsButtons.vue'
import DiffStatsButton from './toolbar/DiffStatsButton.vue'
import TaskRunner from './toolbar/TaskRunner.vue'
import IdeLauncher from './toolbar/IdeLauncher.vue'
import type { BranchInfo, DiffStats, MergeStatus } from '@shared/types'

// 工具栏协调器。集中管理 git 状态(branches / currentBranch / diffStats /
// mergeStatus),通过 props 下发到子组件;子组件触发 git 操作后 emit('changed'),
// 由本组件统一刷新。
//
// 改造关键点:
//   1. 非 git 目录也渲染工具栏 —— 仅隐藏 BranchSelector / WorktreePanel /
//      GitOpsButtons,TaskRunner + IdeLauncher 与 git 无关,任意 cwd 都可用。
//   2. refresh() 节流:Terminal focus 频繁触发,200ms 内合并多次。
//   3. refreshGen 仍然保留 —— 用户主动切分支等场景能立即中断 in-flight。

type WorktreePlacement = 'top' | 'bottom' | 'left' | 'right'

const props = defineProps<{
  cwd: string | undefined
}>()

const emit = defineEmits<{
  worktreeCreated: [path: string, placement: WorktreePlacement]
  openTasks: []
  manageTasks: [cwd?: string, newDraft?: boolean]
}>()

// --- Git 状态(从 IPC 拉取的快照,下发给 BranchSelector / WorktreePanel /
//     GitOpsButtons)----------------------------------------------------------
const isRepo = ref(false)
const currentBranch = ref<string | null>(null)
const branches = ref<BranchInfo[]>([])
const diffStats = ref<DiffStats>({ added: 0, deleted: 0 })
const mergeStatus = ref<MergeStatus | null>(null)
// switching / 乐观分支显示都留在 BranchSelector 内部 —— 父级不需要参与切换流程,
// 切完只关心 refresh,通过子级 emit('changed') 触发。

// 多次 refresh() 用 gen 标记;每次 in-flight call 写状态前都检查自己是不是最新
// 的 —— 用户快速切分支或快速 focus 不同 pane 时,旧调用的 IPC 结果不会污染
// 新状态。
let refreshGen = 0

// 200ms throttle:窗口 / focus / cwd 变化连续触发时合并。第一次立即跑,后续 200ms
// 内合并到一次,最末状态最准。
let throttleTimer: ReturnType<typeof setTimeout> | null = null
let throttlePending = false
let lastRunAt = 0
const THROTTLE_MS = 200

const refresh = async (): Promise<void> => {
  if (!props.cwd) return
  const myGen = ++refreshGen
  try {
    const info = await window.api.getGitInfo(props.cwd)
    if (myGen !== refreshGen) return
    if (!info.isRepo) {
      isRepo.value = false
      currentBranch.value = null
      branches.value = []
      mergeStatus.value = null
      diffStats.value = { added: 0, deleted: 0 }
      return
    }
    const [list, stats, merge] = await Promise.all([
      window.api.getGitBranches(props.cwd),
      window.api.getGitDiffStats(props.cwd),
      window.api.gitMergeStatus(props.cwd)
    ])
    if (myGen !== refreshGen) return
    isRepo.value = true
    currentBranch.value = info.branch
    branches.value = list
    diffStats.value = stats
    mergeStatus.value = merge
  } catch {
    if (myGen !== refreshGen) return
    isRepo.value = false
    currentBranch.value = null
    branches.value = []
    mergeStatus.value = null
  }
}

const requestRefresh = (): void => {
  const now = Date.now()
  const elapsed = now - lastRunAt
  if (elapsed >= THROTTLE_MS) {
    lastRunAt = now
    void refresh()
    return
  }
  // 已经在节流窗口内:挂起一次尾随调用,确保最末状态最终落地。
  if (throttlePending) return
  throttlePending = true
  if (throttleTimer) clearTimeout(throttleTimer)
  throttleTimer = setTimeout(() => {
    throttlePending = false
    throttleTimer = null
    lastRunAt = Date.now()
    void refresh()
  }, THROTTLE_MS - elapsed)
}

// cwd 改变(用户 cd 或者新建 worktree pane)→ 立即触发一次新状态拉取。
// 通过 requestRefresh 走节流,但 cwd 变化频率不高,实际上等价于立即 refresh。
watch(
  () => props.cwd,
  () => requestRefresh(),
  { immediate: true }
)

defineExpose({ refresh: requestRefresh })

// --- Worktree dialog 入口 -----------------------------------------------
// BranchSelector 右键"新工作树"→ 父级转发到 WorktreePanel.openWorktreeDialog。
const worktreePanelRef = ref<InstanceType<typeof WorktreePanel>>()

function onWorktreeFromBranch(prefill: string): void {
  worktreePanelRef.value?.openWorktreeDialog(prefill)
}

function onWorktreeCreated(path: string, placement: WorktreePlacement): void {
  emit('worktreeCreated', path, placement)
}
</script>

<template>
  <!-- 工具栏 v-if 仅在 cwd 已知时渲染;不再以 isRepo 为条件,非 git 目录也展示
       TaskRunner + IdeLauncher。 -->
  <div v-if="props.cwd" class="pane-toolbar" @click.stop>
    <template v-if="isRepo">
      <BranchSelector
        :cwd="props.cwd"
        :branches="branches"
        :current-branch="currentBranch"
        @changed="requestRefresh"
        @worktree-from-branch="onWorktreeFromBranch"
      />
      <WorktreePanel
        ref="worktreePanelRef"
        :cwd="props.cwd"
        :branches="branches"
        :current-branch="currentBranch"
        @worktree-created="onWorktreeCreated"
        @changed="requestRefresh"
      />
      <GitOpsButtons
        :cwd="props.cwd"
        :merge-status="mergeStatus"
        @changed="requestRefresh"
      />
    </template>

    <!-- 任务运行 / IDE 启动:无论是否 git 都显示。语音输入只走快捷键(默认 F2),
         不再渲染按钮 —— 录音中浮在 pane 底部的 RecordingIndicator 就是反馈。
         IdeLauncher 自带 margin-left: auto,把右侧锚定到工具栏末端。
         DiffStatsButton 跟在最后,保证 +N -N 在最右。 -->
    <TaskRunner
      :cwd="props.cwd"
      @open-tasks="emit('openTasks')"
      @manage-tasks="(cwd?: string, nd?: boolean) => emit('manageTasks', cwd, nd)"
    />
    <IdeLauncher :cwd="props.cwd" />
    <DiffStatsButton v-if="isRepo" :cwd="props.cwd" :diff-stats="diffStats" />
  </div>
</template>

<style scoped lang="scss" src="@renderer/assets/style/components/PaneToolbar.scss"></style>
