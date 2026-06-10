// 浏览器面板 session 管理 + CDP 控制。
//
// 每个 pane 最多对应一个 BrowserSession；通过 webContents.debugger 控制 CDP，
// 同时维持一个环形网络请求缓冲区供 MCP server 的 browser_network 工具查询。

import { webContents } from 'electron'

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
    pendingRequests: new Map()
  }

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

/** 退出时清理所有 browser session。 */
export function disposeAllBrowsers(): void {
  for (const paneId of Array.from(sessions.keys())) {
    unregisterBrowser(paneId)
  }
}
