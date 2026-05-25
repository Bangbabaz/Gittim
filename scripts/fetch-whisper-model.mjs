#!/usr/bin/env node
// 拉取 ggml-small-q5_1.bin 到 resources/models/。dev / build 启动时通过
// `node scripts/fetch-whisper-model.mjs && ...` 自动调用;已存在直接跳过。
//
// 国内拉 HuggingFace 慢可以 `set HF_MIRROR=hf-mirror.com` 走镜像。

import { existsSync, mkdirSync, createWriteStream, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)

const MODEL_NAME = 'ggml-tiny-q5_1.bin'
const MODEL_DIR = join(ROOT, 'resources', 'models')
const MODEL_PATH = join(MODEL_DIR, MODEL_NAME)
// HuggingFace 上 whisper.cpp 官方仓库存放的所有 ggml 量化模型。small-q5_1 约 181MB。
const MIRROR = process.env.HF_MIRROR || 'huggingface.co'
const URL = `https://${MIRROR}/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`
// q5_1 tiny 模型的真实大小(~31MB),作为下载完整性校验的下界(允许 ±1MB 误差)。
const MIN_SIZE = 30 * 1024 * 1024

if (existsSync(MODEL_PATH)) {
  const size = statSync(MODEL_PATH).size
  if (size >= MIN_SIZE) {
    // 已经在了,静默跳过 —— 每次 yarn dev 都会触发本脚本,日志要够安静。
    process.exit(0)
  }
  console.warn(`[fetch-models] 检测到不完整的 ${MODEL_NAME}(${size} bytes),将重新下载。`)
  unlinkSync(MODEL_PATH)
}

mkdirSync(MODEL_DIR, { recursive: true })

console.log(`[fetch-models] 下载 whisper 模型 ${MODEL_NAME}(~31MB,仅首次)`)
console.log(`  源: ${URL}`)
console.log(`  目标: ${MODEL_PATH}`)
if (MIRROR === 'huggingface.co') {
  console.log(`  提示: 国内可设 HF_MIRROR=hf-mirror.com 走镜像。`)
}

function fetchToFile(url, outPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      // 跟随 3xx 重定向(HuggingFace 实际命中后会 302 到 CDN)。
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        fetchToFile(res.headers.location, outPath).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`))
        return
      }
      const total = Number(res.headers['content-length']) || 0
      let received = 0
      let lastPrint = 0
      const file = createWriteStream(outPath)
      res.on('data', (chunk) => {
        received += chunk.length
        const now = Date.now()
        if (now - lastPrint > 200 && total > 0) {
          lastPrint = now
          const pct = ((received / total) * 100).toFixed(1)
          const mb = (received / 1024 / 1024).toFixed(1)
          const totalMb = (total / 1024 / 1024).toFixed(1)
          process.stdout.write(`\r  ${pct}%  ${mb} / ${totalMb} MB`)
        }
      })
      res.pipe(file)
      file.on('finish', () => {
        process.stdout.write('\n')
        file.close()
        resolve()
      })
      file.on('error', (err) => {
        try {
          unlinkSync(outPath)
        } catch {}
        reject(err)
      })
    })
    req.on('error', reject)
  })
}

try {
  await fetchToFile(URL, MODEL_PATH)
  const size = statSync(MODEL_PATH).size
  if (size < MIN_SIZE) {
    unlinkSync(MODEL_PATH)
    throw new Error(`下载文件过小(${size} bytes),已删除。请重试。`)
  }
  console.log(`[fetch-models] 完成(${(size / 1024 / 1024).toFixed(1)} MB)`)
} catch (err) {
  console.error(`[fetch-models] 失败: ${err.message}`)
  console.error(`  如果在国内可以设 HF_MIRROR=hf-mirror.com 然后重试 yarn fetch-models`)
  process.exit(1)
}
