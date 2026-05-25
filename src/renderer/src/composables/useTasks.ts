import { ref, type Ref } from 'vue'
import type { TaskMeta } from '@shared/types'

// 全局后台任务列表 —— 跨所有 pane 的 TaskRunner、TasksDrawer 共享一份 reactive ref。
//
// 改造前每个 TaskRunner 各自 fetch + 维护 allTasks ref + 订阅 onTaskStatus /
// onTaskRemoved。N 个 pane 就触发 N 次 upsert + N 次响应式更新,task 状态变化
// 时整个 renderer 被重复广播打到。这里集中到模块级单例:
//
//   - allTasks   单例 ref,所有消费者订阅同一引用 (Vue reactive 共享 → 一次更新
//                自动驱动所有依赖它的组件)
//   - init()     幂等,第一次调用时 subscribe + fetch,后续调用复用同一 promise
//   - 消费者     `const { allTasks } = useTasks()`,无需关心订阅生命周期
//
// 为什么用 taskSubscribe 而不是 taskList:main 端 broadcast (`task-status` /
// `task-removed`) 只发给已 register 的 webContents (subscribers Set)。本 renderer
// 不调 taskSubscribe 一次,所有 onTaskStatus listener 都收不到事件。原来这步
// 由 TasksDrawer 兼任 — 现在抽出来,即使 TasksDrawer 还没 mount,TaskRunner 也
// 能正常收到事件。
//
// 注:onTaskData / onTaskCleared 这两个流事件是 TasksDrawer 的 log viewer 私有
// 关心点(逐字 chunk 写 xterm),不在这里管理。

const allTasks = ref<TaskMeta[]>([])
let initPromise: Promise<void> | null = null

function upsertTask(m: TaskMeta): void {
  const i = allTasks.value.findIndex((t) => t.id === m.id)
  if (i >= 0) allTasks.value[i] = m
  else allTasks.value.push(m)
}

function init(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    // taskSubscribe 同步在 main 端把 webContents 加入 subscribers Set,并返回当前
    // 列表;之后的 task-status / task-removed 广播才会发到本 renderer。
    allTasks.value = await window.api.taskSubscribe()
    window.api.onTaskStatus(upsertTask)
    window.api.onTaskRemoved(({ id }) => {
      allTasks.value = allTasks.value.filter((t) => t.id !== id)
    })
    // 不保存 unsubscribe 句柄:整个 app 生命周期都需要这两个 listener,renderer
    // 退出时 ipcRenderer 自己清理。重复 init 由 initPromise 守护。
  })()
  return initPromise
}

export interface UseTasksReturn {
  /** 共享的全局任务列表。所有消费者读同一引用。 */
  allTasks: Ref<TaskMeta[]>
  /**
   * 首次 subscribe + fetch 完成的 promise。需要"已经拿到列表"再 select 的场景
   * (如 TasksDrawer 想自动定位某个 task)await 它。日常列表展示可以不 await,
   * 数据准备好后响应式会自动驱动 UI。
   */
  ready: Promise<void>
}

export function useTasks(): UseTasksReturn {
  return { allTasks, ready: init() }
}
