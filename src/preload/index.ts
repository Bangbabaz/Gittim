import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getCwd: () => ipcRenderer.invoke('get-cwd') as Promise<string>,
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
