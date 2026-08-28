// 大模型客户端 —— 只在 background service worker 里运行。
//
// 为什么不在内容脚本里调：x.com 的 CSP 会挡掉跨源 fetch；background 用的是
// 扩展自己的源。这也是 report / 白名单申请一直走的路径。
//
// 配置存在 chrome.storage.local，由设置页维护（早期版本从构建期 .env 注入，
// 改一次要重新构建整个扩展）。.env 里的值降级为首次安装时的默认种子。
//
// ⚠️ Key 存在本机 storage 里，任何能打开扩展的人都读得到。这对「本地自用」
// 是可接受的取舍；要公开分发就必须把这一层挪到服务端。

import {
  CONSOLIDATE_SYSTEM_PROMPT,
  type ConsolidateProposal,
  DISTILL_SYSTEM_PROMPT,
  type DistillInput,
  type ParsedSignature,
  buildConsolidatePrompt,
  buildDistillPrompt,
  parseProposal,
  parseSignatures,
} from "../../src/baseline/distill.ts";
import type { LearnedRule } from "../../src/baseline/learned.ts";
import {
  type ParsedVerdict,
  SYSTEM_PROMPT,
  buildUserPrompt,
  extractVerdictJson,
  parseVerdict,
} from "../../src/baseline/prompt.ts";
import type { Signals } from "./types";

export interface LlmConfig {
  base: string;
  key: string;
  model: string;
  enabled: boolean;
}

const KEY = "xss:llm:v1";

/** 构建期种子（extension/.env 的 WXT_LLM_*）。只在存储里还没有配置时生效。 */
function envSeed(): Partial<LlmConfig> {
  const base = import.meta.env.WXT_LLM_BASE;
  const key = import.meta.env.WXT_LLM_KEY;
  const model = import.meta.env.WXT_LLM_MODEL;
  return {
    ...(base ? { base } : {}),
    ...(key ? { key } : {}),
    ...(model ? { model } : {}),
  };
}

export const LLM_DEFAULTS: LlmConfig = { base: "", key: "", model: "", enabled: true };

export async function getLlmConfig(): Promise<LlmConfig> {
  let stored: Partial<LlmConfig> = {};
  try {
    const got = await chrome.storage.local.get(KEY);
    stored = (got[KEY] as Partial<LlmConfig>) ?? {};
  } catch {
    /* 存储不可用 —— 退回种子 */
  }
  const merged = { ...LLM_DEFAULTS, ...envSeed(), ...stored };
  return { ...merged, base: merged.base.replace(/\/+$/, "") };
}

export async function setLlmConfig(patch: Partial<LlmConfig>): Promise<LlmConfig> {
  const next = { ...(await getLlmConfig()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** 三项齐全且未被关掉才算可用。半配置状态下静默走空路径比直接报错更难排查。 */
export async function llmEnabled(): Promise<boolean> {
  const c = await getLlmConfig();
  return c.enabled && !!c.base && !!c.key && !!c.model;
}

const CHAT_TIMEOUT_MS = 30_000;
const CHAT_MAX_ATTEMPTS = 3;

const backoff = (attempt: number) => new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));

interface ChatResponse {
  choices: { message: { content: string } }[];
}

interface ChatOpts {
  maxTokens?: number;
}

async function chat(
  cfg: LlmConfig,
  messages: { role: string; content: string }[],
  opts: ChatOpts = {},
): Promise<ChatResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await backoff(attempt - 1);
    let res: Response;
    try {
      res = await fetch(`${cfg.base}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: opts.maxTokens ?? 600,
          messages,
        }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = err; // 网络错误 / 超时 —— 可重试
      continue;
    }
    if (res.ok) return (await res.json()) as ChatResponse;
    const detail = `LLM HTTP ${res.status}`;
    if (res.status !== 429 && res.status < 500) throw new Error(detail);
    lastErr = new Error(detail);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * 并发闸门。一屏时间线可能同时冒出几十个待判账号，不限流就会同时打出
 * 几十个请求 —— 既烧钱又必然撞上 429。串行化到少量并发，排队等待即可，
 * 判定本来就是异步渲染的。
 */
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

/** 带一次自纠重试的对话。JSON 不合法时把原样回复贴回去让模型自己改。 */
async function chatJson<T>(
  cfg: LlmConfig,
  system: string,
  user: string,
  parse: (raw: unknown) => T,
  opts: ChatOpts = {},
): Promise<T> {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  await acquire();
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await chat(cfg, messages, opts);
      const content = resp.choices[0]?.message?.content ?? "";
      try {
        return parse(extractVerdictJson(content));
      } catch (err) {
        lastErr = err;
        messages.push(
          { role: "assistant", content },
          {
            role: "user",
            content:
              "That was not valid. Reply with ONLY the JSON object in the exact required shape.",
          },
        );
      }
    }
    throw new Error(`模型未返回合法输出: ${String(lastErr)}`);
  } finally {
    release();
  }
}

/** 一次账号判定。 */
export async function classify(sig: Signals): Promise<ParsedVerdict> {
  const cfg = await getLlmConfig();
  if (!cfg.base || !cfg.key || !cfg.model) throw new Error("LLM 未配置");
  return chatJson(
    cfg,
    SYSTEM_PROMPT,
    buildUserPrompt({
      userId: sig.userId,
      handle: sig.handle,
      displayName: sig.displayName,
      bio: sig.bio,
      recentTweets: sig.recentTweets,
      triggeringComment: sig.triggeringComment,
      threadTopic: sig.threadTopic,
      accountAgeDays: sig.accountAgeDays,
      followersCount: sig.followersCount,
      followingCount: sig.followingCount,
      hasDefaultAvatar: sig.hasDefaultAvatar,
    }),
    parseVerdict,
  );
}

/** 从一个已确认的垃圾账号里蒸馏可复用签名。 */
export async function distill(input: DistillInput): Promise<ParsedSignature[]> {
  const cfg = await getLlmConfig();
  if (!cfg.base || !cfg.key || !cfg.model) throw new Error("LLM 未配置");
  return chatJson(cfg, DISTILL_SYSTEM_PROMPT, buildDistillPrompt(input), parseSignatures, {
    maxTokens: 800,
  });
}

/** 让模型通审整个规则库，产出**提案**（绝不自动生效）。 */
export async function consolidate(
  rules: readonly LearnedRule[],
  negatives: readonly string[],
): Promise<ConsolidateProposal> {
  const cfg = await getLlmConfig();
  if (!cfg.base || !cfg.key || !cfg.model) throw new Error("LLM 未配置");
  const ids = new Set(rules.map((r) => r.id));
  return chatJson(
    cfg,
    CONSOLIDATE_SYSTEM_PROMPT,
    buildConsolidatePrompt({ rules, negatives }),
    (raw) => parseProposal(raw, ids),
    { maxTokens: 2000 },
  );
}

/** 设置页的「测试连接」：拿一个固定的良性样本走完整判定链路。 */
export async function testConnection(): Promise<{ ms: number; label: string }> {
  const t0 = Date.now();
  const v = await classify({
    isProfile: false,
    handle: "jack",
    displayName: "Jack",
    bio: "bitcoin",
    hasDefaultAvatar: false,
    recentTweets: ["just setting up my twttr"],
    accountAgeDays: 6000,
  });
  return { ms: Date.now() - t0, label: v.label };
}
