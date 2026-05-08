import * as crypto from "crypto";
import * as vscode from "vscode";
import { getChatPanelHtml } from "./chatHtml";
import { loadOpenThreads, saveOpenThreads, type OpenThreadMeta } from "./persist";
import { ManagedDeepseekRuntime } from "./runtimeProcess";
import { RuntimeClient, type RuntimeEnvelope } from "./runtimeClient";
import { ThreadTreeProvider } from "./threadTreeProvider";

let client: RuntimeClient;
let tree: ThreadTreeProvider;
let managedRuntime: ManagedDeepseekRuntime;

interface ActiveSession {
  panel: vscode.WebviewPanel;
  abort: AbortController;
  lastSeq: number;
  title: string;
  eventBuffer: RuntimeEnvelope[];
  ready: boolean;
  sseRunning: boolean;
  sseInitialConnect: boolean;
}

const sessions = new Map<string, ActiveSession>();

function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function resolveWorkspacePath(): string | undefined {
  const cfg = vscode.workspace.getConfiguration("deepseek.runtime").get<string>("workspace");
  if (cfg && cfg.trim().length > 0) {
    return cfg.trim();
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function persistOpenSessions(ctx: vscode.ExtensionContext): Promise<void> {
  const list: OpenThreadMeta[] = [];
  for (const [threadId, s] of sessions) {
    list.push({ threadId, title: s.title, lastSeq: s.lastSeq });
  }
  await saveOpenThreads(ctx, list);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  client = new RuntimeClient();
  tree = new ThreadTreeProvider(client);
  managedRuntime = new ManagedDeepseekRuntime(client);

  const persistDebounced = debounce(() => void persistOpenSessions(context), 500);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("deepseekThreads", tree),
    managedRuntime
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("deepseek.runtime") || e.affectsConfiguration("deepseek.sidebar")) {
        void tree.loadFromApi();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const auto = vscode.workspace
        .getConfiguration("deepseek.runtime")
        .get<boolean>("autoStartRuntime", true);
      if (!auto) return;
      const ws = resolveWorkspacePath();
      if (managedRuntime.isManagingProcess) {
        void managedRuntime.restart(ws).then((ok) => {
          if (ok) void tree.loadFromApi();
        });
      } else if (ws) {
        void managedRuntime.ensureRunning(ws).then((ok) => {
          if (ok) void tree.loadFromApi();
        });
      }
    })
  );

  async function sendInitAndFlush(threadId: string, s: ActiveSession): Promise<void> {
    try {
      const detail = await client.getThread(threadId);
      const mode = detail.thread.mode ?? "agent";
      const t =
        detail.thread.title?.trim() ||
        `DeepSeek ${detail.thread.id.slice(0, 8)}…`;
      s.title = t;
      s.panel.title = t;
      s.panel.webview.postMessage({ type: "init", mode });
    } catch (e) {
      s.panel.webview.postMessage({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    for (const env of s.eventBuffer) {
      s.panel.webview.postMessage({ type: "runtimeEvent", env });
    }
    s.eventBuffer = [];
  }

  function pushEvent(threadId: string, env: RuntimeEnvelope): void {
    const s = sessions.get(threadId);
    if (!s) return;
    s.lastSeq = Math.max(s.lastSeq, env.seq);
    persistDebounced();
    if (!s.ready) {
      s.eventBuffer.push(env);
      return;
    }
    s.panel.webview.postMessage({ type: "runtimeEvent", env });
  }

  async function startSse(threadId: string): Promise<void> {
    const s = sessions.get(threadId);
    if (!s || s.sseRunning) return;
    s.sseRunning = true;
    const run = async () => {
      while (sessions.get(threadId) === s && !s.abort.signal.aborted) {
        try {
          const since = s.sseInitialConnect
            ? undefined
            : s.lastSeq > 0
              ? s.lastSeq
              : undefined;
          s.sseInitialConnect = false;
          await client.streamThreadEvents(
            threadId,
            since,
            (env) => pushEvent(threadId, env),
            s.abort.signal
          );
        } catch (e) {
          if (s.abort.signal.aborted) break;
          s.panel.webview.postMessage({
            type: "error",
            message: `SSE 断开: ${e instanceof Error ? e.message : String(e)}。5s 后重试…`,
          });
        }
        if (s.abort.signal.aborted) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (sessions.get(threadId) === s) {
        s.sseRunning = false;
      }
    };
    void run();
  }

  function disposeSession(threadId: string): void {
    const s = sessions.get(threadId);
    if (!s) return;
    s.abort.abort();
    sessions.delete(threadId);
    void persistOpenSessions(context);
  }

  function openOrRevealThreadPanel(threadId: string, titleHint?: string): void {
    const max = vscode.workspace
      .getConfiguration("deepseek.runtime")
      .get<number>("maxConcurrentPanels", 8);
    const existing = sessions.get(threadId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    if (sessions.size >= max) {
      void vscode.window.showWarningMessage(`最多同时打开 ${max} 个 DeepSeek 会话面板`);
      return;
    }

    const abort = new AbortController();
    const panel = vscode.window.createWebviewPanel(
      "deepseekChat",
      titleHint ?? `DeepSeek ${threadId.slice(0, 8)}…`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const s: ActiveSession = {
      panel,
      abort,
      lastSeq: 0,
      title: titleHint ?? threadId,
      eventBuffer: [],
      ready: false,
      sseRunning: false,
      sseInitialConnect: true,
    };
    sessions.set(threadId, s);

    const nonce = crypto.randomBytes(16).toString("base64");
    panel.webview.html = getChatPanelHtml(panel.webview, threadId, nonce);

    panel.webview.onDidReceiveMessage(
      async (msg: { type: string; prompt?: string; mode?: string }) => {
        if (msg.type === "ready") {
          s.ready = true;
          await sendInitAndFlush(threadId, s);
          return;
        }
        if (msg.type === "sendPrompt" && msg.prompt) {
          try {
            await client.postTurn(threadId, msg.prompt);
          } catch (e) {
            panel.webview.postMessage({
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            });
          }
          return;
        }
        if (msg.type === "setMode" && msg.mode) {
          try {
            const rec = await client.patchThread(threadId, { mode: msg.mode });
            panel.webview.postMessage({ type: "mode", mode: rec.mode });
          } catch (e) {
            panel.webview.postMessage({
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            });
          }
        }
      },
      undefined,
      context.subscriptions
    );

    panel.onDidDispose(() => {
      disposeSession(threadId);
    });

    void startSse(threadId);
    void persistOpenSessions(context);
  }

  async function cmdNewChat(): Promise<void> {
    try {
      const ws = resolveWorkspacePath();
      const thread = await client.createThread({
        mode: "agent",
        workspace: ws,
      });
      const label = thread.title?.trim() || `DeepSeek ${thread.id.slice(0, 8)}…`;
      openOrRevealThreadPanel(thread.id, label);
      await tree.loadFromApi();
    } catch (e) {
      void vscode.window.showErrorMessage(
        `新建会话失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async function cmdOpenThread(threadId?: string): Promise<void> {
    const id = threadId ?? (await vscode.window.showInputBox({ prompt: "Thread ID" }));
    if (!id?.trim()) return;
    let title: string | undefined;
    try {
      const detail = await client.getThread(id.trim());
      title =
        detail.thread.title?.trim() ||
        `DeepSeek ${detail.thread.id.slice(0, 8)}…`;
    } catch {
      title = `DeepSeek ${id.trim().slice(0, 8)}…`;
    }
    openOrRevealThreadPanel(id.trim(), title);
  }

  async function cmdImportTui(): Promise<void> {
    const sessionId = await vscode.window.showInputBox({
      prompt: "TUI Session ID（deepseek sessions 中的 id）",
    });
    if (!sessionId?.trim()) return;
    try {
      const res = await client.resumeSessionThread(sessionId.trim(), {});
      void vscode.window.showInformationMessage(res.summary);
      openOrRevealThreadPanel(res.thread_id, `导入 ${sessionId.slice(0, 8)}…`);
      await tree.loadFromApi();
    } catch (e) {
      void vscode.window.showErrorMessage(
        `导入失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async function cmdToggleArchived(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("deepseek.sidebar");
    const cur = cfg.get<boolean>("includeArchived", false);
    await cfg.update("includeArchived", !cur, vscode.ConfigurationTarget.Global);
    await tree.loadFromApi();
  }

  async function cmdSearchThreads(): Promise<void> {
    const q = await vscode.window.showInputBox({
      prompt: "按标题 / id / 模型筛选（留空清除筛选）",
      value: "",
    });
    if (q === undefined) return;
    tree.setSearch(q.length ? q : undefined);
    await tree.loadFromApi();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.newChat", cmdNewChat),
    vscode.commands.registerCommand("deepseek.openThread", cmdOpenThread),
    vscode.commands.registerCommand("deepseek.refreshThreads", () => tree.loadFromApi()),
    vscode.commands.registerCommand("deepseek.importTuiSession", cmdImportTui),
    vscode.commands.registerCommand("deepseek.toggleArchived", cmdToggleArchived),
    vscode.commands.registerCommand("deepseek.searchThreads", cmdSearchThreads),
    vscode.commands.registerCommand("deepseek.restartRuntime", async () => {
      const ok = await managedRuntime.restart(resolveWorkspacePath());
      if (ok) await tree.loadFromApi();
    })
  );

  await managedRuntime.ensureRunning(resolveWorkspacePath());
  await tree.loadFromApi();

  const autoRestore = vscode.workspace
    .getConfiguration("deepseek.runtime")
    .get<boolean>("autoRestorePanels", true);
  if (autoRestore) {
    const saved = loadOpenThreads(context);
    for (const m of saved) {
      openOrRevealThreadPanel(m.threadId, m.title);
    }
  }

  context.subscriptions.push({
    dispose: () => {
      for (const id of [...sessions.keys()]) {
        disposeSession(id);
      }
    },
  });
}

export function deactivate(): void {
  for (const [, s] of sessions) {
    s.abort.abort();
  }
  sessions.clear();
}
