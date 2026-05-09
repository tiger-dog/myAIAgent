import * as assert from "node:assert/strict";
import { test } from "node:test";
import { resolveThreadEventsSinceSeq } from "./sseSinceSeq";

test("首次连接：尚无持久化游标时用 since_seq=0", () => {
  assert.equal(resolveThreadEventsSinceSeq({ sseInitialConnect: true, lastSeq: 0 }), 0);
});

test("首次连接：已用 latest_seq 对齐时用 lastSeq 作游标", () => {
  assert.equal(resolveThreadEventsSinceSeq({ sseInitialConnect: true, lastSeq: 99 }), 99);
});

test("重连使用 lastSeq", () => {
  assert.equal(resolveThreadEventsSinceSeq({ sseInitialConnect: false, lastSeq: 42 }), 42);
});

test("重连且尚无事件时不传 since（undefined）", () => {
  assert.equal(resolveThreadEventsSinceSeq({ sseInitialConnect: false, lastSeq: 0 }), undefined);
});
