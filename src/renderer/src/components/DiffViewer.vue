<script setup lang="ts">
import { computed, ref } from 'vue'
import { parse } from 'diff2html'
import { LineType } from 'diff2html/lib-esm/types'

const props = defineProps<{ diff: string }>()

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
</script>

<template>
  <div class="dv-root">
    <aside class="dv-sidebar">
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
        <div v-else class="dv-grid">
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
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
.dv-root {
  display: flex;
  height: 78vh;
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

/* Side-by-side grid: [old#][old code][new#][new code] */
.dv-grid {
  display: grid;
  grid-template-columns: 3.2em minmax(0, 1fr) 3.2em minmax(0, 1fr);
  font-size: 12px;
  line-height: 1.5;
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
