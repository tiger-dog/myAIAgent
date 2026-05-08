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
    let res = await fetch(url, { method: "POST", headers: headers() });
    if (res.ok) return;
    await fetch(`${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/resume`, {
      method: "POST",
      headers: headers(),
    });
    await delay(200);
    res = await fetch(url, { method: "POST", headers: headers() });
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
    await this.interruptTurn(threadId, latestId);
    await delay(400);
  }

  async postTurn(id: string, prompt: string): Promise<void> {
    const { baseUrl } = getConfig();
    const url = `${baseUrl}/v1/threads/${encodeURIComponent(id)}/turns`;
    const body = JSON.stringify({ prompt });

    await this.clearPersistedBlockingTurn(id);

    const post = () =>
      fetch(url, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body,
      });

    let res = await post();
    for (let attempt = 0; res.status === 409 && attempt < 2; attempt++) {
      await this.interruptLatestTurnBestEffort(id);
      await delay(attempt === 0 ? 400 : 700);
      res = await post();
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
          if (typeof env.seq === "number") {
            onEvent(env);
          }
        } catch {
          // ignore parse errors for non-JSON lines
        }
      }
    }
  }
}
