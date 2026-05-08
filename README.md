# MyAIAgent

本仓库将 **DeepSeek TUI** 的 HTTP 运行时（`deepseek serve --http`）接入 **VS Code / Cursor**：在侧栏管理会话、在编辑器区打开多个聊天面板，支持 **Plan / Agent / YOLO**，并可在激活扩展时 **自动拉起** 与本机工作区一致的 `deepseek serve --http`（可关）。

子目录 **`vscode-deepseek-sidebar`** 为扩展源码。

**`DeepSeek-TUI`**：若你本地已有该目录，多为独立 Git 仓库且体积较大，**默认已被 `.gitignore` 排除**，不会随本仓库推送。需要时请自行在旁侧 [clone 上游 DeepSeek-TUI](https://github.com/Hmbown/DeepSeek-TUI) 并安装其中的 `deepseek` CLI；扩展只依赖本机已安装的 `deepseek` 命令，不要求与本仓库同路径。

---

## 功能概览

| 能力 | 说明 |
|------|------|
| 侧栏会话列表 | 调用运行时 `GET /v1/threads/summary`，支持归档筛选与搜索 |
| 多面板聊天 | 每个线程独立 `WebviewPanel`，可并行打开（上限可配置） |
| 模式切换 | 面板内 Plan / Agent / YOLO → `PATCH /v1/threads/{id}` |
| 自动启动运行时 | 默认在 `/health` 不可用时执行 `deepseek --workspace <工作区> serve --http`（与 `baseUrl`、token 配置一致） |
| 重启运行时 | 命令 **DeepSeek: 重启本机 HTTP 运行时** |
| TUI Session 导入 | **DeepSeek: 从 TUI Session 导入为 Thread** |
| 输入体验 | 输入框 **Enter 发送**，**Shift+Enter 换行**（中文输入法选字时避免误发） |
| 构建编排 | 使用 **uv** 管理 Python 虚拟环境与统一入口脚本（见下文） |

详细扩展说明见 [vscode-deepseek-sidebar/README.md](vscode-deepseek-sidebar/README.md)。

---

## 环境要求

- **Python 3.11+** 与 **[uv](https://docs.astral.sh/uv/)**（用于本仓库的 `uv sync` / `uv run`）
- **Node.js** 与 **npm**（编译 / 打包 VS Code 扩展）
- 本机已安装可在终端执行的 **`deepseek`** CLI（HTTP 运行时由扩展自动或手动启动）
- （可选）**Rust / cargo**：仅在你需要自行从源码构建 `DeepSeek-TUI` 时

---

## 使用 uv 的安装与编译命令

在仓库根目录执行：

```bash
# 创建/同步虚拟环境（本仓库未声明第三方 Python 依赖，主要用于统一 uv 工作流）
uv sync

# 一键：npm install + tsc 编译扩展
uv run python scripts/run.py build

# 仅安装 npm 依赖
uv run python scripts/run.py setup
# 或
uv run python scripts/run.py sidebar-install

# 仅编译 TypeScript
uv run python scripts/run.py sidebar-compile

# 监听编译（开发）
uv run python scripts/run.py sidebar-watch

# 打 VSIX 安装包
uv run python scripts/run.py sidebar-package

# 可选：Release 构建 DeepSeek-TUI
uv run python scripts/run.py tui-build-release
```

查看全部子命令：

```bash
uv run python scripts/run.py --help
```

> **说明**：根目录 [pyproject.toml](pyproject.toml) 使用 `[tool.uv] package = false`，不要求从 PyPI 安装构建后端，适合离线或受限网络下仍能用 **uv** 管理解释器与环境；构建动作由 [scripts/run.py](scripts/run.py) 调用 **npm** / **cargo** 完成。

---

## 日常使用（扩展）

1. 安装 **DeepSeek CLI**，保证 `deepseek` 在 PATH（或之后在设置里配置 `deepseek.runtime.executable`）。
2. 按上一节 **`uv run python scripts/run.py build`** 编译扩展；或用 **VSIX**：`uv run python scripts/run.py sidebar-package` 后从 VSIX 安装。
3. 在 VS Code / Cursor 中 **打开你的项目文件夹**。
4. 活动栏打开 **DeepSeek → 会话**；默认会自动尝试启动 HTTP 运行时（可在设置中关闭 `deepseek.runtime.autoStartRuntime`）。

更细步骤、设置项与排错见 [vscode-deepseek-sidebar/README.md](vscode-deepseek-sidebar/README.md)。

---

## 推送到 GitHub

本仓库初始未绑定远程。在 GitHub 上新建空仓库后，在仓库根目录执行（将 URL 换成你的地址）：

```bash
git init
git add .
git commit -m "Initial commit: DeepSeek sidebar extension and uv workspace"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

若使用 SSH：

```bash
git remote add origin git@github.com:<你的用户名>/<仓库名>.git
git push -u origin main
```

---

## 目录结构（摘要）

```
myAIAgent/
  pyproject.toml          # uv 项目元数据（package = false）
  uv.lock                 # 锁文件（随 uv lock 生成）
  scripts/run.py          # 构建入口（npm / cargo）
  vscode-deepseek-sidebar/   # VS Code 扩展
  # DeepSeek-TUI/           # 可选：本地自行 clone，默认不纳入 git
```

---

## 协议与上游

- 运行时 HTTP API 约定见 DeepSeek-TUI 仓库中的 `docs/RUNTIME_API.md`（若本地子模块或拷贝中包含）。
