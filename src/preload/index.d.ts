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

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getCwd: () => Promise<string>
      getPlatform: () => Promise<NodeJS.Platform>
      getGitInfo: (cwd: string) => Promise<{ isRepo: boolean; branch: string | null }>
      getGitBranches: (
        cwd: string
      ) => Promise<
        { name: string; local: boolean; remote: boolean; worktree?: boolean }[]
      >
      getGitDiffStats: (cwd: string) => Promise<{ added: number; deleted: number }>
      gitHasChanges: (cwd: string) => Promise<boolean>
      gitCheckout: (
        cwd: string,
        branchName: string,
        isRemote?: boolean
      ) => Promise<{ success: boolean; error?: string }>
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
        paneLayout?: SavedLayout
      }>
      settingsSet: (patch: { fontSize?: number; paneLayout?: SavedLayout | null }) => void
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
      onPtyData: (paneId: string, cb: (data: string) => void) => () => void
      onPtyExit: (paneId: string, cb: (exitCode: number) => void) => () => void
    }
  }
}
