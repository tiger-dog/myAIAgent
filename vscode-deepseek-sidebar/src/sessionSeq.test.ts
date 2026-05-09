import * as assert from "node:assert/strict";
import { test } from "node:test";
import { mergeEventSeq, mergeLatestSeq } from "./sessionSeq";

test("mergeEventSeq：正常递增", () => {
  assert.equal(mergeEventSeq(0, 1), 1);
  assert.equal(mergeEventSeq(5, 12), 12);
});

test("mergeEventSeq：忽略非法 seq", () => {
  assert.equal(mergeEventSeq(7, undefined), 7);
  assert.equal(mergeEventSeq(7, NaN), 7);
  assert.equal(mergeEventSeq(7, "x"), 7);
  assert.equal(mergeEventSeq(7, 0), 7);
  assert.equal(mergeEventSeq(7, -1), 7);
});

test("mergeEventSeq：current 为 NaN 时回退为 0 再合并", () => {
  assert.equal(mergeEventSeq(NaN, 3), 3);
});

test("mergeEventSeq：字符串数字", () => {
  assert.equal(mergeEventSeq(0, "42"), 42);
});

test("mergeLatestSeq：对齐 latest_seq", () => {
  assert.equal(mergeLatestSeq(0, 100), 100);
  assert.equal(mergeLatestSeq(50, 100), 100);
});

test("mergeLatestSeq：非法则保持", () => {
  assert.equal(mergeLatestSeq(8, undefined), 8);
  assert.equal(mergeLatestSeq(8, 0), 8);
});
