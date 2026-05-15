import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Mirror of main's SavedLayout — preload is its own bundle and can't import
// from main, so the shape is duplicated here. Keep in sync with main/settings.ts.
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

// Custom APIs for renderer
const api = {
  getCwd: () => ipcRenderer.invoke('get-cwd') as Promise<string>,
  getPlatform: () => ipcRenderer.invoke('get-platform') as Promise<NodeJS.Platform>,
  getGitInfo: (cwd: string) =>
    ipcRenderer.invoke('get-git-info', cwd) as Promise<{ isRepo: boolean; branch: string | null }>,
  getGitBranches: (cwd: string) =>
    ipcRenderer.invoke('get-git-branches', cwd) as Promise<
      { name: string; local: boolean; remote: boolean; worktree?: boolean }[]
    >,
  getGitDiffStats: (cwd: string) =>
    ipcRenderer.invoke('git-diff-stats', cwd) as Promise<{ added: number; deleted: number }>,
  gitHasChanges: (cwd: string) => ipcRenderer.invoke('git-has-changes', cwd) as Promise<boolean>,
  gitCheckout: (cwd: string, branchName: string, isRemote?: boolean) =>
    ipcRenderer.invoke('git-checkout', cwd, branchName, isRemote) as Promise<{
      success: boolean
      error?: string
    }>,
  gitWorktreeAdd: (cwd: string, opts: { path: string; newBranch?: string; fromBranch?: string }) =>
    ipcRenderer.invoke('git-worktree-add', cwd, opts) as Promise<{
      success: boolean
      error?: string
      warning?: string
    }>,
  selectDirectory: () => ipcRenderer.invoke('select-directory') as Promise<string | null>,
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized') as Promise<boolean>,
  onWindowStateChanged: (cb: (maximized: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('window-state-changed', listener)
    return () => ipcRenderer.removeListener('window-state-changed', listener)
  },
  settingsGet: () =>
    ipcRenderer.invoke('settings-get') as Promise<{
      windowBounds?: { x?: number; y?: number; width: number; height: number }
      windowMaximized?: boolean
      fontSize?: number
      paneLayout?: SavedLayout
      autoOpenTasksOnRun?: boolean
    }>,
  settingsSet: (patch: {
    fontSize?: number
    paneLayout?: SavedLayout | null
    autoOpenTasksOnRun?: boolean
  }) => ipcRenderer.send('settings-set', patch),
  ptyStart: (opts: { paneId: string; cols?: number; rows?: number; cwd?: string }) =>
    ipcRenderer.invoke('pty-start', opts) as Promise<void>,
  ptyWrite: (paneId: string, data: string) => ipcRenderer.send('pty-write', paneId, data),
  ptyResize: (paneId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty-resize', paneId, cols, rows),
  ptyKill: (paneId: string) => ipcRenderer.send('pty-kill', paneId),
  ptyGetCwd: (paneId: string) =>
    ipcRenderer.invoke('pty-get-cwd', paneId) as Promise<string | null>,
  onPtyData: (paneId: string, cb: (data: string) => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { paneId: string; data: string }
    ): void => {
      if (payload && payload.paneId === paneId) cb(payload.data)
    }
    ipcRenderer.on('pty-data', listener)
    return () => {
      ipcRenderer.removeListener('pty-data', listener)
    }
  },
  onPtyExit: (paneId: string, cb: (exitCode: number) => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { paneId: string; exitCode: number }
    ): void => {
      if (payload && payload.paneId === paneId) cb(payload.exitCode)
    }
    ipcRenderer.on('pty-exit', listener)
    return () => {
      ipcRenderer.removeListener('pty-exit', listener)
    }
  },

  // --- Background tasks ----------------------------------------------------
  taskSubscribe: () => ipcRenderer.invoke('task-subscribe') as Promise<TaskMeta[]>,
  taskList: () => ipcRenderer.invoke('task-list') as Promise<TaskMeta[]>,
  taskOutput: (id: string) => ipcRenderer.invoke('task-output', id) as Promise<string>,
  taskStart: (opts: { id?: string; name?: string; command?: string; cwd?: string }) =>
    ipcRenderer.invoke('task-start', opts) as Promise<TaskMeta>,
  taskStop: (id: string) => ipcRenderer.invoke('task-stop', id) as Promise<void>,
  taskRestart: (id: string) =>
    ipcRenderer.invoke('task-restart', id) as Promise<TaskMeta | null>,
  taskRemove: (id: string) => ipcRenderer.invoke('task-remove', id) as Promise<void>,
  taskUpdate: (id: string, patch: { name?: string; command?: string; cwd?: string }) =>
    ipcRenderer.invoke('task-update', id, patch) as Promise<TaskMeta | null>,
  readPackageScripts: (cwd: string) =>
    ipcRenderer.invoke('read-package-scripts', cwd) as Promise<Record<string, string>>,
  onTaskData: (cb: (payload: { id: string; chunk: string }) => void) => {
    const listener = (_e: IpcRendererEvent, p: { id: string; chunk: string }): void => cb(p)
    ipcRenderer.on('task-data', listener)
    return () => ipcRenderer.removeListener('task-data', listener)
  },
  onTaskStatus: (cb: (meta: TaskMeta) => void) => {
    const listener = (_e: IpcRendererEvent, meta: TaskMeta): void => cb(meta)
    ipcRenderer.on('task-status', listener)
    return () => ipcRenderer.removeListener('task-status', listener)
  },
  onTaskCleared: (cb: (payload: { id: string }) => void) => {
    const listener = (_e: IpcRendererEvent, p: { id: string }): void => cb(p)
    ipcRenderer.on('task-cleared', listener)
    return () => ipcRenderer.removeListener('task-cleared', listener)
  },
  onTaskRemoved: (cb: (payload: { id: string }) => void) => {
    const listener = (_e: IpcRendererEvent, p: { id: string }): void => cb(p)
    ipcRenderer.on('task-removed', listener)
    return () => ipcRenderer.removeListener('task-removed', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
