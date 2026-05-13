import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getCwd: () => ipcRenderer.invoke('get-cwd') as Promise<string>,
  ptyStart: (opts: { cols?: number; rows?: number; cwd?: string }) =>
    ipcRenderer.invoke('pty-start', opts) as Promise<void>,
  ptyWrite: (data: string) => ipcRenderer.send('pty-write', data),
  ptyResize: (cols: number, rows: number) =>
    ipcRenderer.send('pty-resize', cols, rows),
  onPtyData: (cb: (data: string) => void) => {
    const listener = (_event: IpcRendererEvent, data: string) => cb(data)
    ipcRenderer.on('pty-data', listener)
    return () => {
      ipcRenderer.removeListener('pty-data', listener)
    }
  },
  onPtyExit: (cb: (exitCode: number) => void) => {
    const listener = (_event: IpcRendererEvent, exitCode: number) => cb(exitCode)
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
