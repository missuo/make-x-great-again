// 本地 baseline 判定 —— 扩展自己的判定层，不依赖任何远端名单。
//
// 模型（data/baseline/model.json）随扩展打包，判定全在本地完成：不上传、
// 不查询、离线可用。它取代「先下载 20 万条公榜再逐条比对」的旧路径 ——
// 那份公榜里有 27.7% 的条目是泛化词单独命中产生的，正是误杀来源。
//
// 判定只有三种结果：
//   ban  —— 结构性高精度命中，直接执行动作
//   llm  —— 有信号但不足以定罪，交给大模型
//   pass —— 不表态，彻底放行
//
// 「宁可漏，不可误杀」：pass 掉的账号可以靠上报补回来，误杀是不可逆的。

import modelJson from "../../data/baseline/model.json";
import { describeRule, matchLearned } from "../../src/baseline/learned.ts";
import {
  type BaselineModel,
  type ScoreInput,
  type ScoreResult,
  score,
} from "../../src/baseline/score.ts";
import { learnedRules, templateThresholds } from "./learned-store";
import type { Signals } from "./types";

const model = modelJson as unknown as BaselineModel;

export type { ScoreResult };

/** baseline 结果 + 命中的学习规则（若有）。规则 id 要回传，命中的实战
 *  结果才能记到那条规则头上 —— 没有这个回路，规则永远无法晋升或退役。 */
export interface LocalVerdict extends ScoreResult {
  learnedRuleId?: string;
}

/** 模型规模，用于设置页展示「本地模型已加载」。 */
export function baselineStats(): { clusters: number; phrases: number; generatedAt: number } {
  return {
    clusters: model.clusters.length,
    phrases: model.autoban.length,
    generatedAt: model.generatedAt,
  };
}

function toInput(s: Signals): ScoreInput {
  return {
    handle: s.handle,
    displayName: s.displayName,
    bio: s.bio,
    recentTweets: s.recentTweets,
    ...(s.triggeringComment ? { triggeringComment: s.triggeringComment } : {}),
    ...(s.tweetsTranslated ? { tweetsTranslated: true } : {}),
    ...(s.accountAgeDays !== undefined ? { accountAgeDays: s.accountAgeDays } : {}),
    hasDefaultAvatar: s.hasDefaultAvatar,
  };
}

/**
 * 对一个账号跑本地判定：打包模型 + 学到的规则。纯计算，无 IO。
 *
 * 顺序是刻意的：打包模型先说话。它的定罪路径经过离线语料统计与人工签字，
 * 是这里最可靠的一层；学到的规则只在它不表态时补位。
 *
 * 学习层的两级映射就是整套自学习安全性的落点：
 *   trusted   → ban   已经用 ≥8 个账号的实战证明过自己
 *   candidate → llm   **只提级到送审**，学错的代价是一次 API 调用
 * 所以新学到的规则再离谱也造不成误杀，最多是白花钱 —— 这是设计，不是巧合。
 */
export function scoreSignals(s: Signals): LocalVerdict {
  const input = toInput(s);
  const base = score(input, model);
  if (base.decision === "ban") return base;

  const hit = matchLearned(input, learnedRules(), templateThresholds());
  if (!hit) return base;

  const desc = describeRule(hit.rule);
  const simPct = hit.sim === undefined ? "" : `（相似度 ${(hit.sim * 100).toFixed(0)}%）`;
  if (hit.decision === "ban") {
    const evidence =
      hit.rule.kind === "template"
        ? `${desc}${simPct}`
        : `${desc}（已验证 ${hit.rule.hits.length} 个账号）`;
    return {
      decision: "ban",
      score: 100,
      category: hit.rule.cat,
      reasons: [`学习规则命中：${evidence}`],
      learnedRuleId: hit.rule.id,
    };
  }
  return {
    ...base,
    decision: "llm",
    score: Math.max(base.score, 2),
    category: base.category === "other" ? hit.rule.cat : base.category,
    reasons: [`学习规则命中，交大模型复核：${desc}${simPct}`, ...base.reasons],
    learnedRuleId: hit.rule.id,
  };
}
