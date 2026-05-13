import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getCwd: () => Promise<string>
      ptyStart: (opts: { cols?: number; rows?: number; cwd?: string }) => Promise<void>
      ptyWrite: (data: string) => void
      ptyResize: (cols: number, rows: number) => void
      onPtyData: (cb: (data: string) => void) => () => void
      onPtyExit: (cb: (exitCode: number) => void) => () => void
    }
  }
}
