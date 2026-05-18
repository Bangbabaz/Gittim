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
// xterm decorations are JS colors (not CSS), so they can't read our tokens —
// pick a palette per theme so highlights stay readable on a light terminal.
const searchOpts = computed<ISearchOptions>(() => ({
  decorations:
    mode.value === 'dark'
      ? {
          matchBackground: '#62331c',
          matchBorder: '#00000000',
          matchOverviewRuler: '#cc8033',
          activeMatchBackground: '#d7a23b',
          activeMatchColorOverviewRuler: '#ffd700'
        }
      : {
          matchBackground: '#ffe9a8',
          matchBorder: '#00000000',
          matchOverviewRuler: '#cc8033',
          activeMatchBackground: '#ffb300',
          activeMatchColorOverviewRuler: '#b8860b'
        }
}))

let disposeResults: (() => void) | null = null

function next(): void {
  if (term.value) props.searchAddon.findNext(term.value, searchOpts.value)
}

function prev(): void {
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
  if (!v) {
    props.searchAddon.clearDecorations()
    results.value = { index: -1, count: 0 }
    return
  }
  props.searchAddon.findNext(v, { ...searchOpts.value, incremental: true })
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

<style scoped lang="scss">
.search-overlay {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-toolbar);
  border: 1px solid var(--border);
  border-radius: $radius;
  padding: 4px 6px;
  box-shadow: var(--shadow-overlay);
}

.search-input {
  width: 220px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: $radius-sm;
  color: var(--text-primary);
  font-size: 12px;
  font-family: $font-ui;
  padding: 3px 6px;
  outline: none;

  &:focus {
    border-color: var(--focus-ring);
  }
}

.search-count {
  min-width: 44px;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;

  &.none {
    color: var(--danger);
  }
}

.search-btn {
  @include icon-btn(22px);
  border: 1px solid transparent;
  color: var(--text-regular);
  font-size: 13px;
  line-height: 1;

  &:hover {
    background: var(--bg-hover);
    border-color: var(--border-strong);
  }
}
</style>
