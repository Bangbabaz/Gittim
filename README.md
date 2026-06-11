# Gittim

<p align="center">
  <img src="resources/icon.png" width="128" alt="Gittim" />
</p>

<p align="center">
  <strong>Git + tmux 风格的终端模拟器</strong>
</p>

<p align="center">
  无限分屏 · 原生 Git 集成 · 一键工作树 · 内置浏览器 · 后台任务 · 语音输入
</p>

---

## ⚡ 为什么用 Gittim

Gittim 把终端的日常操作搬到图形界面里。不用记 tmux 快捷键、不用切窗口跑 `git worktree`、不用另开浏览器看页面效果 —— 所有事情在一个窗口里完成。

| 你需要的 | Gittim 怎么做 |
|----------|--------------|
| 多窗格终端 | `Ctrl+Shift+D` / `Ctrl+Shift+S` 无限分割，拖拽调大小 |
| 切换分支 | 工具栏下拉直接切，远程分支自动 track |
| 创建工作树 | 弹窗选分支 → 新窗格自动打开到工作树目录 |
| 同时看终端+浏览器 | 右侧抽屉内置 webview，agent 可通过 MCP 操控 |
| 跑后台任务 | `npm run dev` 开在后台，日志随时翻看 |
| 语音输入命令 | 按住 `F2` 说话，松开自动转写并粘贴 |

## 🖥️ 分屏终端

类似 tmux 的递归二叉树布局，一个窗口想开几个终端就开几个。每个窗格独立 Shell，自动跟随 `cd` 切换工作目录。

- **无限分割** — 水平 / 垂直随意切，布局重启后自动恢复
- **拖拽调整** — 拖动窗格之间的分割条改变大小
- **拖拽重排** — 拖住窗格顶部的把手可以重新排列布局

## 🌿 Git 深度集成

每个终端窗格顶部都有 Git 工具栏：

- **当前分支** — 实时显示，`cd` 到其他仓库时自动切换
- **分支列表** — 本地 + 远程 + 工作树，一目了然
- **一键切换** — 有未提交更改时自动提示暂存
- **Diff 查看器** — 改动统计 + 语法高亮 + 文件级跳转
- **合并/变基** — 右键菜单快捷操作

### 工作树

选中任意分支，一键创建 Git 工作树：

1. 点击工具栏的 `+` 按钮
2. 选择基准分支（可选新建分支）
3. 确认后自动拆分新窗格，`cd` 到工作树目录
4. 新建分支自动 `push -u` 到远程

## 🌐 内置浏览器

每个终端面板都可以从右侧滑出内置浏览器。MCP Server 暴露 20 个自动化工具，终端里的 AI Agent（Claude Code、Codex 等）可以直接操控浏览器：

- **导航与截图** — 打开页面、截取全页或元素
- **表单操作** — 填表（兼容 React/Vue 受控组件）、勾选、选择下拉
- **模拟交互** — 点击、悬停、键盘、滚动、文件上传
- **页面感知** — 语义化快照（比截图省 token）、元素属性、Console 日志
- **等待与复合** — 等待元素出现、批量填表、等待后点击

一行命令注册 MCP：

```bash
claude mcp add -s user -t sse gittim-browser http://127.0.0.1:9876/sse
```

## ⚙️ 后台任务

把 `npm run dev`、`docker compose up` 这类长时间运行的命令交给后台：

- 每个任务独立运行，输出实时流式回放
- 停止、重启、删除，随时管理
- 自动读取 `package.json` 的 scripts，一键填入
- 应用重启后任务定义保留，按需启动

## 🎤 语音输入

按住 `F2` 说话，松开自动转写并粘贴到终端。完全离线运行，基于 whisper.cpp，模型内置在安装包中，无需网络。

- 中英混说（语言设为 `auto`）
- 录音时显示音量电平条
- 麦克风设备可在设置中切换

## ⌨️ 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Shift+D` | 向右分割 |
| `Ctrl+Shift+S` | 向下分割 |
| `Ctrl+Shift+W` | 关闭窗格 |
| `Ctrl+F` | 搜索终端 |
| `F2` (按住) | 语音输入 |
| `Ctrl+=` | 放大字号 |
| `Ctrl+-` | 缩小字号 |
| `Ctrl+0` | 重置字号 |

所有快捷键可在设置中自定义。

## 🎨 主题

跟随系统自动切换暗色/亮色，也可手动固定。

## 📦 安装

从 [Releases](https://github.com/Bangbabaz/Gittim/releases) 下载最新版本：

- **Windows** — `.exe` NSIS 安装包
- **macOS** — `.dmg`
- **Linux** — `.AppImage` / `.snap` / `.deb`

## 🛠 开发

```bash
yarn              # 安装依赖
yarn dev          # 启动开发服务 (HMR)
yarn typecheck    # TypeScript 检查
yarn lint         # ESLint
yarn build:win    # 构建 Windows
yarn build:mac    # 构建 macOS
yarn build:linux  # 构建 Linux
```

## 🏗 技术栈

Electron · Vue 3 · xterm.js · TypeScript · Element Plus · node-pty · whisper.cpp

## 📄 协议

[MIT](LICENSE)
