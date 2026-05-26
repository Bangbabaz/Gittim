#!/usr/bin/env node
// smart-whisper 的 native binding (build/Release/smart-whisper.node) 必须按 Electron
// ABI 编译,否则 main 进程 require 时报 "Cannot find module" 或 NODE_MODULE_VERSION
// 不匹配。原因:
//   1. yarn/npm install 默认会跑 smart-whisper 的 install script(gypfile=true 触发
//      node-gyp rebuild),但镜像源(cnpm/tnpm/registry.antgroup-inc.cn 等)会跳过
//      install scripts —— mac 上常见,装完后 build/Release 是空的。
//   2. 即使 install script 跑了,node-gyp 默认用 *Node* 的头文件编,出来的是 Node
//      ABI;到 Electron 进程里加载就是 wrong NODE_MODULE_VERSION。
//
// 这个脚本在 dev / build 前主动跑一次:
//   - 已经有 .node 就跳过(假设是正确 ABI;用户怀疑时用 --force 重建)
//   - 没有就调 @electron/rebuild 按当前 Electron 版本重编
//
// 关键约束:`onlyModules: ['smart-whisper']` —— 只 rebuild smart-whisper,**不动**
// node-pty。CLAUDE.md 明确说 node-pty 的 postinstall 在 Windows 上会触发 winpty 的
// `.bat` invocation 失败 + Spectre mitigation 要求;同时 node-pty 在 ASAR unpack 后
// 自带 prebuild,不需要重编。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)

// Windows: 强制 MSVC 用 UTF-8 编译,否则 whisper.cpp 源文件里的中文字符会被
// 系统默认代码页(936 简中 / 932 日文等)误解,触发 C3688 "文本后缀无效"编译
// 错误。子进程(node-gyp → MSBuild → cl.exe)继承我们这里设的 CL 环境变量。
// `install.ps1` 走的也是这条路 —— 把同样的逻辑内联到脚本里,清理 build 目录
// 后跑 yarn dev / yarn rebuild-stt 也能编通,不必必须走 install.ps1。
if (process.platform === 'win32') {
  process.env.CL = process.env.CL ? `${process.env.CL} /utf-8` : '/utf-8'
}

const NODE_FILE = join(
  ROOT,
  'node_modules',
  'smart-whisper',
  'build',
  'Release',
  'smart-whisper.node'
)

const force = process.argv.includes('--force')
if (existsSync(NODE_FILE) && !force) {
  // 静默跳过 —— 每次 yarn dev/build 都会触发本脚本,日志要够安静。
  process.exit(0)
}

// 读真实安装的 Electron 版本,而不是 package.json 里的 semver 范围。这样 ABI
// 一定对得上 `yarn dev` / electron-builder 实际启动的 Electron。
let electronVersion
try {
  const ep = JSON.parse(
    readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf-8')
  )
  electronVersion = ep.version
} catch {
  console.error('[rebuild-stt] 未找到 node_modules/electron —— 请先 yarn install。')
  process.exit(1)
}

console.log(
  `[rebuild-stt] 为 Electron ${electronVersion} 重建 smart-whisper (仅本模块, 不影响 node-pty)...`
)

let rebuild
try {
  ;({ rebuild } = await import('@electron/rebuild'))
} catch (err) {
  console.error(`[rebuild-stt] 加载 @electron/rebuild 失败: ${err?.message || err}`)
  console.error('  请确认 @electron/rebuild 在 devDependencies, 且 yarn install 已完成。')
  process.exit(1)
}

try {
  await rebuild({
    buildPath: ROOT,
    electronVersion,
    onlyModules: ['smart-whisper'],
    force: true
  })
  if (!existsSync(NODE_FILE)) {
    console.error('[rebuild-stt] 重建完成但 smart-whisper.node 仍不存在,请贴日志排查。')
    process.exit(1)
  }
  console.log('[rebuild-stt] 完成')
} catch (err) {
  console.error(`[rebuild-stt] 重建失败: ${err?.message || err}`)
  console.error('  常见原因:')
  console.error('    - macOS: 未装 Xcode Command Line Tools (xcode-select --install)')
  console.error('    - Linux: 缺 build-essential / python3 / cmake')
  console.error('    - Windows: 缺 MSVC 工具链 (装 Visual Studio Build Tools)')
  process.exit(1)
}
