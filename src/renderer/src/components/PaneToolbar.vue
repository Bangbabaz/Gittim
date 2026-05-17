<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  GitBranch,
  Play,
  RotateCw,
  Square,
  ListChecks,
  ChevronDown,
  FolderGit2,
  FileDiff,
  Trash2
} from 'lucide-vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'
import DiffViewer from './DiffViewer.vue'

type WorktreeInfo = {
  path: string
  branch: string | null
  head: string | null
  isMain: boolean
  detached: boolean
  locked: boolean
}

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
  cwd: string | undefined
}>()

const emit = defineEmits<{
  worktreeCreated: [path: string]
  openTasks: []
  manageTasks: []
}>()

const isRepo = ref(false)
const currentBranch = ref<string | null>(null)
const branches = ref<
  { name: string; local: boolean; remote: boolean; remoteName?: string; worktree?: boolean }[]
>([])
const switching = ref(false)
const diffStats = ref({ added: 0, deleted: 0 })

// Index of the first remote-only entry in `branches`. Used to paint a divider
// above it in the dropdown. -1 if there are no locals OR no remote-only entries
// (in either case there's nothing to separate, so no divider).
const firstRemoteOnlyIdx = computed(() => {
  if (!branches.value.some((b) => b.local)) return -1
  return branches.value.findIndex((b) => !b.local)
})

// Generation counter: every refresh captures the current gen; a later refresh
// or a checkout bumps the counter so the in-flight one knows to bail before
// overwriting fresher state.
let refreshGen = 0

const refresh = async (): Promise<void> => {
  if (!props.cwd || switching.value) return
  const myGen = ++refreshGen
  try {
    const info = await window.api.getGitInfo(props.cwd)
    if (myGen !== refreshGen) return
    if (!info.isRepo) {
      isRepo.value = false
      currentBranch.value = null
      branches.value = []
      return
    }
    const [list, stats] = await Promise.all([
      window.api.getGitBranches(props.cwd),
      window.api.getGitDiffStats(props.cwd)
    ])
    if (myGen !== refreshGen) return
    isRepo.value = true
    currentBranch.value = info.branch
    branches.value = list
    diffStats.value = stats
  } catch {
    if (myGen !== refreshGen) return
    isRepo.value = false
    currentBranch.value = null
    branches.value = []
  }
}

type SwitchTarget = { branch: string; isRemote: boolean; remoteName?: string }
const showSwitchConfirm = ref(false)
const pendingSwitch = ref<SwitchTarget | null>(null)

// `:model-value` is one-way bound, so currentBranch is the single source of
// truth. The dropdown's picked option doesn't stick until we set it here.
const onBranchChange = async (newBranch: string): Promise<void> => {
  if (!props.cwd || switching.value) return
  if (newBranch === currentBranch.value) return

  const branch = branches.value.find((b) => b.name === newBranch)
  // Only `--track <remote>/<name>` when the branch exists ONLY on a remote.
  // If a local copy already exists, plain `git checkout <name>` is what we want.
  const target: SwitchTarget = {
    branch: newBranch,
    isRemote: !!branch && !branch.local && branch.remote,
    remoteName: branch?.remoteName
  }

  let hasChanges = false
  try {
    hasChanges = await window.api.gitHasChanges(props.cwd)
  } catch {
    hasChanges = false
  }
  if (hasChanges) {
    // Let the user choose: stash & switch, switch anyway, or cancel.
    pendingSwitch.value = target
    showSwitchConfirm.value = true
    return
  }
  await doCheckout(target)
}

const doCheckout = async (t: SwitchTarget): Promise<void> => {
  if (!props.cwd) return
  const prev = currentBranch.value
  switching.value = true
  currentBranch.value = t.branch
  // Invalidate any in-flight refresh — its result is now stale.
  ++refreshGen
  try {
    const result = await window.api.gitCheckout(props.cwd, t.branch, t.isRemote, t.remoteName)
    if (result.success) {
      ElMessage.success(`已切换到分支 "${t.branch}"`)
      const [list, stats] = await Promise.all([
        window.api.getGitBranches(props.cwd),
        window.api.getGitDiffStats(props.cwd)
      ])
      branches.value = list
      diffStats.value = stats
    } else {
      ElMessage.error(result.error || '切换失败')
      currentBranch.value = prev
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
    currentBranch.value = prev
  } finally {
    switching.value = false
  }
}

const cancelSwitch = (): void => {
  showSwitchConfirm.value = false
  pendingSwitch.value = null
}

const switchDiscard = async (): Promise<void> => {
  const t = pendingSwitch.value
  showSwitchConfirm.value = false
  pendingSwitch.value = null
  if (t) await doCheckout(t)
}

const switchWithStash = async (): Promise<void> => {
  const t = pendingSwitch.value
  if (!t || !props.cwd) return
  showSwitchConfirm.value = false
  pendingSwitch.value = null
  const r = await window.api.gitStash(props.cwd)
  if (!r.success) {
    ElMessage.error(r.error || '暂存失败')
    return
  }
  ElMessage.success('已暂存当前更改（git stash）')
  await doCheckout(t)
}

onMounted(() => {
  refresh()
})

// Cwd is dynamic: Terminal.vue updates it from OSC 7 / OSC 9;9 and from a
// PID-based query on focus. Re-fetch git state whenever it changes so the
// branch indicator follows the shell's actual directory, not the launch dir.
watch(
  () => props.cwd,
  () => refresh()
)

defineExpose({ refresh })

// -- New worktree dialog ---------------------------------------------------

const showWorktreeDialog = ref(false)
const wtFromBranch = ref('')
const wtNewBranch = ref(false)
const wtNewBranchName = ref('')
const wtProjectName = ref('')
const wtLocation = ref('')
const wtSubmitting = ref(false)

const folderName = computed(() => {
  const parts = (props.cwd ?? '').replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || '项目'
})

const parentDir = computed(() => {
  const p = (props.cwd ?? '').replace(/\\/g, '/')
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.substring(0, idx) : p
})

const defaultProjectName = computed(() => {
  const branch =
    wtNewBranch.value && wtNewBranchName.value
      ? wtNewBranchName.value
      : currentBranch.value || 'worktree'
  return `${folderName.value}-${branch}`
})

watch([wtNewBranch, wtNewBranchName], () => {
  wtProjectName.value = defaultProjectName.value
})

function openWorktreeDialog(): void {
  wtFromBranch.value = currentBranch.value || ''
  wtNewBranch.value = false
  wtNewBranchName.value = ''
  wtProjectName.value = defaultProjectName.value
  wtLocation.value = parentDir.value
  showWorktreeDialog.value = true
}

async function handleBrowseLocation(): Promise<void> {
  const dir = await window.api.selectDirectory()
  if (dir) wtLocation.value = dir
}

async function handleCreateWorktree(): Promise<void> {
  if (!wtProjectName.value.trim()) {
    ElMessage.error('请输入项目名')
    return
  }
  if (!wtLocation.value.trim()) {
    ElMessage.error('请选择位置')
    return
  }
  if (!props.cwd) return
  if (wtNewBranch.value) {
    const name = wtNewBranchName.value.trim()
    if (!name) {
      ElMessage.error('请输入新分支名')
      return
    }
    if (branches.value.some((b) => b.name === name)) {
      ElMessage.error(`分支 "${name}" 已存在`)
      return
    }
  }
  const sep = props.cwd.includes('\\') ? '\\' : '/'
  const fullPath = `${wtLocation.value.replace(/\\/g, sep)}${sep}${wtProjectName.value.trim()}`
  // Remote-only base branches need the `<remote>/<name>` prefix or
  // `git worktree add` can't resolve the ref. Local branches are passed as-is.
  const fromBranchInfo = branches.value.find((b) => b.name === wtFromBranch.value)
  const fromBranchRef =
    fromBranchInfo && !fromBranchInfo.local && fromBranchInfo.remote
      ? `${fromBranchInfo.remoteName || 'origin'}/${fromBranchInfo.name}`
      : wtFromBranch.value || undefined
  wtSubmitting.value = true
  try {
    const result = await window.api.gitWorktreeAdd(props.cwd, {
      path: fullPath,
      newBranch: wtNewBranch.value ? wtNewBranchName.value.trim() || undefined : undefined,
      fromBranch: fromBranchRef
    })
    if (result.success) {
      showWorktreeDialog.value = false
      if (result.warning) ElMessage.warning(result.warning)
      emit('worktreeCreated', fullPath)
    } else {
      ElMessage.error(result.error || '工作树创建失败')
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    wtSubmitting.value = false
  }
}

// -- Worktree management (list / remove) -----------------------------------

const showWtManage = ref(false)
const wtList = ref<WorktreeInfo[]>([])
const wtLoading = ref(false)
const wtRemoving = ref<string | null>(null)

async function loadWorktrees(): Promise<void> {
  if (!props.cwd) return
  wtLoading.value = true
  try {
    wtList.value = await window.api.gitWorktrees(props.cwd)
  } finally {
    wtLoading.value = false
  }
}

function openWtManage(): void {
  showWtManage.value = true
  loadWorktrees()
}

async function removeWorktree(w: WorktreeInfo): Promise<void> {
  if (!props.cwd || w.isMain) return
  try {
    await ElMessageBox.confirm(`删除工作树？\n${w.path}`, '删除工作树', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  wtRemoving.value = w.path
  try {
    let r = await window.api.gitWorktreeRemove(props.cwd, w.path, false)
    // git refuses dirty/locked worktrees without --force — offer it. The IPC
    // call above sits between the two message boxes, so they're never opened
    // back-to-back (which would glitch Element Plus's singleton MessageBox).
    if (!r.success) {
      try {
        await ElMessageBox.confirm(
          `删除失败：${r.error || '该工作树可能有未提交更改或已锁定'}\n是否强制删除？`,
          '强制删除工作树',
          { confirmButtonText: '强制删除', cancelButtonText: '取消', type: 'warning' }
        )
      } catch {
        return // user declined force
      }
      r = await window.api.gitWorktreeRemove(props.cwd, w.path, true)
    }
    if (r.success) {
      ElMessage.success('已删除工作树')
      await loadWorktrees()
      refresh() // branch list "工作树" tags may have changed
    } else {
      ElMessage.error(r.error || '删除失败')
    }
  } finally {
    wtRemoving.value = null
  }
}

// -- Read-only diff viewer (diff2html) -------------------------------------

const showDiff = ref(false)
const diffLoading = ref(false)
const diffText = ref('')
const diffEmpty = ref(false)
const diffTruncated = ref(false)

async function openDiff(): Promise<void> {
  if (!props.cwd) return
  showDiff.value = true
  diffLoading.value = true
  diffText.value = ''
  diffEmpty.value = false
  diffTruncated.value = false
  try {
    const { diff, truncated } = await window.api.gitDiff(props.cwd)
    diffTruncated.value = truncated
    if (!diff.trim()) {
      diffEmpty.value = true
      return
    }
    diffText.value = diff
  } catch {
    diffEmpty.value = true
  } finally {
    diffLoading.value = false
  }
}

// -- Background tasks: run / restart button --------------------------------

// Tasks are global; the toolbar shows every defined command in a dropdown,
// runs the picked one, and surfaces a stop control for whatever's running.
const allTasks = ref<TaskMeta[]>([])
const selectedId = ref<string | null>(null)
let unsubTaskStatus: (() => void) | null = null
let unsubTaskRemoved: (() => void) | null = null

const selectedTask = computed<TaskMeta | null>(
  () => allTasks.value.find((t) => t.id === selectedId.value) || null
)
const runningTasks = computed(() => allTasks.value.filter((t) => t.status === 'running'))

const upsertTask = (m: TaskMeta): void => {
  const i = allTasks.value.findIndex((t) => t.id === m.id)
  if (i >= 0) allTasks.value[i] = m
  else allTasks.value.push(m)
  if (!selectedId.value) selectedId.value = m.id
}

// Keep the selection valid as tasks come and go.
watch(allTasks, (list) => {
  if (selectedId.value && !list.some((t) => t.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? null
  } else if (!selectedId.value && list.length) {
    selectedId.value = list[0].id
  }
})

onMounted(async () => {
  allTasks.value = await window.api.taskList()
  selectedId.value = allTasks.value[0]?.id ?? null
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
    emit('manageTasks')
    return
  }
  selectedId.value = cmd
}

// Run / re-run the command picked in the dropdown. taskStart handles both:
// idle → spawn, running → kill + respawn (reset buffer).
const runSelected = async (): Promise<void> => {
  if (selectedTask.value) await window.api.taskStart({ id: selectedTask.value.id })
}

const stopTask = async (id: string): Promise<void> => {
  await window.api.taskStop(id)
}
</script>

<template>
  <div v-if="isRepo" class="pane-toolbar" @click.stop>
    <GitBranch class="git-icon" :size="14" />
    <el-select
      :model-value="currentBranch"
      class="branch-select"
      popper-class="branch-select-dropdown"
      size="small"
      filterable
      :loading="switching"
      :disabled="switching"
      placeholder="(detached HEAD)"
      @change="onBranchChange"
    >
      <el-option
        v-for="(b, idx) in branches"
        :key="b.name"
        :label="b.name"
        :value="b.name"
        :class="{ 'first-remote': idx === firstRemoteOnlyIdx }"
      >
        <span class="br-opt">
          <span class="br-name">{{ b.name }}</span>
          <span v-if="b.worktree" class="br-tag worktree" title="该分支已在其他工作树检出"
            >工作树</span
          >
          <span v-if="b.local" class="br-tag local">本地</span>
          <span v-if="b.remote" class="br-tag remote">远程</span>
        </span>
      </el-option>
    </el-select>
    <button class="wt-btn" title="新建工作树" @click="openWorktreeDialog">+</button>
    <button class="wt-btn icon" title="管理工作树" @click="openWtManage">
      <FolderGit2 :size="13" />
    </button>
    <button class="wt-btn icon" title="查看改动 (diff)" @click="openDiff">
      <FileDiff :size="13" />
    </button>

    <!-- Command picker -->
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
            v-for="t in allTasks"
            :key="t.id"
            :command="t.id"
            :class="{ picked: t.id === selectedId }"
          >
            <span class="status-dot" :class="t.status" />
            <span class="td-label">{{ t.name || t.command }}</span>
          </el-dropdown-item>
          <el-dropdown-item divided command="__manage__">管理命令…</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <button
      v-if="selectedTask"
      class="run-btn"
      :class="{ active: selectedTask.status === 'running' }"
      :title="
        selectedTask.status === 'running'
          ? `重启：${selectedTask.name}`
          : `运行：${selectedTask.name}`
      "
      @click="runSelected"
    >
      <RotateCw v-if="selectedTask.status === 'running'" :size="13" />
      <Play v-else :size="13" />
    </button>

    <!-- Stop: only when something is running. One running → direct button;
         many → dropdown to pick which (no caret). -->
    <button
      v-if="runningTasks.length === 1"
      class="run-btn stop"
      :title="`停止：${runningTasks[0].name}`"
      @click="stopTask(runningTasks[0].id)"
    >
      <Square :size="12" />
    </button>
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

    <button class="run-btn view" title="查看任务" @click="emit('openTasks')">
      <ListChecks :size="13" />
    </button>

    <button
      v-if="diffStats.added || diffStats.deleted"
      class="diff-stats"
      title="查看改动 (diff)"
      @click="openDiff"
    >
      <span class="diff-added">+{{ diffStats.added }}</span>
      <span class="diff-deleted">-{{ diffStats.deleted }}</span>
    </button>

    <el-dialog v-model="showWorktreeDialog" title="新建工作树" width="440px" class="wt-dialog">
      <div class="wt-form">
        <div class="wt-row">
          <label class="wt-label">从分支</label>
          <el-select
            v-model="wtFromBranch"
            class="wt-field"
            popper-class="branch-select-dropdown"
            size="small"
            filterable
          >
            <el-option
              v-for="(b, idx) in branches"
              :key="b.name"
              :label="b.name"
              :value="b.name"
              :class="{ 'first-remote': idx === firstRemoteOnlyIdx }"
            >
              <span class="br-opt">
                <span class="br-name">{{ b.name }}</span>
                <span v-if="b.worktree" class="br-tag worktree" title="该分支已在其他工作树检出"
                  >工作树</span
                >
                <span v-if="b.local" class="br-tag local">本地</span>
                <span v-if="b.remote" class="br-tag remote">远程</span>
              </span>
            </el-option>
          </el-select>
        </div>

        <div class="wt-row">
          <label class="wt-label">新分支</label>
          <div class="wt-field" style="display: flex; align-items: center; gap: 8px">
            <el-checkbox v-model="wtNewBranch" />
            <el-input
              v-if="wtNewBranch"
              v-model="wtNewBranchName"
              size="small"
              placeholder="新分支名"
              style="flex: 1"
            />
          </div>
        </div>

        <div class="wt-row">
          <label class="wt-label">项目名</label>
          <el-input v-model="wtProjectName" class="wt-field" size="small" />
        </div>

        <div class="wt-row">
          <label class="wt-label">位置</label>
          <div class="wt-field" style="display: flex; gap: 8px">
            <el-input v-model="wtLocation" size="small" style="flex: 1" />
            <el-button size="small" @click="handleBrowseLocation">浏览</el-button>
          </div>
        </div>
      </div>

      <template #footer>
        <el-button size="small" @click="showWorktreeDialog = false">取消</el-button>
        <el-button
          size="small"
          type="primary"
          :loading="wtSubmitting"
          @click="handleCreateWorktree"
        >
          创建工作树
        </el-button>
      </template>
    </el-dialog>

    <!-- Branch switch with uncommitted changes: 3-way choice -->
    <el-dialog
      v-model="showSwitchConfirm"
      title="当前有未提交的更改"
      width="420px"
      class="wt-dialog"
      @closed="cancelSwitch"
    >
      <div class="switch-msg">
        切换到分支 <b>{{ pendingSwitch?.branch }}</b> 前，工作区有未提交的更改。<br />
        可以先 <code>git stash</code> 暂存再切换，或直接切换（Git 会阻止会冲突的切换）。
      </div>
      <template #footer>
        <el-button size="small" @click="cancelSwitch">取消</el-button>
        <el-button size="small" @click="switchDiscard">直接切换</el-button>
        <el-button size="small" type="primary" @click="switchWithStash">暂存并切换</el-button>
      </template>
    </el-dialog>

    <!-- Worktree management -->
    <el-dialog v-model="showWtManage" title="管理工作树" width="640px" class="wt-dialog">
      <div v-if="wtLoading" class="wt-manage-empty">加载中…</div>
      <div v-else-if="!wtList.length" class="wt-manage-empty">没有工作树</div>
      <div v-else class="wt-manage-list">
        <div v-for="w in wtList" :key="w.path" class="wt-manage-row">
          <div class="wt-manage-info">
            <div class="wt-manage-path" :title="w.path">{{ w.path }}</div>
            <div class="wt-manage-meta">
              <span v-if="w.isMain" class="br-tag local">主</span>
              <span v-if="w.locked" class="br-tag worktree">已锁定</span>
              <span v-if="w.detached" class="br-tag remote">分离 HEAD</span>
              <span v-else-if="w.branch" class="wt-manage-branch">{{ w.branch }}</span>
            </div>
          </div>
          <button
            v-if="!w.isMain"
            class="wt-del-btn"
            :disabled="wtRemoving === w.path"
            title="删除此工作树"
            @click="removeWorktree(w)"
          >
            <Trash2 :size="14" />
          </button>
          <span v-else class="wt-main-hint">不可删除</span>
        </div>
      </div>
      <template #footer>
        <el-button size="small" @click="showWtManage = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- Read-only diff viewer -->
    <el-dialog
      v-model="showDiff"
      title="改动（相对 HEAD）"
      width="92%"
      top="4vh"
      class="diff-dialog"
    >
      <div v-if="diffLoading" class="diff-state">加载中…</div>
      <div v-else-if="diffEmpty" class="diff-state">没有改动</div>
      <template v-else>
        <div v-if="diffTruncated" class="diff-trunc">改动过大，仅显示前 10 MB</div>
        <DiffViewer :diff="diffText" />
      </template>
      <template #footer>
        <el-button size="small" @click="showDiff = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.wt-btn {
  background: none;
  border: 1px solid #555;
  color: #ccc;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin-left: 2px;
  flex-shrink: 0;
}

.wt-btn:hover {
  border-color: #888;
  color: #fff;
  background: #3e3e42;
}

/* Action buttons: white icon on a semantic filled background, unified look. */
.run-btn {
  background: #2e944a;
  border: none;
  color: #fff;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin-left: 2px;
  flex-shrink: 0;
}

.run-btn:hover {
  background: #37b058;
  color: #fff;
}

/* Selected command is running → restart affordance, amber. */
.run-btn.active {
  background: #bd8b1b;
}

.run-btn.active:hover {
  background: #d7a23b;
}

.run-btn.stop {
  background: #c0392b;
}

.run-btn.stop:hover {
  background: #da4233;
}

/* View tasks — neutral, not a semantic run/stop action. */
.run-btn.view {
  background: #3a3a42;
}

.run-btn.view:hover {
  background: #4a4a52;
}

/* Command picker (el-dropdown custom trigger) */
.cmd-pick {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 150px;
  height: 20px;
  padding: 0 6px;
  background: none;
  border: 1px solid #555;
  border-radius: 3px;
  color: #ccc;
  font-size: 12px;
  cursor: pointer;
  margin-left: 2px;
  flex-shrink: 0;
}

.cmd-pick:hover {
  border-color: #888;
  background: #3e3e42;
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
  background: #6b6b6b;
  flex-shrink: 0;
}

.status-dot.running {
  background: #3fb950;
  box-shadow: 0 0 4px #3fb95088;
}

.status-dot.failed {
  background: #f14c4c;
}

.status-dot.none {
  background: transparent;
  border: 1px solid #6b6b6b;
}

.wt-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wt-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wt-label {
  font-size: 12px;
  color: #ccc;
  width: 52px;
  flex-shrink: 0;
  text-align: right;
}

.wt-field {
  flex: 1;
  min-width: 0;
}

.wt-btn.icon {
  font-size: 0;
}

.diff-stats {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 6px;
  font-size: 11px;
  line-height: 1;
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
  flex-shrink: 0;
  background: none;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
}

.diff-stats:hover {
  border-color: #555;
  background: #3e3e42;
}

.diff-added {
  color: #4ec9b0;
}

.diff-deleted {
  color: #f14c4c;
}

/* Branch-switch confirm */
.switch-msg {
  font-size: 13px;
  color: #d4d4d4;
  line-height: 1.7;
}

.switch-msg code {
  font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
  font-size: 12px;
  background: #1e1e1e;
  padding: 1px 5px;
  border-radius: 3px;
}

/* Worktree management list */
.wt-manage-empty {
  color: #6b6b6b;
  font-size: 13px;
  padding: 24px 4px;
  text-align: center;
}

.wt-manage-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 52vh;
  overflow-y: auto;
}

.wt-manage-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: #1e1e1e;
  border: 1px solid #3e3e42;
  border-radius: 5px;
}

.wt-manage-info {
  flex: 1;
  min-width: 0;
}

.wt-manage-path {
  font-size: 12px;
  color: #d4d4d4;
  font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wt-manage-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.wt-manage-branch {
  font-size: 11px;
  color: #858585;
}

.wt-del-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid #c42b1c66;
  color: #f14c4c;
  border-radius: 4px;
  cursor: pointer;
}

.wt-del-btn:hover:not(:disabled) {
  background: #c42b1c22;
  border-color: #c42b1c;
}

.wt-del-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.wt-main-hint {
  font-size: 11px;
  color: #6b6b6b;
  flex-shrink: 0;
}

/* Diff viewer */
.diff-state {
  color: #6b6b6b;
  font-size: 13px;
  padding: 40px 4px;
  text-align: center;
}

.diff-trunc {
  font-size: 12px;
  color: #d7a23b;
  background: #d7a23b1a;
  padding: 6px 10px;
  margin: 8px 12px 0;
  border-radius: 4px;
}
</style>

<style scoped>
.pane-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  background: #2d2d30;
  border-bottom: 1px solid #3e3e42;
  flex-shrink: 0;
  user-select: none;
}

.git-icon {
  color: #e74856;
  flex-shrink: 0;
}

.branch-select {
  width: 160px;
  --el-select-input-font-size: 12px;
}

.branch-select :deep(.el-select__wrapper) {
  padding: 0 8px;
  min-height: 22px;
}

.branch-select :deep(.el-select__selected-item) {
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.branch-select :deep(.el-select__placeholder) {
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
</style>

<style>
/* Task command dropdown (teleported to body by el-dropdown). */
.task-pick-dropdown .el-dropdown-menu {
  background: #252526;
  border: 1px solid #454545;
  padding: 4px;
  max-width: 360px;
}

.task-pick-dropdown .el-dropdown-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #cccccc;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 4px;
  line-height: 1.4;
}

.task-pick-dropdown .el-dropdown-menu__item:not(.is-disabled):hover {
  background: #04395e;
  color: #fff;
}

.task-pick-dropdown .el-dropdown-menu__item.picked {
  color: #fff;
}

.task-pick-dropdown .el-dropdown-menu__item--divided {
  border-top: 1px solid #454545;
  margin-top: 4px;
}

.task-pick-dropdown .el-dropdown-menu__item--divided::before {
  display: none;
}

.task-pick-dropdown .status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6b6b6b;
  flex-shrink: 0;
}

.task-pick-dropdown .status-dot.running {
  background: #3fb950;
  box-shadow: 0 0 4px #3fb95088;
}

.task-pick-dropdown .status-dot.failed {
  background: #f14c4c;
}

.task-pick-dropdown .td-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* el-select's dropdown popper is teleported to body — scoped styles can't
   reach it, so override via popper-class globally. */
.branch-select-dropdown .el-select-dropdown__list {
  padding: 4px 0;
}

/* Widen the dropdown so long branch names + tags fit on one line without
   wrapping or aggressive truncation. The trigger stays narrow. */
.branch-select-dropdown.el-popper {
  min-width: 280px !important;
}

.branch-select-dropdown .el-select-dropdown__list {
  padding: 4px 0;
}

.branch-select-dropdown .el-select-dropdown__item {
  height: auto;
  line-height: 1.4;
  padding: 4px 10px;
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* Divider between local-containing and remote-only branches. The class is
   placed on the first remote-only option from PaneToolbar's firstRemoteOnlyIdx. */
.branch-select-dropdown .el-select-dropdown__item.first-remote {
  border-top: 1px solid #3e3e42;
  margin-top: 4px;
  padding-top: 6px;
}

/* Each option fills its row; name takes the slack, tags pin right. */
.br-opt {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.br-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.br-tag {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 2px;
  line-height: 16px;
  flex-shrink: 0;
}

.br-tag.local {
  color: #6a9955;
  background: #6a995522;
}

.br-tag.remote {
  color: #569cd6;
  background: #569cd622;
}

.br-tag.worktree {
  color: #c19c00;
  background: #c19c0022;
}

/* Diff viewer dialog — el-dialog body is teleported to <body>, so scope it
   via the dialog class globally. DiffViewer manages its own internal scroll
   (sidebar + main), so the dialog body itself must not scroll. */
.diff-dialog .el-dialog__body {
  padding: 0;
  overflow: hidden;
}
</style>
