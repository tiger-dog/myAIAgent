import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  coalesceDelta,
  isToolStreamKind,
  resolveFinishedText,
  resolveItemIdFromEnv,
} from "./sseEnvelopeUtils";

test("resolveItemIdFromEnv：信封 item_id 优先", () => {
  assert.equal(
    resolveItemIdFromEnv({ item_id: "a" }, { item_id: "b", item: { id: "c" } }, undefined),
    "a"
  );
});

test("resolveItemIdFromEnv：回退到 payload.item_id", () => {
  assert.equal(resolveItemIdFromEnv({}, { item_id: "x", item: { id: "y" } }, undefined), "x");
});

test("resolveItemIdFromEnv：回退到 payload.item.id", () => {
  assert.equal(resolveItemIdFromEnv({}, { item: { id: "z" } }, undefined), "z");
});

test("resolveItemIdFromEnv：显式传入的 item 覆盖 payload.item", () => {
  assert.equal(resolveItemIdFromEnv({}, { item: { id: "old" } }, { id: "new" }), "new");
});

test("coalesceDelta：认 text / output / stdout", () => {
  assert.equal(coalesceDelta({ text: "hello" }), "hello");
  assert.equal(coalesceDelta({ output: "out" }), "out");
  assert.equal(coalesceDelta({ stdout: "1\n2" }), "1\n2");
  assert.equal(coalesceDelta({ delta: "d", text: "t" }), "d");
});

test("coalesceDelta：对象会 JSON 化", () => {
  assert.equal(coalesceDelta({ output: { code: 1 } }).includes('"code"'), true);
});

test("resolveFinishedText：item 与 payload 多路径", () => {
  assert.equal(resolveFinishedText({}, { detail: "D" }), "D");
  assert.equal(resolveFinishedText({ output: "O" }, {}), "O");
  assert.equal(resolveFinishedText({ tool: { output: "T" } }, {}), "T");
});

test("isToolStreamKind", () => {
  assert.equal(isToolStreamKind("tool_call"), true);
  assert.equal(isToolStreamKind("exec_shell"), false);
});
