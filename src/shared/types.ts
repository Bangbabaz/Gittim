// 所有跨进程共享的类型定义。
//
// main / preload / renderer 三个 bundle 都会引用这里的类型 —— 之前每个 bundle 各自
// 抄一份(SavedLayout、TaskMeta、BranchInfo 全部重复 3 次),改一处要改三处,极易
// 漂移。集中到 src/shared 后,任何字段调整只改一次。
//
// 文件中 **不能** import 任何运行时模块(只能 import type),因为同时被 Node-side
// (main)、preload(沙箱)、renderer(浏览器)消费 —— 任何带运行时副作用的
// import 都会让某一侧炸掉。

// ---------------------------------------------------------------------------
// Pane layout
// ---------------------------------------------------------------------------

/**
 * 持久化到 settings.json 的 layout tree。Pane ID 是运行时生成,每次启动重新分配,
 * 所以序列化形式记录 cwd 而非 ID;deserialize 时分配新 ID 并把 cwd 注入 paneCwd。
 */
export type SavedLayout =
  | { type: 'pane'; cwd: string }
  | {
      type: 'split'
      direction: 'row' | 'column'
      ratio: number
      a: SavedLayout
      b: SavedLayout
    }

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

export type TaskStatus = 'idle' | 'running' | 'exited' | 'failed'

/** 持久化形式 —— 只存定义,不存运行时状态。 */
export interface TaskDef {
  id: string
  name: string
  command: string
  cwd: string
}

/** main → renderer 推送的全量元信息(定义 + 运行状态)。 */
export interface TaskMeta extends TaskDef {
  status: TaskStatus
  exitCode: number | null
  startedAt: number | null
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitInfo {
  isRepo: boolean
  branch: string | null
}

export interface BranchInfo {
  name: string
  /** Exists as a local branch. */
  local: boolean
  /** Exists on at least one remote. A branch can be both local and remote. */
  remote: boolean
  /** 当多个 remote 同名时优先 origin,否则取第一个。Undefined 表示纯本地分支。 */
  remoteName?: string
  /** `git branch` 显示 `+` —— 已在另一 worktree 检出。 */
  worktree?: boolean
}

export interface DiffStats {
  added: number
  deleted: number
}

export interface WorktreeInfo {
  path: string
  branch: string | null
  head: string | null
  isMain: boolean
  detached: boolean
  locked: boolean
}

export type MergeOpKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface ConflictedFile {
  path: string
  /** 来自 `git status -z --porcelain=v2 -u` unmerged 行的两字符 XY 状态。 */
  status: string
  description: string
}

export interface MergeStatus {
  /** null = 没有进行中的操作。 */
  inProgress: MergeOpKind | null
  /**
   * merge:被合并的分支或 ref(从 MERGE_MSG 解析)。
   * rebase:源分支(head-name,无 refs/heads/ 前缀)。
   * cherry-pick / revert:正在应用的 commit short hash。
   */
  target: string | null
  /** 仅 rebase 时有值 —— 正在 replay 到的 commit short hash。 */
  onto: string | null
  conflicts: ConflictedFile[]
}

export interface CommitInfo {
  hash: string
  shortHash: string
  author: string
  email: string
  date: string
  parents: string[]
  /** Decoration refs:['HEAD -> main', 'origin/main', 'tag: v1.0'] */
  refs: string[]
  subject: string
  /**
   * 包含该 commit 的所有分支(本地 + 远程)short name 列表,如 ['main', 'origin/main', 'feat/x']。
   * 由 git-commit-branches IPC 在 commits 加载完成后异步注入,首次拿到 CommitInfo
   * 时该字段为 undefined。前端渲染时通常会减去已经在 `refs` 里展示过的分支名,
   * 余下作为"包含于"行展示 —— 避免和 decoration 标签重复。
   */
  branches?: string[]
}

export interface CommitDetail extends CommitInfo {
  body: string
  /** Unified patch(可能很大 —— caller 自己决定怎么渲染)。 */
  diff: string
  /** patch 超出 buffer cap 被截断时为 true。 */
  truncated: boolean
}

export interface DiffPayload {
  diff: string
  truncated: boolean
}

export interface GitResult {
  success: boolean
  error?: string
}

/** push / worktree-add 等可能在主操作成功的同时附带一个 warning。 */
export interface GitResultWithWarning extends GitResult {
  warning?: string
}

export interface WorktreeAddOpts {
  path: string
  newBranch?: string
  fromBranch?: string
}

export interface CommitLogOpts {
  skip?: number
  limit?: number
  /** branch / tag / 任意 ref。空 → HEAD。 */
  ref?: string
  /** `git log --grep`(case-insensitive regex on subject + body) */
  grep?: string
  /** `git log --author`(case-insensitive regex on name + email) */
  author?: string
}

// ---------------------------------------------------------------------------
// IDE
// ---------------------------------------------------------------------------

export interface IdeInfo {
  id: string
  name: string
  command: string
  iconDataUrl?: string
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemePref = 'system' | 'dark' | 'light'

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export interface Settings {
  windowBounds?: WindowBounds
  windowMaximized?: boolean
  fontSize?: number
  /** 终端 scrollback 缓冲行数。 */
  scrollback?: number
  /** 单个 task 输出缓存上限(KB)。 */
  taskOutputCapKB?: number
  /** null 表示用户在设置面板里清空了 layout(重置)。 */
  paneLayout?: SavedLayout | null
  tasks?: TaskDef[]
  autoOpenTasksOnRun?: boolean
  tasksDrawerWidth?: number
  theme?: ThemePref
  /** 主工具栏 "在 IDE 中打开" 上次选中的 IDE id。 */
  defaultIde?: string
  /**
   * 上一次 detectIdes 的结果(含 iconDataUrl)。启动期 hydrate 进 main 的 cache,
   * 让 IdeLauncher 第一帧就能拿到 IDE 列表 + 真实图标,不需要等异步扫描。
   * 用户点"重新检测"或第一次 dev 启动时由 detectIdes 完整重扫并覆盖。
   */
  cachedIdes?: IdeInfo[]
  /** 非默认快捷键绑定,key = ShortcutAction。 */
  shortcutOverrides?: Record<string, string>
  /** STT 识别语言,默认 'zh'。可选 'zh' | 'en' | 'auto'。 */
  sttLanguage?: string
  /** 语音输入设备 ID,空字符串表示系统默认。 */
  sttDeviceId?: string
  /** 语音输入 PTT 快捷键,默认 'F2'。 */
  voiceShortcut?: string
}

// ---------------------------------------------------------------------------
// Speech-to-Text (whisper.cpp 内置语音输入)
// ---------------------------------------------------------------------------

export interface SttTranscribeOpts {
  /** 16kHz mono Float32 PCM,值域 [-1, 1]。 */
  pcm: Float32Array
  /** ISO 语言码或 'auto'。默认 'auto'。 */
  language?: string
}

export interface SttResult {
  ok: boolean
  /** 识别文本(已 trim,空白片段全部合并)。 */
  text?: string
  /** 模型未就绪 / native binding 加载失败 / 解码失败时的人类可读信息。 */
  error?: string
}

// ---------------------------------------------------------------------------
// PTY
// ---------------------------------------------------------------------------

export interface PtyStartOpts {
  paneId: string
  cols?: number
  rows?: number
  cwd?: string
}

export interface PtyDataPayload {
  paneId: string
  data: string
}

export interface PtyExitPayload {
  paneId: string
  exitCode: number
}

// ---------------------------------------------------------------------------
// 流式 task 事件 payload
// ---------------------------------------------------------------------------

export interface TaskDataPayload {
  id: string
  chunk: string
}

export interface TaskIdPayload {
  id: string
}

// ---------------------------------------------------------------------------
// Auto-update (electron-updater)
// ---------------------------------------------------------------------------

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }
