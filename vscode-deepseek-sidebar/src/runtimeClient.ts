import * as vscode from "vscode";

export interface ThreadSummary {
  id: string;
  title: string;
  preview: string;
  model: string;
  mode: string;
  archived: boolean;
  updated_at: string;
  latest_turn_id: string | null;
  latest_turn_status: string | null;
}

export interface ThreadRecord {
  id: string;
  model: string;
  mode: string;
  archived: boolean;
  title?: string | null;
  allow_shell: boolean;
  trust_mode: boolean;
  auto_approve: boolean;
  latest_turn_id?: string | null;
}

/** Persisted turn row from GET /v1/threads/{id} */
export interface TurnRow {
  id: string;
  status: string;
  started_at?: string | null;
  created_at?: string;
}

export interface ThreadDetail {
  thread: ThreadRecord;
  turns: TurnRow[];
  items: unknown[];
  latest_seq: number;
}

export interface RuntimeEnvelope {
  seq: number;
  timestamp?: string;
  thread_id: string;
  turn_id?: string | null;
  item_id?: string | null;
  event: string;
  payload: Record<string, unknown>;
}

function getConfig(): { baseUrl: string; authToken: string } {
  const cfg = vscode.workspace.getConfiguration("deepseek.runtime");
  const baseUrl = (cfg.get<string>("baseUrl") ?? "http://127.0.0.1:7878").replace(/\/$/, "");
  const authToken = cfg.get<string>("authToken") ?? "";
  return { baseUrl, authToken };
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const { authToken } = getConfig();
  const h: Record<string, string> = { Accept: "application/json", ...extra };
  if (authToken) {
    h.Authorization = `Bearer ${authToken}`;
    h["X-DeepSeek-Runtime-Token"] = authToken;
  }
  return h;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 僵尸「进行中」回合：steer 可能 200 但引擎已不再推进，改走 interrupt + 新回合。 */
const STALE_IN_PROGRESS_MS = 6 * 60 * 1000;

function turnWallClockStartMs(row: Pick<TurnRow, "started_at" | "created_at"> | undefined): number | null {
  if (!row) return null;
  const raw = row.started_at ?? row.created_at;
  if (raw == null || typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

// #region agent log
function agentDbg(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string
): void {
  const payload = {
    sessionId: "ce7ce1",
    runId: "pre-fix",
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  fetch("http://127.0.0.1:7903/ingest/b1fa4e33-b1f3-441a-83ad-cef0440ca9da", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ce7ce1" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
// #endregion

/** interrupt / resume 等辅助请求：超时不阻塞用户发送主路径 */
const INTERRUPT_HTTP_MS = 10_000;
const POST_TURN_MS = 180_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const c = new AbortController();
  const tid = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(tid);
  }
}

export class RuntimeClient {
  async health(): Promise<boolean> {
    const { baseUrl } = getConfig();
    try {
      const res = await fetch(`${baseUrl}/health`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listThreadsSummary(opts: {
    limit?: number;
    search?: string;
    includeArchived?: boolean;
    archivedOnly?: boolean;
  }): Promise<ThreadSummary[]> {
    const { baseUrl } = getConfig();
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.search) params.set("search", opts.search);
    if (opts.includeArchived) params.set("include_archived", "true");
    if (opts.archivedOnly) params.set("archived_only", "true");
    const q = params.toString();
    const url = `${baseUrl}/v1/threads/summary${q ? `?${q}` : ""}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`threads/summary ${res.status}: ${t}`);
    }
    return (await res.json()) as ThreadSummary[];
  }

  async createThread(body: {
    model?: string;
    mode?: string;
    workspace?: string;
  }): Promise<ThreadRecord> {
    const { baseUrl } = getConfig();
    const res = await fetch(`${baseUrl}/v1/threads`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`create thread ${res.status}: ${t}`);
    }
    return (await res.json()) as ThreadRecord;
  }

  async getThread(id: string): Promise<ThreadDetail> {
    const { baseUrl } = getConfig();
    const res = await fetch(`${baseUrl}/v1/threads/${encodeURIComponent(id)}`, {
      headers: headers(),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`get thread ${res.status}: ${t}`);
    }
    return (await res.json()) as ThreadDetail;
  }

  async patchThread(
    id: string,
    body: { mode?: string; archived?: boolean; title?: string }
  ): Promise<ThreadRecord> {
    const { baseUrl } = getConfig();
    const res = await fetch(`${baseUrl}/v1/threads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`patch thread ${res.status}: ${t}`);
    }
    return (await res.json()) as ThreadRecord;
  }

  /**
   * Interrupt the latest turn if persisted status is still queued / in_progress.
   * (Covers reconnecting to a history thread that was mid-flight when the client disconnected.)
   */
  async clearPersistedBlockingTurn(threadId: string): Promise<void> {
    let detail: ThreadDetail;
    try {
      detail = await this.getThread(threadId);
    } catch {
      return;
    }
    const latestId = detail.thread.latest_turn_id;
    if (!latestId || !detail.turns?.length) return;
    const turn = detail.turns.find((t) => t.id === latestId);
    if (!turn) return;
    if (turn.status !== "in_progress" && turn.status !== "queued") return;
    await this.interruptTurn(threadId, latestId);
    await delay(350);
  }

  /**
   * POST .../turns/{turn_id}/interrupt — best-effort; may fail if engine has no active turn.
   */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const { baseUrl } = getConfig();
    const url = `${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`;
    try {
      let res = await fetchWithTimeout(url, { method: "POST", headers: headers() }, INTERRUPT_HTTP_MS);
      // #region agent log
      void res
        .clone()
        .text()
        .then((t) =>
          agentDbg(
            "runtimeClient.ts:interruptTurn",
            "interrupt first response",
            {
              threadId,
              turnId,
              status: res.status,
              bodyHead: t.slice(0, 200),
            },
            "H4"
          )
        )
        .catch(() => {});
      // #endregion
      if (res.ok) return;
      await fetchWithTimeout(
        `${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/resume`,
        { method: "POST", headers: headers() },
        INTERRUPT_HTTP_MS
      );
      await delay(200);
      res = await fetchWithTimeout(url, { method: "POST", headers: headers() }, INTERRUPT_HTTP_MS);
    } catch {
      /* best-effort：超时时不阻塞 postTurn */
    }
  }

  /**
   * Try to clear engine-side active turn when persisted latest_turn_id is known
   * (handles zombie active_turn vs DB already terminal).
   */
  async interruptLatestTurnBestEffort(threadId: string): Promise<void> {
    let detail: ThreadDetail;
    try {
      detail = await this.getThread(threadId);
    } catch {
      return;
    }
    const latestId = detail.thread.latest_turn_id;
    if (!latestId) return;
    const row = detail.turns?.find((t) => t.id === latestId);
    if (row && row.status !== "in_progress" && row.status !== "queued") {
      return;
    }
    await this.interruptTurn(threadId, latestId);
    await delay(400);
  }

  /** 追加输入到当前进行中的回合（避免先发 interrupt 截断流式输出再 POST 新回合）。 */
  async postSteerTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
    const { baseUrl } = getConfig();
    const url = `${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/steer`;
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prompt }),
      },
      POST_TURN_MS
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`post steer ${res.status}: ${t}`);
    }
  }

  /** 轮询直到指定回合在持久化中不再是 queued / in_progress（用于 interrupt 后等新回合收尾）。 */
  async waitUntilTurnTerminal(threadId: string, turnId: string, maxMs: number): Promise<void> {
    if (!turnId) return;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      let d: ThreadDetail;
      try {
        d = await this.getThread(threadId);
      } catch {
        await delay(200);
        continue;
      }
      const row = d.turns?.find((t) => t.id === turnId);
      const st = row?.status;
      if (!row || !st) return;
      if (st !== "in_progress" && st !== "queued") return;
      await delay(220);
    }
  }

  /**
   * POST /v1/threads/{id}/resume — 让引擎与持久化状态对齐；对消解「DB 已终态但引擎仍占 active turn」常为必要。
   */
  async resumeThread(threadId: string): Promise<void> {
    const { baseUrl } = getConfig();
    try {
      await fetchWithTimeout(
        `${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/resume`,
        { method: "POST", headers: headers() },
        INTERRUPT_HTTP_MS
      );
    } catch {
      /* best-effort */
    }
  }

  /**
   * 响应 SSE `approval.required`：POST /v1/approvals/{id}，body `{ decision, remember }`。
   */
  async postApprovalDecision(
    approvalId: string,
    body: { decision: "allow" | "deny"; remember?: boolean }
  ): Promise<void> {
    const { baseUrl } = getConfig();
    const res = await fetch(
      `${baseUrl}/v1/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          decision: body.decision,
          remember: body.remember ?? false,
        }),
      }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`approval ${res.status}: ${t}`);
    }
  }

  async postTurn(id: string, prompt: string): Promise<void> {
    const { baseUrl } = getConfig();
    const url = `${baseUrl}/v1/threads/${encodeURIComponent(id)}/turns`;
    const body = JSON.stringify({ prompt });

    // #region agent log
    const postTurnStartedAt = Date.now();
    agentDbg(
      "runtimeClient.ts:postTurn",
      "postTurn enter",
      { threadId: id, promptLen: prompt.length, t0: postTurnStartedAt },
      "H1"
    );
    // #endregion

    let detail: ThreadDetail | null = null;
    try {
      detail = await this.getThread(id);
    } catch {
      detail = null;
    }
    const routeLatestId = detail?.thread.latest_turn_id ?? null;
    const routeLatestRow = routeLatestId ? detail?.turns?.find((t) => t.id === routeLatestId) : undefined;
    const routeLatestStatus = routeLatestRow?.status;
    const routeStartMs = turnWallClockStartMs(routeLatestRow);
    const routeAgeMs = routeStartMs != null ? Date.now() - routeStartMs : null;
    const staleInProgress =
      (routeLatestStatus === "in_progress" || routeLatestStatus === "queued") &&
      routeAgeMs != null &&
      routeAgeMs > STALE_IN_PROGRESS_MS;

    // #region agent log
    agentDbg(
      "runtimeClient.ts:postTurn",
      "route snapshot",
      {
        threadId: id,
        msSinceEnter: Date.now() - postTurnStartedAt,
        latest_turn_id: routeLatestId,
        latest_turn_status: routeLatestStatus ?? null,
        turnRowCount: detail?.turns?.length ?? -1,
        routeAgeMs,
        staleInProgress,
        route:
          routeLatestId &&
          (routeLatestStatus === "in_progress" || routeLatestStatus === "queued") &&
          !staleInProgress
            ? "steer"
            : "new_turn",
      },
      "H6"
    );
    // #endregion

    if (staleInProgress) {
      // #region agent log
      agentDbg(
        "runtimeClient.ts:postTurn",
        "skip steer: stale in_progress",
        { threadId: id, turnId: routeLatestId, routeAgeMs, staleMs: STALE_IN_PROGRESS_MS },
        "H7"
      );
      // #endregion
    }

    if (
      routeLatestId &&
      (routeLatestStatus === "in_progress" || routeLatestStatus === "queued") &&
      !staleInProgress
    ) {
      try {
        await this.postSteerTurn(id, routeLatestId, prompt);
        // #region agent log
        agentDbg(
          "runtimeClient.ts:postTurn",
          "steer ok",
          {
            threadId: id,
            turnId: routeLatestId,
            msSinceEnter: Date.now() - postTurnStartedAt,
          },
          "H6"
        );
        // #endregion
        return;
      } catch (e) {
        // #region agent log
        agentDbg(
          "runtimeClient.ts:postTurn",
          "steer failed, fall back to new turn",
          {
            threadId: id,
            turnId: routeLatestId,
            msSinceEnter: Date.now() - postTurnStartedAt,
            err: e instanceof Error ? e.message : String(e),
          },
          "H6"
        );
        // #endregion
      }
    }

    let interruptTargetId: string | null = null;
    try {
      const d = await this.getThread(id);
      interruptTargetId = d.thread.latest_turn_id ?? null;
    } catch {
      interruptTargetId = routeLatestId;
    }
    await this.interruptLatestTurnBestEffort(id);
    if (interruptTargetId) {
      await this.waitUntilTurnTerminal(id, interruptTargetId, 15_000);
    }

    // #region agent log
    let snap: ThreadDetail | null = null;
    try {
      snap = await this.getThread(id);
    } catch {
      snap = null;
    }
    const latestId = snap?.thread.latest_turn_id ?? null;
    const latestRow = snap?.turns?.find((t) => t.id === latestId);
    agentDbg(
      "runtimeClient.ts:postTurn",
      "before post new turn",
      {
        threadId: id,
        msSinceEnter: Date.now() - postTurnStartedAt,
        latest_turn_id: latestId,
        latest_turn_status: latestRow?.status ?? null,
        turnRowCount: snap?.turns?.length ?? -1,
      },
      "H2"
    );
    // #endregion

    const post = () =>
      fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: headers({ "Content-Type": "application/json" }),
          body,
        },
        POST_TURN_MS
      );

    let res = await post();
    // #region agent log
    void res
      .clone()
      .text()
      .then((txt) =>
        agentDbg(
          "runtimeClient.ts:postTurn",
          "post turns initial response",
          {
            threadId: id,
            attempt: 0,
            status: res.status,
            msSinceEnter: Date.now() - postTurnStartedAt,
            bodyHead: txt.slice(0, 220),
          },
          "H3"
        )
      )
      .catch(() => {});
    // #endregion
    const max409Attempts = 5;
    for (let attempt = 0; res.status === 409 && attempt < max409Attempts; attempt++) {
      await this.resumeThread(id);
      await delay(280 + attempt * 220);
      let tid: string | null = null;
      let tidStatus: string | null = null;
      try {
        const d = await this.getThread(id);
        tid = d.thread.latest_turn_id ?? null;
        const row = tid ? d.turns?.find((t) => t.id === tid) : undefined;
        tidStatus = row?.status ?? null;
      } catch {
        tid = null;
      }
      /* 运行时证据：仅 resume+wait 时僵尸线程持续 409（debug-02b741.log L12–37）。
         恢复每轮重试再 interrupt，以便 monitor 有机会收尾；与刷屏权衡见串行 postTurn。 */
      if (tidStatus === "in_progress" || tidStatus === "queued") {
        await this.interruptLatestTurnBestEffort(id);
      }
      // #region agent log
      agentDbg(
        "runtimeClient.ts:postTurn",
        "409 retry after conditional interrupt",
        {
          threadId: id,
          retryIndex: attempt + 1,
          tid,
          tidStatus,
          didInterrupt: tidStatus === "in_progress" || tidStatus === "queued",
          msSinceEnter: Date.now() - postTurnStartedAt,
        },
        "H9"
      );
      // #endregion
      if (tid) {
        await this.waitUntilTurnTerminal(id, tid, 15_000);
      }
      await delay(450 + attempt * 280);
      res = await post();
      // #region agent log
      void res
        .clone()
        .text()
        .then((txt) =>
          agentDbg(
            "runtimeClient.ts:postTurn",
            "post turns retry response",
            {
              threadId: id,
              retryIndex: attempt + 1,
              status: res.status,
              msSinceEnter: Date.now() - postTurnStartedAt,
              bodyHead: txt.slice(0, 220),
            },
            "H5"
          )
        )
        .catch(() => {});
      // #endregion
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`post turn ${res.status}: ${t}`);
    }
  }

  async resumeSessionThread(
    sessionId: string,
    body: { model?: string; mode?: string }
  ): Promise<{ thread_id: string; session_id: string; message_count: number; summary: string }> {
    const { baseUrl } = getConfig();
    const res = await fetch(
      `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/resume-thread`,
      {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`resume session ${res.status}: ${t}`);
    }
    return (await res.json()) as {
      thread_id: string;
      session_id: string;
      message_count: number;
      summary: string;
    };
  }

  /**
   * Long-lived SSE stream. Caller should abort via AbortSignal when disposing.
   */
  async streamThreadEvents(
    threadId: string,
    sinceSeq: number | undefined,
    onEvent: (env: RuntimeEnvelope) => void,
    signal: AbortSignal
  ): Promise<void> {
    const { baseUrl, authToken } = getConfig();
    const params = new URLSearchParams();
    if (sinceSeq !== undefined && sinceSeq >= 0) {
      params.set("since_seq", String(sinceSeq));
    }
    if (authToken) {
      params.set("token", authToken);
    }
    const qs = params.toString();
    const cleanUrl = `${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/events${qs ? `?${qs}` : ""}`;

    const res = await fetch(cleanUrl, {
      method: "GET",
      headers: headers({ Accept: "text/event-stream" }),
      signal,
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      throw new Error(`events ${res.status}: ${t}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const lines = part.split(/\r?\n/);
        let data = "";
        for (const line of lines) {
          if (line.startsWith("data:")) {
            data += line.slice(5).trimStart() + "\n";
          }
        }
        const trimmed = data.trimEnd();
        if (!trimmed || trimmed === "keepalive") continue;
        try {
          const env = JSON.parse(trimmed) as RuntimeEnvelope;
          if (env && typeof env.event === "string") {
            const sq = Number(env.seq);
            if (Number.isFinite(sq)) {
              env.seq = sq;
            }
            onEvent(env);
          }
        } catch {
          // ignore parse errors for non-JSON lines
        }
      }
    }
  }
}
