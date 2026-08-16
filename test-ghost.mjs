// test-ghost.mjs — 幽灵会话修复（归档集斗篷语义）单测。
// 场景：rc.6 无内存驱逐原语，删除后内存条目残留 + detachSession 踢出工作区
// → 前端 Ungrouped 桶渲染幽灵。修复：删除后把会话加入归档集（隐藏），
// 重启后 existing 不再含它，下次删除清扫收走。
import test from "node:test";
import assert from "node:assert/strict";
import { nextArchivedSet } from "./index.js";

const ID = "session-ghost-0001";

test("斗篷：被删会话仍在内存 → 加入归档集（立即隐形）", () => {
  const next = nextArchivedSet([], ID, new Set([ID, "session-a"]));
  assert.deepEqual(next, [ID]);
});

test("斗篷幂等：已在归档集的归档会话被删 → 不重复追加", () => {
  const next = nextArchivedSet([ID], ID, new Set([ID]));
  assert.deepEqual(next, [ID]);
});

test("清扫：重启后 existing 不含被删 id → 斗篷自然收走", () => {
  const next = nextArchivedSet([ID], "session-other", new Set(["session-a"]));
  assert.deepEqual(next, []);
});

test("清扫孤儿：内存+磁盘都不存在的历史残渣被顺带清掉", () => {
  const next = nextArchivedSet(
    ["session-orphan-1", "session-orphan-2", "session-alive"],
    "session-other",
    new Set(["session-alive"]),
  );
  assert.deepEqual(next, ["session-alive"]);
});

test("官方未来版本：persistence.remove 生效 → existing 不含被删 id，不加斗篷", () => {
  const next2 = nextArchivedSet(["session-archived-old"], ID, new Set(["session-a"]));
  assert.equal(next2.includes(ID), false);
});

test("边界：currentArchived null/undefined 按空集处理", () => {
  assert.deepEqual(nextArchivedSet(null, ID, new Set([ID])), [ID]);
  assert.deepEqual(nextArchivedSet(undefined, "x", new Set(["y"])), []);
});

test("边界：existingIds 接受数组与 null", () => {
  assert.deepEqual(nextArchivedSet([ID], ID, [ID]), [ID]);
  assert.deepEqual(nextArchivedSet([ID], ID, null), []);
});