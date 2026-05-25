<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ChevronDown, FolderClosed, RefreshCw } from 'lucide-vue-next'
import { iconFor } from '../ideIcons'
import type { IdeInfo } from '@shared/types'

// "在 IDE 中打开"控件 —— 左边一个品牌色 chip(打开默认 IDE)+ 右边小 caret
// (下拉切换 IDE)。chosen IDE 持久化到 settings.defaultIde,下次启动直接命中。
//
// **不依赖 git** —— 任何 cwd 都能用,PaneToolbar 在 isRepo / 非 isRepo 时都
// 渲染。

const props = defineProps<{
  cwd: string
}>()

const ides = ref<IdeInfo[]>([])
const ideLoading = ref(false)
const defaultIdeId = ref<string | null>(null)

const defaultIde = computed<IdeInfo | null>(() => {
  if (!ides.value.length) return null
  const persisted = defaultIdeId.value ? ides.value.find((i) => i.id === defaultIdeId.value) : null
  return persisted || ides.value[0]
})

const defaultIdeIcon = computed(() =>
  defaultIde.value ? iconFor(defaultIde.value.id, defaultIde.value.name) : null
)

async function loadIdes(force = false): Promise<void> {
  ideLoading.value = true
  try {
    ides.value = await window.api.ideList(force)
  } catch {
    ides.value = []
  } finally {
    ideLoading.value = false
  }
}

onMounted(async () => {
  const [settings] = await Promise.all([window.api.settingsGet(), loadIdes(false)])
  if (typeof settings.defaultIde === 'string') {
    defaultIdeId.value = settings.defaultIde
  }
})

async function openWithIde(id: string): Promise<void> {
  if (!props.cwd) return
  const r = await window.api.ideOpen(id, props.cwd)
  if (!r.success) {
    ElMessage.error(r.error || '打开 IDE 失败')
    return
  }
  if (defaultIdeId.value !== id) {
    defaultIdeId.value = id
    window.api.settingsSet({ defaultIde: id })
  }
}

const openDefaultIde = async (): Promise<void> => {
  if (!defaultIde.value) return
  await openWithIde(defaultIde.value.id)
}

const onPickIde = async (cmd: string): Promise<void> => {
  if (cmd === '__refresh__') {
    await loadIdes(true)
    ElMessage.success(ides.value.length ? `检测到 ${ides.value.length} 个 IDE` : '未检测到任何 IDE')
    return
  }
  await openWithIde(cmd)
}
</script>

<template>
  <div class="ide-group">
    <el-tooltip
      :content="defaultIde ? `在 ${defaultIde.name} 中打开` : '在文件管理器中打开'"
      placement="bottom"
      :show-after="300"
    >
      <button
        class="ide-chip"
        :class="{ 'has-real-icon': !!defaultIde?.iconDataUrl }"
        :disabled="ideLoading"
        :style="
          defaultIde?.iconDataUrl
            ? undefined
            : defaultIdeIcon
              ? { background: defaultIdeIcon.color, color: '#fff' }
              : undefined
        "
        @click="openDefaultIde"
      >
        <img
          v-if="defaultIde?.iconDataUrl"
          class="ide-chip-img"
          :src="defaultIde.iconDataUrl"
          alt=""
          draggable="false"
        />
        <svg
          v-else-if="defaultIdeIcon && defaultIdeIcon.path"
          class="ide-chip-svg"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path :d="defaultIdeIcon.path" fill="currentColor" />
        </svg>
        <span v-else-if="defaultIdeIcon" class="ide-chip-letter">
          {{ defaultIdeIcon.letter }}
        </span>
        <FolderClosed v-else :size="13" />
      </button>
    </el-tooltip>
    <el-dropdown
      trigger="click"
      placement="bottom-end"
      popper-class="ide-pick-dropdown"
      @command="onPickIde"
    >
      <button class="ide-caret" :disabled="ideLoading" title="切换 IDE">
        <ChevronDown :size="12" />
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="ide in ides"
            :key="ide.id"
            :command="ide.id"
            :title="ide.command"
            :class="{ picked: ide.id === defaultIde?.id }"
          >
            <span
              class="ide-row-icon"
              :class="{ 'has-real-icon': !!ide.iconDataUrl }"
              :style="ide.iconDataUrl ? undefined : { background: iconFor(ide.id, ide.name).color }"
            >
              <img v-if="ide.iconDataUrl" :src="ide.iconDataUrl" alt="" draggable="false" />
              <svg
                v-else-if="iconFor(ide.id, ide.name).path"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path :d="iconFor(ide.id, ide.name).path" fill="#fff" />
              </svg>
              <span v-else class="ide-row-letter">
                {{ iconFor(ide.id, ide.name).letter }}
              </span>
            </span>
            <span class="td-label">{{ ide.name }}</span>
          </el-dropdown-item>
          <el-dropdown-item v-if="!ides.length" disabled class="cmd-empty">
            未检测到 IDE
          </el-dropdown-item>
          <el-dropdown-item divided command="__refresh__">
            <RefreshCw :size="12" style="margin-right: 6px" />
            重新检测
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<style scoped lang="scss">
.ide-group {
  margin-left: auto;
  display: inline-flex;
  align-items: stretch;
  height: 20px;
  flex-shrink: 0;
}

.ide-chip {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 20px;
  border: 1px solid var(--el-border-color);
  border-right: none;
  border-radius: $radius-sm 0 0 $radius-sm;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-regular);
  flex-shrink: 0;
  transition: filter 0.12s;
}

.ide-chip:hover:not(:disabled) {
  filter: brightness(1.1);
}

.ide-chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ide-chip-svg {
  width: 13px;
  height: 13px;
  display: block;
}

.ide-chip-img {
  width: 16px;
  height: 16px;
  display: block;
  image-rendering: -webkit-optimize-contrast;
}

.ide-chip.has-real-icon {
  background: transparent !important;
  border-color: var(--el-border-color);
}

.ide-chip-letter {
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  font-family: $font-ui;
}

.ide-caret {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 20px;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: 0 $radius-sm $radius-sm 0;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

.ide-caret:hover:not(:disabled) {
  background: var(--el-fill-color);
  color: var(--el-color-primary);
  border-color: var(--el-text-color-secondary);
}

.ide-caret:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

<style lang="scss">
// IDE 下拉行的图标(teleport 到 body,scoped 不到)
.ide-pick-dropdown {
  .ide-row-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    margin-right: 8px;
    flex-shrink: 0;
  }

  .ide-row-icon svg {
    width: 12px;
    height: 12px;
    display: block;
  }

  .ide-row-icon img {
    width: 16px;
    height: 16px;
    display: block;
  }

  .ide-row-icon.has-real-icon {
    background: transparent !important;
  }

  .ide-row-letter {
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    color: #fff;
    font-family: $font-ui;
  }
}
</style>
