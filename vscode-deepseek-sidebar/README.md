# DeepSeek Runtime（VS Code 扩展）

将本机 [DeepSeek TUI](https://github.com/Hmbown/DeepSeek-TUI) 的 **HTTP 运行时**（`deepseek serve --http`）接入 VS Code：活动栏 **DeepSeek → 会话** 列出历史线程，在编辑器区打开 **多个聊天面板**，支持 **Plan / Agent / YOLO** 模式切换。

## 推荐用法（日常）

1. 在本机安装 **DeepSeek CLI**（`deepseek` / `deepseek-tui`，且 `deepseek` 在终端可运行）。
2. **安装扩展一次**（任选其一）：
   - **VSIX**：在本目录执行 `npm install` 与 `npm run compile` 后打包安装（见下文「打包 VSIX」），在 VS Code / Cursor 中用 **从 VSIX 安装** 或命令行安装。
   - **开发调试**：在本目录打开仓库，按 `F5` 启动 Extension Development Host（见「开发与调试」）。
3. 在编辑器中 **文件 → 打开文件夹**，打开你的项目根目录。
4. 默认会开启 **`deepseek.runtime.autoStartRuntime`**：若 `http://127.0.0.1:7878/health` 尚无响应，扩展会自动执行  
   `deepseek --workspace <当前工作区> serve --http`（参数与 `deepseek.runtime.baseUrl`、`authToken` 对齐）。  
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
