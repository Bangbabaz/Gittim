<script setup lang="ts">
// PTT(push-to-talk)按钮:按下开始录音,松开转写。视觉状态(录音中/转写中/
// 完成/失败)由 Terminal 内的 RecordingIndicator 胶囊单独表达,这里只是个
// 普通触发器 —— 维护两层状态会双倍出错路径。
//
// 用 pointer capture 解决"按下后鼠标滑出按钮"问题:setPointerCapture 让后续
// pointerup 一定路由回原元素,用户不必精确松在按钮上。

import { Mic } from 'lucide-vue-next'

defineProps<{
  /** 父级正在录音 → 给个红色高亮提示,即便胶囊已经显示也明确按钮处于激活态。 */
  active?: boolean
}>()

const emit = defineEmits<{
  press: []
  release: []
}>()

function onDown(e: PointerEvent): void {
  // 左键 / 触摸 / 笔尖 才触发;右键不算 PTT,留给浏览器/系统菜单。
  if (e.button !== 0 && e.pointerType === 'mouse') return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  emit('press')
}

function onUp(e: PointerEvent): void {
  // pointercancel / pointerup 都走这里。release 必须 idempotent —— useVoiceInput
  // 的 stop() 自己会判断 state,重复调用无副作用。
  e.preventDefault()
  emit('release')
}
</script>

<template>
  <button
    class="voice-input-btn"
    :class="{ active }"
    title="按住录音,松开转写(快捷键 F2)"
    @pointerdown="onDown"
    @pointerup="onUp"
    @pointercancel="onUp"
    @contextmenu.prevent
  >
    <Mic :size="14" />
  </button>
</template>

<style scoped lang="scss">
.voice-input-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--el-text-color-regular);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
  transition:
    background 0.12s,
    color 0.12s;
}

.voice-input-btn:hover {
  background: var(--el-fill-color);
  color: var(--el-text-color-primary);
}

.voice-input-btn.active,
.voice-input-btn:active {
  background: color-mix(in srgb, #ff5e57 22%, transparent);
  color: #ff5e57;
}
</style>
