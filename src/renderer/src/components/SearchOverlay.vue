<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search'
import { useTheme } from '../composables/useTheme'

const { mode } = useTheme()

// Shared search box for any xterm instance. Owns the query string, the
// prev/next/close controls, the match-count readout and the highlight
// decorations — so the terminal pane and the task-log drawer behave
// identically. The parent just toggles visibility and hands over the
// SearchAddon of the terminal to search.
const props = defineProps<{
  searchAddon: SearchAddon
  resultLimit?: number
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const term = ref('')
const inputRef = ref<HTMLInputElement>()
const results = ref<{ index: number; count: number }>({ index: -1, count: 0 })

// No query → blank; matches → "current/total"; query but no hit → "0".
const countText = computed(() => {
  if (!term.value) return ''
  if (results.value.count === 0) return '0'
  const capped = !!props.resultLimit && results.value.count >= props.resultLimit
  const total = `${results.value.count}${capped ? '+' : ''}`
  return results.value.index < 0 ? total : `${results.value.index + 1}/${total}`
})

// xterm decorations 直接画到 canvas(JS object 不是 CSS),没法用 var()。但仍然
// 可以从 EL CSS var 读出真实色,然后按主题加 alpha 通道:
//   matchBackground       — warning hex + 35% alpha(底色)
//   activeMatchBackground — warning hex,不透明(高亮当前)
//   overviewRuler         — warning hex,饱和度高
// dark 主题上 alpha 偏深,light 主题上 alpha 偏浅 —— 两者基色一样,alpha 不同就够。
function colorFromCss(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

const searchOpts = computed<ISearchOptions>(() => {
  // mode 是依赖,主题切换时本 computed 自动重算;getComputedStyle 也会返回新值。
  const warn = colorFromCss('--el-color-warning', '#e6a23c')
  const isDark = mode.value === 'dark'
  return {
    decorations: {
      // hex8 alpha:dark 40%(浅显)、light 55%(浅色背景上要更深才看得见)
      matchBackground: warn + (isDark ? '66' : '8c'),
      matchBorder: '#00000000',
      matchOverviewRuler: warn,
      activeMatchBackground: warn,
      activeMatchColorOverviewRuler: warn
    }
  }
})

let disposeResults: (() => void) | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null

function cancelPendingSearch(): void {
  if (searchTimer === null) return
  clearTimeout(searchTimer)
  searchTimer = null
}

function runSearch(incremental: boolean): void {
  cancelPendingSearch()
  if (!term.value) return
  props.searchAddon.findNext(term.value, { ...searchOpts.value, incremental })
}

function next(): void {
  runSearch(false)
}

function prev(): void {
  cancelPendingSearch()
  if (term.value) props.searchAddon.findPrevious(term.value, searchOpts.value)
}

function close(): void {
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    e.shiftKey ? prev() : next()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

// Live search so the count + highlights update while typing.
watch(term, (v) => {
  cancelPendingSearch()
  if (!v) {
    props.searchAddon.clearDecorations()
    results.value = { index: -1, count: 0 }
    return
  }
  searchTimer = setTimeout(() => {
    searchTimer = null
    props.searchAddon.findNext(v, { ...searchOpts.value, incremental: true })
  }, 120)
})

onMounted(() => {
  const d = props.searchAddon.onDidChangeResults((r) => {
    results.value = { index: r.resultIndex, count: r.resultCount }
  })
  disposeResults = () => d.dispose()
  nextTick(() => inputRef.value?.focus())
})

onBeforeUnmount(() => {
  cancelPendingSearch()
  disposeResults?.()
  props.searchAddon.clearDecorations()
})
</script>

<template>
  <div class="search-overlay" @click.stop>
    <input ref="inputRef" v-model="term" class="search-input" placeholder="搜索" @keydown="onKey" />
    <span class="search-count" :class="{ none: !!term && !results.count }">
      {{ countText }}
    </span>
    <button class="search-btn" title="上一个 (Shift+Enter)" @click="prev">↑</button>
    <button class="search-btn" title="下一个 (Enter)" @click="next">↓</button>
    <button class="search-btn" title="关闭 (Esc)" @click="close">×</button>
  </div>
</template>

<style scoped lang="scss" src="@renderer/assets/style/components/SearchOverlay.scss"></style>
