/** Webview 与上游 SSE 对齐的纯函数（chatHtml 内嵌脚本需保持行为一致） */

export type RuntimeEnvLike = {
  item_id?: string | null;
};

export type ItemLike = {
  id?: string | null;
  detail?: unknown;
  summary?: unknown;
  output?: unknown;
  result?: unknown;
};

export type PayloadLike = Record<string, unknown> & {
  item?: ItemLike | null;
  item_id?: string | null;
  id?: string | null;
  tool?: { output?: unknown };
};

export function resolveItemIdFromEnv(
  env: RuntimeEnvLike,
  payload: PayloadLike | null | undefined,
  itemFromPayload: ItemLike | null | undefined
): string {
  const p = payload || {};
  const it = itemFromPayload !== undefined ? itemFromPayload : p.item;
  const raw = env.item_id ?? p.item_id ?? (it && it.id) ?? p.id;
  return raw != null && raw !== "" ? String(raw) : "";
}

export function stringifyPayloadPart(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** item.delta 的文本可能在 delta / text / chunk / output 等字段 */
export function coalesceDelta(payload: PayloadLike | null | undefined): string {
  const p = payload || {};
  const keys = ["delta", "text", "chunk", "output", "stdout", "stderr", "content"] as const;
  for (const k of keys) {
    const v = p[k];
    if (v != null && v !== "") {
      const s = stringifyPayloadPart(v);
      if (s) return s;
    }
  }
  return "";
}

export function resolveFinishedText(
  payload: PayloadLike | null | undefined,
  item: ItemLike | null | undefined
): string {
  const p = payload || {};
  const it = item || {};
  const direct = it.detail ?? it.summary ?? it.output ?? it.result;
  if (direct != null && String(direct).length) return stringifyPayloadPart(direct);
  const fall = p.output ?? p.result ?? p.text ?? p.delta;
  if (fall != null && String(fall).length) return stringifyPayloadPart(fall);
  const tool = p.tool || {};
  if (tool.output != null) return stringifyPayloadPart(tool.output);
  return "";
}

export function isToolStreamKind(kind: string): boolean {
  return kind === "tool_call" || kind === "file_change" || kind === "command_execution";
}
