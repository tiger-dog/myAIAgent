import * as vscode from "vscode";

export interface OpenThreadMeta {
  threadId: string;
  title?: string;
  lastSeq: number;
}

const KEY_OPEN_THREADS = "deepseek.openThreads";

export function loadOpenThreads(ctx: vscode.ExtensionContext): OpenThreadMeta[] {
  const raw = ctx.workspaceState.get<OpenThreadMeta[]>(KEY_OPEN_THREADS);
  return Array.isArray(raw) ? raw : [];
}

export async function saveOpenThreads(
  ctx: vscode.ExtensionContext,
  threads: OpenThreadMeta[]
): Promise<void> {
  await ctx.workspaceState.update(KEY_OPEN_THREADS, threads);
}

export function upsertOpenThread(
  list: OpenThreadMeta[],
  threadId: string,
  patch: Partial<Pick<OpenThreadMeta, "title" | "lastSeq">>
): OpenThreadMeta[] {
  const i = list.findIndex((t) => t.threadId === threadId);
  if (i === -1) {
    list = [...list, { threadId, lastSeq: 0, ...patch }];
    return list;
  }
  const next = [...list];
  next[i] = { ...next[i], ...patch };
  return next;
}

export function removeOpenThread(list: OpenThreadMeta[], threadId: string): OpenThreadMeta[] {
  return list.filter((t) => t.threadId !== threadId);
}
