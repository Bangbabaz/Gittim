# Gittim

Git + tmux 风格的终端模拟器，支持分屏、分支切换、工作树管理与后台任务系统。

基于 Electron + Vue 3 + xterm.js 构建，在单个窗口中提供类似 tmux 的多窗格终端体验，并深度集成 Git 操作。

## 功能特性

### 终端

- 基于 xterm.js 的完整终端模拟，搭配 node-pty 伪终端后端
- 支持 xterm-256color 真彩色，暗色主题配色
- 自适应缩放（FitAddon）、搜索（SearchAddon）、可点击链接（WebLinksAddon）、Unicode 11（Unicode11Addon）
- 自定义字体族和字号（8-32，默认 14），支持 SF Mono、Cascadia Code、Fira Code、JetBrains Mono 等
- 可配置的滚动缓冲区大小（1,000-200,000 行）
- 自动注入 OSC 7 转义序列，实时跟踪 shell 当前工作目录

### tmux 风格分屏

- 递归二叉树分割布局：水平/垂直无限分割窗格
- 拖拽分割条调整窗格大小（比例范围 5%-95%）
- 关闭最后窗格时自动退出应用，关闭分割中第二个子窗格时自动合并
- 布局和每个窗格的工作目录自动保存，应用重启后恢复
- 关闭含运行中进程的窗格时弹出确认提示

### 键盘快捷键

| 快捷键              | 功能                       |
| ------------------- | -------------------------- |
| `Ctrl+Shift+D`      | 向右分割窗格               |
| `Ctrl+Shift+S`      | 向下分割窗格               |
| `Ctrl+Shift+W`      | 关闭当前窗格               |
| `Ctrl+Shift+C`      | 复制选中文本               |
| `Ctrl+Shift+V`      | 粘贴                       |
| `Ctrl+F`            | 打开终端搜索               |
| `Ctrl+=` / `Ctrl++` | 增大字号                   |
| `Ctrl+-`            | 减小字号                   |
| `Ctrl+0`            | 重置字号                   |
| `Ctrl+C`            | 有选中时复制，否则正常传递 |
| `Ctrl+V`            | 粘贴                       |

右键菜单提供相同操作入口。

### Git 集成

- **分支信息**：窗格工具栏实时显示当前分支名，随 `cd` 命令自动更新
- **分支切换**：下拉列表合并本地和远程分支，支持一键切换；本地分支用 `git checkout`，远程分支用 `git checkout --track`；有未提交更改时提供暂存后切换选项
- **分支标签**：本地 / 远程 / 工作树 三种类型标记，一目了然
- **Diff 查看器**：侧边对比视图，使用 diff2html 解析 `git diff` 输出；左侧文件列表点击跳转，有 +N -M 改动统计徽标，支持新文件/删除/重命名/二进制文件标记

### 工作树管理

- **创建工作树**：选择基准分支，可选项新建分支、自定义项目名称和目标路径
- **管理工作树**：查看所有工作树列表（含 main/locked/detached 状态），支持删除（含强制删除）
- **自动推送**：创建工作树并新建分支时，自动执行 `git push -u origin <branch>`
- **一键跳转**：创建完成后自动拆分新窗格并定位到工作树目录

### 后台任务系统

- **任务定义**：设置名称、Shell 命令、工作目录，持久化到配置文件
- **任务运行**：每个任务在独立 PTY 中运行，输出以环形缓冲区（512 KB）捕获
- **生命周期管理**：运行、停止、重启、删除；应用退出时自动杀死所有运行中任务
- **输出查看**：任务抽屉使用只读 xterm 实例回放日志，支持实时滚动和搜索
- **快速操作**：窗格工具栏上的命令下拉选择器 + 运行/停止按钮
- **package.json 集成**：编辑任务时自动读取工作目录下的 npm scripts，一键填入命令
- **自动弹出**：任务启动时可选自动打开任务抽屉

### Shell 集成

自动向用户 Shell 注入 OSC 7 hook，使终端能实时感知当前工作目录：

| Shell             | 注入方式                                        |
| ----------------- | ----------------------------------------------- |
| Bash              | `--rcfile` 指向生成文件，`PROMPT_COMMAND` 追加  |
| Zsh               | `ZDOTDIR` 指向生成目录，`precmd_functions` 追加 |
| PowerShell / pwsh | `-NoLogo -NoExit -Command` 自定义 `prompt` 函数 |
| Cmd               | 设置 `PROMPT` 环境变量，前缀带 OSC 7            |

未知 Shell 回退到 PID 查询方式（Linux 读 `/proc/<pid>/cwd`，macOS 用 `lsof`）。

### 窗口与外观

- 自定义标题栏（Windows / Linux），macOS 使用原生红绿灯按钮
- 窗口位置、大小、最大化状态持久化，防止外接显示器断开后窗口跑出屏幕
- 设置抽屉（通用 + 关于），可调整字号、滚动缓冲、自动打开任务设置
- 应用配置存储在 `~/.Gittim/settings.json`

## 技术栈

- **Electron** 39 — 桌面应用框架
- **Vue 3** — Composition API + `<script setup lang="ts">`
- **xterm.js** 6 — 终端模拟
- **node-pty** — 伪终端
- **Element Plus** — UI 组件库
- **diff2html** — Diff 解析
- **TypeScript** — 全面类型覆盖（主进程 + 预加载 + 渲染进程）
- **electron-vite** — 构建工具链

## 开发

包管理器使用 **yarn**。

```bash
# 安装依赖
yarn

# 启动开发服务（HMR 热更新）
yarn dev

# 类型检查
yarn typecheck

# 代码检查
yarn lint

# 格式化
yarn format
```

## 构建

```bash
# 构建安装包
yarn build:win      # Windows (NSIS)
yarn build:mac      # macOS (DMG)
yarn build:linux    # Linux (AppImage / Snap / Deb)
```

## 平台支持

Windows、macOS、Linux 全平台支持。Shell 集成覆盖 Bash、Zsh、PowerShell / pwsh、Cmd。
