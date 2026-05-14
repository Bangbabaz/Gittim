<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { GitBranch } from 'lucide-vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps<{
  cwd: string | undefined
}>()

const emit = defineEmits<{
  worktreeCreated: [path: string]
}>()

const isRepo = ref(false)
const currentBranch = ref<string | null>(null)
const branches = ref<string[]>([])
const switching = ref(false)

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
    const list = await window.api.getGitBranches(props.cwd)
    if (myGen !== refreshGen) return
    isRepo.value = true
    currentBranch.value = info.branch
    branches.value = list
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
      await ElMessageBox.confirm(
        '当前有未提交的更改，切换分支后可能丢失。确定继续？',
        '警告',
        { confirmButtonText: '继续切换', cancelButtonText: '取消', type: 'warning' }
      )
    }
  } catch {
    // user cancelled
    return
  }

  const prev = currentBranch.value
  switching.value = true
  currentBranch.value = newBranch
  // Invalidate any in-flight refresh — its result is now stale.
  ++refreshGen
  try {
    const result = await window.api.gitCheckout(props.cwd, newBranch)
    if (result.success) {
      ElMessage.success(`已切换到分支 "${newBranch}"`)
      branches.value = await window.api.getGitBranches(props.cwd)
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
    if (branches.value.includes(name)) {
      ElMessage.error(`分支 "${name}" 已存在`)
      return
    }
  }
  const sep = props.cwd.includes('\\') ? '\\' : '/'
  const fullPath = `${wtLocation.value.replace(/\\/g, sep)}${sep}${wtProjectName.value.trim()}`
  wtSubmitting.value = true
  try {
    const result = await window.api.gitWorktreeAdd(props.cwd, {
      path: fullPath,
      newBranch: wtNewBranch.value ? wtNewBranchName.value.trim() || undefined : undefined,
      fromBranch: wtFromBranch.value || undefined
    })
    if (result.success) {
      showWorktreeDialog.value = false
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
      <el-option v-for="b in branches" :key="b" :label="b" :value="b" />
    </el-select>
    <button class="wt-btn" title="新建工作树" @click="openWorktreeDialog">+</button>

    <el-dialog v-model="showWorktreeDialog" title="新建工作树" width="440px" class="wt-dialog">
      <div class="wt-form">
        <div class="wt-row">
          <label class="wt-label">从分支</label>
          <el-select v-model="wtFromBranch" class="wt-field" popper-class="branch-select-dropdown" size="small" filterable>
            <el-option v-for="b in branches" :key="b" :label="b" :value="b" />
          </el-select>
        </div>

        <div class="wt-row">
          <label class="wt-label">新分支</label>
          <div class="wt-field" style="display:flex;align-items:center;gap:8px">
            <el-checkbox v-model="wtNewBranch" />
            <el-input
              v-if="wtNewBranch"
              v-model="wtNewBranchName"
              size="small"
              placeholder="新分支名"
              style="flex:1"
            />
          </div>
        </div>

        <div class="wt-row">
          <label class="wt-label">项目名</label>
          <el-input v-model="wtProjectName" class="wt-field" size="small" />
        </div>

        <div class="wt-row">
          <label class="wt-label">位置</label>
          <div class="wt-field" style="display:flex;gap:8px">
            <el-input v-model="wtLocation" size="small" style="flex:1" />
            <el-button size="small" @click="handleBrowseLocation">浏览</el-button>
          </div>
        </div>
      </div>

      <template #footer>
        <el-button size="small" @click="showWorktreeDialog = false">取消</el-button>
        <el-button size="small" type="primary" :loading="wtSubmitting" @click="handleCreateWorktree">
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
/* el-select's dropdown popper is teleported to body — scoped styles can't
   reach it, so override via popper-class globally. */
.branch-select-dropdown .el-select-dropdown__list {
  padding: 4px 0;
}

.branch-select-dropdown .el-select-dropdown__item {
  height: 28px;
  line-height: 28px;
  padding: 0 20px 0 10px;
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
</style>
