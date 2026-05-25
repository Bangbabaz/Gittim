<script setup lang="ts">
// 语音输入状态胶囊。浮在 pane 底部中央,展示录音 / 转写 / 完成 / 错误四态。
// 调用方负责什么时候渲染、什么时候卸载;done / error 的自动消失也由调用方控制
// (等转写完成后用 setTimeout 切回 hidden / 卸载组件)。

import { computed } from 'vue'
import { Check, X, Mic, Loader2 } from 'lucide-vue-next'

type State = 'recording' | 'transcribing' | 'done' | 'error'

const props = withDefaults(
  defineProps<{
    state: State
    /** 0-1。recording 状态下用于驱动电平条。 */
    level?: number
    /** done 时展示识别出的文本(截断显示),error 时展示错误消息。 */
    message?: string
  }>(),
  { level: 0, message: '' }
)

// 电平条数量。12 条在 24px 高的胶囊里视觉密度合适。
const BARS = 12

const activeBars = computed(() => {
  // level 0-1 → 0-12 个条亮起,从左到右点亮。
  return Math.round(Math.max(0, Math.min(1, props.level)) * BARS)
})

// done 时把识别文本截断展示;太长会撑变胶囊。
const displayMessage = computed(() => {
  if (props.state === 'done' && props.message) {
    return props.message.length > 24 ? props.message.slice(0, 24) + '…' : props.message
  }
  return props.message
})
</script>

<template>
  <div class="recording-indicator" :class="`state-${state}`">
    <template v-if="state === 'recording'">
      <Mic :size="13" class="ri-icon ri-mic" />
      <span class="ri-dot" />
      <div class="ri-meter">
        <span
          v-for="i in BARS"
          :key="i"
          class="ri-bar"
          :class="{ active: i <= activeBars }"
        />
      </div>
      <span class="ri-label">正在听</span>
    </template>
    <template v-else-if="state === 'transcribing'">
      <Loader2 :size="13" class="ri-icon ri-spin" />
      <span class="ri-label">转写中…</span>
    </template>
    <template v-else-if="state === 'done'">
      <Check :size="13" class="ri-icon ri-ok" />
      <span class="ri-label">{{ displayMessage || '已粘贴' }}</span>
    </template>
    <template v-else-if="state === 'error'">
      <X :size="13" class="ri-icon ri-err" />
      <span class="ri-label">{{ displayMessage || '识别失败' }}</span>
    </template>
  </div>
</template>

<style scoped lang="scss">
.recording-indicator {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0 12px;
  border-radius: 13px;
  background: rgba(0, 0, 0, 0.72);
  color: #f5f5f5;
  font-size: 12px;
  font-family: $font-ui;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  user-select: none;
  z-index: 5;
  // 浅色主题下深色胶囊保持深色 —— 高对比更易识别。
}

.ri-icon {
  flex-shrink: 0;
  opacity: 0.95;
}

.ri-mic {
  color: #ff5e57;
}

.ri-ok {
  color: #51cf66;
}

.ri-err {
  color: #ff5e57;
}

.ri-spin {
  animation: ri-spin 0.9s linear infinite;
  color: var(--el-color-primary);
}

@keyframes ri-spin {
  to {
    transform: rotate(360deg);
  }
}

.ri-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff5e57;
  box-shadow: 0 0 0 0 rgba(255, 94, 87, 0.6);
  animation: ri-pulse 1.2s ease-in-out infinite;
}

@keyframes ri-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(255, 94, 87, 0.55);
    opacity: 1;
  }
  50% {
    box-shadow: 0 0 0 6px rgba(255, 94, 87, 0);
    opacity: 0.85;
  }
}

.ri-meter {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 14px;
}

.ri-bar {
  width: 2px;
  height: 5px;
  background: rgba(255, 255, 255, 0.22);
  border-radius: 1px;
  transition:
    height 0.08s,
    background 0.08s;
}

.ri-bar.active {
  height: 12px;
  background: #ff5e57;
}

.ri-label {
  letter-spacing: 0.02em;
  white-space: nowrap;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
