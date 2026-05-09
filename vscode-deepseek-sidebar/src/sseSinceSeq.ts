/** 线程 SSE /events 的 since_seq 计算（与 extension 中 startSse 一致） */

export function resolveThreadEventsSinceSeq(params: {
  sseInitialConnect: boolean;
  lastSeq: number;
}): number | undefined {
  const { sseInitialConnect, lastSeq } = params;
  const safe = Number.isFinite(lastSeq) ? lastSeq : 0;
  if (sseInitialConnect) {
    if (safe > 0) return Math.floor(safe);
    return 0;
  }
  if (safe > 0) return Math.floor(safe);
  return undefined;
}
