// 浏览器面板 session 管理 + CDP 控制。
//
// 每个 pane 最多对应一个 BrowserSession；通过 webContents.debugger 控制 CDP，
// 同时维持一个环形网络请求缓冲区供 MCP server 的 browser_network 工具查询。

import { app, webContents } from 'electron'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface NetworkEntry {
  requestId: string
  url: string
  method: string
  status?: number
  statusText?: string
  type: string // Document, XHR, Fetch, Script, Stylesheet, Image, etc.
  timestamp: number
  /** ms，从 requestWillBeSent 到 responseReceived。 */
  duration?: number
  /** encodedDataLength，仅 response 时有值。 */
  size?: number
  /** response / websocket / eventSource / ... */
  resourceType?: string
}

export interface BrowserRouteRule {
  id: string
  urlPattern: string
  method?: string
  action: 'continue' | 'abort' | 'mock'
  status?: number
  headers?: Record<string, string>
  body?: string
  contentType?: string
}

export interface DownloadEntry {
  guid: string
  url: string
  fileName?: string
  suggestedFilename?: string
  state: 'inProgress' | 'completed' | 'canceled'
  totalBytes?: number
  receivedBytes?: number
  path?: string
  timestamp: number
}

interface RequestTrace {
  url: string
  method: string
  type: string
  timestamp: number
}

interface BrowserSession {
  paneId: string
  webContentsId: number
  debuggerAttached: boolean
  networkRequests: NetworkEntry[]
  pendingRequests: Map<string, RequestTrace>
  /** 待处理的 JS dialog（alert/confirm/prompt） */
  pendingDialog?: { type: string; message: string; defaultPrompt?: string }
  /** Console 日志环形缓冲（最多 50 条） */
  consoleLogs: Array<{ type: string; text: string; timestamp: number }>
  routeRules: BrowserRouteRule[]
  downloads: DownloadEntry[]
}

const sessions = new Map<string, BrowserSession>()
const NETWORK_BUFFER_MAX = 200

// 等待激活: MCP server 请求激活浏览器后,在此等待 registerBrowser 回调
const pendingActivations = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function pushNetworkEntry(session: BrowserSession, entry: NetworkEntry): void {
  session.networkRequests.push(entry)
  if (session.networkRequests.length > NETWORK_BUFFER_MAX) {
    session.networkRequests.shift()
  }
}

function wcForSession(session: BrowserSession): Electron.WebContents | null {
  const wc = webContents.fromId(session.webContentsId)
  if (!wc || wc.isDestroyed()) return null
  return wc
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 注册浏览器面板 —— renderer 中 <webview> onReady 后调用。
 * 附加 CDP debugger 并开始监听网络事件。
 */
export function registerBrowser(paneId: string, wcId: number): void {
  // 防御：先注销旧的
  unregisterBrowser(paneId)

  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) {
    throw new Error(`webContents.fromId(${wcId}) returned null`)
  }

  wc.debugger.attach('1.3')

  const session: BrowserSession = {
    paneId,
    webContentsId: wcId,
    debuggerAttached: true,
    networkRequests: [],
    pendingRequests: new Map(),
    consoleLogs: [],
    routeRules: [],
    downloads: []
  }

  void wc.debugger.sendCommand('Network.enable').catch(() => {})
  void wc.debugger.sendCommand('Page.enable').catch(() => {})
  void wc.debugger.sendCommand('Runtime.enable').catch(() => {})
  void wc.debugger
    .sendCommand('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: app.getPath('downloads'),
      eventsEnabled: true
    })
    .catch(() => {})

  // 监听网络请求
  wc.debugger.on('message', (_event, method, params) => {
    if (!sessions.has(paneId)) return

    if (method === 'Network.requestWillBeSent') {
      const p = params as {
        requestId: string
        request: { url: string; method: string }
        type: string
        timestamp: number
      }
      session.pendingRequests.set(p.requestId, {
        url: p.request.url,
        method: p.request.method,
        type: p.type,
        timestamp: p.timestamp
      })
    } else if (method === 'Network.responseReceived') {
      const p = params as {
        requestId: string
        response: {
          url: string
          status: number
          statusText: string
          mimeType: string
          encodedDataLength: number
        }
        type: string
        timestamp: number
      }
      const trace = session.pendingRequests.get(p.requestId)
      const entry: NetworkEntry = {
        requestId: p.requestId,
        url: p.response.url,
        method: trace?.method ?? 'GET',
        status: p.response.status,
        statusText: p.response.statusText,
        type: p.type,
        timestamp: trace?.timestamp ?? p.timestamp,
        duration: trace ? p.timestamp - trace.timestamp : undefined,
        size: p.response.encodedDataLength,
        resourceType: p.type
      }
      pushNetworkEntry(session, entry)
    } else if (method === 'Network.loadingFinished') {
      const p = params as { requestId: string; encodedDataLength: number }
      // 更新已存在 entry 的 size(可能 responseReceived 时没拿到)
      for (let i = session.networkRequests.length - 1; i >= 0; i--) {
        if (session.networkRequests[i].requestId === p.requestId) {
          if (session.networkRequests[i].size == null || session.networkRequests[i].size === 0) {
            session.networkRequests[i].size = p.encodedDataLength
          }
          break
        }
      }
    } else if (method === 'Page.javascriptDialogOpening') {
      // Dialog 监听
      const p = params as { type: string; message: string; defaultPrompt?: string }
      session.pendingDialog = {
        type: p.type,
        message: p.message,
        defaultPrompt: p.defaultPrompt
      }
    } else if (method === 'Runtime.consoleAPICalled') {
      // Console 监听
      const p = params as {
        type: string
        args: Array<{ value?: unknown; description?: string }>
        timestamp: number
      }
      const text = p.args
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
        .join(' ')
      session.consoleLogs.push({ type: p.type, text, timestamp: p.timestamp })
      if (session.consoleLogs.length > 50) session.consoleLogs.shift()
    } else if (method === 'Fetch.requestPaused') {
      void handleRouteRequest(session, params as FetchRequestPausedParams)
    } else if (method === 'Browser.downloadWillBegin') {
      const p = params as { guid: string; url: string; suggestedFilename?: string }
      session.downloads.push({
        guid: p.guid,
        url: p.url,
        suggestedFilename: p.suggestedFilename,
        fileName: p.suggestedFilename,
        state: 'inProgress',
        path: p.suggestedFilename ? `${app.getPath('downloads')}\\${p.suggestedFilename}` : undefined,
        timestamp: Date.now()
      })
      if (session.downloads.length > 50) session.downloads.shift()
    } else if (method === 'Browser.downloadProgress') {
      const p = params as {
        guid: string
        state: 'inProgress' | 'completed' | 'canceled'
        totalBytes?: number
        receivedBytes?: number
      }
      const item = session.downloads.find((d) => d.guid === p.guid)
      if (item) {
        item.state = p.state
        item.totalBytes = p.totalBytes
        item.receivedBytes = p.receivedBytes
      }
    }
  })

  sessions.set(paneId, session)

  // 如果有等待中的激活请求,通知它
  const pending = pendingActivations.get(paneId)
  if (pending) {
    pending.resolve()
    pendingActivations.delete(paneId)
  }
}

/** 注销浏览器面板 —— renderer 中 <webview> onDestroyed 时或 pane 关闭时调用。 */
export function unregisterBrowser(paneId: string): void {
  const session = sessions.get(paneId)
  if (!session) return

  const wc = webContents.fromId(session.webContentsId)
  if (wc && !wc.isDestroyed() && session.debuggerAttached) {
    try {
      wc.debugger.detach()
    } catch {
      // 可能已经被 detach 了 —— 忽略
    }
  }

  session.pendingRequests.clear()
  sessions.delete(paneId)
}

/** 对指定 pane 的浏览器执行 CDP 命令。 */
export async function executeCdp(
  paneId: string,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const session = sessions.get(paneId)
  if (!session) throw new Error(`Browser session not found: ${paneId}`)

  const wc = wcForSession(session)
  if (!wc) throw new Error(`webContents destroyed for pane: ${paneId}`)

  return wc.debugger.sendCommand(method, params)
}

/** 获取指定 pane 的网络请求缓冲(最近 200 条)。 */
export function getNetworkRequests(paneId: string): NetworkEntry[] {
  const session = sessions.get(paneId)
  if (!session) return []
  return [...session.networkRequests]
}

/** 获取指定请求的响应体。 */
export async function getNetworkResponseBody(
  paneId: string,
  requestId: string
): Promise<{ body: string; base64Encoded: boolean }> {
  const session = sessions.get(paneId)
  if (!session) throw new Error(`Browser session not found: ${paneId}`)

  const wc = wcForSession(session)
  if (!wc) throw new Error(`webContents destroyed for pane: ${paneId}`)

  try {
    const result = (await wc.debugger.sendCommand('Network.getResponseBody', {
      requestId
    })) as { body: string; base64Encoded: boolean }
    return result
  } catch (e) {
    throw new Error(`Failed to get response body for ${requestId}: ${String(e)}`)
  }
}

/** 检查指定 pane 的浏览器是否已注册。 */
export function hasBrowser(paneId: string): boolean {
  return sessions.has(paneId)
}

/** 获取所有活跃浏览器面板的 paneId 列表。 */
export function getActiveBrowserPaneIds(): string[] {
  return Array.from(sessions.keys())
}

/**
 * 等待指定 pane 的浏览器激活。
 * 用于 agent 首次调用 MCP 工具时自动触发浏览器抽屉打开,webview 挂载后 resolve。
 */
export function waitForActivation(paneId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingActivations.delete(paneId)
      reject(new Error('浏览器激活超时。请手动点击工具栏的 🌐 按钮打开浏览器。'))
    }, 15000)
    pendingActivations.set(paneId, {
      resolve: () => {
        clearTimeout(timeout)
        resolve()
      },
      reject: (e) => {
        clearTimeout(timeout)
        reject(e)
      }
    })
  })
}

/**
 * 拒绝某个 pane 的激活请求(如 pane 不存在)。
 */
export function rejectActivation(paneId: string, reason: string): void {
  const pending = pendingActivations.get(paneId)
  if (pending) {
    pending.reject(new Error(reason))
    pendingActivations.delete(paneId)
  }
}

/** 获取指定 pane 的待处理 dialog。 */
export function getPendingDialog(
  paneId: string
): { type: string; message: string; defaultPrompt?: string } | null {
  const session = sessions.get(paneId)
  if (!session?.pendingDialog) return null
  return session.pendingDialog
}

/** 清除指定 pane 的待处理 dialog。 */
export function clearPendingDialog(paneId: string): void {
  const session = sessions.get(paneId)
  if (session) session.pendingDialog = undefined
}

/** 获取指定 pane 的 console 日志缓冲。 */
export function getConsoleLogs(
  paneId: string
): Array<{ type: string; text: string; timestamp: number }> {
  const session = sessions.get(paneId)
  if (!session) return []
  return [...session.consoleLogs]
}

/** 清空指定 pane 的 console 日志缓冲。 */
export function clearConsoleLogs(paneId: string): void {
  const session = sessions.get(paneId)
  if (session) session.consoleLogs = []
}

export function getDownloads(paneId: string): DownloadEntry[] {
  const session = sessions.get(paneId)
  if (!session) return []
  return [...session.downloads]
}

export function clearDownloads(paneId: string): void {
  const session = sessions.get(paneId)
  if (session) session.downloads = []
}

export async function addRouteRule(paneId: string, rule: BrowserRouteRule): Promise<void> {
  const session = sessions.get(paneId)
  if (!session) throw new Error(`Browser session not found: ${paneId}`)
  session.routeRules = session.routeRules.filter((r) => r.id !== rule.id)
  session.routeRules.push(rule)
  await executeCdp(paneId, 'Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }]
  })
}

export async function clearRouteRules(paneId: string): Promise<void> {
  const session = sessions.get(paneId)
  if (!session) return
  session.routeRules = []
  await executeCdp(paneId, 'Fetch.disable')
}

export function getRouteRules(paneId: string): BrowserRouteRule[] {
  const session = sessions.get(paneId)
  if (!session) return []
  return [...session.routeRules]
}

interface FetchRequestPausedParams {
  requestId: string
  request: {
    url: string
    method: string
    headers?: Record<string, string>
  }
}

async function handleRouteRequest(
  session: BrowserSession,
  params: FetchRequestPausedParams
): Promise<void> {
  const rule = session.routeRules.find((r) =>
    routeMatches(r, params.request.url, params.request.method)
  )
  try {
    if (!rule || rule.action === 'continue') {
      await executeCdp(session.paneId, 'Fetch.continueRequest', { requestId: params.requestId })
      return
    }

    if (rule.action === 'abort') {
      await executeCdp(session.paneId, 'Fetch.failRequest', {
        requestId: params.requestId,
        errorReason: 'Aborted'
      })
      return
    }

    const headers = Object.entries({
      'content-type': rule.contentType ?? 'application/json',
      ...(rule.headers ?? {})
    }).map(([name, value]) => ({ name, value }))

    await executeCdp(session.paneId, 'Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: rule.status ?? 200,
      responseHeaders: headers,
      body: Buffer.from(rule.body ?? '').toString('base64')
    })
  } catch {
    try {
      await executeCdp(session.paneId, 'Fetch.continueRequest', { requestId: params.requestId })
    } catch {
      // ignore
    }
  }
}

function routeMatches(rule: BrowserRouteRule, url: string, method: string): boolean {
  if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false
  if (rule.urlPattern.startsWith('/') && rule.urlPattern.endsWith('/')) {
    try {
      return new RegExp(rule.urlPattern.slice(1, -1)).test(url)
    } catch {
      return false
    }
  }
  return url.includes(rule.urlPattern)
}

/** 退出时清理所有 browser session。 */
export function disposeAllBrowsers(): void {
  for (const paneId of Array.from(sessions.keys())) {
    unregisterBrowser(paneId)
  }
}
