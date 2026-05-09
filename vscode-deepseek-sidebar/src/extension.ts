import * as crypto from "crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { getChatPanelHtml } from "./chatHtml";
import { loadOpenThreads, saveOpenThreads, type OpenThreadMeta } from "./persist";
import { ManagedDeepseekRuntime } from "./runtimeProcess";
import { RuntimeClient, type RuntimeEnvelope } from "./runtimeClient";
import { clampSeqToThreadMax, mergeEventSeq, mergeLatestSeq } from "./sessionSeq";
import { resolveFinishedText } from "./sseEnvelopeUtils";
import { resolveThreadEventsSinceSeq } from "./sseSinceSeq";
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

/** 同一线程串行执行 postTurn，避免首条尚在 409 重试时第二条又 interrupt/POST 叠在一起（日志 L14–18）。 */
const postTurnTail = new Map<string, Promise<void>>();

/** CSP nonce：仅字母数字，避免 base64 的 +/ 在部分环境下干扰 CSP 解析 */
function getCspNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(32);
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars[bytes[i]! % chars.length];
  }
  return out;
}

function normalizeMode(mode: string | undefined | null): string {
  const m = (mode ?? "agent").trim().toLowerCase();
  if (m === "plan" || m === "yolo" || m === "agent") return m;
  return "agent";
}

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
    const lastSeq = Number.isFinite(s.lastSeq) ? s.lastSeq : 0;
    list.push({ threadId, title: s.title, lastSeq });
  }
  await saveOpenThreads(ctx, list);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const debugLogPath = path.join(context.extensionPath, "..", "debug-ce7ce1.log");
  const agentDeltaAccum = new Map<string, number>();
  function dbgLog(entry: Record<string, unknown>): void {
    try {
      fs.appendFileSync(
        debugLogPath,
        JSON.stringify({ sessionId: "ce7ce1", timestamp: Date.now(), ...entry }) + "\n"
      );
    } catch {
      /* ignore */
    }
  }
  function coalesceDeltaPayload(p: Record<string, unknown>): string {
    const keys = ["delta", "text", "chunk", "output", "stdout", "stderr", "content"] as const;
    for (const k of keys) {
      const v = p[k];
      if (v == null || v === "") continue;
      if (typeof v === "string") return v;
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }
    return "";
  }

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
    let mode = "agent";
    try {
      const detail = await client.getThread(threadId);
      mode = normalizeMode(detail.thread.mode);
      const t =
        detail.thread.title?.trim() ||
        `DeepSeek ${detail.thread.id.slice(0, 8)}…`;
      s.title = t;
      s.panel.title = t;
      s.lastSeq = clampSeqToThreadMax(
        mergeLatestSeq(s.lastSeq, detail.latest_seq),
        detail.latest_seq
      );
      s.panel.webview.postMessage({ type: "init", mode, items: detail.items ?? [] });
    } catch (e) {
      s.panel.webview.postMessage({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      s.panel.webview.postMessage({ type: "init", mode, items: [] });
    }
    /* 在已知 latest_seq 之前启动 SSE 会错误地用 0 游标拉全量；丢弃该窗口内缓冲 */
    s.eventBuffer = [];
    void startSse(threadId);
  }

  function pushEvent(threadId: string, env: RuntimeEnvelope): void {
    const s = sessions.get(threadId);
    if (!s) return;
    s.lastSeq = mergeEventSeq(s.lastSeq, env.seq);
    persistDebounced();
    if (!s.ready) {
      s.eventBuffer.push(env);
      return;
    }
    // #region agent log
    const p = env.payload || {};
    const item = (p.item as Record<string, unknown> | undefined) || {};
    const kind =
      (typeof item.kind === "string" ? item.kind : "") ||
      (typeof p.kind === "string" ? p.kind : "");
    const rawId = env.item_id ?? p.item_id ?? item.id ?? "";
    const itemId = rawId != null && rawId !== "" ? String(rawId) : "";
    if (kind === "agent_message") {
      const accKey = `${threadId}:${itemId || "_"}`;
      if (env.event === "item.delta") {
        const d = coalesceDeltaPayload(p as Record<string, unknown>);
        if (d.length) {
          const prev = agentDeltaAccum.get(accKey) || 0;
          agentDeltaAccum.set(accKey, prev + d.length);
          if (prev === 0) {
            dbgLog({
              runId: "post-fix",
              hypothesisId: "H4",
              location: "extension.ts:pushEvent",
              message: "agent_message first delta",
              data: { threadId, itemId: itemId || null, deltaLen: d.length, seq: env.seq },
            });
          }
        }
      } else if (env.event === "item.completed" || env.event === "item.failed") {
        const finished = resolveFinishedText(p as never, item as never);
        const acc = agentDeltaAccum.get(accKey) || 0;
        dbgLog({
          runId: "post-fix",
          hypothesisId: "H1",
          location: "extension.ts:pushEvent",
          message: "agent_message terminal (wire to webview)",
          data: {
            threadId,
            itemId: itemId || null,
            event: env.event,
            finishedLen: finished.length,
            streamedDeltaAcc: acc,
            finishedGtStream: finished.length > acc,
          },
        });
        dbgLog({
          runId: "post-fix",
          hypothesisId: "H3",
          location: "extension.ts:pushEvent",
          message: "runtimeEvent envelope size",
          data: { approxJsonBytes: JSON.stringify(env).length, event: env.event, kind },
        });
        agentDeltaAccum.delete(accKey);
      }
    }
    // #endregion
    s.panel.webview.postMessage({ type: "runtimeEvent", env });
  }

  async function startSse(threadId: string): Promise<void> {
    const s = sessions.get(threadId);
    if (!s || s.sseRunning) return;
    s.sseRunning = true;
    const run = async () => {
      while (sessions.get(threadId) === s && !s.abort.signal.aborted) {
        try {
          const since = resolveThreadEventsSinceSeq({
            sseInitialConnect: s.sseInitialConnect,
            lastSeq: s.lastSeq,
          });
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
    postTurnTail.delete(threadId);
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
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(context.extensionPath)],
      }
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

    const nonce = getCspNonce();
    panel.webview.html = getChatPanelHtml(panel.webview, context.extensionUri, threadId, nonce);

    panel.webview.onDidReceiveMessage(
      async (msg: {
        type: string;
        prompt?: string;
        mode?: string;
        approvalId?: string;
        decision?: string;
        remember?: boolean;
        payload?: Record<string, unknown>;
      }) => {
        // #region agent log
        if (msg.type === "_debugLog" && msg.payload && typeof msg.payload === "object") {
          dbgLog({ runId: "post-fix", ...(msg.payload as Record<string, unknown>) });
          return;
        }
        // #endregion
        if (msg.type === "ready") {
          s.ready = true;
          await sendInitAndFlush(threadId, s);
          return;
        }
        if (msg.type === "sendPrompt" && msg.prompt) {
          const promptText = msg.prompt;
          // #region agent log
          dbgLog({
            runId: "post-fix",
            hypothesisId: "H2",
            location: "extension.ts:sendPrompt",
            message: "sendPrompt handler entered",
            data: { threadId, promptLen: promptText.length },
          });
          // #endregion
          const prev = postTurnTail.get(threadId) ?? Promise.resolve();
          const work = prev.then(async () => {
            await client.postTurn(threadId, promptText);
            try {
              const d = await client.getThread(threadId);
              s.lastSeq = clampSeqToThreadMax(s.lastSeq, d.latest_seq);
            } catch {
              /* ignore */
            }
          });
          postTurnTail.set(
            threadId,
            work.catch(() => {
              /* 错误由下方 await 处理；链尾需吞掉 rejection 以免阻断后续发送 */
            })
          );
          try {
            await work;
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
            const rec = await client.patchThread(threadId, { mode: normalizeMode(msg.mode) });
            panel.webview.postMessage({ type: "mode", mode: normalizeMode(rec.mode) });
          } catch (e) {
            panel.webview.postMessage({
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            });
          }
          return;
        }
        if (msg.type === "approvalDecision" && msg.approvalId && msg.decision) {
          const d = msg.decision;
          if (d !== "allow" && d !== "deny") return;
          try {
            await client.postApprovalDecision(msg.approvalId, {
              decision: d,
              remember: Boolean(msg.remember),
            });
            panel.webview.postMessage({
              type: "approvalResolved",
              approvalId: msg.approvalId,
              decision: d,
            });
          } catch (e) {
            panel.webview.postMessage({
              type: "approvalError",
              approvalId: msg.approvalId,
              message: e instanceof Error ? e.message : String(e),
            });
          }
          return;
        }
      },
      undefined,
      context.subscriptions
    );

    panel.onDidDispose(() => {
      disposeSession(threadId);
    });

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
