import assert from "node:assert/strict";
import { test } from "node:test";
import { autoEligible } from "../lib/auto-policy";

// 2026-08-12：公榜与官方关键词规则两条来源整个移除后，这里只剩两个来源，
// 分级门禁（autoScope / autoTierMode）随之删掉 —— 它们唯一约束的对象就是
// 那两条来源。测试跟着收窄到「谁能自动处理」这一个问题。

test("baseline 与大模型判定可自动处理", () => {
  assert.equal(autoEligible({ source: "baseline" }), true);
  assert.equal(autoEligible({ source: "llm" }), true);
});

test("缓存与中性判定永不自动处理", () => {
  // 缓存里可能躺着 v0.4 时代由公榜写入的判定，那正是已确认的误杀来源；
  // fresh 表示还没有任何判定依据。两者都不该驱动不可逆动作。
  assert.equal(autoEligible({ source: "cache" }), false);
  assert.equal(autoEligible({ source: "fresh" }), false);
});
