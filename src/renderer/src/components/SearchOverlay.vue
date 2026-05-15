<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search'

// Shared search box for any xterm instance. Owns the query string, the
// prev/next/close controls, the match-count readout and the highlight
// decorations — so the terminal pane and the task-log drawer behave
// identically. The parent just toggles visibility and hands over the
// SearchAddon of the terminal to search.
const props = defineProps<{
  searchAddon: SearchAddon
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const term = ref('')
const inputRef = ref<HTMLInputElement>()
const results = ref<{ index: number; count: number }>({ index: -1, count: 0 })

// No query → blank; matches → "current/total"; query but no hit → "0".
const countText = computed(() => {
  if (!term.value) return ''
  return results.value.count === 0 ? '0' : `${results.value.index + 1}/${results.value.count}`
})

// `onDidChangeResults` only fires (and matches only get a background) when
// decorations are enabled, so every search call must carry these options.
// Requires the terminal to be created with `allowProposedApi: true`.
const OPTS: ISearchOptions = {
  decorations: {
    matchBackground: '#62331c',
    matchBorder: '#00000000',
    matchOverviewRuler: '#cc8033',
    activeMatchBackground: '#d7a23b',
    activeMatchColorOverviewRuler: '#ffd700'
  }
}

let disposeResults: (() => void) | null = null

function next(): void {
  if (term.value) props.searchAddon.findNext(term.value, OPTS)
}

function prev(): void {
  if (term.value) props.searchAddon.findPrevious(term.value, OPTS)
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
  if (!v) {
    props.searchAddon.clearDecorations()
    results.value = { index: -1, count: 0 }
    return
  }
  props.searchAddon.findNext(v, { ...OPTS, incremental: true })
})

onMounted(() => {
  const d = props.searchAddon.onDidChangeResults((r) => {
    results.value = { index: r.resultIndex, count: r.resultCount }
  })
  disposeResults = () => d.dispose()
  nextTick(() => inputRef.value?.focus())
})

onBeforeUnmount(() => {
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

<style scoped>
.search-overlay {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #2d2d30;
  border: 1px solid #3e3e42;
  border-radius: 4px;
  padding: 4px 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.search-input {
  width: 220px;
  background: #1e1e1e;
  border: 1px solid #3e3e42;
  border-radius: 3px;
  color: #d4d4d4;
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  padding: 3px 6px;
  outline: none;
}

.search-input:focus {
  border-color: #094771;
}

.search-count {
  min-width: 44px;
  text-align: center;
  font-size: 11px;
  color: #9d9d9d;
  font-variant-numeric: tabular-nums;
}

.search-count.none {
  color: #f14c4c;
}

.search-btn {
  background: none;
  border: 1px solid transparent;
  color: #ccc;
  width: 22px;
  height: 22px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.search-btn:hover {
  background: #3e3e42;
  border-color: #555;
}
</style>
