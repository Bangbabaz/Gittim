<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { GitBranch, Play, RotateCw, ListChecks } from 'lucide-vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'

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
}>()

const isRepo = ref(false)
const currentBranch = ref<string | null>(null)
const branches = ref<
  { name: string; local: boolean; remote: boolean; worktree?: boolean }[]
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

// `:model-value` is one-way bound, so currentBranch is the single source of
// truth. The dropdown's picked option doesn't stick until we set it here.
const onBranchChange = async (newBranch: string): Promise<void> => {
  if (!props.cwd || switching.value) return
  if (newBranch === currentBranch.value) return

  try {
    const hasChanges = await window.api.gitHasChanges(props.cwd)
    if (hasChanges) {
      await ElMessageBox.confirm('当前有未提交的更改，切换分支后可能丢失。确定继续？', '警告', {
        confirmButtonText: '继续切换',
        cancelButtonText: '取消',
        type: 'warning'
      })
    }
  } catch {
    // user cancelled
    return
  }

  const branch = branches.value.find((b) => b.name === newBranch)
  // Only `--track origin/<name>` when the branch exists ONLY on the remote.
  // If a local copy already exists, plain `git checkout <name>` is what we want.
  const isRemote = !!branch && !branch.local && branch.remote

  const prev = currentBranch.value
  switching.value = true
  currentBranch.value = newBranch
  // Invalidate any in-flight refresh — its result is now stale.
  ++refreshGen
  try {
    const result = await window.api.gitCheckout(props.cwd, newBranch, isRemote)
    if (result.success) {
      ElMessage.success(`已切换到分支 "${newBranch}"`)
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
  // Remote-only base branches need the `origin/` prefix or `git worktree add`
  // can't resolve the ref. Local branches are passed as-is.
  const fromBranchInfo = branches.value.find((b) => b.name === wtFromBranch.value)
  const fromBranchRef =
    fromBranchInfo && !fromBranchInfo.local && fromBranchInfo.remote
      ? `origin/${fromBranchInfo.name}`
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

// -- Background tasks: run / restart button --------------------------------

const allTasks = ref<TaskMeta[]>([])
let unsubTaskStatus: (() => void) | null = null
let unsubTaskRemoved: (() => void) | null = null

// The "primary task" the run button is bound to for this pane's cwd: prefer a
// running one, otherwise the most recently started, otherwise the first defined.
const primaryTask = computed<TaskMeta | null>(() => {
  if (!props.cwd) return null
  const here = allTasks.value.filter((t) => t.cwd === props.cwd)
  if (!here.length) return null
  const running = here.filter((t) => t.status === 'running')
  const pool = running.length ? running : here
  return [...pool].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
})

const upsertTask = (m: TaskMeta): void => {
  const i = allTasks.value.findIndex((t) => t.id === m.id)
  if (i >= 0) allTasks.value[i] = m
  else allTasks.value.push(m)
}

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

// Command launcher popover (shown when there's no primary task yet)
const showRunPopover = ref(false)
const runCommand = ref('')
const pkgScripts = ref<Record<string, string>>({})
const pkgScriptNames = computed(() => Object.keys(pkgScripts.value))

watch(
  () => [props.cwd, showRunPopover.value] as const,
  async ([c, open]) => {
    if (open && c) pkgScripts.value = await window.api.readPackageScripts(c)
  }
)

const startCommand = async (command: string): Promise<void> => {
  if (!command.trim() || !props.cwd) return
  await window.api.taskStart({ command: command.trim(), cwd: props.cwd })
  showRunPopover.value = false
  runCommand.value = ''
}

// Run button click: no task → open launcher; has task → restart it.
const onRunClick = async (): Promise<void> => {
  const t = primaryTask.value
  if (!t) {
    showRunPopover.value = !showRunPopover.value
    return
  }
  await window.api.taskRestart(t.id)
}

// Manual-trigger popover: dismiss on outside click / Escape.
const onDocPointerDown = (e: MouseEvent): void => {
  const el = e.target as HTMLElement
  if (el.closest('.run-popover') || el.closest('.run-btn')) return
  showRunPopover.value = false
}
const onDocKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') showRunPopover.value = false
}
watch(showRunPopover, (open) => {
  if (open) {
    document.addEventListener('mousedown', onDocPointerDown, true)
    document.addEventListener('keydown', onDocKey, true)
  } else {
    document.removeEventListener('mousedown', onDocPointerDown, true)
    document.removeEventListener('keydown', onDocKey, true)
  }
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocPointerDown, true)
  document.removeEventListener('keydown', onDocKey, true)
})
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

    <el-popover
      :visible="showRunPopover"
      placement="bottom-start"
      :width="280"
      popper-class="run-popover"
      trigger="manual"
    >
      <template #reference>
        <button
          class="run-btn"
          :class="{ active: !!primaryTask }"
          :title="primaryTask ? `重启：${primaryTask.name}` : '运行命令'"
          @click="onRunClick"
        >
          <RotateCw v-if="primaryTask" :size="13" />
          <Play v-else :size="13" />
        </button>
      </template>
      <div class="run-pop">
        <div class="run-pop-title">运行命令</div>
        <div v-if="pkgScriptNames.length" class="run-pop-scripts">
          <button
            v-for="s in pkgScriptNames"
            :key="s"
            class="run-pop-chip"
            :title="pkgScripts[s]"
            @click="startCommand(`npm run ${s}`)"
          >
            {{ s }}
          </button>
        </div>
        <div class="run-pop-row">
          <input
            v-model="runCommand"
            class="run-pop-input"
            placeholder="自定义命令"
            @keydown.enter="startCommand(runCommand)"
          />
          <button class="run-pop-go" @click="startCommand(runCommand)">运行</button>
        </div>
      </div>
    </el-popover>

    <button class="run-btn" title="查看任务" @click="emit('openTasks')">
      <ListChecks :size="13" />
    </button>

    <div v-if="diffStats.added || diffStats.deleted" class="diff-stats">
      <span class="diff-added">+{{ diffStats.added }}</span>
      <span class="diff-deleted">-{{ diffStats.deleted }}</span>
    </div>

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

.run-btn {
  background: none;
  border: 1px solid #555;
  color: #4ec9b0;
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
  border-color: #4ec9b0;
  color: #4ec9b0;
  background: #3e3e42;
}

/* Bound to a task → restart affordance, amber to read as "re-run". */
.run-btn.active {
  color: #d7a23b;
}

.run-btn.active:hover {
  border-color: #d7a23b;
  color: #d7a23b;
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

.diff-stats {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  font-size: 11px;
  line-height: 1;
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
  flex-shrink: 0;
}

.diff-added {
  color: #4ec9b0;
}

.diff-deleted {
  color: #f14c4c;
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
/* Run-command launcher popover (teleported to body by el-popover). */
.run-popover.el-popover.el-popper {
  background: #252526;
  border: 1px solid #454545;
  padding: 10px;
}

.run-popover .el-popper__arrow::before {
  background: #252526 !important;
  border-color: #454545 !important;
}

.run-pop-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #858585;
  margin-bottom: 8px;
}

.run-pop-scripts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}

.run-pop-chip {
  background: #0e639c33;
  border: 1px solid #0e639c66;
  color: #6cb6ff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  cursor: pointer;
}

.run-pop-chip:hover {
  background: #0e639c55;
}

.run-pop-row {
  display: flex;
  gap: 6px;
}

.run-pop-input {
  flex: 1;
  min-width: 0;
  background: #1e1e1e;
  border: 1px solid #3e3e42;
  border-radius: 4px;
  color: #d4d4d4;
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
}

.run-pop-input:focus {
  border-color: #094771;
}

.run-pop-go {
  background: #0e639c;
  border: none;
  color: #fff;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 4px;
  cursor: pointer;
}

.run-pop-go:hover {
  background: #1177bb;
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
</style>
