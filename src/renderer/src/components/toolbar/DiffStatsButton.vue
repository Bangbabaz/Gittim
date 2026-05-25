<script setup lang="ts">
import { ref } from 'vue'
import DiffViewer from '../DiffViewer.vue'
import type { DiffStats } from '@shared/types'

// 工作区改动统计 chip(+N -N)。点击展开 diff dialog。
//
// 从 GitOpsButtons 拆出来,因为它要锚在工具栏最右(用户体感:"行数统计在最末,
// 跟 IDE 按钮分开"),与 history / merge badge 的位置正好相反。

const props = defineProps<{
  cwd: string
  diffStats: DiffStats
}>()

const showDiff = ref(false)
const diffLoading = ref(false)
const diffText = ref('')
const diffEmpty = ref(false)
const diffTruncated = ref(false)

function fetchDiffContent(side: 'old' | 'new', path: string): Promise<string | null> {
  return window.api.gitShowFile(props.cwd, side === 'old' ? 'HEAD' : null, path)
}

async function openDiff(): Promise<void> {
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
</script>

<template>
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

  <el-dialog
    v-model="showDiff"
    title="改动"
    width="92%"
    align-center
    class="diff-dialog"
    :lock-scroll="true"
    :close-on-click-modal="false"
  >
    <div v-if="diffLoading" class="diff-state">加载中…</div>
    <div v-else-if="diffEmpty" class="diff-state">没有改动</div>
    <template v-else>
      <div v-if="diffTruncated" class="diff-trunc">改动过大,仅显示前 10 MB</div>
      <DiffViewer :diff="diffText" :fetch-content="fetchDiffContent" />
    </template>
    <template #footer>
      <el-button size="small" @click="showDiff = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.diff-stats {
  @include btn-reset;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 6px;
  font-size: 11px;
  line-height: 1;
  font-family: $font-mono;
  flex-shrink: 0;
  border: 1px solid transparent;
  border-radius: $radius-sm;
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
