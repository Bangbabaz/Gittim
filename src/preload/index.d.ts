import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getCwd: () => Promise<string>
      getGitInfo: (cwd: string) => Promise<{ isRepo: boolean; branch: string | null }>
      getGitBranches: (cwd: string) => Promise<string[]>
      gitHasChanges: (cwd: string) => Promise<boolean>
      gitCheckout: (
        cwd: string,
        branchName: string
      ) => Promise<{ success: boolean; error?: string }>
      gitWorktreeAdd: (
        cwd: string,
        opts: { path: string; newBranch?: string; fromBranch?: string }
      ) => Promise<{ success: boolean; error?: string }>
      selectDirectory: () => Promise<string | null>
      ptyStart: (opts: {
        paneId: string
        cols?: number
        rows?: number
        cwd?: string
      }) => Promise<void>
      ptyWrite: (paneId: string, data: string) => void
      ptyResize: (paneId: string, cols: number, rows: number) => void
      ptyKill: (paneId: string) => void
      onPtyData: (paneId: string, cb: (data: string) => void) => () => void
      onPtyExit: (paneId: string, cb: (exitCode: number) => void) => () => void
    }
  }
}
