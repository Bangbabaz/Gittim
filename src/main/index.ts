import { app, shell, BrowserWindow, dialog, ipcMain, screen, nativeTheme, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  startPty,
  writePty,
  resizePty,
  killPty,
  killAllPtyTrees,
  getCurrentDir,
  getPtyCwd,
  ptyHasRunningProcess,
  getGitInfo,
  getGitBranches,
  getRepoName,
  checkoutGitBranch,
  gitAddWorktree,
  gitHasUncommittedChanges,
  getGitDiffStats,
  gitStash,
  getGitWorktrees,
  gitRemoveWorktree,
  getGitDiff,
  getMergeStatus,
  resolveConflictBySide,
  markConflictResolved,
  abortMergeOp,
  continueMergeOp,
  getFileDiff,
  gitShowFile,
  getCommitLog,
  getCommitDetail,
  gitMerge,
  gitRebase,
  gitPush,
  gitPull,
  gitDeleteBranch
} from './shell'
import { readSettings, updateSettings, flushSettings } from './settings'
import { readFileSync, existsSync, statSync } from 'fs'
import {
  registerTaskSubscriber,
  loadPersistedTasks,
  listTasks,
  getTaskOutput,
  startTask,
  stopTask,
  restartTask,
  removeTask,
  updateTask,
  createTask,
  writeTask,
  resizeTask,
  killAllTasks
} from './tasks'
import { detectIdes, openIde, prewarmIdes } from './ide'
import { transcribePcm, disposeStt, sttModelExists } from './stt'
import icon from '../../resources/icon.png?asset'
import type { PtyStartOpts, Settings, WorktreeAddOpts, CommitLogOpts } from '@shared/types'

let mainWindow: BrowserWindow | null = null

function clampBoundsToDisplay(b: { x?: number; y?: number; width: number; height: number }): {
  x?: number
  y?: number
  width: number
  height: number
} {
  // If a saved position lands off-screen (display unplugged, resolution change),
  // drop x/y so Electron centers the window on the primary display.
  if (b.x === undefined || b.y === undefined) return b
  const displays = screen.getAllDisplays()
  const onScreen = displays.some((d) => {
    const a = d.workArea
    return b.x! >= a.x && b.y! >= a.y && b.x! < a.x + a.width && b.y! < a.y + a.height
  })
  return onScreen ? b : { width: b.width, height: b.height }
}

function createWindow(): void {
  const settings = readSettings()
  const bounds = clampBoundsToDisplay(settings.windowBounds ?? { width: 1100, height: 720 })

  const win = new BrowserWindow({
    ...bounds,
    show: false,
    title: 'Gittim',
    autoHideMenuBar: true,
    // macOS gets the system traffic-light buttons; win/linux gets our custom
    // HTML buttons rendered in App.vue.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    if (settings.windowMaximized) win.maximize()
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // PTY cleanup happens via webContents.once('destroyed') inside startPty —
  // don't touch mainWindow on 'closed' (the BrowserWindow is already destroyed
  // and accessing .webContents throws "Object has been destroyed").

  // HMR for renderer base on electron-vite cli.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Persist window state. Resize/move fire continuously during drag — settings
  // module debounces, so this is safe.
  const persistBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
    const b = win.getBounds()
    updateSettings({ windowBounds: b })
  }
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('maximize', () => {
    updateSettings({ windowMaximized: true })
    win.webContents.send('window-state-changed', true)
  })
  win.on('unmaximize', () => {
    updateSettings({ windowMaximized: false })
    win.webContents.send('window-state-changed', false)
  })

  mainWindow = win
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.gittim.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 允许 renderer 调用 getUserMedia 拿麦克风(语音输入功能)。Chromium 把
  // 麦克风 + 摄像头都归为 'media' permission,这里只放行 media,其它请求一律拒绝。
  // 不放行 mac 上会静默 deny,renderer 端 getUserMedia 报 NotAllowedError。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  // ----- IPC handlers ------------------------------------------------------
  //
  // 通道命名约定:
  //   - sys-*    系统信息(cwd / platform / app version)
  //   - git-*    git 操作和查询(全部带前缀,无 get- 双前缀)
  //   - pty-*    PTY 终端会话
  //   - task-*   后台任务
  //   - settings-* / theme-* / win-* / ide-*    各自模块名空间
  //   - 其它独立 channel:select-directory / path-exists / read-package-scripts
  //
  // 之前 git 相关 channel 混用了 `get-git-*` 与 `git-*` 两种前缀,统一改为 git-*。
  ipcMain.handle('sys-cwd', () => getCurrentDir())
  ipcMain.handle('sys-platform', () => process.platform)
  ipcMain.handle('sys-app-version', () => app.getVersion())
  ipcMain.handle('git-info', (_event, cwd: string) => getGitInfo(cwd))
  ipcMain.handle('git-branches', (_event, cwd: string) => getGitBranches(cwd))
  ipcMain.handle('git-repo-name', (_event, cwd: string) => getRepoName(cwd))
  ipcMain.handle('git-diff-stats', (_event, cwd: string) => getGitDiffStats(cwd))
  ipcMain.handle('git-has-changes', (_event, cwd: string) => gitHasUncommittedChanges(cwd))

  ipcMain.handle(
    'git-checkout',
    (_event, cwd: string, branchName: string, isRemote?: boolean, remoteName?: string) => {
      return checkoutGitBranch(cwd, branchName, isRemote, remoteName)
    }
  )

  ipcMain.handle('git-stash', (_event, cwd: string) => gitStash(cwd))
  ipcMain.handle('git-worktrees', (_event, cwd: string) => getGitWorktrees(cwd))
  ipcMain.handle(
    'git-worktree-remove',
    (_event, cwd: string, worktreePath: string, force?: boolean) => {
      return gitRemoveWorktree(cwd, worktreePath, force)
    }
  )
  ipcMain.handle('git-diff', (_event, cwd: string) => getGitDiff(cwd))

  // Merge / rebase / cherry-pick / revert conflict state
  ipcMain.handle('git-merge-status', (_event, cwd: string) => getMergeStatus(cwd))
  ipcMain.handle(
    'git-conflict-resolve',
    (_event, cwd: string, file: string, side: 'ours' | 'theirs') =>
      resolveConflictBySide(cwd, file, side)
  )
  ipcMain.handle('git-conflict-mark-resolved', (_event, cwd: string, file: string) =>
    markConflictResolved(cwd, file)
  )
  ipcMain.handle(
    'git-merge-abort',
    (_event, cwd: string, kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert') =>
      abortMergeOp(cwd, kind)
  )
  ipcMain.handle(
    'git-merge-continue',
    (_event, cwd: string, kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert') =>
      continueMergeOp(cwd, kind)
  )
  ipcMain.handle('git-file-diff', (_event, cwd: string, file: string) => getFileDiff(cwd, file))
  ipcMain.handle('git-show-file', (_event, cwd: string, ref: string | null, path: string) =>
    gitShowFile(cwd, ref, path)
  )

  // Commit history
  ipcMain.handle('git-log', (_event, cwd: string, opts: CommitLogOpts) =>
    getCommitLog(cwd, opts || {})
  )
  ipcMain.handle('git-commit-detail', (_event, cwd: string, hash: string) =>
    getCommitDetail(cwd, hash)
  )

  // Branch operations (from the branch context menu)
  ipcMain.handle('git-merge', (_event, cwd: string, ref: string) => gitMerge(cwd, ref))
  ipcMain.handle('git-rebase', (_event, cwd: string, ref: string) => gitRebase(cwd, ref))
  ipcMain.handle('git-push', (_event, cwd: string, branch: string) => gitPush(cwd, branch))
  ipcMain.handle('git-pull', (_event, cwd: string) => gitPull(cwd))
  ipcMain.handle('git-branch-delete', (_event, cwd: string, branch: string, force?: boolean) =>
    gitDeleteBranch(cwd, branch, force)
  )

  ipcMain.handle('git-worktree-add', (_event, cwd: string, opts: WorktreeAddOpts) => {
    return gitAddWorktree(cwd, opts)
  })

  ipcMain.handle('select-directory', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.on('win-minimize', () => mainWindow?.minimize())
  ipcMain.on('win-maximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('win-close', () => mainWindow?.close())
  ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false)

  // Settings IPC
  ipcMain.handle('settings-get', () => readSettings())
  ipcMain.on('settings-set', (_event, patch: Partial<Settings>) => {
    updateSettings(patch)
  })

  // Theme IPC. The renderer owns the CSS-token swap; nativeTheme is the source
  // of truth for "follow system" (and keeps native chrome — dialogs, scrollbars
  // — consistent with the chosen theme).
  const applyThemeSource = (src: unknown): void => {
    nativeTheme.themeSource = src === 'dark' || src === 'light' ? src : 'system'
  }
  applyThemeSource(readSettings().theme)
  ipcMain.on('theme-set-source', (_event, src: 'system' | 'dark' | 'light') => {
    applyThemeSource(src)
  })
  ipcMain.handle('theme-should-use-dark', () => nativeTheme.shouldUseDarkColors)
  // Fires when the OS appearance changes (only meaningful in 'system' mode).
  nativeTheme.on('updated', () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('native-theme-updated', nativeTheme.shouldUseDarkColors)
      }
    }
  })

  ipcMain.handle('pty-start', (event, opts: PtyStartOpts) => {
    startPty(event.sender, opts)
  })

  ipcMain.on('pty-write', (_event, paneId: string, data: string) => {
    writePty(paneId, data)
  })

  ipcMain.on('pty-resize', (_event, paneId: string, cols: number, rows: number) => {
    resizePty(paneId, cols, rows)
  })

  ipcMain.on('pty-kill', (_event, paneId: string) => {
    killPty(paneId)
  })

  ipcMain.handle('pty-get-cwd', (_event, paneId: string) => getPtyCwd(paneId))

  ipcMain.handle('pty-has-running-process', (_event, paneId: string) =>
    ptyHasRunningProcess(paneId)
  )

  // Background tasks
  loadPersistedTasks()
  ipcMain.handle('task-subscribe', (event) => {
    registerTaskSubscriber(event.sender)
    return listTasks()
  })
  ipcMain.handle('task-list', () => listTasks())
  ipcMain.handle('task-output', (_event, id: string) => getTaskOutput(id))
  ipcMain.handle(
    'task-start',
    (_event, opts: { id?: string; name?: string; command: string; cwd: string }) => {
      return startTask(opts)
    }
  )
  ipcMain.handle('task-create', (_event, opts: { name?: string; command: string; cwd: string }) => {
    return createTask(opts)
  })
  ipcMain.on('task-input', (_event, id: string, data: string) => writeTask(id, data))
  ipcMain.on('task-resize', (_event, id: string, cols: number, rows: number) =>
    resizeTask(id, cols, rows)
  )
  ipcMain.handle('task-stop', (_event, id: string) => stopTask(id))
  ipcMain.handle('task-restart', (_event, id: string) => restartTask(id))
  ipcMain.handle('task-remove', (_event, id: string) => removeTask(id))
  ipcMain.handle(
    'task-update',
    (_event, id: string, patch: { name?: string; command?: string; cwd?: string }) => {
      return updateTask(id, patch)
    }
  )

  // Read `scripts` from a directory's package.json for one-click task chips.
  ipcMain.handle('path-exists', (_event, p: string): boolean => {
    try {
      return !!p && existsSync(p)
    } catch {
      return false
    }
  })

  // IDE detection + launch. Detection scans PATH + a handful of well-known
  // install dirs; the result is cached for the session unless the renderer
  // explicitly forces a re-scan (e.g. after the user installed something new).
  ipcMain.handle('ide-list', (_event, force?: boolean) => detectIdes(!!force))
  ipcMain.handle('ide-open', (_event, ideId: string, cwd: string) => openIde(ideId, cwd))
  ipcMain.handle('open-folder', (_event, cwd: string) => shell.openPath(cwd).then(() => true))

  // ----- Speech-to-Text ----------------------------------------------------
  // renderer 录完一段就发完整 PCM(Float32, 16kHz, mono)过来。IPC 走结构化克隆,
  // typed array 直接传,无需 Base64。返回值即转写结果。
  ipcMain.handle(
    'stt-transcribe',
    async (_event, opts: { pcm: Float32Array; language?: string }) => {
      const pcm = opts?.pcm
      if (!(pcm instanceof Float32Array)) {
        return { ok: false, error: 'PCM 数据无效' }
      }
      return transcribePcm(pcm, opts.language || 'auto')
    }
  )
  ipcMain.handle('stt-model-exists', () => sttModelExists())

  ipcMain.handle('read-package-scripts', (_event, cwd: string): Record<string, string> => {
    try {
      const path = join(cwd, 'package.json')
      // 防御性大小检查 —— 一个 10 MB 的伪 package.json 不会让 main process 拿
      // 整个文件 readFile + JSON.parse,而是直接当成"无 scripts"返回。realistic
      // package.json 远不及 1 MB,大于阈值的多半是攻击或者垃圾文件。
      const size = statSync(path).size
      if (size > 1024 * 1024) return {}
      const raw = readFileSync(path, 'utf8')
      const pkg = JSON.parse(raw)
      return pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {}
    } catch {
      return {}
    }
  })

  createWindow()
  // IDE 检测要 ~300 ms（Windows 注册表）/ 1-2 s（macOS system_profiler）。
  // 在窗口已经显示后异步预扫,首次点击 IDE 按钮时就是缓存命中。失败也无所谓 ——
  // detectIdes(true) 会按需重试。
  prewarmIdes()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// before-quit fires synchronously and Electron tears the process down right
// after we return — but killAllTasks is now async (it has to snapshot the
// descendant tree before each pty.kill()). Defer the actual quit until the
// cleanup resolves; without this the snapshot PowerShell is killed mid-flight
// and detached survivors (Nx workers, dev servers) are left running.
let cleanupDone = false
let cleanupPromise: Promise<void> | null = null

async function runCleanup(): Promise<void> {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      try {
        // 后台任务 + 每个面板的 PTY 子进程树并行清理。仅依赖
        // webContents.once('destroyed') 兜底是不够的 —— before-quit 期间 main
        // 已在收尾,async killPty 没人 await,killProcessTree 起的 PowerShell
        // snapshot 会被 main 退出打断,detached 的孙子(Nx workers / vite /
        // dev server)随之逃逸。这里两边一起 await 直到全部杀完。
        await Promise.all([killAllTasks(), killAllPtyTrees(), disposeStt()])
      } finally {
        flushSettings()
        cleanupDone = true
      }
    })()
  }
  return cleanupPromise
}

app.on('before-quit', (event) => {
  if (cleanupDone) return
  event.preventDefault()
  runCleanup().then(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    runCleanup().then(() => app.quit())
  }
})
