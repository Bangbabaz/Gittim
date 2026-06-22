// MCP (Model Context Protocol) HTTP Server —— SSE transport。
//
// 监听 127.0.0.1 上的可配置端口，提供终端控制与浏览器自动化工具。
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
  hasBrowser,
  waitForActivation,
  getActiveBrowserPaneIds,
  getNetworkRequests,
  getNetworkResponseBody,
  getPendingDialog,
  clearPendingDialog,
  getConsoleLogs,
  clearConsoleLogs
} from './browser'
import type { NetworkEntry } from './browser'
import * as driver from './browser-driver'
import * as actions from './browser-actions'
import { getAccessibilitySnapshot, formatSnapshot, getQuickSnapshot } from './browser-snapshot'
import { waitScript, ELEMENT_INFO_SCRIPT } from './browser-injected'
import { getActivePtyPaneIds, getPtyCwd, getPtyWebContents, ptyHasRunningProcess } from './shell'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const BROWSER_MCP_PORT = 9876
const AGENT_MCP_PORT = 9877
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
  kind: McpServerKind
  agent?: {
    paneId: string
    name: string
  }
}

type McpServerKind = 'browser' | 'agent'

interface AgentConversation {
  id: string
  participants: [string, string]
  createdAt: number
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
    name: 'agent_register',
    description:
      '把当前 MCP 会话注册为一个协作 Agent。开始 Agent 间协作前必须先调用；' +
      'paneId 从环境变量 GITTIM_PANE_ID 读取。注册后发送者身份由 Gittim 会话绑定，不从消息正文推断。',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: {
          type: 'string',
          description: '当前 Agent 所在终端的 GITTIM_PANE_ID'
        },
        name: {
          type: 'string',
          description: '便于其他 Agent 识别的名称，如 planner、reviewer'
        }
      },
      required: ['paneId', 'name']
    }
  },
  {
    name: 'agent_list',
    description: '列出已注册、可以通过 Gittim MCP 通信的协作 Agent。',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'agent_send',
    description:
      '向一个或多个已注册 Agent 定向发送协作消息。每个目标分别建立独立的双向会话，' +
      '目标能看到真实发送者，但不会看到其他目标，也不会发生广播。' +
      '单个目标可传 targetPaneId；多个目标传 targetPaneIds。',
    inputSchema: {
      type: 'object',
      properties: {
        targetPaneId: {
          type: 'string',
          description: '目标 Agent 的 paneId，通过 agent_list 获取'
        },
        targetPaneIds: {
          type: 'array',
          items: { type: 'string' },
          description: '多个目标 Agent 的 paneId；每个目标会获得独立 conversationId'
        },
        kind: {
          type: 'string',
          enum: ['task', 'question', 'result', 'progress', 'error'],
          description: '消息语义类型，默认 question'
        },
        message: { type: 'string', description: '只包含本轮协作所需信息的消息正文' }
      },
      required: ['message']
    }
  },
  {
    name: 'agent_reply',
    description:
      '回复一条 GITTIM_AGENT_MESSAGE。Gittim 根据 conversationId 自动路由给另一位参与者，' +
      '不要把协作回复伪装成对用户的回答。',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: '收到的协作消息中的 conversationId' },
        kind: {
          type: 'string',
          enum: ['question', 'result', 'progress', 'error'],
          description: '回复类型，默认 result'
        },
        message: { type: 'string', description: '回复正文' }
      },
      required: ['conversationId', 'message']
    }
  },
  {
    name: 'terminal_list_panes',
    description: '列出 Gittim 中当前存活的终端面板，返回 paneId、cwd 和是否有前台子进程。',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'terminal_paste',
    description: '向指定终端安全粘贴文本，但不按 Enter。文本通过 xterm bracketed-paste 链路输入。',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: {
          type: 'string',
          description: '目标终端面板 ID，可通过 terminal_list_panes 获取'
        },
        text: { type: 'string', description: '要粘贴的文本' }
      },
      required: ['paneId', 'text']
    }
  },
  {
    name: 'terminal_submit',
    description: '向指定终端发送一次 Enter。通常在 terminal_paste 后显式调用。',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: {
          type: 'string',
          description: '目标终端面板 ID，可通过 terminal_list_panes 获取'
        }
      },
      required: ['paneId']
    }
  },
  // ---- 原子工具 ----
  {
    // #1
    name: 'browser_navigate',
    description:
      '导航到指定 URL，返回页面 title、最终 URL 和前 10 个可交互元素快照。' +
      '示例：{url: "https://example.com"}。' +
      '导航后直接得到页面结构概览，无需额外调用 snapshot。',
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
    // #2
    name: 'browser_screenshot',
    description:
      '截取当前页面或指定元素的截图，返回 base64 编码的 PNG 图片。' +
      '示例：{selector: "#main"} 截取元素；不传 selector 截整个视口。' +
      '截图消耗较多 token，优先用 browser_snapshot 了解页面状态。',
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
    // #3
    name: 'browser_click',
    description:
      '点击页面元素（CSS 选择器）或指定坐标。含 actionability check——' +
      '自动检测可见性、遮挡、disabled、是否在视口内。' +
      '示例：{selector: "#submit-btn"} 或 {x: 100, y: 200}。' +
      '元素被遮挡或不可操作时返回具体原因和建议。',
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
    // #4
    name: 'browser_type',
    description:
      '逐字符模拟真实键入（触发 keydown/keypress/keyup 事件）。' +
      '适合搜索框自动补全、密码强度检测等依赖逐字符事件的场景。' +
      '示例：{selector: "#search", text: "hello"}。' +
      '普通表单填入文本请用 browser_fill（兼容 React/Vue 受控组件）。',
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
    // #5
    name: 'browser_evaluate',
    description:
      '在页面中执行 JavaScript 表达式并返回结果（JSON 序列化）。' +
      '示例：{script: "document.title"} → 返回页面标题。' +
      '支持 async/await。',
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
    // #6
    name: 'browser_network',
    description:
      '获取网络请求信息。action=list 返回最近请求列表；action=get 获取指定请求的响应体。' +
      '示例：{action: "list"} 或 {action: "get", requestId: "1234.1"}。',
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
  },
  {
    // #7
    name: 'browser_snapshot',
    description:
      '获取页面语义化结构（可交互元素列表），比截图省 token。' +
      '返回每个元素的 ref（序号）、role、name、selector，以及 disabled/focused/checked 等状态。' +
      '最多 100 个节点。' +
      '优先用此工具了解页面状态，截图仅用于需要视觉判断的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    // #8
    name: 'browser_keyboard',
    description:
      '模拟键盘按键。支持单键（"Enter"、"Tab"、"Escape"、"ArrowDown"）和组合键（"Control+a"、"Meta+c"）。' +
      '示例：{key: "Enter"} 提交表单；{key: "Control+a"} 全选。' +
      '支持的功能键：Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, Space, Home, End, PageUp, PageDown, Delete, F1-F12',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            '按键名，如 "Enter"、"Tab"、"Escape"、"ArrowDown"、"Control+a"、"Meta+c"'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['key']
    }
  },
  {
    // #9
    name: 'browser_scroll',
    description:
      '滚动页面或指定元素。传 selector 则将该元素滚入视图；传 direction 则按方向滚动。' +
      '示例：{selector: "#footer"} 滚动到页脚；{direction: "down", amount: 300} 向下滚动 300px。' +
      '返回滚动后的 scrollX/scrollY。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器，将该元素滚入视口中心。与 direction 二选一'
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: '滚动方向（页面级滚动）'
        },
        amount: {
          type: 'number',
          description: '滚动像素数，默认 300'
        },
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    // #10
    name: 'browser_hover',
    description:
      '鼠标悬停到元素或坐标上，触发 hover 效果（下拉菜单、tooltip 等）。' +
      '示例：{selector: ".menu-item"} 或 {x: 200, y: 150}。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器，与 x/y 二选一' },
        x: { type: 'number', description: 'X 坐标（与 y 一起使用）' },
        y: { type: 'number', description: 'Y 坐标（与 x 一起使用）' },
        ...PANE_ID_SCHEMA
      }
    }
  },
  {
    // #11
    name: 'browser_wait',
    description:
      '等待元素达到指定状态。state 可选：visible（可见）、hidden（隐藏）、attached（存在于 DOM）、detached（不存在于 DOM）。' +
      '示例：{selector: ".loading", state: "hidden", timeout: 10000} 等待加载指示器消失。' +
      '默认超时 5000ms。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '要等待的元素的 CSS 选择器' },
        state: {
          type: 'string',
          enum: ['visible', 'hidden', 'attached', 'detached'],
          description: '等待目标状态，默认 visible'
        },
        timeout: {
          type: 'number',
          description: '超时毫秒数，默认 5000'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector']
    }
  },
  {
    // #12
    name: 'browser_element_info',
    description:
      '获取元素的详细属性。默认返回所有属性（text, value, visible, enabled, checked, href, placeholder, boundingBox）。' +
      '示例：{selector: "#email", properties: ["value", "enabled"]}。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器' },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description:
            '要查询的属性列表，可选：text, value, visible, enabled, checked, href, placeholder。默认全部'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector']
    }
  },
  {
    // #13
    name: 'browser_dialog',
    description:
      '处理浏览器原生弹窗（alert/confirm/prompt）。' +
      '示例：{action: "accept"} 点确定；{action: "dismiss"} 点取消；' +
      '{action: "accept", promptText: "hello"} 处理 prompt 并填入文本。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['accept', 'dismiss'],
          description: 'accept=确定, dismiss=取消'
        },
        promptText: {
          type: 'string',
          description: 'action=accept 且弹窗为 prompt 时，填入的文本'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['action']
    }
  },
  {
    // #14
    name: 'browser_console',
    description:
      '获取浏览器控制台输出（最近 50 条 log/warn/error/info）。' +
      '示例：{clear: true} 获取并清空缓冲。' +
      '用于调试页面 JS 错误。',
    inputSchema: {
      type: 'object',
      properties: {
        clear: {
          type: 'boolean',
          description: '是否在获取后清空缓冲，默认 false'
        },
        ...PANE_ID_SCHEMA
      }
    }
  },

  // ---- 复合工具 ----
  {
    // #15
    name: 'browser_fill',
    description:
      '在输入框填入文本（兼容 React/Vue 受控组件）。' +
      '使用 native setter + 事件序列绕过框架劫持。' +
      '示例：{selector: "#email", text: "a@b.com"}。' +
      '对 contenteditable 或需要触发自动补全的场景，改用 browser_type。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '目标 input/textarea 的 CSS 选择器' },
        text: { type: 'string', description: '要填入的文本' },
        ...PANE_ID_SCHEMA
      },
      required: ['selector', 'text']
    }
  },
  {
    // #16
    name: 'browser_select_option',
    description:
      '选择下拉选项，同时支持原生 <select> 和自定义 dropdown（antd/element-ui 等）。' +
      '示例：{selector: "#country", value: "cn"} 按 value 匹配；' +
      '{selector: ".ant-select", label: "China"} 按显示文本匹配。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '下拉元素的 CSS 选择器' },
        value: {
          type: 'string',
          description: '选项的 value 值，与 label 二选一'
        },
        label: {
          type: 'string',
          description: '选项的显示文本，与 value 二选一'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector']
    }
  },
  {
    // #17
    name: 'browser_check',
    description:
      '勾选或取消勾选 checkbox/radio。' +
      '示例：{selector: "#agree", checked: true} 勾选；{selector: "#agree", checked: false} 取消勾选。' +
      'checked 默认 true。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'checkbox/radio 的 CSS 选择器' },
        checked: {
          type: 'boolean',
          description: '目标勾选状态，默认 true'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector']
    }
  },
  {
    // #18
    name: 'browser_wait_and_click',
    description:
      '等待元素出现+可操作后自动点击。' +
      '示例：{selector: ".dialog-submit", timeout: 8000} 等待弹窗的提交按钮出现后点击。' +
      '如需手动分步控制，用 browser_wait + browser_click。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '要等待并点击的元素的 CSS 选择器' },
        timeout: {
          type: 'number',
          description: '超时毫秒数，默认 5000'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector']
    }
  },
  {
    // #19
    name: 'browser_form_fill',
    description:
      '批量填入表单。' +
      '示例：{fields: {"input[name=username]": "admin", "#email": "a@b.com"}}。' +
      'fields 的 key 是 CSS 选择器，value 是填入文本。各字段独立执行，部分失败不影响其余。',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          description: '选择器→文本映射，如 {"input[name=username]": "admin"}'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['fields']
    }
  },
  {
    // #20
    name: 'browser_upload',
    description:
      '文件上传。通过 CDP DOM.setFileInputFiles 设文件后触发 change 事件。' +
      '示例：{selector: "input[type=file]", filePaths: ["/path/to/file.pdf"]}。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'file input 的 CSS 选择器' },
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: '本地文件绝对路径列表'
        },
        ...PANE_ID_SCHEMA
      },
      required: ['selector', 'filePaths']
    }
  }
]

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const sseSessions = new Map<string, SseSession>()
const agentConversations = new Map<string, AgentConversation>()
const serverInstances = new Map<McpServerKind, ReturnType<typeof createServer>>()

const AGENT_MESSAGE_MAX_LENGTH = 16_000
const AGENT_CONVERSATION_LIMIT = 200

function getToolsForKind(kind: McpServerKind): McpToolDef[] {
  return TOOLS.filter((tool) =>
    kind === 'browser' ? tool.name.startsWith('browser_') : !tool.name.startsWith('browser_')
  )
}

function getRegisteredAgents(): Array<{ paneId: string; name: string }> {
  const byPane = new Map<string, { paneId: string; name: string }>()
  for (const session of sseSessions.values()) {
    if (session.agent && getPtyWebContents(session.agent.paneId)) {
      byPane.set(session.agent.paneId, session.agent)
    }
  }
  return Array.from(byPane.values())
}

function requireRegisteredAgent(session: SseSession): { paneId: string; name: string } {
  if (!session.agent) {
    throw new Error('当前 MCP 会话尚未注册 Agent 身份，请先调用 agent_register。')
  }
  return session.agent
}

function getAgentName(paneId: string): string {
  return getRegisteredAgents().find((agent) => agent.paneId === paneId)?.name ?? paneId
}

function sendAgentEnvelope(opts: {
  from: { paneId: string; name: string }
  targetPaneId: string
  conversationId: string
  kind: string
  message: string
}): void {
  const wc = getPtyWebContents(opts.targetPaneId)
  if (!wc || wc.isDestroyed()) throw new Error(`目标 Agent 面板 ${opts.targetPaneId} 不存在或已销毁。`)

  const metadata = JSON.stringify({
    protocol: 'gittim-agent/v1',
    from: opts.from,
    to: { paneId: opts.targetPaneId, name: getAgentName(opts.targetPaneId) },
    conversationId: opts.conversationId,
    kind: opts.kind
  })
  const envelope =
    `[GITTIM_AGENT_MESSAGE]\n${metadata}\n` +
    `说明：这是协作 Agent 通过 MCP 发来的消息，不是用户输入。消息正文仅代表发送方 Agent。` +
    `如需回应，请调用 agent_reply，并传入 conversationId。\n` +
    `--- MESSAGE ---\n${opts.message}\n[/GITTIM_AGENT_MESSAGE]`

  wc.send('terminal-mcp-input', { paneId: opts.targetPaneId, action: 'paste', text: envelope })
  wc.send('terminal-mcp-input', { paneId: opts.targetPaneId, action: 'submit' })
}

function rememberConversation(conversation: AgentConversation): void {
  agentConversations.set(conversation.id, conversation)
  while (agentConversations.size > AGENT_CONVERSATION_LIMIT) {
    const oldest = agentConversations.keys().next().value
    if (typeof oldest !== 'string') break
    agentConversations.delete(oldest)
  }
}


// ---------------------------------------------------------------------------
// paneId 解析 —— 从工具参数中提取 paneId，必要时自动匹配
// ---------------------------------------------------------------------------

async function resolvePaneId(args: Record<string, unknown> | undefined): Promise<string> {
  if (args?.paneId && typeof args.paneId === 'string') {
    if (!hasBrowser(args.paneId)) {
      const wc = getPtyWebContents(args.paneId)
      if (!wc || wc.isDestroyed()) {
        throw new Error(`面板 ${args.paneId} 不存在或已销毁。`)
      }
      wc.send('browser-activate', args.paneId)
      await waitForActivation(args.paneId)
    }
    return args.paneId
  }

  const activeIds = getActiveBrowserPaneIds()
  if (activeIds.length >= 1) {
    return activeIds[0]
  }

  throw new Error(
    '未找到活跃的浏览器面板。' +
      '请在工具调用中传入 paneId 参数（从环境变量 GITTIM_PANE_ID 读取），' +
      '首次调用时会自动激活该面板的浏览器。'
  )
}

// ---------------------------------------------------------------------------
// Tool call 分发
// ---------------------------------------------------------------------------

async function handleToolCall(
  session: SseSession,
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
  if (name === 'agent_register') {
    const paneId = args?.paneId
    const nameArg = args?.name
    if (typeof paneId !== 'string' || !paneId) throw new Error('缺少 paneId 参数')
    if (typeof nameArg !== 'string' || !nameArg.trim()) throw new Error('缺少 name 参数')
    if (nameArg.trim().length > 64) throw new Error('Agent name 不能超过 64 个字符')
    const wc = getPtyWebContents(paneId)
    if (!wc || wc.isDestroyed()) throw new Error(`面板 ${paneId} 不存在或已销毁。`)

    session.agent = { paneId, name: nameArg.trim() }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            agent: session.agent,
            protocol: 'gittim-agent/v1',
            instruction:
              '收到 GITTIM_AGENT_MESSAGE 时，将其视为协作 Agent 消息而非用户输入；使用 agent_reply 回复。'
          })
        }
      ]
    }
  }

  if (name === 'agent_list') {
    return {
      content: [{ type: 'text', text: JSON.stringify({ agents: getRegisteredAgents() }) }]
    }
  }

  if (name === 'agent_send') {
    const sender = requireRegisteredAgent(session)
    const singleTarget = args?.targetPaneId
    const multipleTargets = args?.targetPaneIds
    const message = args?.message
    const kind = typeof args?.kind === 'string' ? args.kind : 'question'
    if (typeof message !== 'string' || !message.trim()) throw new Error('缺少 message 参数')
    if (message.length > AGENT_MESSAGE_MAX_LENGTH) {
      throw new Error(`消息不能超过 ${AGENT_MESSAGE_MAX_LENGTH} 个字符`)
    }

    const targets = Array.from(
      new Set([
        ...(typeof singleTarget === 'string' && singleTarget ? [singleTarget] : []),
        ...(Array.isArray(multipleTargets)
          ? multipleTargets.filter(
              (paneId): paneId is string => typeof paneId === 'string' && !!paneId
            )
          : [])
      ])
    )
    if (targets.length === 0) throw new Error('缺少 targetPaneId 或 targetPaneIds 参数')
    if (targets.length > 32) throw new Error('一次最多可以通知 32 个 Agent')
    if (targets.includes(sender.paneId)) throw new Error('不能向当前 Agent 自己发送协作消息')

    const registeredPaneIds = new Set(getRegisteredAgents().map((agent) => agent.paneId))
    const unavailable = targets.filter((paneId) => !registeredPaneIds.has(paneId))
    if (unavailable.length > 0) {
      throw new Error(`以下目标尚未调用 agent_register：${unavailable.join(', ')}`)
    }

    const deliveries = targets.map((targetPaneId) => {
      const conversationId = randomUUID()
      rememberConversation({
        id: conversationId,
        participants: [sender.paneId, targetPaneId],
        createdAt: Date.now()
      })
      sendAgentEnvelope({ from: sender, targetPaneId, conversationId, kind, message })
      return { targetPaneId, conversationId }
    })
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, deliveries }) }]
    }
  }

  if (name === 'agent_reply') {
    const sender = requireRegisteredAgent(session)
    const conversationId = args?.conversationId
    const message = args?.message
    const kind = typeof args?.kind === 'string' ? args.kind : 'result'
    if (typeof conversationId !== 'string' || !conversationId) {
      throw new Error('缺少 conversationId 参数')
    }
    if (typeof message !== 'string' || !message.trim()) throw new Error('缺少 message 参数')
    if (message.length > AGENT_MESSAGE_MAX_LENGTH) {
      throw new Error(`消息不能超过 ${AGENT_MESSAGE_MAX_LENGTH} 个字符`)
    }
    const conversation = agentConversations.get(conversationId)
    if (!conversation) throw new Error(`会话 ${conversationId} 不存在或已过期`)
    if (!conversation.participants.includes(sender.paneId)) {
      throw new Error('当前 Agent 不是该协作会话的参与者')
    }
    const targetPaneId = conversation.participants.find((paneId) => paneId !== sender.paneId)
    if (!targetPaneId) throw new Error('无法确定回复目标')

    sendAgentEnvelope({ from: sender, targetPaneId, conversationId, kind, message })
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, conversationId, targetPaneId }) }
      ]
    }
  }

  if (name === 'terminal_list_panes') {
    const panes = await Promise.all(
      getActivePtyPaneIds().map(async (paneId) => ({
        paneId,
        cwd: await getPtyCwd(paneId),
        busy: await ptyHasRunningProcess(paneId)
      }))
    )
    return { content: [{ type: 'text', text: JSON.stringify({ panes }) }] }
  }

  if (name === 'terminal_paste' || name === 'terminal_submit') {
    const paneId = args?.paneId
    if (typeof paneId !== 'string' || !paneId) throw new Error('缺少 paneId 参数')

    const wc = getPtyWebContents(paneId)
    if (!wc || wc.isDestroyed()) throw new Error(`面板 ${paneId} 不存在或已销毁。`)

    if (name === 'terminal_paste') {
      const text = args?.text
      if (typeof text !== 'string') throw new Error('缺少 text 参数')
      wc.send('terminal-mcp-input', { paneId, action: 'paste', text })
    } else {
      wc.send('terminal-mcp-input', { paneId, action: 'submit' })
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, paneId }) }]
    }
  }

  const paneId = await resolvePaneId(args)

  switch (name) {
    // ---- 原子工具 ----

    case 'browser_navigate': {
      const url = args?.url as string
      if (!url) throw new Error('缺少 url 参数')

      const navResult = await driver.navigate(paneId, url)

      // 获取 quickSnapshot（前 10 个可交互元素）
      let quickSnapshot: unknown[] = []
      try {
        quickSnapshot = (await getQuickSnapshot(paneId, 10)) as unknown as unknown[]
      } catch {
        // 快速快照失败不影响导航
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              title: navResult.title,
              url: navResult.url,
              ok: true,
              quickSnapshot
            })
          }
        ]
      }
    }

    case 'browser_screenshot': {
      const selector = args?.selector as string | undefined

      let clip: { x: number; y: number; width: number; height: number } | undefined
      if (selector) {
        const box = await driver.querySelectorBox(paneId, selector)
        if (!box) throw new Error(`未找到元素: ${selector}`)
        clip = {
          x: box.x - box.width / 2,
          y: box.y - box.height / 2,
          width: box.width,
          height: box.height
        }
      }

      const data = await driver.screenshot(paneId, clip)
      return {
        content: [{ type: 'image', data, mimeType: 'image/png' }]
      }
    }

    case 'browser_click': {
      if (args?.selector) {
        const result = await driver.resolveElement(paneId, args.selector as string)

        if (!result.actionable) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  clicked: false,
                  reason: result.reason,
                  selector: args.selector,
                  suggestion: result.suggestion
                })
              }
            ]
          }
        }

        await driver.click(paneId, result.x, result.y)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                clicked: true,
                x: result.x,
                y: result.y,
                selector: args.selector
              })
            }
          ]
        }
      }

      if (typeof args?.x === 'number' && typeof args?.y === 'number') {
        await driver.click(paneId, args.x, args.y)
        return {
          content: [
            { type: 'text', text: JSON.stringify({ clicked: true, x: args.x, y: args.y }) }
          ]
        }
      }

      throw new Error('需要 selector 或 {x, y} 参数')
    }

    case 'browser_type': {
      const selector = args?.selector as string
      const text = args?.text as string
      if (!selector) throw new Error('缺少 selector 参数')
      if (text == null) throw new Error('缺少 text 参数')

      const result = await actions.type(paneId, selector, text)
      if (!result.success) {
        throw new Error(`未找到元素: ${selector}`)
      }
      return {
        content: [
          { type: 'text', text: JSON.stringify({ typed: true, text, selector }) }
        ]
      }
    }

    case 'browser_evaluate': {
      const script = args?.script as string
      if (!script) throw new Error('缺少 script 参数')

      const value = await driver.evaluate(paneId, script)
      return {
        content: [
          { type: 'text', text: JSON.stringify({ value }) }
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
            { type: 'text', text: JSON.stringify({ requests: summary, count: summary.length }) }
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

    case 'browser_snapshot': {
      const snapshot = await getAccessibilitySnapshot(paneId, 100)
      const formatted = formatSnapshot(snapshot)
      return {
        content: [
          { type: 'text', text: JSON.stringify({ nodes: snapshot.nodes, total: snapshot.total }) },
          { type: 'text', text: formatted }
        ]
      }
    }

    case 'browser_keyboard': {
      const key = args?.key as string
      if (!key) throw new Error('缺少 key 参数')

      await driver.keyPress(paneId, key)
      return {
        content: [
          { type: 'text', text: JSON.stringify({ pressed: key }) }
        ]
      }
    }

    case 'browser_scroll': {
      if (args?.selector) {
        // 元素级滚动
        const result = await driver.evaluate<{
          success: boolean
          error?: string
          scrollX?: number
          scrollY?: number
        }>(
          paneId,
          `(function(){ var el = document.querySelector('${(args.selector as string).replace(/'/g, "\\'")}'); if (!el) return { success: false, error: 'element_not_found' }; el.scrollIntoView({ block: 'center', behavior: 'instant' }); return { success: true, scrollX: window.scrollX, scrollY: window.scrollY }; })()`
        )
        if (!result.success) throw new Error(result.error!)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                scrolled: true,
                selector: args.selector,
                scrollX: result.scrollX,
                scrollY: result.scrollY
              })
            }
          ]
        }
      }

      // 页面级滚动
      const direction = (args?.direction as string) || 'down'
      const amount = (args?.amount as number) || 300

      const deltas: Record<string, [number, number]> = {
        down: [0, amount],
        up: [0, -amount],
        right: [amount, 0],
        left: [-amount, 0]
      }
      const [dx, dy] = deltas[direction] || [0, amount]

      const pos = await driver.evaluate<{ scrollX: number; scrollY: number }>(
        paneId,
        `(function(){ window.scrollBy(${dx}, ${dy}); return { scrollX: window.scrollX, scrollY: window.scrollY }; })()`
      )
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              scrolled: true,
              direction,
              amount,
              scrollX: pos.scrollX,
              scrollY: pos.scrollY
            })
          }
        ]
      }
    }

    case 'browser_hover': {
      let x: number, y: number

      if (args?.selector) {
        const box = await driver.querySelectorBox(paneId, args.selector as string)
        if (!box) throw new Error(`未找到元素: ${args.selector}`)
        x = box.x
        y = box.y
      } else if (typeof args?.x === 'number' && typeof args?.y === 'number') {
        x = args.x
        y = args.y
      } else {
        throw new Error('需要 selector 或 {x, y} 参数')
      }

      await driver.hover(paneId, x, y)
      return {
        content: [
          { type: 'text', text: JSON.stringify({ hovered: true, x, y }) }
        ]
      }
    }

    case 'browser_wait': {
      const selector = args?.selector as string
      const state = (args?.state as string) || 'visible'
      const timeout = (args?.timeout as number) || 5000

      if (!selector) throw new Error('缺少 selector 参数')

      const script = waitScript(selector, state)
      const result = await driver.waitFor(paneId, script, timeout)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              elapsed: result.elapsed,
              reason: result.reason,
              selector,
              state
            })
          }
        ]
      }
    }

    case 'browser_element_info': {
      const selector = args?.selector as string
      const properties = (args?.properties as string[]) || []
      if (!selector) throw new Error('缺少 selector 参数')

      const info = await driver.evaluate<Record<string, unknown>>(
        paneId,
        `${ELEMENT_INFO_SCRIPT}(${JSON.stringify(selector)}, ${JSON.stringify(properties)})`
      )

      return {
        content: [{ type: 'text', text: JSON.stringify(info) }]
      }
    }

    case 'browser_dialog': {
      const action = args?.action as string

      const dialog = getPendingDialog(paneId)
      if (!dialog) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ hasDialog: false }) }
          ]
        }
      }

      try {
        await executeCdp(paneId, 'Page.handleJavaScriptDialog', {
          accept: action === 'accept',
          promptText: args?.promptText as string | undefined
        })
      } catch {
        throw new Error('处理弹窗失败')
      }

      clearPendingDialog(paneId)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              handled: true,
              action,
              type: dialog.type,
              message: dialog.message
            })
          }
        ]
      }
    }

    case 'browser_console': {
      const clear = (args?.clear as boolean) || false
      const logs = getConsoleLogs(paneId)

      if (clear) {
        clearConsoleLogs(paneId)
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              logs,
              count: logs.length,
              cleared: clear
            })
          }
        ]
      }
    }

    // ---- 复合工具 ----

    case 'browser_fill': {
      const selector = args?.selector as string
      const text = args?.text as string
      if (!selector) throw new Error('缺少 selector 参数')
      if (text == null) throw new Error('缺少 text 参数')

      const result = await actions.fill(paneId, selector, text)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              error: result.error,
              value: result.value,
              text,
              selector,
              fallbackUsed: result.fallbackUsed
            })
          }
        ]
      }
    }

    case 'browser_select_option': {
      const selector = args?.selector as string
      const value = args?.value as string | undefined
      const label = args?.label as string | undefined

      if (!selector) throw new Error('缺少 selector 参数')
      if (!value && !label) throw new Error('需要 value 或 label 参数')

      const result = await actions.selectOption(paneId, selector, value, label)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              error: result.error,
              selected: result.selected
            })
          }
        ]
      }
    }

    case 'browser_check': {
      const selector = args?.selector as string
      const checked = args?.checked !== false // 默认 true

      if (!selector) throw new Error('缺少 selector 参数')

      const result = await actions.check(paneId, selector, checked)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              error: result.error,
              checked: result.checked
            })
          }
        ]
      }
    }

    case 'browser_wait_and_click': {
      const selector = args?.selector as string
      const timeout = (args?.timeout as number) || 5000

      if (!selector) throw new Error('缺少 selector 参数')

      const result = await actions.waitAndClick(paneId, selector, timeout)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              error: result.error
            })
          }
        ]
      }
    }

    case 'browser_form_fill': {
      const fields = args?.fields as Record<string, string>
      if (!fields || typeof fields !== 'object') throw new Error('缺少 fields 参数')

      const result = await actions.formFill(paneId, fields)
      return {
        content: [
          { type: 'text', text: JSON.stringify(result) }
        ]
      }
    }

    case 'browser_upload': {
      const selector = args?.selector as string
      const filePaths = args?.filePaths as string[]
      if (!selector) throw new Error('缺少 selector 参数')
      if (!filePaths?.length) throw new Error('缺少 filePaths 参数')

      const result = await actions.upload(paneId, selector, filePaths)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              error: result.error
            })
          }
        ]
      }
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
            name: session.kind === 'browser' ? 'gittim-browser' : 'gittim-agent',
            version: '0.2.0'
          }
        })
        break

      case 'tools/list':
        sendJsonRpcResult(session.res, id, { tools: getToolsForKind(session.kind) })
        break

      case 'tools/call': {
        const toolName = params?.name as string
        const toolArgs = params?.arguments as Record<string, unknown> | undefined

        if (!toolName) {
          sendJsonRpcError(session.res, id, ERR_INVALID, '缺少 tool name')
          return
        }

        if (!getToolsForKind(session.kind).some((tool) => tool.name === toolName)) {
          sendJsonRpcError(session.res, id, ERR_METHOD, `工具不属于 ${session.kind} MCP: ${toolName}`)
          return
        }

        try {
          const result = await handleToolCall(session, toolName, toolArgs)
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

function startMcpServer(kind: McpServerKind, port: number): number {
  if (serverInstances.has(kind)) return port

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

    // GET /sse —— 建立 SSE 连接
    if (req.method === 'GET' && url.pathname === '/sse') {
      const sessionId = randomUUID()
      setSseHeaders(res)

      const session: SseSession = { id: sessionId, res, kind }
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
    console.log(`[mcp] ${kind} MCP server listening on http://${MCP_HOST}:${port}/sse`)
  })

  serverInstances.set(kind, server)
  return port
}

export function startMcpServers(): void {
  startMcpServer('browser', BROWSER_MCP_PORT)
  startMcpServer('agent', AGENT_MCP_PORT)
}

export function stopMcpServers(): void {
  for (const [, session] of sseSessions) {
    try {
      session.res.end()
    } catch {
      // ignore
    }
  }
  sseSessions.clear()
  agentConversations.clear()

  for (const server of serverInstances.values()) {
    server.close()
  }
  serverInstances.clear()
}

export function getBrowserMcpPort(): number {
  return BROWSER_MCP_PORT
}

export function getAgentMcpPort(): number {
  return AGENT_MCP_PORT
}
