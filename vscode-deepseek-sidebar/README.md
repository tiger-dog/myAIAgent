# DeepSeek Runtime（VS Code 扩展）

若你从本仓库的**上一级根目录**（`myAIAgent`）管理工程，可用 **uv** 统一编译：在根目录执行 `uv sync` 后 `uv run python scripts/run.py build`，等价于在本目录执行 `npm install` 与 `npm run compile`。更完整的单仓说明在**上级目录** `myAIAgent` 根下的 `README.md`（该文件不在 VSIX 包内，仅供本地克隆后阅读）。

将本机 [DeepSeek TUI](https://github.com/Hmbown/DeepSeek-TUI) 的 **HTTP 运行时**（`deepseek serve --http`）接入 VS Code：活动栏 **DeepSeek → 会话** 列出历史线程，在编辑器区打开 **多个聊天面板**，支持 **Plan / Agent / YOLO** 模式切换。

## 推荐用法（日常）

1. 在本机安装 **DeepSeek CLI**（`deepseek` / `deepseek-tui`，且 `deepseek` 在终端可运行）。
2. **安装扩展一次**（任选其一）：
   - **VSIX**：在本目录执行 `npm install` 与 `npm run compile` 后打包安装（见下文「打包 VSIX」），在 VS Code / Cursor 中用 **从 VSIX 安装** 或命令行安装。
   - **开发调试**：在本目录打开仓库，按 `F5` 启动 Extension Development Host（见「开发与调试」）。
3. 在编辑器中 **文件 → 打开文件夹**，打开你的项目根目录。
4. 默认会开启 **`deepseek.runtime.autoStartRuntime`**：若 `http://127.0.0.1:7878/health` 尚无响应，扩展会在**当前工作区目录**下自动执行  
   `deepseek serve --http …`（监听地址与 `deepseek.runtime.baseUrl`、可选 `authToken` 对齐），等价于在终端先 `cd` 到项目再运行。  
   之后直接使用活动栏 **DeepSeek** 即可，**无需再开 CMD 手动起 serve**。

若已自行在终端运行了 `deepseek serve --http` 且端口一致，扩展 **不会** 再启第二个进程。

**命令**：**DeepSeek: 重启本机 HTTP 运行时**（`deepseek.restartRuntime`）— 先结束由扩展拉起的进程（如有），再在 `/health` 不可用时重新启动。

**输出**：自动启动或排错日志在输出面板 **「DeepSeek Runtime」**。

### 单端口说明

同一 `host:port` 上只能有一个 HTTP 运行时。若另一窗口已占用且 `/health` 正常，本窗口会认为「已有运行时」而不会自动启动；此时侧栏会话列表可能对应 **其他工作区** 的进程。可关闭多余的 `deepseek serve`、改用不同端口并同步修改 `deepseek.runtime.baseUrl`，或使用「重启本机 HTTP 运行时」。

## 手动启动运行时（可选）

若关闭 **`deepseek.runtime.autoStartRuntime`**，或希望完全自行控制进程，可在项目目录执行：

```bash
cd /path/to/your/project
deepseek serve --http
```

默认监听 `http://127.0.0.1:7878`。若使用 `--auth-token`，在设置中填写 `deepseek.runtime.authToken`。

## 打包 VSIX（一次安装、长期可用）

在本目录：

```bash
npm install
npm run compile
npx --yes @vscode/vsce package
```

会生成 `deepseek-sidebar-0.1.0.vsix`（版本号以 `package.json` 为准）。安装示例：

```bash
code --install-extension deepseek-sidebar-0.1.0.vsix
```

Cursor 用户可在命令面板中搜索 **Install from VSIX** 并选择该文件。

## 开发与调试

```bash
cd vscode-deepseek-sidebar
npm install
npm run compile
```

在 VS Code 中 **文件 → 打开文件夹** 选择本目录，按 `F5` 启动 **Extension Development Host**（依赖本仓库内 `.vscode/launch.json`）。

在宿主窗口中打开你的项目文件夹，点击活动栏 **DeepSeek** 图标使用侧栏。

## 功能说明

| 能力 | 说明 |
|------|------|
| 历史会话 | 侧栏调用 `GET /v1/threads/summary`，可切换「含归档」 |
| 多窗口 | 每个线程一个 `WebviewPanel`，可同时打开多个（上限见设置） |
| 恢复 | 默认在重载窗口后根据 `workspaceState` 自动重新打开面板；消息由运行时 **Thread 持久化**，扩展只存 `threadId` / `lastSeq` 等元数据 |
| 模式 | 面板内 **Plan / Agent / YOLO** → `PATCH /v1/threads/{id}` |
| TUI Session 导入 | 命令 **DeepSeek: 从 TUI Session 导入为 Thread** → `POST /v1/sessions/{id}/resume-thread` |
| 搜索 | 侧栏标题栏 **搜索会话** → 调用 `threads/summary?search=`（留空清除筛选） |

## 与交互式 TUI 的关系

`deepseek`（终端 TUI）与 `deepseek serve --http` 是不同进程；侧栏只连接 **HTTP 线程**。与纯 TUI 的实时同屏需通过 **导入 Session** 或统一在 HTTP 侧使用线程。

## 排错

### Linux / macOS 与 Windows 差异（参数传递）

- **Linux / macOS**：Node `spawn(executable, args, { cwd })` 使用 `execve` 风格 **argv 数组**，不会出现 Windows 上偶发的「整条命令行被合成一个参数」问题。与 **`--workspace` 误用** 相关的 clap 报错在**各平台**上的根因相同：调度器不接受在 `serve` 前的该写法；本扩展已统一改为 **`cwd` = 工作区根 + `serve --http …`**。
- **仍可能遇到的问题**（与 Windows 类似）：从桌面/应用菜单启动 VS Code / Cursor 时，进程 **PATH** 可能不含 `~/.cargo/bin`、`~/.local/bin`。扩展会尝试 `which deepseek`（及 `command -v`）并临时前缀常见目录；若仍找不到，请在设置中填写 `deepseek.runtime.executable` 绝对路径。

### `unexpected argument '--workspace …'`（旧版扩展或手写命令）

上游调度器 **`deepseek`（deepseek-tui-cli）不接受** 在 `serve` 前的全局 `--workspace`；工作区由**进程工作目录**决定。本扩展已改为在**工作区根 cwd** 下执行 `deepseek serve --http …`。若在终端自测，请使用 `cd <项目根>` 后 `deepseek serve --http`，勿写 `deepseek --workspace … serve …`。

### `unexpected argument …` 且 Usage 里仅有 `deepseek-tui.exe --workspace`

说明扩展实际启动的是 **TUI 本体**（`deepseek-tui` / `deepseek-tui.exe`），它只有 `--workspace`，**没有** `serve --http`。本扩展必须用 **调度器** `deepseek`（Windows 上常见为 `deepseek.exe`），与 `deepseek-tui` 成对发布（见上游 [INSTALL.md](https://github.com/Hmbown/DeepSeek-TUI/blob/main/docs/INSTALL.md)）。

处理：

1. 在终端执行 `deepseek serve --http`：若提示未知子命令，说明当前 PATH 上的不是调度器。
2. 在 PowerShell 执行 `where.exe deepseek`，确认指向的是 **deepseek** 而非 **deepseek-tui**。
3. 在编辑器设置里将 **`deepseek.runtime.executable`** 设为调度器的**绝对路径**（例如 npm 全局 bin 下的 `deepseek.cmd` 所调用的实际 `deepseek.exe`，或 Release 里的 `deepseek-windows-x64.exe` 安装位置）。

调度器未成功监听时，侧栏会通过 `fetch` 连 `baseUrl`，你会看到 **「SSE 断开: fetch failed」**——先让 `/health` 正常即可恢复。

### 希望免手动执行 `deepseek serve --http`

保持 **`deepseek.runtime.autoStartRuntime`** 开启（默认）。设置里使用默认可执行文件名 **`deepseek`** 时，扩展会：

1. **系统查找**：在增强后的 `PATH` 上执行 **`where deepseek`**（Windows）或 **`which deepseek` / `command -v deepseek`**（Linux / macOS）。增强方式是把常见目录**临时前缀**到 PATH（例如 `%USERPROFILE%\.cargo\bin`、`scoop\shims`、`%APPDATA%\npm` 等），减轻「从桌面启动编辑器时 PATH 不完整」的问题。
2. **静态回退**：若查找失败，再直接探测上述常见目录下的可执行文件。
3. 仍找不到则回退为命令名 `deepseek`（依赖进程自身 PATH）。

安装在其他自定义目录且不在 PATH 中时，请在设置中填写 **`deepseek.runtime.executable`** 的绝对路径。

## 设置项

- `deepseek.runtime.baseUrl` — 运行时地址（自动启动时同时用于 `--host` / `--port`）
- `deepseek.runtime.authToken` — 可选 Bearer（传给 `--auth-token`）
- `deepseek.runtime.autoStartRuntime` — 是否在激活时自动启动 `deepseek serve --http`（默认开启）
- `deepseek.runtime.executable` — `deepseek` 可执行文件名或绝对路径（默认 `deepseek`）
- `deepseek.runtime.autoRestorePanels` — 重载后是否恢复已打开面板
- `deepseek.runtime.maxConcurrentPanels` — 最大并发面板数
- `deepseek.runtime.workspace` — 覆盖工作区路径（空则用当前 VS Code 工作区根）
- `deepseek.sidebar.includeArchived` — 列表是否包含已归档线程

## 协议参考

实现契约见 DeepSeek-TUI 仓库内 `docs/RUNTIME_API.md`。
