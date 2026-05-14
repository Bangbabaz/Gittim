import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getCwd: () => ipcRenderer.invoke('get-cwd') as Promise<string>,
  getGitInfo: (cwd: string) =>
    ipcRenderer.invoke('get-git-info', cwd) as Promise<{ isRepo: boolean; branch: string | null }>,
  getGitBranches: (cwd: string) => ipcRenderer.invoke('get-git-branches', cwd) as Promise<string[]>,
  gitHasChanges: (cwd: string) => ipcRenderer.invoke('git-has-changes', cwd) as Promise<boolean>,
  gitCheckout: (cwd: string, branchName: string) =>
    ipcRenderer.invoke('git-checkout', cwd, branchName) as Promise<{
      success: boolean
      error?: string
    }>,
  gitWorktreeAdd: (
    cwd: string,
    opts: { path: string; newBranch?: string; fromBranch?: string }
  ) =>
    ipcRenderer.invoke('git-worktree-add', cwd, opts) as Promise<{
      success: boolean
      error?: string
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
  ptyStart: (opts: { paneId: string; cols?: number; rows?: number; cwd?: string }) =>
    ipcRenderer.invoke('pty-start', opts) as Promise<void>,
  ptyWrite: (paneId: string, data: string) => ipcRenderer.send('pty-write', paneId, data),
  ptyResize: (paneId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty-resize', paneId, cols, rows),
  ptyKill: (paneId: string) => ipcRenderer.send('pty-kill', paneId),
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
