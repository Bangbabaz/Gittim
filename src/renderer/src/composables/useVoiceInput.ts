// 语音输入:getUserMedia → ScriptProcessor 累积 Float32 PCM → 停止时合并 +
// OfflineAudioContext 重采样到 16kHz → IPC 发到 main 的 whisper.cpp → 文本回调。
//
// 取舍说明:
//   - 用 ScriptProcessorNode 而非 AudioWorklet:Worklet 要单独的 worker 文件,在
//     electron-vite 下要额外配 build target;ScriptProcessor 在 Chromium 里
//     virtual-deprecated 但仍受支持,实测延迟够用(用户感知不到 ~85ms 的 audio
//     thread 延迟)。如果将来 Chromium 真把它去掉,再迁移。
//   - 不流式分段转写:whisper.cpp 的 context 不是流式的,一段语音整体送入识别
//     质量最好;按住录音的 PTT 形态下,单段一般 < 30s,整段处理体验最自然。
//   - language 默认 'zh'(可通过 settings.sttLanguage 配置),可选 'en'/'auto'。

import { ref, type Ref } from 'vue'

const TARGET_RATE = 16000
// 太短的段(< 300ms)送给 whisper 容易得到空文本或乱猜,直接丢弃。
const MIN_DURATION_S = 0.3

export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'done' | 'error'

export interface VoiceInputOptions {
  language?: string
  /** 音频输入设备 ID,空字符串表示系统默认。 */
  deviceId?: string
  onResult?: (text: string) => void
  onError?: (msg: string) => void
}

async function resampleTo16k(samples: Float32Array, sourceRate: number): Promise<Float32Array> {
  if (sourceRate === TARGET_RATE) return samples
  const targetLength = Math.max(1, Math.round((samples.length * TARGET_RATE) / sourceRate))
  // OfflineAudioContext 的内置重采样器是 high-quality sinc 插值,质量比手写线性
  // 重采样好很多 —— whisper 对 aliased 输入敏感,这步省不得。
  const offline = new OfflineAudioContext(1, targetLength, TARGET_RATE)
  const buffer = offline.createBuffer(1, samples.length, sourceRate)
  buffer.getChannelData(0).set(samples)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  src.start(0)
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

export interface UseVoiceInputReturn {
  state: Ref<VoiceState>
  level: Ref<number>
  message: Ref<string>
  start: () => Promise<void>
  stop: () => Promise<void>
  cancel: () => Promise<void>
}

export function useVoiceInput(opts: VoiceInputOptions = {}): UseVoiceInputReturn {
  const state = ref<VoiceState>('idle')
  // 0-1,实时音量(RMS)用于电平条展示。
  const level = ref(0)
  // done / error 状态附带的可读提示。
  const message = ref('')

  let stream: MediaStream | null = null
  let audioContext: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let chunks: Float32Array[] = []
  let sourceRate = TARGET_RATE
  // 防抖:start/stop 重入时直接吃掉旧的回调。
  let runId = 0

  async function cleanup(): Promise<void> {
    if (processor) {
      processor.onaudioprocess = null
      try {
        processor.disconnect()
      } catch {
        // 已断开
      }
      processor = null
    }
    if (source) {
      try {
        source.disconnect()
      } catch {
        // 已断开
      }
      source = null
    }
    if (audioContext) {
      try {
        await audioContext.close()
      } catch {
        // 已关闭
      }
      audioContext = null
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
  }

  async function start(): Promise<void> {
    if (state.value === 'recording' || state.value === 'transcribing') return
    const myRun = ++runId
    state.value = 'recording'
    message.value = ''
    level.value = 0
    chunks = []
    try {
      const deviceId = opts.deviceId || ''
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {})
        }
      })
      if (myRun !== runId) {
        // 异步等期间被 cancel,丢弃 stream。
        for (const track of stream.getTracks()) track.stop()
        stream = null
        return
      }
      audioContext = new AudioContext()
      sourceRate = audioContext.sampleRate
      source = audioContext.createMediaStreamSource(stream)
      // bufferSize 4096 在 48kHz 下 ≈ 85ms,延迟可接受且不会被 audio thread 餐饿
      // (太小会 underrun,太大会增加 onaudioprocess 间隔)。
      processor = audioContext.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (ev): void => {
        const input = ev.inputBuffer.getChannelData(0)
        // 必须 copy —— audio thread 会复用 input buffer。引用持有意味着下一帧
        // 数据会覆盖上一帧。
        chunks.push(new Float32Array(input))
        // RMS for 电平表(实际经验:静音 < 0.005,正常说话 0.02-0.1,喊叫 > 0.2)。
        // ×5 拉伸到 [0, 1] 区间,clamp 后给 UI;够直观就行,没必要再做 EMA 平滑。
        let sum = 0
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
        const rms = Math.sqrt(sum / input.length)
        level.value = Math.min(1, rms * 5)
      }
      source.connect(processor)
      // ScriptProcessor 必须连到 destination 才会被 audio graph 拉取,但我们不想
      // 听到自己的麦克风 —— 连接到 audioContext.destination 是必要的(否则
      // onaudioprocess 不会触发),浏览器/electron 不会把麦克风内容再播出来。
      processor.connect(audioContext.destination)
    } catch (err) {
      if (myRun !== runId) return
      state.value = 'error'
      message.value = err instanceof Error ? humanizeMicError(err) : '麦克风启动失败'
      opts.onError?.(message.value)
      level.value = 0
      await cleanup()
    }
  }

  async function stop(): Promise<void> {
    if (state.value !== 'recording') return
    const myRun = runId
    state.value = 'transcribing'
    level.value = 0
    const captured = chunks
    const rate = sourceRate
    chunks = []
    await cleanup()
    try {
      const total = captured.reduce((sum, c) => sum + c.length, 0)
      if (total === 0 || total / rate < MIN_DURATION_S) {
        // 太短 —— 当成误触,静默回到 idle,不弹错误。
        if (myRun === runId) state.value = 'idle'
        return
      }
      const merged = new Float32Array(total)
      let offset = 0
      for (const c of captured) {
        merged.set(c, offset)
        offset += c.length
      }
      const pcm16k = await resampleTo16k(merged, rate)
      if (myRun !== runId) return
      const result = await window.api.sttTranscribe({
        pcm: pcm16k,
        language: opts.language ?? 'zh'
      })
      if (myRun !== runId) return
      if (result.ok) {
        const text = (result.text || '').trim()
        if (text) {
          opts.onResult?.(text)
          state.value = 'done'
          message.value = text
        } else {
          // 识别到空文本(背景噪声等)。轻提示一下,2s 后回 idle 由调用方处理。
          state.value = 'done'
          message.value = ''
        }
      } else {
        state.value = 'error'
        message.value = result.error || '识别失败'
        opts.onError?.(message.value)
      }
    } catch (err) {
      if (myRun !== runId) return
      state.value = 'error'
      message.value = err instanceof Error ? err.message : '识别失败'
      opts.onError?.(message.value)
    }
  }

  async function cancel(): Promise<void> {
    runId++
    chunks = []
    await cleanup()
    state.value = 'idle'
    level.value = 0
    message.value = ''
  }

  return { state, level, message, start, stop, cancel }
}

function humanizeMicError(err: Error): string {
  const name = err.name || ''
  if (name === 'NotAllowedError') return '麦克风权限被拒绝'
  if (name === 'NotFoundError') return '未找到麦克风设备'
  if (name === 'NotReadableError') return '麦克风被其他应用占用'
  return err.message || '麦克风启动失败'
}
