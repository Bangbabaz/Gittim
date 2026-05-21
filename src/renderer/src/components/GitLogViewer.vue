<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { RefreshCw, GitCommit, User, Calendar, ChevronDown } from 'lucide-vue-next'
import DiffViewer from './DiffViewer.vue'

interface CommitInfo {
  hash: string
  shortHash: string
  author: string
  email: string
  date: string
  parents: string[]
  refs: string[]
  subject: string
}

interface CommitDetail extends CommitInfo {
  body: string
  diff: string
  truncated: boolean
}

const props = defineProps<{ cwd: string }>()

const PAGE = 200

const commits = ref<CommitInfo[]>([])
const selectedHash = ref<string | null>(null)
const detail = ref<CommitDetail | null>(null)
const loadingList = ref(false)
const loadingMore = ref(false)
const loadingDetail = ref(false)
const showAll = ref(false)
// Once a page returns fewer than PAGE rows we've hit the bottom; sticky flag
// so the "加载更多" button hides even after the user toggles --all back off
// (which resets it).
const hasMore = ref(true)

// Generation guard for list refreshes (page reload / branch filter toggle).
// A second one for commit-detail loads (clicks happen fast and we must not
// let an older detail land on a newer selection).
let listGen = 0
let detailGen = 0

async function loadInitial(): Promise<void> {
  if (!props.cwd) return
  loadingList.value = true
  hasMore.value = true
  commits.value = []
  selectedHash.value = null
  detail.value = null
  const myGen = ++listGen
  try {
    const list = await window.api.gitLog(props.cwd, {
      skip: 0,
      limit: PAGE,
      all: showAll.value
    })
    if (myGen !== listGen) return
    commits.value = list
    hasMore.value = list.length === PAGE
    if (list.length) {
      selectedHash.value = list[0].hash
      loadDetail(list[0].hash)
    }
  } catch {
    if (myGen === listGen) commits.value = []
  } finally {
    if (myGen === listGen) loadingList.value = false
  }
}

async function loadMore(): Promise<void> {
  if (!props.cwd || !hasMore.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const list = await window.api.gitLog(props.cwd, {
      skip: commits.value.length,
      limit: PAGE,
      all: showAll.value
    })
    commits.value = [...commits.value, ...list]
    if (list.length < PAGE) hasMore.value = false
  } finally {
    loadingMore.value = false
  }
}

async function loadDetail(hash: string): Promise<void> {
  if (!props.cwd) return
  loadingDetail.value = true
  detail.value = null
  const myGen = ++detailGen
  try {
    const d = await window.api.gitCommitDetail(props.cwd, hash)
    if (myGen !== detailGen) return
    if (!d) {
      ElMessage.error('未能读取该提交')
      return
    }
    detail.value = d
  } finally {
    if (myGen === detailGen) loadingDetail.value = false
  }
}

function selectCommit(c: CommitInfo): void {
  if (c.hash === selectedHash.value) return
  selectedHash.value = c.hash
  loadDetail(c.hash)
}

watch(
  () => props.cwd,
  () => loadInitial(),
  { immediate: true }
)

// `--all` toggle = full reload, but the cwd watcher above already handles the
// "user switched panes" reload, so no need to guard against the dual-trigger.
watch(showAll, () => loadInitial())

defineExpose({ refresh: loadInitial })

// Friendly relative date (just for the list — detail panel shows the full
// timestamp). All within the last 24h → "3 小时前"; otherwise the ISO date.
function formatDate(iso: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const diff = (Date.now() - t) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86_400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)} 天前`
  return iso.slice(0, 10)
}

function formatFullDate(iso: string): string {
  if (!iso) return ''
  // Keep the timezone (helpful for distributed teams). Trim seconds-precision
  // for a less noisy line: `2026-05-21T14:32+08:00`.
  return iso.replace(/:\d{2}([+-]\d{2}:\d{2}|Z)$/, '$1')
}

// Ref-decorator chips: `HEAD -> main` becomes the HEAD pointer + branch;
// `tag: v1.0` becomes a tag pill; remote refs (`origin/main`) get a 3rd colour.
type Decoration = { kind: 'head' | 'branch' | 'remote' | 'tag'; label: string }

function decorate(refs: string[]): Decoration[] {
  const out: Decoration[] = []
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) {
      out.push({ kind: 'head', label: 'HEAD' })
      out.push({ kind: 'branch', label: r.slice('HEAD -> '.length) })
    } else if (r === 'HEAD') {
      out.push({ kind: 'head', label: 'HEAD' })
    } else if (r.startsWith('tag: ')) {
      out.push({ kind: 'tag', label: r.slice('tag: '.length) })
    } else if (r.includes('/')) {
      // origin/main, upstream/feat — treat anything containing `/` as a
      // remote-tracking ref. Local branches with slashes (`feat/foo`) get
      // decorated as branches by the `HEAD -> ` path above; if such a branch
      // is NOT current, it shows up as a plain branch token without slash here.
      out.push({ kind: 'remote', label: r })
    } else {
      out.push({ kind: 'branch', label: r })
    }
  }
  return out
}
</script>

<template>
  <div class="gl-root">
    <header class="gl-header">
      <span class="gl-count">{{ commits.length }} 个提交</span>
      <el-checkbox v-model="showAll" size="small">显示所有分支</el-checkbox>
      <button class="gl-refresh" :disabled="loadingList" title="刷新" @click="loadInitial">
        <RefreshCw :size="13" />
      </button>
    </header>

    <div class="gl-body">
      <aside class="gl-sidebar">
        <div v-if="loadingList && !commits.length" class="gl-state">加载中…</div>
        <div v-else-if="!commits.length" class="gl-state">没有提交</div>
        <template v-else>
          <button
            v-for="c in commits"
            :key="c.hash"
            class="gl-row"
            :class="{ active: c.hash === selectedHash }"
            @click="selectCommit(c)"
          >
            <div class="gl-row-top">
              <span class="gl-subject" :title="c.subject">{{ c.subject }}</span>
            </div>
            <div class="gl-row-meta">
              <span class="gl-hash">{{ c.shortHash }}</span>
              <span class="gl-author">{{ c.author }}</span>
              <span class="gl-date" :title="c.date">{{ formatDate(c.date) }}</span>
            </div>
            <div v-if="c.refs.length" class="gl-row-refs">
              <span
                v-for="(d, i) in decorate(c.refs)"
                :key="i"
                class="gl-ref"
                :class="`gl-ref-${d.kind}`"
                :title="d.label"
                >{{ d.label }}</span
              >
            </div>
          </button>
          <button v-if="hasMore" class="gl-load-more" :disabled="loadingMore" @click="loadMore">
            <ChevronDown :size="13" />
            {{ loadingMore ? '加载中…' : '加载更多' }}
          </button>
        </template>
      </aside>

      <section class="gl-detail">
        <div v-if="loadingDetail" class="gl-state">加载提交详情…</div>
        <template v-else-if="detail">
          <div class="gl-detail-head">
            <div class="gl-detail-subject">{{ detail.subject }}</div>
            <div class="gl-detail-meta">
              <span class="gl-detail-row">
                <GitCommit :size="13" />
                <code>{{ detail.hash }}</code>
              </span>
              <span class="gl-detail-row">
                <User :size="13" />
                {{ detail.author }} &lt;{{ detail.email }}&gt;
              </span>
              <span class="gl-detail-row">
                <Calendar :size="13" />
                {{ formatFullDate(detail.date) }}
              </span>
              <span v-if="detail.parents.length" class="gl-detail-row">
                <span class="gl-detail-label">父提交</span>
                <code v-for="p in detail.parents" :key="p" class="gl-parent">{{
                  p.slice(0, 7)
                }}</code>
              </span>
            </div>
            <pre v-if="detail.body" class="gl-detail-body">{{ detail.body }}</pre>
            <div v-if="detail.refs.length" class="gl-detail-refs">
              <span
                v-for="(d, i) in decorate(detail.refs)"
                :key="i"
                class="gl-ref"
                :class="`gl-ref-${d.kind}`"
                >{{ d.label }}</span
              >
            </div>
          </div>
          <div v-if="detail.truncated" class="gl-trunc">改动过大，仅显示前 10 MB</div>
          <DiffViewer v-if="detail.diff" :diff="detail.diff" />
          <div v-else class="gl-state">该提交无文本改动</div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
.gl-root {
  display: flex;
  flex-direction: column;
  height: 80vh;
  font-family: $font-ui;
}

.gl-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 4px 10px;
  border-bottom: 1px solid var(--el-border-color);
}

.gl-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.gl-refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: 1px solid var(--el-border-color);
  border-radius: $radius-sm;
  color: var(--el-text-color-regular);
  cursor: pointer;
  margin-left: auto;
}

.gl-refresh:hover:not(:disabled) {
  background: var(--el-fill-color);
  color: var(--el-color-primary);
  border-color: var(--el-text-color-secondary);
}

.gl-refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.gl-body {
  flex: 1;
  display: flex;
  min-height: 0;
  margin-top: 10px;
  gap: 12px;
}

.gl-sidebar {
  width: 360px;
  flex-shrink: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-right: 4px;
}

.gl-state {
  padding: 24px 12px;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  text-align: center;
}

.gl-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: $radius-sm;
  cursor: pointer;
  text-align: left;
}

.gl-row:hover {
  background: var(--el-fill-color);
}

.gl-row.active {
  background: var(--el-color-primary-light-9);
  border-color: color-mix(in srgb, var(--el-color-primary) 35%, transparent);
}

.gl-row-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.gl-subject {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--el-text-color-primary);
  font-weight: 500;
  @include ellipsis;
}

.gl-row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.gl-hash {
  font-family: $font-mono;
  color: var(--el-color-warning);
}

.gl-author {
  flex: 1;
  min-width: 0;
  @include ellipsis;
}

.gl-date {
  flex-shrink: 0;
}

.gl-row-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

.gl-ref {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: $radius-sm;
  font-family: $font-mono;
  line-height: 1.4;
  @include ellipsis;
  max-width: 200px;
}

.gl-ref-head {
  background: color-mix(in srgb, var(--el-color-warning) 22%, transparent);
  color: var(--el-color-warning);
  font-weight: 600;
}

.gl-ref-branch {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.gl-ref-remote {
  background: color-mix(in srgb, var(--el-color-info) 18%, transparent);
  color: var(--el-color-info);
}

.gl-ref-tag {
  background: color-mix(in srgb, var(--el-color-success) 18%, transparent);
  color: var(--el-color-success);
}

.gl-load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 4px;
  padding: 6px 8px;
  background: var(--el-fill-color);
  border: 1px dashed var(--el-border-color);
  border-radius: $radius-sm;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  cursor: pointer;
}

.gl-load-more:hover:not(:disabled) {
  background: var(--el-fill-color-darker);
  color: var(--el-color-primary);
}

.gl-load-more:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.gl-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--el-border-color);
  padding-left: 12px;
  overflow: hidden;
}

.gl-detail-head {
  flex-shrink: 0;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--el-border-color);
  margin-bottom: 10px;
}

.gl-detail-subject {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 8px;
}

.gl-detail-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gl-detail-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.gl-detail-row code {
  font-family: $font-mono;
  background: var(--el-fill-color);
  padding: 1px 6px;
  border-radius: $radius-sm;
  font-size: 11px;
}

.gl-detail-label {
  color: var(--el-text-color-secondary);
}

.gl-parent {
  font-family: $font-mono;
  background: var(--el-fill-color);
  padding: 1px 6px;
  border-radius: $radius-sm;
  font-size: 11px;
}

.gl-detail-body {
  margin: 8px 0 0;
  padding: 8px 12px;
  background: var(--el-fill-color-lighter);
  border-left: 3px solid var(--el-color-info);
  border-radius: $radius-sm;
  font-family: $font-mono;
  font-size: 12px;
  color: var(--el-text-color-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
}

.gl-detail-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.gl-trunc {
  font-size: 12px;
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 10%, transparent);
  padding: 6px 10px;
  border-radius: $radius-sm;
  margin-bottom: 8px;
}
</style>
