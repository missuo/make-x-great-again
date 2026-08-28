// 学到的规则库 —— chrome.storage 持久化 + 内容脚本用的同步内存副本。
//
// 判定必须同步：scoreSignals 在时间线滚动时对每个账号跑，改成异步会让
// 徽标晚于用户视线出现。所以这里维持一份 warm 过的内存副本，靠
// storage.onChanged 跨上下文同步（规则可能由 background 蒸馏产生、由
// 设置页人工改动，两边都不在内容脚本里）。

import {
  DEFAULT_TEMPLATE_THRESHOLDS,
  type LearnedRule,
  type NegativeSample,
  type RuleDraft,
  type TemplateThresholds,
  admit,
  applyOutcome,
  negativeSampleOf,
  retireMatching,
  ruleKey,
  templateDraftFrom,
} from "../../src/baseline/learned.ts";
import { getSamples } from "./training";

const KEY = "xss:learned:v1";

/** 规则总数上限。超出后丢弃最旧的**退役**规则 —— 活跃规则永远保留。 */
const MAX_RULES = 500;

let cache: LearnedRule[] = [];
let warmed = false;

/** 写串行化：background 蒸馏与设置页人工改动可能同时落盘，read-modify-write
 *  交错会丢更新。规则库很小，直接排队最省事也最不容易错。 */
let writeChain: Promise<void> = Promise.resolve();

async function readRaw(): Promise<LearnedRule[]> {
  try {
    const got = await chrome.storage.local.get(KEY);
    const list = got[KEY] as LearnedRule[] | undefined;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function prune(list: LearnedRule[]): LearnedRule[] {
  if (list.length <= MAX_RULES) return list;
  const active = list.filter((r) => r.status !== "retired");
  const retired = list.filter((r) => r.status === "retired");
  return [...active, ...retired.slice(-Math.max(0, MAX_RULES - active.length))];
}

/** 读入内存并订阅变更。内容脚本启动时调一次即可。 */
export async function warmLearned(): Promise<void> {
  cache = await readRaw();
  thresholds = await getThresholds();
  if (!warmed) {
    warmed = true;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes[TH_KEY]) {
          thresholds = {
            ...DEFAULT_TEMPLATE_THRESHOLDS,
            ...((changes[TH_KEY].newValue as Partial<TemplateThresholds>) ?? {}),
          };
        }
        if (!changes[KEY]) return;
        const next = changes[KEY].newValue as LearnedRule[] | undefined;
        cache = Array.isArray(next) ? next : [];
      });
    } catch {
      /* 非扩展上下文（测试）—— 无视 */
    }
  }
}

/** 同步读内存副本。未 warm 时返回空数组 = 不影响判定，符合「宁可漏」。 */
export function learnedRules(): readonly LearnedRule[] {
  return cache;
}

/** 通过读-改-写更新规则库，写入串行化。 */
function mutate(fn: (list: LearnedRule[]) => LearnedRule[]): Promise<LearnedRule[]> {
  const run = writeChain.then(async () => {
    const current = await readRaw();
    const next = prune(fn(current));
    try {
      await chrome.storage.local.set({ [KEY]: next });
    } catch {
      /* 存储不可用 —— 非致命 */
    }
    cache = next;
    return next;
  });
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function getRules(): Promise<LearnedRule[]> {
  return readRaw();
}

/**
 * 准入体检用的负样本文本。
 *
 * 只用用户亲手标为 legit 的样本 —— 那是**他本人**对「这是正常账号」的
 * 判断，是这套体系里唯一可信的负标签。公开白名单只有 userId / handle，
 * 没有昵称简介，回扫时打不到任何文本规则，收进来也没用。
 */
export async function negativeCorpus(): Promise<NegativeSample[]> {
  const samples = await getSamples();
  return samples.filter((s) => s.label === "legit").map((s) => negativeSampleOf(s));
}

// ── 模板阈值 ──────────────────────────────────────────────────────
//
// 判定是同步的，所以阈值也要有一份内存副本，和规则库同样靠 onChanged 同步。

const TH_KEY = "xss:learned:thresholds:v1";
let thresholds: TemplateThresholds = { ...DEFAULT_TEMPLATE_THRESHOLDS };

export function templateThresholds(): TemplateThresholds {
  return thresholds;
}

export async function getThresholds(): Promise<TemplateThresholds> {
  try {
    const got = await chrome.storage.local.get(TH_KEY);
    return {
      ...DEFAULT_TEMPLATE_THRESHOLDS,
      ...((got[TH_KEY] as Partial<TemplateThresholds>) ?? {}),
    };
  } catch {
    return { ...DEFAULT_TEMPLATE_THRESHOLDS };
  }
}

export async function setThresholds(
  patch: Partial<TemplateThresholds>,
): Promise<TemplateThresholds> {
  const next = { ...(await getThresholds()), ...patch };
  try {
    await chrome.storage.local.set({ [TH_KEY]: next });
  } catch {
    /* 非致命 */
  }
  thresholds = next;
  return next;
}

let seq = 0;
function newId(now: number): string {
  seq = (seq + 1) % 1000;
  return `r${now.toString(36)}${seq.toString(36)}`;
}

export interface AdmitReport {
  added: LearnedRule[];
  rejected: { terms: string[]; reason: string }[];
}

/**
 * 把蒸馏出来的候选过一遍体检并入库。
 *
 * 被拒的也如实回报 —— 面板上要能看到「学了什么、又为什么没学」。一个
 * 只显示成功的学习系统，出问题时完全无法排查。
 */
export async function addDrafts(
  drafts: RuleDraft[],
  origin: LearnedRule["origin"] = "distill",
): Promise<AdmitReport> {
  if (!drafts.length) return { added: [], rejected: [] };
  const negatives = await negativeCorpus();
  const th = await getThresholds();
  const report: AdmitReport = { added: [], rejected: [] };
  await mutate((current) => {
    const next = [...current];
    const now = Date.now();
    for (const d of drafts) {
      const verdict = admit(d, { negatives, existing: next, thresholds: th });
      if (!verdict.ok) {
        report.rejected.push({ terms: d.terms, reason: verdict.reason });
        continue;
      }
      const rule: LearnedRule = {
        id: newId(now),
        kind: verdict.draft.kind,
        field: verdict.draft.field,
        terms: verdict.draft.terms,
        cat: verdict.draft.cat,
        // 模板是用户亲手拉黑的那条原文本身，不是 AI 的推断 —— 证据等级
        // 不同，起始层级也不同。相似度阈值是它的安全边际，取代了 phrase
        // 规则靠 8 次确认才换来的那份把握。
        status: verdict.draft.kind === "template" ? "trusted" : "candidate",
        why: verdict.draft.why,
        hits: [],
        confirms: 0,
        rejects: 0,
        origin,
        createdAt: now,
        updatedAt: now,
      };
      next.push(rule);
      report.added.push(rule);
    }
    return next;
  });
  return report;
}

/** 记一次实战结果（候选规则命中后大模型给出了判定）。 */
export async function recordOutcome(
  ruleId: string,
  accountId: string,
  outcome: "spam" | "legit",
  reason?: string,
): Promise<LearnedRule | null> {
  let updated: LearnedRule | null = null;
  await mutate((current) =>
    current.map((r) => {
      if (r.id !== ruleId) return r;
      updated = applyOutcome(r, accountId, outcome, Date.now(), reason);
      return updated;
    }),
  );
  return updated;
}

/**
 * 新负样本入库 → 回扫全部规则，退役一切会打中它的。
 *
 * 用户纠错一次，拔掉的是一整类误判源头，而不是一个账号的处理结果。
 */
export async function retireByNegative(sample: {
  displayName?: string;
  bio?: string;
  recentTweets?: string[];
}): Promise<LearnedRule[]> {
  const neg = negativeSampleOf(sample);
  if (!neg.text && !neg.strippedTweets.length) return [];
  const th = await getThresholds();
  let retired: LearnedRule[] = [];
  await mutate((current) => {
    const out = retireMatching(current, neg, Date.now(), th);
    retired = out.retired;
    return out.rules;
  });
  return retired;
}

/**
 * 手动拉黑时把那条推文原文留存为模板规则。
 *
 * 与蒸馏并行、互不依赖：蒸馏要联网、要模型配合、还可能一条签名都给不出；
 * 这一路是纯本地计算，只要用户按了拉黑就一定留下证据。用户的原话是
 * 「如果没有关键词可以抓得出来的话，把这一条完整的文字存到 JSON 里」。
 */
export async function captureTemplate(
  tweet: string | undefined,
  cat: LearnedRule["cat"] = "porn",
): Promise<AdmitReport> {
  if (!tweet) return { added: [], rejected: [] };
  return addDrafts([templateDraftFrom(tweet, cat)], "manual");
}

export async function setStatus(
  ruleId: string,
  status: LearnedRule["status"],
  why?: string,
): Promise<void> {
  await mutate((current) =>
    current.map((r) =>
      r.id === ruleId
        ? {
            ...r,
            status,
            updatedAt: Date.now(),
            ...(status === "retired" ? { retiredReason: why ?? "维护者手动停用" } : {}),
          }
        : r,
    ),
  );
}

export async function removeRule(ruleId: string): Promise<void> {
  await mutate((current) => current.filter((r) => r.id !== ruleId));
}

/** 人工新增一条规则。仍然走完整体检 —— 手写也可能写出过泛的词。 */
export async function addManual(draft: RuleDraft): Promise<AdmitReport> {
  return addDrafts([draft], "manual");
}

export async function exportRules(): Promise<string> {
  return JSON.stringify(await readRaw(), null, 2);
}

/** 导入。按结构指纹去重，已存在的跳过（不覆盖本机战绩）。 */
export async function importRules(json: string): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("不是合法的 JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("应当是一个规则数组");
  let n = 0;
  await mutate((current) => {
    const seen = new Set(current.map(ruleKey));
    const next = [...current];
    for (const raw of parsed as LearnedRule[]) {
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.terms)) continue;
      const key = ruleKey(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ ...raw, id: newId(Date.now()) });
      n++;
    }
    return next;
  });
  return n;
}

// ── 蒸馏日志 ──────────────────────────────────────────────────────
//
// 每一次蒸馏都留痕，无论成败。
//
// 为什么必须有：蒸馏跑在 service worker 里，它的 console 不是用户会去看的
// 地方；而「没学到规则」在外部看来完全一样的四种情况 —— 没配 AI、模型没
// 返回签名、签名被体检拒了、网络挂了 —— 需要完全不同的处理。没有这份日志
// 时用户只能看到沉默，我自己排查也只能靠猜。

const LOG_KEY = "xss:learned:log:v1";
const MAX_LOG = 30;

export type DistillStatus = "added" | "no_signatures" | "all_rejected" | "not_configured" | "error";

export interface DistillLogEntry {
  ts: number;
  handle: string;
  displayName: string;
  /** 送进模型的证据文本（截断），用来回答「它到底看到了什么」。 */
  sample: string;
  status: DistillStatus;
  /** 新增规则的可读描述。 */
  added: string[];
  rejected: { terms: string[]; reason: string }[];
  error?: string;
}

export async function appendDistillLog(entry: DistillLogEntry): Promise<void> {
  try {
    const got = await chrome.storage.local.get(LOG_KEY);
    const list = (got[LOG_KEY] as DistillLogEntry[] | undefined) ?? [];
    await chrome.storage.local.set({ [LOG_KEY]: [...list, entry].slice(-MAX_LOG) });
  } catch {
    /* 非致命 */
  }
}

export async function getDistillLog(): Promise<DistillLogEntry[]> {
  try {
    const got = await chrome.storage.local.get(LOG_KEY);
    const list = (got[LOG_KEY] as DistillLogEntry[] | undefined) ?? [];
    return [...list].reverse();
  } catch {
    return [];
  }
}

export async function clearDistillLog(): Promise<void> {
  try {
    await chrome.storage.local.remove(LOG_KEY);
  } catch {
    /* 非致命 */
  }
}

export interface LearnedStats {
  candidate: number;
  trusted: number;
  retired: number;
}

export async function learnedStats(): Promise<LearnedStats> {
  const list = await readRaw();
  return {
    candidate: list.filter((r) => r.status === "candidate").length,
    trusted: list.filter((r) => r.status === "trusted").length,
    retired: list.filter((r) => r.status === "retired").length,
  };
}
