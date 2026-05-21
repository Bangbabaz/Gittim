<script setup lang="ts">
import { computed, ref } from 'vue'
import { parse } from 'diff2html'
import { LineType } from 'diff2html/lib-esm/types'

const props = defineProps<{
  diff: string
  /**
   * Hide the built-in file list. Used when the parent (e.g. GitLogViewer) owns
   * its own file-picker and only wants the right-hand diff grid rendered.
   * Defaults to false to preserve existing call sites.
   */
  hideSidebar?: boolean
}>()

type CellKind = 'ctx' | 'del' | 'ins' | 'empty'
type Cell = { num: number | null; text: string; kind: CellKind }
type Row = { kind: 'hunk'; text: string } | { kind: 'pair'; left: Cell; right: Cell }

type FileView = {
  id: string
  name: string
  status: string
  statusClass: string
  added: number
  deleted: number
  rows: Row[]
  binary: boolean
}

const DEV_NULL = new Set(['dev/null', '/dev/null'])

// diff2html keeps the leading +/-/space marker on each line's content.
function stripPrefix(s: string): string {
  return s.length ? s.slice(1) : s
}

const files = computed<FileView[]>(() => {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(props.diff)
  } catch {
    return []
  }
  return parsed.map((f, idx) => {
    const [status, statusClass] = f.isNew
      ? ['新增', 'st-new']
      : f.isDeleted
        ? ['删除', 'st-del']
        : f.isCopy
          ? ['复制', 'st-ren']
          : f.isRename
            ? ['重命名', 'st-ren']
            : f.isBinary
              ? ['二进制', 'st-mod']
              : ['修改', 'st-mod']

    const oldN = f.oldName && !DEV_NULL.has(f.oldName) ? f.oldName : ''
    const newN = f.newName && !DEV_NULL.has(f.newName) ? f.newName : ''
    let name = newN || oldN
    if ((f.isRename || f.isCopy) && oldN && newN && oldN !== newN) name = `${oldN} → ${newN}`
    else if (f.isDeleted) name = oldN || newN

    const rows: Row[] = []
    for (const block of f.blocks) {
      rows.push({ kind: 'hunk', text: block.header })
      const lines = block.lines
      let i = 0
      while (i < lines.length) {
        const ln = lines[i]
        if (ln.type === LineType.CONTEXT) {
          const text = stripPrefix(ln.content)
          rows.push({
            kind: 'pair',
            left: { num: ln.oldNumber ?? null, text, kind: 'ctx' },
            right: { num: ln.newNumber ?? null, text, kind: 'ctx' }
          })
          i++
        } else {
          const dels: typeof lines = []
          const ins: typeof lines = []
          while (i < lines.length && lines[i].type === LineType.DELETE) dels.push(lines[i++])
          while (i < lines.length && lines[i].type === LineType.INSERT) ins.push(lines[i++])
          const n = Math.max(dels.length, ins.length)
          for (let k = 0; k < n; k++) {
            const d = dels[k]
            const a = ins[k]
            rows.push({
              kind: 'pair',
              left: d
                ? { num: d.oldNumber ?? null, text: stripPrefix(d.content), kind: 'del' }
                : { num: null, text: '', kind: 'empty' },
              right: a
                ? { num: a.newNumber ?? null, text: stripPrefix(a.content), kind: 'ins' }
                : { num: null, text: '', kind: 'empty' }
            })
          }
        }
      }
    }

    return {
      id: `dvf-${idx}`,
      name,
      status,
      statusClass,
      added: f.addedLines,
      deleted: f.deletedLines,
      rows,
      binary: !!f.isBinary
    }
  })
})

const mainRef = ref<HTMLElement>()
const activeId = ref<string | null>(null)

function jumpTo(id: string): void {
  const host = mainRef.value
  if (!host) return
  const el = host.querySelector<HTMLElement>(`#${id}`)
  if (el) {
    host.scrollTo({ top: el.offsetTop - 4, behavior: 'smooth' })
    activeId.value = id
  }
}

// Side-by-side split ratio (left / right code columns). The two `*-num`
// columns stay at a fixed 3.2em each — only the two `*-code` columns share
// the remainder, so the ratio is just `left-code : right-code`. Shared
// across every file in this DiffViewer instance.
const midRatio = ref(0.5)

const gridStyle = computed(() => ({
  gridTemplateColumns: `3.2em ${midRatio.value * 100}fr 3.2em ${(1 - midRatio.value) * 100}fr`
}))

// Splitter X position inside the wrap element. The two `*-num` columns
// together span 6.4em from the wrap's left edge before the usable code area
// begins, so position = leftNumCol(3.2em) + usable * ratio.
const splitterStyle = computed(() => ({
  left: `calc(3.2em + (100% - 6.4em) * ${midRatio.value})`
}))

function startMidDrag(e: MouseEvent): void {
  e.preventDefault()
  const wrap = (e.currentTarget as HTMLElement).parentElement
  if (!wrap) return
  const rect = wrap.getBoundingClientRect()
  // Read the actual font-size in case the host changed it (settings drawer
  // adjusts terminal font but the diff viewer is fixed — still cheap and
  // safer than hard-coding 14px).
  const fontSize = parseFloat(getComputedStyle(wrap).fontSize) || 14
  const numColPx = 3.2 * fontSize
  const usable = Math.max(1, rect.width - numColPx * 2)

  function move(ev: MouseEvent): void {
    const xInUsable = ev.clientX - rect.left - numColPx
    midRatio.value = Math.max(0.1, Math.min(0.9, xInUsable / usable))
  }
  function up(): void {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
</script>

<template>
  <div class="dv-root">
    <aside v-if="!props.hideSidebar" class="dv-sidebar">
      <div class="dv-sidebar-title">改动文件（{{ files.length }}）</div>
      <button
        v-for="f in files"
        :key="f.id"
        class="dv-file-item"
        :class="{ active: f.id === activeId }"
        @click="jumpTo(f.id)"
      >
        <span class="dv-badge" :class="f.statusClass">{{ f.status }}</span>
        <span class="dv-file-name" :title="f.name">{{ f.name }}</span>
        <span class="dv-counts">
          <span v-if="f.added" class="dv-add">+{{ f.added }}</span>
          <span v-if="f.deleted" class="dv-del">−{{ f.deleted }}</span>
        </span>
      </button>
    </aside>

    <div ref="mainRef" class="dv-main">
      <section v-for="f in files" :id="f.id" :key="f.id" class="dv-file">
        <header class="dv-file-head">
          <span class="dv-badge" :class="f.statusClass">{{ f.status }}</span>
          <span class="dv-file-name" :title="f.name">{{ f.name }}</span>
          <span class="dv-counts">
            <span v-if="f.added" class="dv-add">+{{ f.added }}</span>
            <span v-if="f.deleted" class="dv-del">−{{ f.deleted }}</span>
          </span>
        </header>
        <div v-if="f.binary" class="dv-binary">二进制文件，不显示差异</div>
        <div v-else-if="!f.rows.length" class="dv-binary">无文本差异</div>
        <div v-else class="dv-grid-wrap">
          <div class="dv-grid" :style="gridStyle">
            <template v-for="(r, ri) in f.rows" :key="ri">
              <div v-if="r.kind === 'hunk'" class="dv-hunk">{{ r.text }}</div>
              <template v-if="r.kind === 'pair'">
                <div class="dv-num" :class="r.left.kind">{{ r.left.num ?? '' }}</div>
                <div class="dv-code" :class="r.left.kind">{{ r.left.text }}</div>
                <div class="dv-num" :class="r.right.kind">{{ r.right.num ?? '' }}</div>
                <div class="dv-code" :class="r.right.kind">{{ r.right.text }}</div>
              </template>
            </template>
          </div>
          <!-- Absolute splitter overlay positioned at the column-2/3 boundary.
               Pointer events are picked up only on the narrow drag handle to
               keep the grid fully clickable elsewhere (text selection still
               works). -->
          <div class="dv-mid-splitter" :style="splitterStyle" @mousedown="startMidDrag" />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
.dv-root {
  display: flex;
  height: 100%;
  min-height: 0;
  font-family: $font-mono;
}

/* Left: changed-files list */
.dv-sidebar {
  width: 250px;
  flex-shrink: 0;
  border-right: 1px solid var(--el-border-color);
  overflow-y: auto;
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.dv-sidebar-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--el-text-color-secondary);
  padding: 4px 8px 8px;
  @include ui-font;
}

.dv-file-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  background: transparent;
  border: none;
  border-radius: $radius;
  cursor: pointer;
  text-align: left;

  &:hover {
    background: var(--el-fill-color);
  }

  &.active {
    background: var(--el-color-primary-light-9);
  }
}

.dv-main {
  flex: 1;
  min-width: 0;
  overflow: auto;
}

.dv-file {
  margin-bottom: 18px;

  &:last-child {
    margin-bottom: 0;
  }
}

/* Filename stays pinned while scrolling through a long file. */
.dv-file-head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: var(--el-fill-color-light);
  border-bottom: 1px solid var(--el-border-color);
  @include ui-font;
}

.dv-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: $radius-sm;
  flex-shrink: 0;
  @include ui-font;
}

.st-new {
  color: color-mix(in srgb, var(--el-color-success) 75%, var(--el-text-color-primary));
  background: var(--el-color-success-light-8);
}

.st-del {
  color: color-mix(in srgb, var(--el-color-danger) 75%, var(--el-text-color-primary));
  background: var(--el-color-danger-light-8);
}

.st-ren {
  color: var(--el-color-warning);
  background: var(--el-color-warning-light-8);
}

/* "修改" is the most common diff status — keep it readable, not the muted
   info grey. Use the primary brand colour so it visually outweighs the
   placeholder/info-coloured tags. */
.st-mod {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.dv-file-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--el-text-color-primary);
  @include ellipsis;
  font-family: $font-mono;
}

.dv-counts {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  font-size: 11px;
}

.dv-add {
  color: color-mix(in srgb, var(--el-color-success) 75%, var(--el-text-color-primary));
}

.dv-del {
  color: color-mix(in srgb, var(--el-color-danger) 75%, var(--el-text-color-primary));
}

/* Wraps the grid + the absolute splitter overlay. position:relative so the
   splitter can absolute-position itself against this box. */
.dv-grid-wrap {
  position: relative;
}

/* Side-by-side grid: [old#][old code][new#][new code]. The two `code` columns
   share whatever remains after the two 3.2em number columns; the static
   declaration here is a fallback — the live ratio comes from the inline
   `gridTemplateColumns` style bound to midRatio. */
.dv-grid {
  display: grid;
  grid-template-columns: 3.2em minmax(0, 1fr) 3.2em minmax(0, 1fr);
  font-size: 12px;
  line-height: 1.5;
}

/* Vertical splitter pinned to the column-2/3 boundary. Wider hit area than
   visual to make grabbing it easy; the centred 2px-wide rule lights up on
   hover/drag so the affordance is visible without cluttering the diff. */
.dv-mid-splitter {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 9px;
  margin-left: -4px;
  cursor: col-resize;
  z-index: 2;
  user-select: none;
}

.dv-mid-splitter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 3px;
  background: transparent;
  transition: background 0.12s;
}

.dv-mid-splitter:hover::after,
.dv-mid-splitter:active::after {
  background: var(--el-color-primary);
}

.dv-hunk {
  grid-column: 1 / -1;
  padding: 2px 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);
  white-space: pre-wrap;
  word-break: break-all;
}

.dv-num {
  text-align: right;
  padding: 0 0.6em;
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-lighter);
  border-right: 1px solid var(--el-border-color);
  user-select: none;
  white-space: nowrap;
}

.dv-code {
  padding: 0 0.8em;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: anywhere;
  color: var(--el-text-color-primary);
}

.dv-num.del,
.dv-code.del {
  background: var(--el-color-danger-light-5);
}

.dv-num.ins,
.dv-code.ins {
  background: var(--el-color-success-light-5);
}

.dv-num.empty,
.dv-code.empty {
  background: var(--el-fill-color-light);
}

.dv-binary {
  padding: 16px 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  @include ui-font;
}
</style>
