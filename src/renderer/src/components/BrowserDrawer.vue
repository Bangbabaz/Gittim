<!--
  浏览器抽屉组件 —— 每个终端面板底部可展开的内置浏览器。

  功能极简：导航栏 + webview，不做 DevTools / 调试 / 状态显示。
  挂载时通过 IPC 向 main process 注册 webContentsId，使 MCP server
  能通过 CDP 控制该 webview；卸载时注销。
-->
<template>
  <div class="browser-drawer">
    <!-- 导航栏 -->
    <div class="browser-nav">
      <button class="browser-nav-btn" title="后退" :disabled="!canGoBack" @click="goBack">
        <ChevronLeft :size="14" />
      </button>
      <button class="browser-nav-btn" title="前进" :disabled="!canGoForward" @click="goForward">
        <ChevronRight :size="14" />
      </button>
      <button class="browser-nav-btn" title="刷新" @click="reload">
        <RotateCw :size="12" />
      </button>
      <input
        ref="urlInputRef"
        class="browser-nav-url"
        type="text"
        :value="currentUrl"
        title="输入 URL 后回车导航"
        @keydown.enter="navigateToUrl"
      />
      <button class="browser-nav-btn" title="收起抽屉" @click="emit('collapse')">
        <Minus :size="14" />
      </button>
      <button class="browser-nav-close" title="关闭浏览器" @click="emit('close')">
        <X :size="14" />
      </button>
    </div>

    <!-- webview -->
    <div class="browser-webview-container">
      <webview
        ref="webviewRef"
        :src="initialUrl || 'about:blank'"
        :preload="''"
        :nodeintegration="false"
        :disablewebsecurity="false"
        :allowpopups="false"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { ChevronLeft, ChevronRight, RotateCw, X, Minus } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    paneId: string
    initialUrl?: string
  }>(),
  {
    initialUrl: 'about:blank'
  }
)

const emit = defineEmits<{
  close: []
  collapse: []
  ready: []
}>()

const webviewRef = ref<HTMLElement | null>(null)
const urlInputRef = ref<HTMLInputElement | null>(null)
const currentUrl = ref('about:blank')
const canGoBack = ref(false)
const canGoForward = ref(false)

function getWebview(): HTMLElement & {
  getWebContentsId(): number
  goBack(): void
  goForward(): void
  reload(): void
  loadURL(url: string): void
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return webviewRef.value as any
}

function goBack(): void {
  const wv = getWebview()
  if (wv) wv.goBack()
}

function goForward(): void {
  const wv = getWebview()
  if (wv) wv.goForward()
}

function reload(): void {
  const wv = getWebview()
  if (wv) wv.reload()
}

function navigateToUrl(): void {
  const input = urlInputRef.value?.value
  if (input) {
    const wv = getWebview()
    if (wv) wv.loadURL(input)
  }
}

function updateNavState(): void {
  const wv = getWebview()
  if (!wv) return
  try {
    currentUrl.value = wv.getURL() || currentUrl.value
    canGoBack.value = wv.canGoBack()
    canGoForward.value = wv.canGoForward()
  } catch {
    // webview 可能尚未就绪
  }
}

onMounted(() => {
  const wv = getWebview()
  if (!wv) return

  // 等待 webview 加载完成后注册到 main process
  const onDomReady = (): void => {
    try {
      const wcId = (
        webviewRef.value as unknown as { getWebContentsId(): number }
      ).getWebContentsId()
      window.api.browserRegister(props.paneId, wcId)
    } catch (e) {
      console.error('[BrowserDrawer] 注册 webview 失败:', e)
    }
  }

  const onNavigated = (): void => {
    updateNavState()
  }

  wv.addEventListener('dom-ready', onDomReady)
  wv.addEventListener('did-navigate', onNavigated)
  wv.addEventListener('did-navigate-in-page', onNavigated)
  wv.addEventListener('did-start-loading', updateNavState)
  wv.addEventListener('did-stop-loading', updateNavState)

  // 挂载去抖动：webview 可能还需要一点时间才能 call getWebContentsId
  // dom-ready 事件一般在首帧渲染后触，届时 devtools 可用
  emit('ready')
})

onUnmounted(() => {
  window.api.browserUnregister(props.paneId)
})
</script>

<style scoped lang="scss" src="@renderer/assets/style/components/BrowserDrawer.scss"></style>
