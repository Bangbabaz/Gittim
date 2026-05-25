// Speech-to-Text:在 main 进程惰性加载 whisper.cpp,renderer 通过 IPC 传 16kHz
// mono PCM 过来 → 返回识别文本。模型常驻内存(初次加载 ~1-2s,后续每段转写
// ~数百 ms),退出时 free()。
//
// 设计要点:
//   - 模型路径:开发 = resources/models/,打包 = process.resourcesPath/models/。
//     `extraResources` 把 `resources/models` 复制到包外的 `Resources/models`,
//     运行时通过 process.resourcesPath 命中,完全离线。
//   - 单例 + initPromise 去重:多次并发首次调用只触发一次构造。失败时清掉
//     promise,下次重试不会卡在永久 rejected。
//   - smart-whisper 是 native binding(ESM, 顶层 `new Whisper(modelPath)`)—
//     用 dynamic import,模型文件缺失 / native ABI 不匹配时,错误向上抛到 IPC
//     层,UI 显示原始 error.message,而不是让整个 main 进程因 require 失败崩溃。
//   - transcribe 选项:no_timestamps 拿纯文本,suppress_non_speech_tokens 避免
//     "[音乐]" "[掌声]" 这种标注混入;language='auto' 让 whisper 自检中英。

import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

const MODEL_FILE = 'ggml-tiny-q5_1.bin'

// 在 dev 与打包下,模型文件落在不同位置 —— 解析时按优先级试。
// dev: __dirname = D:\project\gittim\out\main → ../../resources/models/
// pkg: process.resourcesPath = <app>/Resources → models/
function resolveModelPath(): string | null {
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(join(process.resourcesPath, 'models', MODEL_FILE))
  } else {
    candidates.push(join(__dirname, '..', '..', 'resources', 'models', MODEL_FILE))
    candidates.push(join(process.cwd(), 'resources', 'models', MODEL_FILE))
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

// smart-whisper 的运行时类型 —— 它是 CJS-friendly 但只暴露最小 API,我们这里
// 显式标 any 避免引入 `@types/smart-whisper`(无官方类型)。
type WhisperInstance = {
  transcribe: (
    pcm: Float32Array,
    opts: Record<string, unknown>
  ) => Promise<{ result: Promise<Array<{ text?: string }>> }>
  free: () => Promise<void>
}

let whisperInstance: WhisperInstance | null = null
let initPromise: Promise<WhisperInstance> | null = null

async function getWhisper(): Promise<WhisperInstance> {
  if (whisperInstance) return whisperInstance
  if (initPromise) return initPromise
  initPromise = (async () => {
    const modelPath = resolveModelPath()
    if (!modelPath) {
      throw new Error(
        '未找到 whisper 模型文件 ggml-small-q5_1.bin。请运行 `yarn fetch-models` 拉取后重启。'
      )
    }
    // dynamic import:smart-whisper 是 native binding,加载失败要把错误传给 IPC
    // 调用方,而不是让 main 进程启动期 require 时就崩。
    const mod = await import('smart-whisper')
    const Whisper = (mod as { Whisper: new (path: string, opts?: object) => WhisperInstance })
      .Whisper
    return new Whisper(modelPath, { gpu: false })
  })()
  try {
    whisperInstance = await initPromise
    return whisperInstance
  } catch (err) {
    initPromise = null
    throw err
  }
}

export async function transcribePcm(
  pcm: Float32Array,
  language: string = 'auto'
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    if (!pcm || pcm.length === 0) {
      return { ok: false, error: '没有录到声音' }
    }
    const whisper = await getWhisper()
    const task = await whisper.transcribe(pcm, {
      language,
      suppress_non_speech_tokens: true,
      no_timestamps: true
    })
    const segments = await task.result
    const text = (Array.isArray(segments) ? segments : [])
      .map((s) => (typeof s?.text === 'string' ? s.text : ''))
      .join('')
      .trim()
    return { ok: true, text }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

export async function disposeStt(): Promise<void> {
  if (whisperInstance) {
    try {
      await whisperInstance.free()
    } catch {
      // 忽略 —— 进程退出阶段 free 失败不是 fatal。
    }
    whisperInstance = null
  }
  initPromise = null
}

export function sttModelExists(): boolean {
  return resolveModelPath() !== null
}
