<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { GitBranch } from 'lucide-vue-next'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  cwd: string | undefined
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
  const prev = currentBranch.value
  switching.value = true
  currentBranch.value = newBranch
  // Invalidate any in-flight refresh — its result is now stale.
  ++refreshGen
  try {
    const result = await window.api.gitCheckout(props.cwd, newBranch)
    if (result.success) {
      ElMessage.success(`Switched to branch "${newBranch}"`)
      branches.value = await window.api.getGitBranches(props.cwd)
    } else {
      ElMessage.error(result.error || 'Checkout failed')
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
  </div>
</template>

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
