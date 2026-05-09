/**
 * 合并 SSE 信封 seq 到 lastSeq（避免 undefined/非数字把游标弄成 NaN）。
 */
export function mergeEventSeq(currentLastSeq: number, envSeq: unknown): number {
  const seq = Number(envSeq);
  if (!Number.isFinite(seq) || seq <= 0) {
    return Number.isFinite(currentLastSeq) ? currentLastSeq : 0;
  }
  const cur = Number.isFinite(currentLastSeq) ? currentLastSeq : 0;
  return Math.max(cur, Math.floor(seq));
}

/** 用线程详情里的 latest_seq 对齐游标 */
export function mergeLatestSeq(currentLastSeq: number, latestSeq: unknown): number {
  const latest = Number(latestSeq);
  if (!Number.isFinite(latest) || latest <= 0) {
    return Number.isFinite(currentLastSeq) ? currentLastSeq : 0;
  }
  const cur = Number.isFinite(currentLastSeq) ? currentLastSeq : 0;
  return Math.max(cur, Math.floor(latest));
}

/**
 * `latest_seq` 必须是**本线程**事件的最大 seq。若持久化里误用了更大的全局游标，
 * SSE 会用过大的 `since_seq` 漏掉本线程 backlog。将客户端游标钳到线程上限。
 */
export function clampSeqToThreadMax(clientSeq: number, threadLatestSeq: unknown): number {
  const cap = Number(threadLatestSeq);
  const cur = Number.isFinite(clientSeq) ? Math.floor(clientSeq) : 0;
  if (!Number.isFinite(cap) || cap < 0) return cur;
  const c = Math.floor(cap);
  if (cur > c) return c;
  return cur;
}
