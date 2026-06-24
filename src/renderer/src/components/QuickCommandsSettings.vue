<script setup lang="ts">
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-vue-next'
import type { QuickCommand } from '@shared/types'

const props = defineProps<{
  modelValue: QuickCommand[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: QuickCommand[]]
}>()

function createId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `quick-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  )
}

function updateAt(index: number, patch: Partial<QuickCommand>): void {
  const next = props.modelValue.map((item, i) => (i === index ? { ...item, ...patch } : item))
  emit('update:modelValue', next)
}

function add(): void {
  emit('update:modelValue', [...props.modelValue, { id: createId(), name: '新指令', command: '' }])
}

function remove(index: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, i) => i !== index)
  )
}

function move(index: number, offset: -1 | 1): void {
  const target = index + offset
  if (target < 0 || target >= props.modelValue.length) return
  const next = [...props.modelValue]
  ;[next[index], next[target]] = [next[target], next[index]]
  emit('update:modelValue', next)
}
</script>

<template>
  <section class="settings-section">
    <header class="settings-section-header quick-command-settings-header">
      <h3 class="settings-section-title">快捷指令</h3>
      <button class="quick-command-add" @click="add">
        <Plus :size="13" />
        添加
      </button>
    </header>
    <p class="quick-command-settings-desc">点击标题栏闪电按钮，在当前激活面板执行命令。</p>

    <div v-if="modelValue.length" class="quick-command-editor-list">
      <div v-for="(item, index) in modelValue" :key="item.id" class="quick-command-editor">
        <div class="quick-command-order">
          <button :disabled="index === 0" title="上移" @click="move(index, -1)">
            <ArrowUp :size="13" />
          </button>
          <button :disabled="index === modelValue.length - 1" title="下移" @click="move(index, 1)">
            <ArrowDown :size="13" />
          </button>
        </div>
        <div class="quick-command-fields">
          <el-input
            :model-value="item.name"
            size="small"
            placeholder="名称"
            @update:model-value="(value: string) => updateAt(index, { name: value })"
          />
          <el-input
            :model-value="item.command"
            size="small"
            placeholder="例如 yarn dev"
            @update:model-value="(value: string) => updateAt(index, { command: value })"
          />
        </div>
        <button class="quick-command-delete" title="删除" @click="remove(index)">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>
    <div v-else class="quick-command-settings-empty">暂无快捷指令。添加后可从标题栏直接执行。</div>
  </section>
</template>

<style scoped lang="scss">
.quick-command-settings-header {
  justify-content: space-between;
}

.quick-command-settings-desc {
  margin: -6px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 11.5px;
  line-height: 1.5;
}

.quick-command-add,
.quick-command-delete,
.quick-command-order button {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: $radius-sm;
  cursor: pointer;
}

.quick-command-add {
  gap: 5px;
  flex-shrink: 0;
  white-space: nowrap;
  padding: 4px 9px;
  color: var(--el-color-primary);
  border: 1px solid var(--el-color-primary);
  font-size: 11px;

  &:hover {
    background: color-mix(in srgb, var(--el-color-primary) 8%, transparent);
  }
}

.quick-command-editor-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.quick-command-editor {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 9px;
  border: 1px solid var(--el-border-color);
  border-radius: $radius;
  background: var(--el-fill-color-lighter);
}

.quick-command-order {
  display: flex;
  flex-direction: column;
  gap: 2px;

  button {
    width: 22px;
    height: 20px;
    color: var(--el-text-color-secondary);

    &:hover:not(:disabled) {
      color: var(--el-color-primary);
      background: var(--el-fill-color);
    }

    &:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
  }
}

.quick-command-fields {
  display: grid;
  grid-template-columns: minmax(0, 0.42fr) minmax(0, 1fr);
  gap: 8px;
  flex: 1;
  min-width: 0;

  :deep(.el-input) {
    min-width: 0;
  }
}

.quick-command-delete {
  width: 28px;
  height: 28px;
  color: var(--el-text-color-secondary);

  &:hover {
    color: var(--el-color-danger);
    background: color-mix(in srgb, var(--el-color-danger) 8%, transparent);
  }
}

.quick-command-settings-empty {
  padding: 32px 16px;
  border: 1px dashed var(--el-border-color);
  border-radius: $radius;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 560px) {
  .quick-command-fields {
    grid-template-columns: minmax(0, 1fr);
  }

  .quick-command-editor {
    align-items: flex-start;
  }

  .quick-command-delete {
    margin-top: 1px;
  }
}
</style>
