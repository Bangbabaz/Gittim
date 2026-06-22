import {
  app,
  shell,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  screen,
  nativeTheme,
  session
} from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import { writeFile, mkdir } from 'fs/promises'
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
  getConflictVersions,
  saveConflictResolution,
  abortMergeOp,
  continueMergeOp,
  getFileDiff,
  gitShowFile,
  getCommitLog,
  getCommitDetail,
  gitCommitBranches,
  gitMerge,
  gitRebase,
  gitCreateBranch,
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
  killAllTasks,
  removeTasksByCwd
} from './tasks'
import { initAutoUpdater, checkForUpdates, installUpdate } from './updater'
import { detectIdes, openIde, hydrateIdeCache } from './ide'
import { transcribePcm, disposeStt, sttModelExists } from './stt'
import { registerBrowser, unregisterBrowser, disposeAllBrowsers } from './browser'
import { startMcpServer, stopMcpServer, getMcpPort } from './mcp-server'
import icon from '../../resources/icon.png?asset'
import type { PtyStartOpts, Settings, WorktreeAddOpts, CommitLogOpts } from '@shared/types'

// macOS 26 (Tahoe) + Electron 39 上,Chromium 的输入法状态机会与 mac IME 频繁
// 不同步,blink.mojom.WidgetHost 每秒抛 100+ 条 `TextInputStateChanged rejected`
// IPC 错误,顶死 mojo pipe 导致 GPU/Network helper 偶发崩重启 —— 表现为启动
// 后输入卡顿、首帧渲染拖慢。下面三个 feature 都和"窗口/焦点状态被 macOS 误判
// 为不可见"链路相关,关掉后错误流消失。必须在 app.whenReady() 之前调用,
// commandLine switches 只在进程启动早期生效。
// 如果将来 Electron 升级修了上游问题(跟踪关键字
// "MacWebContentsOcclusion + TextInputState")可以拆掉这三行。
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,MacWebContentsOcclusion'
)
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

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
      sandbox: false,
      webviewTag: true
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

  // 初始化自动更新。必须在 mainWindow 赋值后调用,updater 需要向
  // renderer 发送状态事件。开发模式下自动跳过。
  initAutoUpdater(win)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.gittim.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 允许 renderer 调用:
  //   - getUserMedia 拿麦克风(语音输入功能)。Chromium 把麦克风 + 摄像头都归
  //     为 'media' permission,不放行 mac 上会静默 deny,getUserMedia 报
  //     NotAllowedError。
  //   - navigator.clipboard.readText / writeText(粘贴等系统快捷键)。Electron
  //     默认拒绝 'clipboard-read' / 'clipboard-sanitized-write',readText() 抛错
  //     被空 catch 吞掉,表现为 Cmd/Ctrl+V 无反应。
  // 其它权限请求(notifications、geolocation 等)一律拒绝。
  const allowedPermissions = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowedPermissions.has(permission))
  })

  // 用上次扫描的 IDE 列表填充 main 的内存 cache,让首个 IdeLauncher mount 时
  // ide-list IPC 直接返回缓存,不必等本次完整扫描(mac 上 system_profiler 首次
  // 10+ 秒,会占满 libuv 线程池让其它 execFile 排队 —— 这是启动卡顿的主要来源)。
  // 必须在注册 `ide-list` ipcMain.handle 之前调用。
  hydrateIdeCache(readSettings().cachedIdes)

  // 启动内置 MCP server —— Agent 可以在终端面板里通过 MCP 协议操控浏览器。
  startMcpServer()

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
    async (_event, cwd: string, worktreePath: string, force?: boolean) => {
      const result = await gitRemoveWorktree(cwd, worktreePath, force)
      if (result.success) {
        // 删除工作树后同步清理该目录下的后台任务
        removeTasksByCwd(worktreePath).catch(() => {})
      }
      return result
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
  ipcMain.handle('git-conflict-versions', (_event, cwd: string, file: string) =>
    getConflictVersions(cwd, file)
  )
  ipcMain.handle(
    'git-conflict-save',
    (_event, cwd: string, file: string, content: string) =>
      saveConflictResolution(cwd, file, content)
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
  ipcMain.handle('git-commit-branches', (_event, cwd: string, hashes: string[]) =>
    gitCommitBranches(cwd, hashes)
  )

  // Branch operations (from the branch context menu)
  ipcMain.handle('git-merge', (_event, cwd: string, ref: string) => gitMerge(cwd, ref))
  ipcMain.handle('git-rebase', (_event, cwd: string, ref: string) => gitRebase(cwd, ref))
  ipcMain.handle(
    'git-branch-create',
    (_event, cwd: string, name: string, startRef: string) => gitCreateBranch(cwd, name, startRef)
  )
  ipcMain.handle('git-push', (_event, cwd: string, branch: string) => gitPush(cwd, branch))
  ipcMain.handle('git-pull', (_event, cwd: string) => gitPull(cwd))
  ipcMain.handle('git-branch-delete', (_event, cwd: string, branch: string, force?: boolean) =>
    gitDeleteBranch(cwd, branch, force)
  )

  ipcMain.handle('git-worktree-add', (_event, cwd: string, opts: WorktreeAddOpts) => {
    return gitAddWorktree(cwd, opts)
  })

  // 读取剪贴板中的图片。
  //
  // 优先级：
  // 1. 文件引用（Finder/资源管理器复制图片文件）→ 直接返回原始路径
  // 2. 位图数据（截图等）→ 落盘为临时 PNG
  //
  // Electron 原生 clipboard.readImage() 可直接读取 NSPasteboard (macOS) /
  // CF_DIB (Windows) 中的位图,不受 navigator.clipboard 只能读文本的限制。
  // 但 macOS Finder 复制文件时剪贴板存的是 file reference URL
  // (file:///.file/id=...)，readImage() 拿到的是 Finder 生成的类型图标而非
  // 文件内容 —— 所以必须优先走文件路径检测。
  const IMG_EXTS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp',
    'webp', 'svg', 'tiff', 'ico', 'heic', 'heif'
  ])

  ipcMain.handle('clipboard-read-image', async (): Promise<string | null> => {
    // ── macOS: 文件引用 URL ──────────────────────────────────────────
    if (process.platform === 'darwin') {
      try {
        const fileUrl = clipboard.read('public.file-url') as string | null
        if (fileUrl && typeof fileUrl === 'string' && fileUrl.startsWith('file://')) {
          // file:///.file/id=... 是不透明的 macOS file reference URL,需要用
          // osascript 通过 Foundation 解析为真实 POSIX 路径。
          const realPath = execFileSync('osascript', [
            '-e',
            `get POSIX path of (POSIX file "${fileUrl}")`
          ], { encoding: 'utf8', timeout: 3000 }).trim()
          if (realPath && existsSync(realPath)) {
            const ext = realPath.split('.').pop()?.toLowerCase()
            if (ext && IMG_EXTS.has(ext)) return realPath
          }
        }
      } catch {
        // osascript 解析失败或文件不存在,fallthrough 到 readImage
      }
    }

    // ── Windows: CF_HDROP ────────────────────────────────────────────
    if (process.platform === 'win32') {
      try {
        const buf = clipboard.readBuffer('FileNameW')
        if (buf && buf.length > 0) {
          // FileNameW / CF_HDROP: DROPFILES 头部的 pFiles (DWORD, offset 0)
          // 指向文件列表起始偏移。列表是 UTF-16LE null-terminated 字符串,
          // 以双 null 结尾。
          const pFiles = buf.readUInt32LE(0)
          let pos = pFiles
          const paths: string[] = []
          while (pos < buf.length - 1) {
            let end = pos
            while (end < buf.length - 1 && !(buf[end] === 0 && buf[end + 1] === 0)) {
              end += 2
            }
            if (end > pos) {
              paths.push(buf.toString('utf16le', pos, end))
            }
            pos = end + 2
            // 双 null 表示列表结束
            if (pos >= buf.length - 1 || (buf[pos] === 0 && buf[pos + 1] === 0)) break
          }
          for (const p of paths) {
            if (existsSync(p)) {
              const ext = p.split('.').pop()?.toLowerCase()
              if (ext && IMG_EXTS.has(ext)) return p
            }
          }
        }
      } catch {
        // 剪贴板不含 FileNameW 数据,fallthrough 到 readImage
      }
    }

    // ── 位图（截图等）─────────────────────────────────────────────────
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    // macOS 截图进剪贴板是 PNG;Windows 截图一般是 BMP/PNG,统一写 PNG。
    const png = img.toPNG()
    if (!png || png.length === 0) return null
    const dir = join(tmpdir(), 'gittim-paste')
    await mkdir(dir, { recursive: true })
    const name = `gittim-paste-${Date.now()}-${randomBytes(4).toString('hex')}.png`
    const filePath = join(dir, name)
    await writeFile(filePath, png)
    return filePath
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

  ipcMain.handle('update-check', () => checkForUpdates())
  ipcMain.on('update-install', () => installUpdate())

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

  // Browser
  ipcMain.handle('browser-register', (_event, paneId: string, webContentsId: number) => {
    try {
      registerBrowser(paneId, webContentsId)
    } catch (e) {
      console.error('[browser] register failed:', e)
      throw e
    }
  })
  ipcMain.handle('browser-unregister', (_event, paneId: string) => {
    unregisterBrowser(paneId)
  })
  ipcMain.handle('browser-get-mcp-url', () => {
    return `http://127.0.0.1:${getMcpPort()}/sse`
  })

  createWindow()
  // 不再启动期自动 detectIdes —— hydrateIdeCache 已经让 UI 立即可用,真正的扫描
  // 推迟到 cache miss(首次启动无 settings.cachedIdes)或用户点"重新检测"时。
  // mac 上 system_profiler 一次扫 10+ 秒,启动期不该跟 PTY/git 抢线程池。

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
        await Promise.all([killAllTasks(), killAllPtyTrees(), disposeStt(), disposeAllBrowsers()])
        stopMcpServer()
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
