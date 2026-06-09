<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { GitMerge, GitCommitHorizontal, Eye, AlertTriangle, Check } from 'lucide-vue-next'
import DiffViewer from './DiffViewer.vue'

type MergeOpKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

interface ConflictedFile {
  path: string
  status: string
  description: string
}

interface MergeStatus {
  inProgress: MergeOpKind | null
  target: string | null
  onto: string | null
  conflicts: ConflictedFile[]
}

const props = defineProps<{ cwd: string }>()

const emit = defineEmits<{
  /** Fires whenever the merge state actually changed on disk (resolve, abort,
   *  continue). The host (PaneToolbar) re-fetches its own state in response. */
  changed: []
  /** Caller-driven close — used when --abort / --continue clears the state. */
  requestClose: []
}>()

const status = ref<MergeStatus | null>(null)
const loading = ref(false)
const busyFile = ref<string | null>(null)
const aborting = ref(false)
const continuing = ref(false)

// Pinned at refresh time so the abort/continue buttons keep working even after
// status briefly becomes null mid-operation. Without this the kind chip would
// flash empty during the loading window.
let lastKnownKind: MergeOpKind | null = null

const opLabel = computed(() => {
  switch (status.value?.inProgress) {
    case 'merge':
      return '正在合并'
    case 'rebase':
      return '正在变基'
    case 'cherry-pick':
      return '正在 cherry-pick'
    case 'revert':
      return '正在 revert'
    default:
      return ''
  }
})

const opClass = computed(() => {
  switch (status.value?.inProgress) {
    case 'merge':
      return 'op-merge'
    case 'rebase':
      return 'op-rebase'
    case 'cherry-pick':
      return 'op-cherry'
    case 'revert':
      return 'op-revert'
    default:
      return ''
  }
})

// During a rebase, git's --ours/--theirs labels are reversed (vs a merge):
// --ours = the commit being replayed (the branch you rebased)
// --theirs = the branch you rebased onto
// We surface this explicitly so the user picks the right side.
const oursLabel = computed(() =>
  status.value?.inProgress === 'rebase' ? '保留被变基侧（--ours）' : '保留我方（--ours）'
)
const theirsLabel = computed(() =>
  status.value?.inProgress === 'rebase' ? '保留变基目标（--theirs）' : '保留对方（--theirs）'
)

let refreshGen = 0

async function refresh(): Promise<void> {
  if (!props.cwd) return
  loading.value = true
  const myGen = ++refreshGen
  try {
    const s = await window.api.gitMergeStatus(props.cwd)
    if (myGen !== refreshGen) return
    status.value = s
    if (s.inProgress) lastKnownKind = s.inProgress
  } catch {
    if (myGen !== refreshGen) return
    status.value = null
  } finally {
    if (myGen === refreshGen) loading.value = false
  }
}

watch(
  () => props.cwd,
  () => refresh(),
  { immediate: true }
)

defineExpose({ refresh })

// 文件解决后,缓存的 diff(冲突 marker 版本)就过期了 —— 必须丢掉,否则用户
// 在 refresh 期间或者下次再展开看到的还是带冲突的旧 patch。同步丢掉 expanded
// 状态(resolve 后该文件多半已经从 conflicts 列表消失,但保险起见显式清理)。
function invalidateDiffCache(path: string): void {
  if (fileDiffs.value.has(path)) {
    const next = new Map(fileDiffs.value)
    next.delete(path)
    fileDiffs.value = next
  }
  if (expanded.value.has(path)) {
    const e = new Set(expanded.value)
    e.delete(path)
    expanded.value = e
  }
}

async function pickSide(file: ConflictedFile, side: 'ours' | 'theirs'): Promise<void> {
  if (!props.cwd) return
  busyFile.value = file.path
  try {
    const r = await window.api.gitConflictResolve(props.cwd, file.path, side)
    if (!r.success) {
      ElMessage.error(r.error || '解决冲突失败')
      return
    }
    ElMessage.success(side === 'ours' ? '已保留我方版本' : '已保留对方版本')
    invalidateDiffCache(file.path)
    emit('changed')
    await refresh()
  } finally {
    busyFile.value = null
  }
}

async function markResolved(file: ConflictedFile): Promise<void> {
  if (!props.cwd) return
  busyFile.value = file.path
  try {
    const r = await window.api.gitConflictMarkResolved(props.cwd, file.path)
    if (!r.success) {
      ElMessage.error(r.error || '标记失败')
      return
    }
    ElMessage.success('已标记为解决')
    invalidateDiffCache(file.path)
    emit('changed')
    await refresh()
  } finally {
    busyFile.value = null
  }
}

// Inline diff preview — folded in by default so the file list stays scannable.
// Stores expanded paths in a Set; toggling closes / opens a single panel.
const expanded = ref<Set<string>>(new Set())
const fileDiffs = ref<Map<string, { diff: string; truncated: boolean; loading: boolean }>>(
  new Map()
)

// DiffViewer 拉取整文件做语法高亮。冲突文件 diff 同 working diff：
// 左侧 = HEAD，右侧 = working tree（含 conflict markers）。
function fetchDiffContent(side: 'old' | 'new', path: string): Promise<string | null> {
  return window.api.gitShowFile(props.cwd, side === 'old' ? 'HEAD' : null, path)
}

async function toggleDiff(file: ConflictedFile): Promise<void> {
  const set = new Set(expanded.value)
  if (set.has(file.path)) {
    set.delete(file.path)
    expanded.value = set
    return
  }
  set.add(file.path)
  expanded.value = set

  // Already cached? Skip the IPC round-trip.
  if (fileDiffs.value.get(file.path) && !fileDiffs.value.get(file.path)?.loading) return

  const next = new Map(fileDiffs.value)
  next.set(file.path, { diff: '', truncated: false, loading: true })
  fileDiffs.value = next

  try {
    const r = await window.api.gitFileDiff(props.cwd, file.path)
    const updated = new Map(fileDiffs.value)
    updated.set(file.path, { diff: r.diff, truncated: r.truncated, loading: false })
    fileDiffs.value = updated
  } catch {
    const updated = new Map(fileDiffs.value)
    updated.set(file.path, { diff: '', truncated: false, loading: false })
    fileDiffs.value = updated
  }
}

async function doAbort(): Promise<void> {
  const kind = status.value?.inProgress || lastKnownKind
  if (!kind || !props.cwd) return
  try {
    await ElMessageBox.confirm(
      `确定要中止当前${opLabel.value.replace(/^正在/, '')}操作？`,
      '中止操作',
      {
        confirmButtonText: '中止',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return
  }
  aborting.value = true
  try {
    const r = await window.api.gitMergeAbort(props.cwd, kind)
    if (!r.success) {
      ElMessage.error(r.error || '中止失败')
      return
    }
    ElMessage.success('已中止')
    emit('changed')
    await refresh()
    if (!status.value?.inProgress) emit('requestClose')
  } finally {
    aborting.value = false
  }
}

async function doContinue(): Promise<void> {
  const kind = status.value?.inProgress || lastKnownKind
  if (!kind || !props.cwd) return
  continuing.value = true
  try {
    const r = await window.api.gitMergeContinue(props.cwd, kind)
    if (!r.success) {
      ElMessage.error(r.error || '继续失败')
      return
    }
    ElMessage.success('已继续')
    emit('changed')
    await refresh()
    if (!status.value?.inProgress) emit('requestClose')
  } finally {
    continuing.value = false
  }
}

const canContinue = computed(() => {
  // Rebase/cherry-pick/revert can be continued after every file is staged,
  // even if conflicts remain in earlier patches — but the safest UX is "all
  // visible conflicts resolved". For merge, --continue is only available since
  // git 2.12; --no-edit makes it work without an editor.
  return !!status.value?.inProgress && status.value.conflicts.length === 0
})
</script>

<template>
  <div class="ms-root">
    <div v-if="loading && !status" class="ms-empty">加载中…</div>
    <div v-else-if="!status?.inProgress && !status?.conflicts.length" class="ms-empty">
      <Check :size="18" style="margin-right: 6px; vertical-align: -3px" />
      当前没有进行中的合并 / 变基 / cherry-pick / revert
    </div>
    <template v-else>
      <header class="ms-banner" :class="opClass">
        <GitMerge :size="16" />
        <span class="ms-op-label">{{ opLabel }}</span>
        <span v-if="status?.target" class="ms-target">
          <span class="ms-target-label">分支/对象</span>
          <code>{{ status.target }}</code>
        </span>
        <span v-if="status?.onto" class="ms-target">
          <span class="ms-target-label">到</span>
          <code>{{ status.onto }}</code>
        </span>
        <span class="ms-conflict-count">
          <AlertTriangle :size="13" />
          {{ status?.conflicts.length || 0 }} 个冲突
        </span>
      </header>

      <div v-if="status?.conflicts.length" class="ms-list">
        <div v-for="f in status.conflicts" :key="f.path" class="ms-item">
          <div class="ms-item-head">
            <span class="ms-status-chip" :title="f.status">{{ f.description }}</span>
            <span class="ms-path" :title="f.path">{{ f.path }}</span>
            <div class="ms-actions">
              <el-tooltip content="查看差异" placement="top" :show-after="300">
                <button
                  class="ms-icon-btn"
                  :class="{ active: expanded.has(f.path) }"
                  @click="toggleDiff(f)"
                >
                  <Eye :size="13" />
                </button>
              </el-tooltip>
              <el-button size="small" :loading="busyFile === f.path" @click="pickSide(f, 'ours')">
                {{ oursLabel }}
              </el-button>
              <el-button size="small" :loading="busyFile === f.path" @click="pickSide(f, 'theirs')">
                {{ theirsLabel }}
              </el-button>
              <el-button
                size="small"
                type="success"
                :loading="busyFile === f.path"
                @click="markResolved(f)"
              >
                已解决
              </el-button>
            </div>
          </div>
          <div v-if="expanded.has(f.path)" class="ms-diff">
            <div v-if="fileDiffs.get(f.path)?.loading" class="ms-diff-state">加载差异…</div>
            <template v-else-if="fileDiffs.get(f.path)">
              <div v-if="fileDiffs.get(f.path)!.truncated" class="ms-diff-trunc">
                差异过大，仅显示前 4 MB
              </div>
              <DiffViewer
                v-if="fileDiffs.get(f.path)!.diff"
                :diff="fileDiffs.get(f.path)!.diff"
                :fetch-content="fetchDiffContent"
              />
              <div v-else class="ms-diff-state">无文本差异</div>
            </template>
          </div>
        </div>
      </div>
      <div v-else class="ms-all-resolved">
        <GitCommitHorizontal :size="16" />
        所有冲突已解决 — 可点击「继续」完成操作
      </div>
    </template>

    <footer v-if="status?.inProgress || lastKnownKind" class="ms-footer">
      <el-button size="small" :loading="aborting" @click="doAbort">中止操作</el-button>
      <el-button
        size="small"
        type="primary"
        :disabled="!canContinue"
        :loading="continuing"
        @click="doContinue"
      >
        继续操作
      </el-button>
    </footer>
  </div>
</template>

<style scoped lang="scss" src="@renderer/assets/style/components/MergeStatusPanel.scss"></style>
