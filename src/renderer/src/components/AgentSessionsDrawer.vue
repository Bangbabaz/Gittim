<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { AgentSessionInfo, AgentSessionProvider } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  filterCwd?: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'openSession', session: AgentSessionInfo): void
}>()

const loading = ref(false)
const sessions = ref<AgentSessionInfo[]>([])
const provider = ref<'all' | AgentSessionProvider>('all')

function normPath(p: string | null | undefined): string {
  if (!p) return ''
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase()
  return s
}

function pathMatchesScope(sessionCwd: string | null, scopeCwd: string): boolean {
  const sessionPath = normPath(sessionCwd)
  if (!sessionPath || !scopeCwd) return false
  if (sessionPath === scopeCwd) return true
  return sessionPath.startsWith(`${scopeCwd}/`) || scopeCwd.startsWith(`${sessionPath}/`)
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    sessions.value = await window.api.agentSessionsList()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ElMessage.error(`读取会话失败: ${msg}`)
  } finally {
    loading.value = false
  }
}

const filtered = computed(() => {
  const cwd = normPath(props.filterCwd)
  const seen = new Set<string>()
  return sessions.value.filter((session) => {
    const key = `${session.provider}:${session.id}`
    if (seen.has(key)) return false
    seen.add(key)
    if (provider.value !== 'all' && session.provider !== provider.value) return false
    if (cwd && !pathMatchesScope(session.cwd, cwd)) return false
    return true
  })
})

function openSession(session: AgentSessionInfo): void {
  emit('openSession', session)
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) void refresh()
  }
)

watch(
  () => props.filterCwd,
  () => {
    provider.value = 'all'
    if (props.modelValue) void refresh()
  }
)

onMounted(() => {
  if (props.modelValue) void refresh()
})
</script>

<template>
  <aside v-if="modelValue" class="agent-sessions-panel">
    <div class="agent-session-toolbar">
      <el-radio-group v-model="provider" size="small" class="agent-session-provider-filter">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="claude">Claude</el-radio-button>
        <el-radio-button value="codex">Codex</el-radio-button>
      </el-radio-group>
    </div>

    <div v-if="loading && sessions.length === 0" class="agent-session-empty">读取中...</div>
    <div v-else-if="filtered.length === 0" class="agent-session-empty">没有会话</div>
    <div v-else class="agent-session-list">
      <button
        v-for="session in filtered"
        :key="`${session.provider}:${session.id}`"
        class="agent-session-row"
        :title="session.title"
        @click="openSession(session)"
      >
        {{ session.title }}
      </button>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.agent-sessions-panel {
  width: 260px;
  min-width: 180px;
  max-width: 320px;
  height: 100%;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color-overlay);
  border-right: 1px solid var(--el-border-color);
  overflow: hidden;
  padding: 8px;
}

.agent-session-toolbar {
  margin-bottom: 6px;
}

.agent-session-provider-filter {
  width: 100%;

  :deep(.el-radio-button) {
    flex: 1;
  }

  :deep(.el-radio-button__inner) {
    width: 100%;
    padding: 6px 4px;
    font-size: 11px;
    line-height: 1;
  }
}

.agent-session-list {
  overflow: auto;
  padding: 0;
}

.agent-session-row {
  width: 100%;
  min-width: 0;
  display: block;
  border: 0;
  background: transparent;
  color: var(--el-text-color-primary);
  text-align: left;
  font-size: 12px;
  line-height: 1.15;
  padding: 4px 6px;
  border-radius: 5px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    background: var(--el-fill-color);
  }
}

.agent-session-empty {
  padding: 16px 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-align: center;
}
</style>
