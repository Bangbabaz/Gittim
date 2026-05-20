import { ElectronAPI } from '@electron-toolkit/preload'

type SavedLayout =
  | { type: 'pane'; cwd: string }
  | {
      type: 'split'
      direction: 'row' | 'column'
      ratio: number
      a: SavedLayout
      b: SavedLayout
    }

interface TaskMeta {
  id: string
  name: string
  command: string
  cwd: string
  status: 'idle' | 'running' | 'exited' | 'failed'
  exitCode: number | null
  startedAt: number | null
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getCwd: () => Promise<string>
      getPlatform: () => Promise<NodeJS.Platform>
      getAppVersion: () => Promise<string>
      getGitInfo: (cwd: string) => Promise<{ isRepo: boolean; branch: string | null }>
      getGitBranches: (
        cwd: string
      ) => Promise<
        { name: string; local: boolean; remote: boolean; remoteName?: string; worktree?: boolean }[]
      >
      getRepoName: (cwd: string) => Promise<string | null>
      getGitDiffStats: (cwd: string) => Promise<{ added: number; deleted: number }>
      gitHasChanges: (cwd: string) => Promise<boolean>
      gitCheckout: (
        cwd: string,
        branchName: string,
        isRemote?: boolean,
        remoteName?: string
      ) => Promise<{ success: boolean; error?: string }>
      gitStash: (cwd: string) => Promise<{ success: boolean; error?: string }>
      gitWorktrees: (cwd: string) => Promise<
        {
          path: string
          branch: string | null
          head: string | null
          isMain: boolean
          detached: boolean
          locked: boolean
        }[]
      >
      gitWorktreeRemove: (
        cwd: string,
        worktreePath: string,
        force?: boolean
      ) => Promise<{ success: boolean; error?: string }>
      gitDiff: (cwd: string) => Promise<{ diff: string; truncated: boolean }>
      gitWorktreeAdd: (
        cwd: string,
        opts: { path: string; newBranch?: string; fromBranch?: string }
      ) => Promise<{ success: boolean; error?: string; warning?: string }>
      selectDirectory: () => Promise<string | null>
      winMinimize: () => void
      winMaximize: () => void
      winClose: () => void
      winIsMaximized: () => Promise<boolean>
      onWindowStateChanged: (cb: (maximized: boolean) => void) => () => void
      settingsGet: () => Promise<{
        windowBounds?: { x?: number; y?: number; width: number; height: number }
        windowMaximized?: boolean
        fontSize?: number
        scrollback?: number
        paneLayout?: SavedLayout
        autoOpenTasksOnRun?: boolean
        tasksDrawerWidth?: number
        theme?: 'system' | 'dark' | 'light'
        defaultIde?: string
      }>
      settingsSet: (patch: {
        fontSize?: number
        scrollback?: number
        paneLayout?: SavedLayout | null
        autoOpenTasksOnRun?: boolean
        tasksDrawerWidth?: number
        theme?: 'system' | 'dark' | 'light'
        defaultIde?: string
      }) => void
      themeSetSource: (src: 'system' | 'dark' | 'light') => void
      themeShouldUseDark: () => Promise<boolean>
      onNativeThemeUpdated: (cb: (shouldUseDark: boolean) => void) => () => void
      ptyStart: (opts: {
        paneId: string
        cols?: number
        rows?: number
        cwd?: string
      }) => Promise<void>
      ptyWrite: (paneId: string, data: string) => void
      ptyResize: (paneId: string, cols: number, rows: number) => void
      ptyKill: (paneId: string) => void
      ptyGetCwd: (paneId: string) => Promise<string | null>
      ptyHasRunningProcess: (paneId: string) => Promise<boolean>
      onPtyData: (paneId: string, cb: (data: string) => void) => () => void
      onPtyExit: (paneId: string, cb: (exitCode: number) => void) => () => void
      taskSubscribe: () => Promise<TaskMeta[]>
      taskList: () => Promise<TaskMeta[]>
      taskOutput: (id: string) => Promise<string>
      taskStart: (opts: {
        id?: string
        name?: string
        command?: string
        cwd?: string
      }) => Promise<TaskMeta>
      taskCreate: (opts: { name?: string; command: string; cwd: string }) => Promise<TaskMeta>
      taskStop: (id: string) => Promise<void>
      taskInput: (id: string, data: string) => void
      taskResize: (id: string, cols: number, rows: number) => void
      taskRestart: (id: string) => Promise<TaskMeta | null>
      taskRemove: (id: string) => Promise<void>
      taskUpdate: (
        id: string,
        patch: { name?: string; command?: string; cwd?: string }
      ) => Promise<TaskMeta | null>
      readPackageScripts: (cwd: string) => Promise<Record<string, string>>
      ideList: (
        force?: boolean
      ) => Promise<{ id: string; name: string; command: string; iconDataUrl?: string }[]>
      ideOpen: (ideId: string, cwd: string) => Promise<{ success: boolean; error?: string }>
      openFolder: (cwd: string) => Promise<boolean>
      pathExists: (p: string) => Promise<boolean>
      onTaskData: (cb: (payload: { id: string; chunk: string }) => void) => () => void
      onTaskStatus: (cb: (meta: TaskMeta) => void) => () => void
      onTaskCleared: (cb: (payload: { id: string }) => void) => () => void
      onTaskRemoved: (cb: (payload: { id: string }) => void) => () => void
    }
  }
}
