/**
 * shiki 高亮 worker。
 *
 * 主线程通过 postMessage({ id, content, lang }) 请求高亮，
 * 完成后回 postMessage({ id, lines: string[] | null })。
 *
 * 为什么要 worker：shiki 的 codeToHtml / codeToTokensWithThemes 在 JS 引擎模式下
 * 是同步 CPU 密集操作（每个 token 跑一遍所有 grammar regex），一个 1000 行的
 * 文件可能阻塞主线程几百毫秒。这刚好撞上 el-dialog 的进入动画窗口，用户感受
 * 就是"打开 diff 弹窗卡一下"。搬到 worker 之后主线程零阻塞，动画流畅。
 *
 * 这里直接生成每行的 HTML 字符串数组，避免主线程再用 DOMParser 解析整段 shiki
 * 输出（DOMParser 很快但 shiki 输出可能上万 span，省一步是一步）。
 */
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

interface RequestMsg {
  id: number
  content: string
  lang: string
}
interface ResponseMsg {
  id: number
  lines: string[] | null
}

let highlighter: Highlighter | null = null
let highlighterPromise: Promise<Highlighter> | null = null
const langLoading = new Map<string, Promise<void>>()

function getHi(): Promise<Highlighter> {
  if (highlighter) return Promise.resolve(highlighter)
  if (highlighterPromise) return highlighterPromise
  highlighterPromise = createHighlighter({
    themes: ['github-dark', 'github-light'],
    langs: [],
    engine: createJavaScriptRegexEngine()
  }).then((h) => {
    highlighter = h
    return h
  })
  return highlighterPromise
}

async function ensureLang(hi: Highlighter, lang: string): Promise<boolean> {
  if (hi.getLoadedLanguages().includes(lang)) return true
  let p = langLoading.get(lang)
  if (!p) {
    p = hi.loadLanguage(lang as BundledLanguage).then(
      () => undefined,
      () => {
        langLoading.delete(lang)
      }
    )
    langLoading.set(lang, p)
  }
  try {
    await p
    return hi.getLoadedLanguages().includes(lang)
  } catch {
    return false
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// codeToTokensWithThemes 返回 ThemedTokenWithVariants[][]，每个 token.variants
// 以我们传的 themes object key（'light'/'dark'）作子键。手写 span 比 DOMParser
// 解析 codeToHtml 输出更快、更可控。
function renderLines(hi: Highlighter, content: string, lang: string): string[] {
  const lines = hi.codeToTokensWithThemes(content, {
    themes: { light: 'github-light', dark: 'github-dark' },
    lang: lang as BundledLanguage
  })
  return lines.map((line) =>
    line
      .map((t) => {
        const v = t.variants as Record<string, { color?: string; fontStyle?: number }>
        const lc = v?.light?.color || ''
        const dc = v?.dark?.color || ''
        // fontStyle bit 1=italic, 2=bold, 4=underline
        const fs = v?.dark?.fontStyle ?? v?.light?.fontStyle ?? 0
        let style = ''
        // dark 是 app 默认主题 → 走 inline color；light 主题靠 CSS 用 --shiki-light 覆盖
        if (dc) style += `color:${dc};`
        if (lc) style += `--shiki-light:${lc};`
        if (fs & 1) style += 'font-style:italic;'
        if (fs & 2) style += 'font-weight:bold;'
        if (fs & 4) style += 'text-decoration:underline;'
        return style
          ? `<span style="${style}">${escapeHtml(t.content)}</span>`
          : escapeHtml(t.content)
      })
      .join('')
  )
}

self.onmessage = async (e: MessageEvent<RequestMsg>): Promise<void> => {
  const { id, content, lang } = e.data
  const reply = (lines: string[] | null): void => {
    const msg: ResponseMsg = { id, lines }
    ;(self as unknown as { postMessage: (m: ResponseMsg) => void }).postMessage(msg)
  }
  try {
    const hi = await getHi()
    if (!(await ensureLang(hi, lang))) {
      reply(null)
      return
    }
    reply(renderLines(hi, content, lang))
  } catch {
    reply(null)
  }
}

// 模块加载即开始 highlighter init（fire-and-forget），主线程 spawn worker 后
// worker 后台预热，第一次 tokenize 时大概率 ready。
void getHi()
