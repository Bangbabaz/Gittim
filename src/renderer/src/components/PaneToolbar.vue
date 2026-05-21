<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  GitBranch,
  GitMerge,
  History,
  Play,
  RotateCw,
  Square,
  ListChecks,
  ChevronDown,
  FolderGit2,
  Trash2,
  FolderClosed,
  RefreshCw
} from 'lucide-vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'
import DiffViewer from './DiffViewer.vue'
import MergeStatusPanel from './MergeStatusPanel.vue'
import GitLogViewer from './GitLogViewer.vue'
import { iconFor } from './ideIcons'

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

type WorktreePlacement = 'top' | 'bottom' | 'left' | 'right'

const emit = defineEmits<{
  worktreeCreated: [path: string, placement: WorktreePlacement]
  openTasks: []
  // cwd scopes the manager to that folder; newDraft also starts a fresh draft
  // (the "为此文件夹新建命令" shortcut). Both pane entries pass this pane's cwd.
  manageTasks: [cwd?: string, newDraft?: boolean]
}>()

const isRepo = ref(false)
const currentBranch = ref<string | null>(null)
const branches = ref<
  { name: string; local: boolean; remote: boolean; remoteName?: string; worktree?: boolean }[]
>([])
const switching = ref(false)
const diffStats = ref({ added: 0, deleted: 0 })
const showLocal = ref(true)
const showRemote = ref(true)

type MergeOpKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null
const mergeStatus = ref<{
  inProgress: MergeOpKind
  target: string | null
  onto: string | null
  conflicts: { path: string; status: string; description: string }[]
} | null>(null)
const showMerge = ref(false)
const showLog = ref(false)

// Banner shown ON the toolbar when an op is in progress. The dialog body
// repeats the same info — this one's the at-a-glance hint that something
// needs attention. Empty string when nothing's in progress (template hides it).
const mergeBadgeLabel = computed(() => {
  const s = mergeStatus.value
  if (!s || (!s.inProgress && !s.conflicts.length)) return ''
  const opText =
    s.inProgress === 'merge'
      ? '合并'
      : s.inProgress === 'rebase'
        ? '变基'
        : s.inProgress === 'cherry-pick'
          ? 'cherry-pick'
          : s.inProgress === 'revert'
            ? 'revert'
            : '冲突'
  const target = s.target ? `（${s.target}）` : ''
  return `${opText}进行中${target} — ${s.conflicts.length} 个冲突`
})

const mergeBadgeVisible = computed(() => {
  const s = mergeStatus.value
  return !!s && (!!s.inProgress || s.conflicts.length > 0)
})

const localBranches = computed(() => branches.value.filter((b) => b.local))
const remoteBranches = computed(() => branches.value.filter((b) => b.remote))

function toggleLocal(checked: boolean | string | number): void {
  const v = Boolean(checked)
  if (!v && !showRemote.value) return // keep last one checked
  showLocal.value = v
}
function toggleRemote(checked: boolean | string | number): void {
  const v = Boolean(checked)
  if (!v && !showLocal.value) return
  showRemote.value = v
}

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
      mergeStatus.value = null
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
// Once the user types in the 项目名 field we stop auto-deriving it from the
// branch, so a deliberate name isn't clobbered when they tweak 从分支/新分支.
const wtNameEdited = ref(false)
const wtLocation = ref('')
const wtPlacement = ref<WorktreePlacement>('right')
const wtSubmitting = ref(false)
// Cached repo name (main working tree's folder name). Fetched on dialog open
// so the project-name default is `<repo>-<branch>` even when the user is
// already inside a worktree — otherwise the current folder is already named
// `<repo>-<oldBranch>` and we'd compound it into `<repo>-<oldBranch>-<new>`.
const repoName = ref<string | null>(null)

const folderName = computed(() => {
  if (repoName.value) return repoName.value
  const parts = (props.cwd ?? '').replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || '项目'
})

const parentDir = computed(() => {
  const p = (props.cwd ?? '').replace(/\\/g, '/')
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.substring(0, idx) : p
})

// `wtFromBranch` is encoded as `<source>:<name>` (`local:master` /
// `remote:feature/x`) so the same branch name appearing in both 本地分支 and
// 远程分支 groups can be told apart by the el-select.
function parseFromBranch(v: string): { source: 'local' | 'remote'; name: string } {
  const idx = v.indexOf(':')
  if (idx < 0) return { source: 'local', name: v }
  const src = v.slice(0, idx)
  return { source: src === 'remote' ? 'remote' : 'local', name: v.slice(idx + 1) }
}

// Default folder name = 项目文件夹 + "-" + 分支名. The branch is the new
// branch name when creating one, otherwise the selected 从分支 (NOT the repo's
// live HEAD — the dialog's dropdown is the source of truth so the name tracks
// what the user picks).
const defaultProjectName = computed(() => {
  const fromName = parseFromBranch(wtFromBranch.value).name
  const raw =
    wtNewBranch.value && wtNewBranchName.value
      ? wtNewBranchName.value
      : fromName || currentBranch.value || 'worktree'
  // A branch like `feat/xx` or `fix/xx` must NOT become a folder name with a
  // slash (that nests `原文件夹-feat/xx`). Use only the last segment.
  const leaf = raw.split('/').filter(Boolean).pop() || 'worktree'
  return `${folderName.value}-${leaf}`
})

// Resolved target path (location + project name). Used to pre-warn when a
// same-named folder already exists, before git refuses on submit.
const wtFullPath = computed(() => {
  const loc = wtLocation.value.trim().replace(/[\\/]+$/, '')
  const name = wtProjectName.value.trim()
  if (!loc || !name) return ''
  const sep = loc.includes('\\') || (props.cwd ?? '').includes('\\') ? '\\' : '/'
  return `${loc}${sep}${name}`
})

const wtPathExists = ref(false)
let wtCheckGen = 0
watch([wtFullPath, showWorktreeDialog], async () => {
  if (!showWorktreeDialog.value || !wtFullPath.value) {
    wtPathExists.value = false
    return
  }
  const gen = ++wtCheckGen
  try {
    const exists = await window.api.pathExists(wtFullPath.value)
    if (gen === wtCheckGen) wtPathExists.value = exists
  } catch {
    if (gen === wtCheckGen) wtPathExists.value = false
  }
})

// Auto-check "新分支" when the base comes from a remote — git worktree add
// against a remote ref alone yields a detached HEAD, so the natural action
// is to create a tracking branch with the same name. Triggers on user pick
// of any `remote:<name>` option, even when a local branch with that name
// also exists (user explicitly chose the remote source).
watch(wtFromBranch, (v) => {
  const { source, name } = parseFromBranch(v)
  if (source === 'remote' && !wtNewBranch.value) {
    wtNewBranch.value = true
    if (!wtNameEdited.value) wtNewBranchName.value = name
  }
})

// Keep 项目名 in sync with 从分支 / 新分支 until the user takes it over.
watch([wtNewBranch, wtNewBranchName, wtFromBranch], () => {
  if (!wtNameEdited.value) wtProjectName.value = defaultProjectName.value
})

// el-input @input only fires on real user keystrokes, never on the
// programmatic assignment above — so this reliably flags a deliberate edit.
function onProjectNameInput(): void {
  wtNameEdited.value = true
}

async function openWorktreeDialog(): Promise<void> {
  // Reset repo name first so the computed defaultProjectName falls back to
  // folderName-from-cwd if the IPC call lags. The fetched value below then
  // re-triggers the watcher and the project-name field updates.
  repoName.value = null
  // currentBranch is always a local branch (HEAD), so seed with the local
  // source — and assign it BEFORE wtNewBranch is reset so the watch on
  // wtFromBranch (which auto-checks 新分支 for `remote:` picks) doesn't
  // misfire and flip wtNewBranch back to true.
  wtFromBranch.value = currentBranch.value ? `local:${currentBranch.value}` : ''
  wtNewBranch.value = false
  wtNewBranchName.value = ''
  wtNameEdited.value = false
  wtLocation.value = parentDir.value
  wtPlacement.value = 'right'
  showWorktreeDialog.value = true

  if (props.cwd) {
    try {
      repoName.value = await window.api.getRepoName(props.cwd)
    } catch {
      repoName.value = null
    }
  }
  // Re-apply the default with the (possibly newly-fetched) repo name. The
  // watcher on wtNewBranch/wtFromBranch will also keep this in sync as the
  // user toggles new-branch / picks a different base.
  if (!wtNameEdited.value) wtProjectName.value = defaultProjectName.value
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
    // Only conflict with EXISTING LOCAL branches. A remote-only branch with
    // the same name is fine — that's the canonical "track origin/<name>" path
    // when the user picks a remote source and auto-checks 新分支.
    if (branches.value.some((b) => b.name === name && b.local)) {
      ElMessage.error(`本地分支 "${name}" 已存在`)
      return
    }
  }
  const sep = props.cwd.includes('\\') ? '\\' : '/'
  const fullPath = `${wtLocation.value.replace(/\\/g, sep)}${sep}${wtProjectName.value.trim()}`
  // Re-check at submit time: the reactive hint may be stale if the user
  // clicked before the debounced check settled. Never create into an existing
  // path — git would refuse anyway, but warn clearly instead of failing late.
  if (await window.api.pathExists(fullPath)) {
    wtPathExists.value = true
    ElMessage.error(`同名文件夹已存在：${fullPath}`)
    return
  }
  // Decode `local:<name>` / `remote:<name>` to figure out which ref to base
  // the new worktree on. A `remote:` pick passes `<remote>/<name>` so git
  // resolves the remote-tracking ref (and, paired with newBranch above, sets
  // up a local tracking branch). A `local:` pick passes the bare name.
  const { source, name: fromName } = parseFromBranch(wtFromBranch.value)
  let fromBranchRef: string | undefined
  if (source === 'remote' && fromName) {
    const info = branches.value.find((b) => b.name === fromName && b.remote)
    fromBranchRef = `${info?.remoteName || 'origin'}/${fromName}`
  } else {
    fromBranchRef = fromName || undefined
  }
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
      emit('worktreeCreated', fullPath, wtPlacement.value)
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

// Tasks are global, but each pane's picker is scoped to that pane's folder:
// it only lists / selects / controls tasks whose cwd matches props.cwd, so
// `npm run dev` in folder A and another in folder B stay independent (running
// one never shows the other as running).
const allTasks = ref<TaskMeta[]>([])
const selectedId = ref<string | null>(null)
let unsubTaskStatus: (() => void) | null = null
let unsubTaskRemoved: (() => void) | null = null

// Folder identity: normalize separators + trailing slash; Windows paths
// (drive-letter prefix) compare case-insensitively.
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

// Keep the selection valid and folder-scoped as tasks come/go or the pane's
// cwd changes (paneTasks depends on both allTasks and props.cwd).
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

// Run / re-run the command picked in the dropdown. taskStart handles both:
// idle → spawn, running → kill + respawn (reset buffer).
const runSelected = async (): Promise<void> => {
  if (selectedTask.value) await window.api.taskStart({ id: selectedTask.value.id })
}

const stopTask = async (id: string): Promise<void> => {
  await window.api.taskStop(id)
}

// -- IDE picker ------------------------------------------------------------
// Detection happens once per session on the main side (cached); the picker
// here is a "default IDE + dropdown to switch". Left chip = open default
// IDE on cwd; small caret = expand the list. Choosing an entry both opens
// the cwd AND remembers that IDE as the new default (persisted via
// settings.json → `defaultIde`).
type IdeInfo = { id: string; name: string; command: string; iconDataUrl?: string }
const ides = ref<IdeInfo[]>([])
const ideLoading = ref(false)
const defaultIdeId = ref<string | null>(null)

// The actually-resolved default: the persisted id if it's still installed,
// else the first detected IDE, else null. We re-derive on every change so
// uninstalled IDEs don't leave a dead chip on the toolbar.
const defaultIde = computed<IdeInfo | null>(() => {
  if (!ides.value.length) return null
  const persisted = defaultIdeId.value ? ides.value.find((i) => i.id === defaultIdeId.value) : null
  return persisted || ides.value[0]
})

const defaultIdeIcon = computed(() =>
  defaultIde.value ? iconFor(defaultIde.value.id, defaultIde.value.name) : null
)

async function loadIdes(force = false): Promise<void> {
  ideLoading.value = true
  try {
    ides.value = await window.api.ideList(force)
  } catch {
    ides.value = []
  } finally {
    ideLoading.value = false
  }
}

onMounted(async () => {
  // Kick off everything that needs the IPC bridge in parallel: initial git
  // state for the toolbar, task list + subscriptions, IDE detection, and the
  // persisted default IDE. Each landing independently keeps the toolbar
  // interactive even if (say) IDE detection takes a while on Windows.
  refresh()
  allTasks.value = await window.api.taskList()
  unsubTaskStatus = window.api.onTaskStatus(upsertTask)
  unsubTaskRemoved = window.api.onTaskRemoved(({ id }) => {
    allTasks.value = allTasks.value.filter((t) => t.id !== id)
  })
  const [settings] = await Promise.all([window.api.settingsGet(), loadIdes(false)])
  if (typeof settings.defaultIde === 'string') {
    defaultIdeId.value = settings.defaultIde
  }
})

// Open with a specific IDE. Single source of truth for "open + remember" so
// the chip click and the dropdown click can't drift apart.
async function openWithIde(id: string): Promise<void> {
  if (!props.cwd) return
  const r = await window.api.ideOpen(id, props.cwd)
  if (!r.success) {
    ElMessage.error(r.error || '打开 IDE 失败')
    return
  }
  if (defaultIdeId.value !== id) {
    defaultIdeId.value = id
    window.api.settingsSet({ defaultIde: id })
  }
}

// Left chip click: open with the resolved default. Refuses politely if
// nothing is detected — the dropdown next to it stays available for the
// "重新检测" entry so the user has a path forward.
const openDefaultIde = async (): Promise<void> => {
  if (!defaultIde.value) {
    if (!props.cwd) return
    await window.api.openFolder(props.cwd)
    return
  }
  await openWithIde(defaultIde.value.id)
}

// Dropdown command handler. Carets ('__refresh__') are sentinels we own;
// everything else is an IDE id.
const onPickIde = async (cmd: string): Promise<void> => {
  if (cmd === '__refresh__') {
    await loadIdes(true)
    ElMessage.success(ides.value.length ? `检测到 ${ides.value.length} 个 IDE` : '未检测到任何 IDE')
    return
  }
  await openWithIde(cmd)
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
      <template #header>
        <div class="branch-filter-header">
          <el-checkbox :model-value="showLocal" size="small" @update:model-value="toggleLocal">
            本地 ({{ localBranches.length }})
          </el-checkbox>
          <el-checkbox :model-value="showRemote" size="small" @update:model-value="toggleRemote">
            远程 ({{ remoteBranches.length }})
          </el-checkbox>
        </div>
      </template>
      <el-option-group v-if="showLocal" label="本地分支">
        <el-option v-for="b in localBranches" :key="b.name" :label="b.name" :value="b.name">
          <span class="br-opt">
            <span class="br-name">{{ b.name }}</span>
            <span v-if="b.worktree" class="br-tag worktree" title="该分支已在其他工作树检出"
              >工作树</span
            >
            <span class="br-tag local">本地</span>
            <span v-if="b.remote" class="br-tag remote">远程</span>
          </span>
        </el-option>
      </el-option-group>
      <el-option-group v-if="showRemote && remoteBranches.length" label="远程分支">
        <el-option v-for="b in remoteBranches" :key="b.name" :label="b.name" :value="b.name">
          <span class="br-opt">
            <span class="br-name">{{ b.name }}</span>
            <span class="br-tag remote">远程</span>
          </span>
        </el-option>
      </el-option-group>
    </el-select>
    <el-tooltip content="新建工作树" placement="bottom" :show-after="300">
      <button class="wt-btn" @click="openWorktreeDialog">+</button>
    </el-tooltip>
    <el-tooltip content="管理工作树" placement="bottom" :show-after="300">
      <button class="wt-btn icon" @click="openWtManage">
        <FolderGit2 :size="13" />
      </button>
    </el-tooltip>
    <el-tooltip content="提交历史" placement="bottom" :show-after="300">
      <button class="wt-btn icon" @click="showLog = true">
        <History :size="13" />
      </button>
    </el-tooltip>
    <el-tooltip
      v-if="mergeBadgeVisible"
      :content="mergeBadgeLabel"
      placement="bottom"
      :show-after="300"
    >
      <button class="merge-badge" @click="showMerge = true">
        <GitMerge :size="12" />
        <span class="merge-badge-count">{{ mergeStatus?.conflicts.length || 0 }}</span>
      </button>
    </el-tooltip>

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
        selectedTask.status === 'running'
          ? `重启：${selectedTask.name}`
          : `运行：${selectedTask.name}`
      "
      placement="bottom"
      :show-after="300"
    >
      <button class="run-btn" @click="runSelected">
        <RotateCw v-if="selectedTask.status === 'running'" :size="13" />
        <Play v-else :size="13" />
      </button>
    </el-tooltip>

    <!-- Stop: only when something is running. One running → direct button;
         many → dropdown to pick which (no caret). -->
    <el-tooltip
      v-if="runningTasks.length === 1"
      :content="`停止：${runningTasks[0].name}`"
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

    <!-- Open in IDE — connected pair. Left chip = open with default IDE
         immediately; right caret = expand the list to pick a different one
         (which also becomes the new default). Together carry margin-left:
         auto so they (and the diff badge after) anchor to the right. -->
    <div class="ide-group">
      <el-tooltip
        :content="defaultIde ? `在 ${defaultIde.name} 中打开` : '在文件管理器中打开'"
        placement="bottom"
        :show-after="300"
      >
        <button
          class="ide-chip"
          :class="{ 'has-real-icon': !!defaultIde?.iconDataUrl }"
          :disabled="ideLoading"
          :style="
            defaultIde?.iconDataUrl
              ? undefined
              : defaultIdeIcon
                ? { background: defaultIdeIcon.color, color: '#fff' }
                : undefined
          "
          @click="openDefaultIde"
        >
          <!-- Priority: real icon extracted from the .exe / .app → handwritten
               brand SVG → coloured chip with the IDE's initial → generic
               external-link glyph (nothing detected at all). -->
          <img
            v-if="defaultIde?.iconDataUrl"
            class="ide-chip-img"
            :src="defaultIde.iconDataUrl"
            alt=""
            draggable="false"
          />
          <svg
            v-else-if="defaultIdeIcon && defaultIdeIcon.path"
            class="ide-chip-svg"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path :d="defaultIdeIcon.path" fill="currentColor" />
          </svg>
          <span v-else-if="defaultIdeIcon" class="ide-chip-letter">
            {{ defaultIdeIcon.letter }}
          </span>
          <FolderClosed v-else :size="13" />
        </button>
      </el-tooltip>
      <el-dropdown
        trigger="click"
        placement="bottom-end"
        popper-class="ide-pick-dropdown"
        @command="onPickIde"
      >
        <button class="ide-caret" :disabled="ideLoading" title="切换 IDE">
          <ChevronDown :size="12" />
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="ide in ides"
              :key="ide.id"
              :command="ide.id"
              :title="ide.command"
              :class="{ picked: ide.id === defaultIde?.id }"
            >
              <span
                class="ide-row-icon"
                :class="{ 'has-real-icon': !!ide.iconDataUrl }"
                :style="
                  ide.iconDataUrl ? undefined : { background: iconFor(ide.id, ide.name).color }
                "
              >
                <img v-if="ide.iconDataUrl" :src="ide.iconDataUrl" alt="" draggable="false" />
                <svg
                  v-else-if="iconFor(ide.id, ide.name).path"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path :d="iconFor(ide.id, ide.name).path" fill="#fff" />
                </svg>
                <span v-else class="ide-row-letter">
                  {{ iconFor(ide.id, ide.name).letter }}
                </span>
              </span>
              <span class="td-label">{{ ide.name }}</span>
            </el-dropdown-item>
            <el-dropdown-item v-if="!ides.length" disabled class="cmd-empty">
              未检测到 IDE
            </el-dropdown-item>
            <el-dropdown-item divided command="__refresh__">
              <RefreshCw :size="12" style="margin-right: 6px" />
              重新检测
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <el-tooltip
      v-if="diffStats.added || diffStats.deleted"
      content="查看改动 (diff)"
      placement="bottom"
      :show-after="300"
    >
      <button class="diff-stats" @click="openDiff">
        <span class="diff-added">+{{ diffStats.added }}</span>
        <span class="diff-deleted">-{{ diffStats.deleted }}</span>
      </button>
    </el-tooltip>

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
            <template #header>
              <div class="branch-filter-header">
                <el-checkbox
                  :model-value="showLocal"
                  size="small"
                  @update:model-value="toggleLocal"
                >
                  本地 ({{ localBranches.length }})
                </el-checkbox>
                <el-checkbox
                  :model-value="showRemote"
                  size="small"
                  @update:model-value="toggleRemote"
                >
                  远程 ({{ remoteBranches.length }})
                </el-checkbox>
              </div>
            </template>
            <el-option-group v-if="showLocal" label="本地分支">
              <el-option
                v-for="b in localBranches"
                :key="`local:${b.name}`"
                :label="b.name"
                :value="`local:${b.name}`"
              >
                <span class="br-opt">
                  <span class="br-name">{{ b.name }}</span>
                  <span v-if="b.worktree" class="br-tag worktree" title="该分支已在其他工作树检出"
                    >工作树</span
                  >
                  <span class="br-tag local">本地</span>
                  <span v-if="b.remote" class="br-tag remote">远程</span>
                </span>
              </el-option>
            </el-option-group>
            <el-option-group v-if="showRemote && remoteBranches.length" label="远程分支">
              <el-option
                v-for="b in remoteBranches"
                :key="`remote:${b.name}`"
                :label="`${b.remoteName || 'origin'}/${b.name}`"
                :value="`remote:${b.name}`"
              >
                <span class="br-opt">
                  <span class="br-name">{{ b.remoteName || 'origin' }}/{{ b.name }}</span>
                  <span class="br-tag remote">远程</span>
                </span>
              </el-option>
            </el-option-group>
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
          <el-input
            v-model="wtProjectName"
            class="wt-field"
            size="small"
            @input="onProjectNameInput"
          />
        </div>

        <div class="wt-row">
          <label class="wt-label">位置</label>
          <div class="wt-field" style="display: flex; gap: 8px">
            <el-input v-model="wtLocation" size="small" style="flex: 1" />
            <el-button size="small" @click="handleBrowseLocation">浏览</el-button>
          </div>
        </div>

        <div class="wt-row">
          <label class="wt-label">面板位置</label>
          <el-radio-group v-model="wtPlacement" size="small" class="wt-field wt-placement">
            <el-radio-button label="top">上</el-radio-button>
            <el-radio-button label="bottom">下</el-radio-button>
            <el-radio-button label="left">左</el-radio-button>
            <el-radio-button label="right">右</el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <div v-if="wtPathExists" class="wt-warn">同名文件夹已存在：{{ wtFullPath }}</div>

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
      :lock-scroll="true"
      :close-on-click-modal="false"
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

    <!-- Merge / conflict resolver. v-if so the panel re-fetches state on each
         open instead of stale state from a previous merge that's since landed. -->
    <el-dialog
      v-model="showMerge"
      title="合并 / 冲突"
      width="92%"
      top="4vh"
      class="diff-dialog"
      :lock-scroll="true"
      :close-on-click-modal="false"
    >
      <MergeStatusPanel
        v-if="showMerge && props.cwd"
        :cwd="props.cwd"
        @changed="refresh"
        @request-close="showMerge = false"
      />
      <template #footer>
        <el-button size="small" @click="showMerge = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- Commit history viewer -->
    <el-dialog
      v-model="showLog"
      title="提交历史"
      width="92%"
      top="4vh"
      class="diff-dialog"
      :lock-scroll="true"
      :close-on-click-modal="false"
    >
      <GitLogViewer v-if="showLog && props.cwd" :cwd="props.cwd" />
      <template #footer>
        <el-button size="small" @click="showLog = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.wt-btn {
  background: none;
  border: 1px solid var(--el-border-color);
  color: var(--el-text-color-regular);
  width: 20px;
  height: 20px;
  border-radius: $radius-sm;
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
  border-color: var(--el-text-color-secondary);
  color: var(--el-color-primary);
  background: var(--el-fill-color);
}

/* Action buttons: white icon on a semantic filled background, unified look.
   Uses the base semantic colour (not light-3) so contrast is readable in
   both themes — Element Plus's light-3 in light mode is a very pale fill
   where white text drops below WCAG AA (~1.6:1). */
.run-btn {
  background: var(--el-color-success);
  border: none;
  color: #fff;
  width: 20px;
  height: 20px;
  border-radius: $radius-sm;
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
  background: var(--el-color-success-light-3);
  color: #fff;
}

.run-btn.stop {
  background: var(--el-color-danger);
}

.run-btn.stop:hover {
  background: var(--el-color-danger-light-3);
}

/* View tasks — neutral, not a semantic run/stop action. Outlined (like the
   worktree button) instead of a filled neutral chip: a filled neutral fill
   with the base .run-btn's white icon is invisible in the light theme. */
.run-btn.view {
  @include neutral-outlined-btn;
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
  border: 1px solid var(--el-border-color);
  border-radius: $radius-sm;
  color: var(--el-text-color-regular);
  font-size: 12px;
  cursor: pointer;
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
  color: var(--el-text-color-regular);
  width: 52px;
  flex-shrink: 0;
  text-align: right;
}

.wt-field {
  flex: 1;
  min-width: 0;
}

/* 4 equal-width segments so 上/下/左/右 fill the row like a segmented control. */
.wt-placement {
  display: flex;
}

.wt-placement :deep(.el-radio-button) {
  flex: 1;
}

.wt-placement :deep(.el-radio-button__inner) {
  width: 100%;
}

.wt-warn {
  margin-top: 12px;
  font-size: 12px;
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--el-color-warning) 27%, transparent);
  padding: 6px 10px;
  border-radius: $radius;
  word-break: break-all;
}

.wt-btn.icon {
  font-size: 0;
}

/* Merge/conflict in-progress chip — only rendered when an op is active. Uses
   the danger palette so it stands out against neutral toolbar siblings. */
.merge-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  background: color-mix(in srgb, var(--el-color-danger) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--el-color-danger) 45%, transparent);
  color: var(--el-color-danger);
  border-radius: $radius-sm;
  font-size: 11px;
  cursor: pointer;
  font-family: $font-ui;
  font-weight: 600;
  flex-shrink: 0;
  margin-left: 2px;
}

.merge-badge:hover {
  background: color-mix(in srgb, var(--el-color-danger) 22%, transparent);
}

.merge-badge-count {
  font-family: $font-mono;
}

/* Open-in-IDE control: a connected pair (brand chip + small caret) that
   together carry the auto margin anchoring the right-hand cluster. */
.ide-group {
  margin-left: auto;
  display: inline-flex;
  align-items: stretch;
  height: 20px;
  flex-shrink: 0;
}

/* Left chip — coloured square showing the active IDE's brand logo. The
   inline `background` style on the element supplies the brand colour;
   :hover dims/brightens via filter so we don't have to mirror each colour. */
.ide-chip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--el-border-color);
  border-right: none;
  border-radius: $radius-sm 0 0 $radius-sm;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-regular);
  cursor: pointer;
  flex-shrink: 0;
  transition: filter 0.12s;
}

.ide-chip:hover:not(:disabled) {
  filter: brightness(1.1);
}

.ide-chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ide-chip-svg {
  width: 13px;
  height: 13px;
  display: block;
}

.ide-chip-img {
  width: 16px;
  height: 16px;
  display: block;
  /* Native exe icons already bring their own colour scheme; we just need a
     transparent chip behind them. The :class="has-real-icon" branch handles
     that — but make sure the image itself sits crisp at 16px on both DPIs. */
  image-rendering: -webkit-optimize-contrast;
}

.ide-chip.has-real-icon {
  background: transparent !important;
  border-color: var(--el-border-color);
}

.ide-chip-letter {
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  font-family: $font-ui;
}

/* Caret — slim button glued to the chip's right edge. */
.ide-caret {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 20px;
  padding: 0;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: 0 $radius-sm $radius-sm 0;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  flex-shrink: 0;
}

.ide-caret:hover:not(:disabled) {
  background: var(--el-fill-color);
  color: var(--el-color-primary);
  border-color: var(--el-text-color-secondary);
}

.ide-caret:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Dropdown rows: brand-coloured 18px square + IDE name. The current default
   gets a subtle highlight so the user can see what the chip will open. */
.ide-row-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  margin-right: 8px;
  flex-shrink: 0;
}

.ide-row-icon svg {
  width: 12px;
  height: 12px;
  display: block;
}

.ide-row-icon img {
  width: 16px;
  height: 16px;
  display: block;
}

.ide-row-icon.has-real-icon {
  background: transparent !important;
}

.ide-row-letter {
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  font-family: $font-ui;
}

.diff-stats {
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
  border-color: var(--el-border-color);
  background: var(--el-fill-color);
}

.diff-added {
  color: var(--el-color-success);
}

.diff-deleted {
  color: var(--el-color-danger);
}

/* Branch-switch confirm */
.switch-msg {
  font-size: 13px;
  color: var(--el-text-color-primary);
  line-height: 1.7;
}

.switch-msg code {
  font-family: $font-mono;
  font-size: 12px;
  background: var(--el-fill-color-blank);
  padding: 1px 5px;
  border-radius: $radius-sm;
}

/* Worktree management list */
.wt-manage-empty {
  color: var(--el-text-color-placeholder);
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
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color);
  border-radius: $radius-md;
}

.wt-manage-info {
  flex: 1;
  min-width: 0;
}

.wt-manage-path {
  font-size: 12px;
  color: var(--el-text-color-primary);
  font-family: $font-mono;
  @include ellipsis;
}

.wt-manage-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.wt-manage-branch {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.wt-del-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--el-color-danger) 40%, transparent);
  color: var(--el-color-danger);
  border-radius: $radius;
  cursor: pointer;
}

.wt-del-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--el-color-danger) 13%, transparent);
  border-color: var(--el-color-danger);
}

.wt-del-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.wt-main-hint {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  flex-shrink: 0;
}

/* Diff viewer */
.diff-state {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  padding: 40px 4px;
  text-align: center;
}

.diff-trunc {
  font-size: 12px;
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 10%, transparent);
  padding: 6px 10px;
  margin: 8px 12px 0;
  border-radius: $radius;
}
</style>

<style scoped lang="scss">
.pane-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  background: var(--el-fill-color-light);
  border-bottom: 1px solid var(--el-border-color);
  flex-shrink: 0;
  user-select: none;
}

.git-icon {
  color: var(--el-color-danger);
  flex-shrink: 0;
}

.branch-select {
  width: 160px;
  --el-select-input-font-size: 12px;

  :deep(.el-select__wrapper) {
    padding: 0 8px;
    min-height: 22px;
  }

  :deep(.el-select__selected-item) {
    font-size: 12px;
    font-family: $font-ui;
  }

  :deep(.el-select__placeholder) {
    font-size: 12px;
    font-family: $font-ui;
  }
}
</style>
