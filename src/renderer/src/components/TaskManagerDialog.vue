<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, X, FolderOpen } from 'lucide-vue-next'

type TaskMeta = {
  id: string
  name: string
  command: string
  cwd: string
  status: 'idle' | 'running' | 'exited' | 'failed'
  exitCode: number | null
  startedAt: number | null
}

interface EditItem {
  key: string
  id?: string // undefined = unsaved draft
  name: string
  command: string
  cwd: string
  isNew: boolean
  dirty: boolean
}

const props = defineProps<{
  modelValue: boolean
  focusId: string | null
  defaultCwd: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()

const items = ref<EditItem[]>([])
const selectedKey = ref<string | null>(null)
const pkgScripts = ref<Record<string, string>>({})

let keySeq = 0
const nextKey = (): string => `k${++keySeq}`

const selected = computed(() => items.value.find((i) => i.key === selectedKey.value) || null)

const itemLabel = (i: EditItem): string => i.name.trim() || i.command.trim() || 'new command'

async function reload(): Promise<void> {
  const list: TaskMeta[] = await window.api.taskList()
  items.value = list.map((t) => ({
    key: nextKey(),
    id: t.id,
    name: t.name,
    command: t.command,
    cwd: t.cwd,
    isNew: false,
    dirty: false
  }))
  const focus = props.focusId ? items.value.find((i) => i.id === props.focusId) : undefined
  selectedKey.value = focus?.key ?? items.value[0]?.key ?? null
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reload()
  }
)

watch(
  () => selected.value?.cwd,
  async (c) => {
    pkgScripts.value = c ? await window.api.readPackageScripts(c) : {}
  }
)

const pkgScriptNames = computed(() => Object.keys(pkgScripts.value))

function select(i: EditItem): void {
  selectedKey.value = i.key
}

function addDraft(): void {
  const draft: EditItem = {
    key: nextKey(),
    name: '',
    command: '',
    cwd: props.defaultCwd || '',
    isNew: true,
    dirty: true
  }
  items.value.push(draft)
  selectedKey.value = draft.key
}

function markDirty(): void {
  if (selected.value) selected.value.dirty = true
}

function applyScript(name: string): void {
  if (!selected.value) return
  selected.value.command = `npm run ${name}`
  if (!selected.value.name.trim()) selected.value.name = name
  selected.value.dirty = true
}

async function browseCwd(): Promise<void> {
  const dir = await window.api.selectDirectory()
  if (dir && selected.value) {
    selected.value.cwd = dir
    selected.value.dirty = true
  }
}

async function deleteItem(i: EditItem): Promise<void> {
  if (!i.isNew && i.id) {
    try {
      await ElMessageBox.confirm(`删除命令 "${itemLabel(i)}"？运行中的进程会被结束。`, '删除命令', {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      })
    } catch {
      return
    }
    await window.api.taskRemove(i.id)
  }
  const idx = items.value.findIndex((x) => x.key === i.key)
  if (idx >= 0) items.value.splice(idx, 1)
  if (selectedKey.value === i.key) {
    selectedKey.value = items.value[0]?.key ?? null
  }
}

async function save(): Promise<void> {
  const s = selected.value
  if (!s) return
  const command = s.command.trim()
  if (!command) {
    ElMessage.error('请输入命令')
    return
  }
  const cwd = s.cwd.trim()
  if (!cwd) {
    ElMessage.error('请输入工作目录')
    return
  }
  const name = s.name.trim() || command
  if (s.isNew || !s.id) {
    const meta = await window.api.taskCreate({ name, command, cwd })
    s.id = meta.id
    s.isNew = false
  } else {
    await window.api.taskUpdate(s.id, { name, command, cwd })
  }
  s.name = name
  s.dirty = false
  ElMessage.success('已保存')
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="管理命令"
    width="760px"
    :with-header="true"
    class="task-mgr-dialog"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="tm-body">
      <!-- Left: command list -->
      <aside class="tm-list">
        <div class="tm-list-head">
          <span class="tm-list-title">命令</span>
          <button class="tm-add" title="新建命令" @click="addDraft">
            <Plus :size="14" />
          </button>
        </div>
        <div class="tm-list-scroll">
          <div v-if="!items.length" class="tm-empty">还没有命令</div>
          <div
            v-for="i in items"
            :key="i.key"
            class="tm-item"
            :class="{ active: i.key === selectedKey }"
            @click="select(i)"
          >
            <span class="tm-item-label">{{ itemLabel(i) }}</span>
            <span v-if="i.isNew" class="tm-badge new">未保存</span>
            <span v-else-if="i.dirty" class="tm-dot" title="有未保存的修改" />
            <button class="tm-del" title="删除" @click.stop="deleteItem(i)">
              <X :size="13" />
            </button>
          </div>
        </div>
      </aside>

      <!-- Right: detail -->
      <section class="tm-detail">
        <template v-if="selected">
          <label class="tm-field">
            <span class="tm-label">名称</span>
            <input
              v-model="selected.name"
              class="tm-input"
              placeholder="留空则用命令文本"
              @input="markDirty"
            />
          </label>
          <label class="tm-field">
            <span class="tm-label">命令</span>
            <input
              v-model="selected.command"
              class="tm-input mono"
              placeholder="如 npm run dev"
              @input="markDirty"
            />
          </label>
          <label class="tm-field">
            <span class="tm-label">工作目录</span>
            <div class="tm-cwd-row">
              <input
                v-model="selected.cwd"
                class="tm-input mono"
                placeholder="命令执行的目录"
                @input="markDirty"
              />
              <button class="tm-browse" title="浏览" @click="browseCwd">
                <FolderOpen :size="14" />
              </button>
            </div>
          </label>
          <div v-if="pkgScriptNames.length" class="tm-scripts">
            <span class="tm-scripts-label">package.json：</span>
            <button
              v-for="s in pkgScriptNames"
              :key="s"
              class="tm-chip"
              :title="pkgScripts[s]"
              @click="applyScript(s)"
            >
              {{ s }}
            </button>
          </div>
          <div class="tm-actions">
            <span class="tm-hint">未保存的更改关闭后会丢弃</span>
            <button class="tm-save" :disabled="!selected.command.trim()" @click="save">保存</button>
          </div>
        </template>
        <div v-else class="tm-placeholder">选择左侧命令，或点 + 新建</div>
      </section>
    </div>
  </el-dialog>
</template>

<style scoped>
.tm-body {
  display: flex;
  height: 420px;
  gap: 0;
}

.tm-list {
  width: 210px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #3e3e42;
}

.tm-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 12px 8px;
}

.tm-list-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #858585;
}

.tm-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: 1px solid #3e3e42;
  border-radius: 4px;
  color: #ccc;
  cursor: pointer;
}

.tm-add:hover {
  background: #3e3e42;
  color: #fff;
}

.tm-list-scroll {
  flex: 1;
  overflow-y: auto;
  padding-right: 6px;
}

.tm-empty {
  color: #6b6b6b;
  font-size: 12px;
  padding: 16px 4px;
}

.tm-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: 5px;
  cursor: pointer;
}

.tm-item:hover {
  background: #2d2d30;
}

.tm-item.active {
  background: #04395e;
}

.tm-item-label {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: #d4d4d4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tm-badge.new {
  font-size: 10px;
  color: #d7a23b;
  background: #d7a23b22;
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}

.tm-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d7a23b;
  flex-shrink: 0;
}

.tm-del {
  display: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: transparent;
  border: none;
  color: #9d9d9d;
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}

.tm-item:hover .tm-del {
  display: flex;
}

.tm-del:hover {
  background: #c42b1c44;
  color: #f14c4c;
}

.tm-detail {
  flex: 1;
  min-width: 0;
  padding: 0 2px 0 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.tm-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.tm-label {
  font-size: 12px;
  color: #858585;
}

.tm-input {
  background: #1e1e1e;
  border: 1px solid #3e3e42;
  border-radius: 4px;
  color: #d4d4d4;
  font-size: 13px;
  padding: 7px 9px;
  outline: none;
  font-family: inherit;
}

.tm-input.mono {
  font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
  font-size: 12px;
}

.tm-input:focus {
  border-color: #094771;
}

.tm-cwd-row {
  display: flex;
  gap: 6px;
}

.tm-cwd-row .tm-input {
  flex: 1;
  min-width: 0;
}

.tm-browse {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  background: transparent;
  border: 1px solid #3e3e42;
  border-radius: 4px;
  color: #ccc;
  cursor: pointer;
}

.tm-browse:hover {
  background: #3e3e42;
  color: #fff;
}

.tm-scripts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.tm-scripts-label {
  font-size: 11px;
  color: #858585;
}

.tm-chip {
  background: #0e639c33;
  border: 1px solid #0e639c66;
  color: #6cb6ff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  cursor: pointer;
}

.tm-chip:hover {
  background: #0e639c55;
}

.tm-actions {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.tm-hint {
  font-size: 11px;
  color: #6b6b6b;
}

.tm-save {
  background: #0e639c;
  border: none;
  color: #fff;
  font-size: 13px;
  padding: 7px 20px;
  border-radius: 4px;
  cursor: pointer;
}

.tm-save:hover:not(:disabled) {
  background: #1177bb;
}

.tm-save:disabled {
  background: #3a3a3a;
  color: #777;
  cursor: not-allowed;
}

.tm-placeholder {
  margin: auto;
  color: #6b6b6b;
  font-size: 13px;
}
</style>

<style>
.task-mgr-dialog.el-dialog {
  background: #1b1b1f;
  border: 1px solid #3e3e42;
}

.task-mgr-dialog .el-dialog__title {
  color: #d4d4d4;
  font-size: 14px;
  font-weight: 600;
}

.task-mgr-dialog .el-dialog__header {
  border-bottom: 1px solid #3e3e42;
  margin-right: 0;
  padding: 18px 20px 14px;
}

.task-mgr-dialog .el-dialog__body {
  padding: 18px 20px 20px;
}
</style>
