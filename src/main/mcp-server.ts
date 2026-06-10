// MCP (Model Context Protocol) HTTP Server —— SSE transport。
//
// 监听 127.0.0.1 上的可配置端口，提供 6 个浏览器自动化工具。
// Agent 通过 shell 环境变量 GITTIM_PANE_ID 获取自己的 paneId，
// 在每个工具调用中作为 paneId 参数传入，server 据此路由到对应浏览器。
// 不传 paneId 且仅有一个活跃浏览器时自动匹配（多浏览器时报错提示）。
//
// MCP over SSE 协议:
//   1. Client → GET /sse → 服务器返回 SSE 流（无需 ?pane=）
//   2. Server 先发 `event: endpoint` 告知消息端点 URL
//   3. Client → POST /message?sessionId=<id> → JSON-RPC 请求
//   4. Server 通过 SSE 流返回 JSON-RPC response

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { URL } from 'url'
import {
  executeCdp,
  getNetworkRequests,
  getNetworkResponseBody,
  hasBrowser,
  waitForActivation,
  getActiveBrowserPaneIds
} from './browser'
import type { NetworkEntry } from './browser'
import { getPtyWebContents } from './shell'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MCP_PORT = 9876
const MCP_HOST = '127.0.0.1'

/** JSON-RPC 错误码 */
const ERR_METHOD = -32601
const ERR_INVALID = -32602
const ERR_INTERNAL = -32603

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

interface SseSession {
  id: string
  res: ServerResponse
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// paneId 参数 schema（注入到每个工具的 inputSchema）
// ---------------------------------------------------------------------------

const PANE_ID_SCHEMA = {
  paneId: {
    type: 'string',
    description:
      '当前终端面板的 ID。从环境变量 GITTIM_PANE_ID 读取。' +
      '仅有一个活跃浏览器时可省略（自动匹配）；多个浏览器时必填。'
  }
} as const

// ---------------------------------------------------------------------------
// MCP 工具定义
// ---------------------------------------------------------------------------

const TOOLS: McpToolDef[] = [
  {
    name: 'browser_navigate',
    description: '导航到指定 URL，返回页面 title 和最终 URL（含重定向）',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '目标 URL，需带协议头（如 https://example.com）'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['url']
    }
  },
  {
    name: 'browser_screenshot',
    description: '截取当前页面或指定元素的截图，返回 base64 编码的 PNG 图片',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器。不传则截整个视口；传入则截该元素的 bounding box'
        },
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    name: 'browser_click',
    description: '点击页面元素（CSS 选择器）或指定坐标',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器，与 x/y 二选一'
        },
        x: { type: 'number', description: 'X 坐标（与 y 一起使用）' },
        y: { type: 'number', description: 'Y 坐标（与 x 一起使用）' },
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    name: 'browser_type',
    description: '在输入框中输入文本',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '目标 input/textarea 的 CSS 选择器'
        },
        text: { type: 'string', description: '要输入的文本' },
        ...PANE_ID_SCHEMA
      },
      required: ['selector', 'text']
    }
  },
  {
    name: 'browser_evaluate',
    description: '在页面中执行 JavaScript 表达式并返回结果（JSON 序列化）',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '要执行的 JavaScript 代码' },
        ...PANE_ID_SCHEMA
      },
      required: ['script']
    }
  },
  {
    name: 'browser_network',
    description: '获取网络请求信息。action=list 返回最近请求列表；action=get 获取指定请求的响应体',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get'],
          description: 'list=列请求列表, get=取单个请求响应体'
        },
        requestId: {
          type: 'string',
          description: 'action=get 时必填，要获取响应体的请求 ID'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['action']
    }
  }
]

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const sseSessions = new Map<string, SseSession>()
let serverInstance: ReturnType<typeof createServer> | null = null

// ---------------------------------------------------------------------------
// paneId 解析 —— 从工具参数中提取 paneId，必要时自动匹配
// ---------------------------------------------------------------------------

async function resolvePaneId(args: Record<string, unknown> | undefined): Promise<string> {
  // 用户显式传递 paneId → 直接使用；未激活则自动激活
  if (args?.paneId && typeof args.paneId === 'string') {
    if (!hasBrowser(args.paneId)) {
      // 通知对应面板的渲染进程自动打开浏览器抽屉
      const wc = getPtyWebContents(args.paneId)
      if (!wc || wc.isDestroyed()) {
        throw new Error(`面板 ${args.paneId} 不存在或已销毁。`)
      }
      wc.send('browser-activate', args.paneId)
      await waitForActivation(args.paneId)
    }
    return args.paneId
  }

  // 自动匹配
  const activeIds = getActiveBrowserPaneIds()
  if (activeIds.length >= 1) {
    // 仅一个时直接用，多个时取第一个（agent 环境最常见的是每个面板独立运行）
    return activeIds[0]
  }

  // 无活跃浏览器，无法自动匹配 → 提示传 paneId
  throw new Error(
    '未找到活跃的浏览器面板。' +
      '请在工具调用中传入 paneId 参数（从环境变量 GITTIM_PANE_ID 读取），' +
      '首次调用时会自动激活该面板的浏览器。'
  )
}

// ---------------------------------------------------------------------------
// CDP 操作辅助
// ---------------------------------------------------------------------------

async function getPageTitle(paneId: string): Promise<string> {
  try {
    const result = (await executeCdp(paneId, 'Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true
    })) as { result: { value: string } }
    return result?.result?.value ?? ''
  } catch {
    return ''
  }
}

async function querySelectorBox(
  paneId: string,
  selector: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const nodeResult = (await executeCdp(paneId, 'DOM.getDocument', {
      depth: -1
    })) as { root: { nodeId: number } }
    const rootNodeId = nodeResult.root.nodeId

    const queryResult = (await executeCdp(paneId, 'DOM.querySelector', {
      nodeId: rootNodeId,
      selector
    })) as { nodeId: number }

    if (!queryResult.nodeId || queryResult.nodeId === 0) {
      return null
    }

    const boxResult = (await executeCdp(paneId, 'DOM.getBoxModel', {
      nodeId: queryResult.nodeId
    })) as { model: { content: number[] } }

    if (!boxResult?.model?.content || boxResult.model.content.length < 8) {
      return null
    }

    const [x1, y1, x2, y2, x3, y3, x4, y4] = boxResult.model.content
    const x = Math.min(x1, x2, x3, x4)
    const y = Math.min(y1, y2, y3, y4)
    const w = Math.max(x1, x2, x3, x4) - x
    const h = Math.max(y1, y2, y3, y4) - y

    return { x: x + w / 2, y: y + h / 2, width: w, height: h }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tool call 分发
// ---------------------------------------------------------------------------

async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<{
  content: Array<{
    type: string
    text?: string
    data?: string
    mimeType?: string
  }>
}> {
  const paneId = await resolvePaneId(args)

  switch (name) {
    case 'browser_navigate': {
      const url = args?.url as string
      if (!url) throw new Error('缺少 url 参数')

      const navResult = (await executeCdp(paneId, 'Page.navigate', {
        url
      })) as { frameId?: string; loaderId?: string; errorText?: string }

      if (navResult?.errorText) {
        throw new Error(`导航失败: ${navResult.errorText}`)
      }

      // 等 load 事件
      try {
        await executeCdp(paneId, 'Page.loadEventFired')
      } catch {
        // 可能页面加载太快或 protocol 不支持，忽略
      }

      const title = await getPageTitle(paneId)
      return {
        content: [{ type: 'text', text: JSON.stringify({ title, url, ok: true }) }]
      }
    }

    case 'browser_screenshot': {
      const selector = args?.selector as string | undefined

      const captureParams: Record<string, unknown> = { format: 'png' }
      if (selector) {
        const box = await querySelectorBox(paneId, selector)
        if (!box) throw new Error(`未找到元素: ${selector}`)
        captureParams.clip = {
          x: box.x - box.width / 2,
          y: box.y - box.height / 2,
          width: box.width,
          height: box.height,
          scale: 1
        }
      }

      const result = (await executeCdp(paneId, 'Page.captureScreenshot', captureParams)) as {
        data: string
      }

      return {
        content: [
          {
            type: 'image',
            data: result.data,
            mimeType: 'image/png'
          }
        ]
      }
    }

    case 'browser_click': {
      let x: number, y: number

      if (args?.selector) {
        const box = await querySelectorBox(paneId, args.selector as string)
        if (!box) throw new Error(`未找到元素: ${args.selector}`)
        x = box.x
        y = box.y
      } else if (typeof args?.x === 'number' && typeof args?.y === 'number') {
        x = args.x
        y = args.y
      } else {
        throw new Error('需要 selector 或 {x, y} 参数')
      }

      await executeCdp(paneId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y
      })
      await executeCdp(paneId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1
      })
      await executeCdp(paneId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1
      })

      return {
        content: [{ type: 'text', text: JSON.stringify({ clicked: true, x, y }) }]
      }
    }

    case 'browser_type': {
      const selector = args?.selector as string
      const text = args?.text as string
      if (!selector) throw new Error('缺少 selector 参数')
      if (text == null) throw new Error('缺少 text 参数')

      const box = await querySelectorBox(paneId, selector)
      if (!box) throw new Error(`未找到元素: ${selector}`)

      // 先点一下聚焦
      await executeCdp(paneId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1
      })
      await executeCdp(paneId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1
      })

      await executeCdp(paneId, 'Input.insertText', { text })

      return {
        content: [{ type: 'text', text: JSON.stringify({ typed: true, text }) }]
      }
    }

    case 'browser_evaluate': {
      const script = args?.script as string
      if (!script) throw new Error('缺少 script 参数')

      const result = (await executeCdp(paneId, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
        awaitPromise: true
      })) as {
        result: { type: string; value?: unknown; description?: string }
        exceptionDetails?: {
          text?: string
          exception?: { description?: string }
        }
      }

      if (result?.exceptionDetails) {
        const msg =
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Unknown'
        throw new Error(`执行脚本出错: ${msg}`)
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              type: result?.result?.type,
              value: result?.result?.value
            })
          }
        ]
      }
    }

    case 'browser_network': {
      const action = args?.action as string
      if (!action) throw new Error('缺少 action 参数')

      if (action === 'list') {
        const entries: NetworkEntry[] = getNetworkRequests(paneId)
        const summary = entries.map((e) => ({
          requestId: e.requestId,
          url: e.url,
          method: e.method,
          status: e.status,
          type: e.type,
          duration: e.duration,
          size: e.size
        }))
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                requests: summary,
                count: summary.length
              })
            }
          ]
        }
      }

      if (action === 'get') {
        const requestId = args?.requestId as string
        if (!requestId) throw new Error('action=get 需要 requestId 参数')
        const body = await getNetworkResponseBody(paneId, requestId)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                requestId,
                body: body.body,
                base64Encoded: body.base64Encoded
              })
            }
          ]
        }
      }

      throw new Error(`未知 action: ${action}，支持 list 和 get`)
    }

    default:
      throw new Error(`未知工具: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// SSE + HTTP Server
// ---------------------------------------------------------------------------

function setSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  })
}

function sendSseEvent(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\ndata: ${data}\n\n`)
}

function sendJsonRpcError(
  res: ServerResponse,
  id: number | string | undefined | null,
  code: number,
  message: string
): void {
  sendSseEvent(
    res,
    'message',
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message }
    })
  )
}

function sendJsonRpcResult(
  res: ServerResponse,
  id: number | string | undefined,
  result: unknown
): void {
  sendSseEvent(
    res,
    'message',
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      result
    })
  )
}

async function handleJsonRpc(session: SseSession, req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req

  try {
    switch (method) {
      case 'initialize':
        sendJsonRpcResult(session.res, id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'gittim-browser',
            version: '0.1.0'
          }
        })
        break

      case 'tools/list':
        sendJsonRpcResult(session.res, id, { tools: TOOLS })
        break

      case 'tools/call': {
        const toolName = params?.name as string
        const toolArgs = params?.arguments as Record<string, unknown> | undefined

        if (!toolName) {
          sendJsonRpcError(session.res, id, ERR_INVALID, '缺少 tool name')
          return
        }

        try {
          const result = await handleToolCall(toolName, toolArgs)
          sendJsonRpcResult(session.res, id, result)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          sendJsonRpcResult(session.res, id, {
            content: [{ type: 'text', text: msg }],
            isError: true
          })
        }
        break
      }

      case 'notifications/initialized':
        // 客户端初始化完成，不回复
        break

      default:
        sendJsonRpcError(session.res, id, ERR_METHOD, `未知方法: ${method}`)
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    sendJsonRpcError(session.res, id, ERR_INTERNAL, msg)
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function startMcpServer(port: number = MCP_PORT): number {
  if (serverInstance) return port

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${MCP_HOST}:${port}`)

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      })
      res.end()
      return
    }

    // GET /sse —— 建立 SSE 连接（无需 ?pane= 参数）
    if (req.method === 'GET' && url.pathname === '/sse') {
      const sessionId = randomUUID()
      setSseHeaders(res)

      const session: SseSession = { id: sessionId, res }
      sseSessions.set(sessionId, session)

      const messageUrl = `http://${MCP_HOST}:${port}/message?sessionId=${sessionId}`
      sendSseEvent(res, 'endpoint', messageUrl)

      req.on('close', () => {
        sseSessions.delete(sessionId)
      })

      return
    }

    // POST /message?sessionId=<id> —— 接收 JSON-RPC 请求
    if (req.method === 'POST' && url.pathname === '/message') {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('缺少 ?sessionId= 参数')
        return
      }

      const session = sseSessions.get(sessionId)
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('未知或已过期的 session')
        return
      }

      try {
        const raw = await readBody(req)
        const rpc = JSON.parse(raw) as JsonRpcRequest
        res.writeHead(202, { 'Content-Type': 'text/plain' })
        res.end('Accepted')

        await handleJsonRpc(session, rpc)
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('无效的 JSON-RPC 请求')
      }
      return
    }

    // 其他
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  server.listen(port, MCP_HOST, () => {
    console.log(`[mcp] MCP server listening on http://${MCP_HOST}:${port}/sse`)
  })

  serverInstance = server
  return port
}

export function stopMcpServer(): void {
  for (const [, session] of sseSessions) {
    try {
      session.res.end()
    } catch {
      // ignore
    }
  }
  sseSessions.clear()

  if (serverInstance) {
    serverInstance.close()
    serverInstance = null
  }
}

export function getMcpPort(): number {
  return MCP_PORT
}
