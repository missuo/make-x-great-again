// 人工标注样本库 —— 用户每一次亲手判断都留档，供后续训练。
//
// 为什么这件事重要：baseline 目前只能做「模板成员判定」，做不了真正的
// 判别式分类，唯一的原因就是**没有负样本**（公开白名单只有 2023 条且不含
// display_name）。而用户的操作恰好同时产出两类标签：
//
//   手动拉黑 / 静音 / 隐藏  → 正样本（人已 review 过，确定有问题）
//   处理记录里点「恢复显示」 → 负样本（人已 review 过，确定是误判）
//
// 负样本是这套体系里最稀缺的资源。一条都不能丢。
//
// 存的是**完整特征快照**，不是只有 handle：训练需要的是判定时看到的东西
// （昵称、简介、近期推文、账号年龄、粉丝数、头像状态）。只存 handle 的话，
// 等到要训练时特征已经无从还原 —— 账号可能改名、删推、甚至已被封。

import type { Signals } from "./types";

const KEY = "xss:training:v1";
/** 上限。超出后丢弃最旧的 —— 但负样本永远优先保留（见 trim）。 */
const MAX_SAMPLES = 5000;

export type SampleLabel = "spam" | "legit";

export interface TrainingSample {
  /** userId，或 h:<handle> 兜底。用于去重与后续覆盖。 */
  id: string;
  label: SampleLabel;
  /** 判定时刻的完整特征快照 —— 训练要用的就是这些。 */
  handle: string;
  displayName: string;
  bio: string;
  recentTweets: string[];
  triggeringComment?: string;
  accountAgeDays?: number;
  followersCount?: number;
  followingCount?: number;
  hasDefaultAvatar: boolean;
  /** 这条标注是怎么来的 —— 训练时可据此加权（人工确认 > 自动处理未纠错）。 */
  origin: "manual" | "restore" | "auto";
  /** 自动处理当时给出的理由，用于事后复核「模型当初凭什么」。 */
  modelReason?: string;
  ts: number;
}

async function read(): Promise<TrainingSample[]> {
  try {
    const got = await chrome.storage.local.get(KEY);
    return (got[KEY] as TrainingSample[]) ?? [];
  } catch {
    return [];
  }
}

/**
 * 超限裁剪。负样本优先保留：正样本随时能再攒（垃圾号源源不断），负样本
 * 只有用户亲手纠错时才产生，是不可再生资源。
 */
function trim(list: TrainingSample[]): TrainingSample[] {
  if (list.length <= MAX_SAMPLES) return list;
  const negatives = list.filter((s) => s.label === "legit");
  const positives = list.filter((s) => s.label === "spam");
  const keepPositives = Math.max(0, MAX_SAMPLES - negatives.length);
  return [...negatives, ...positives.slice(-keepPositives)].sort((a, b) => a.ts - b.ts);
}

/**
 * 记一条标注。同一账号重复标注时**后写覆盖**：用户先拉黑、后又恢复，
 * 说明最终判断是「误判」，样本必须翻成负样本 —— 留着旧的正样本会把一次
 * 明确的纠错变成训练集里的自相矛盾。
 */
export async function recordSample(
  sig: Signals,
  label: SampleLabel,
  origin: TrainingSample["origin"],
  modelReason?: string,
): Promise<void> {
  const id = sig.userId || `h:${sig.handle}`;
  const sample: TrainingSample = {
    id,
    label,
    handle: sig.handle,
    displayName: sig.displayName,
    bio: sig.bio,
    recentTweets: sig.recentTweets.slice(0, 10),
    ...(sig.triggeringComment ? { triggeringComment: sig.triggeringComment } : {}),
    ...(sig.accountAgeDays !== undefined ? { accountAgeDays: sig.accountAgeDays } : {}),
    ...(sig.followersCount !== undefined ? { followersCount: sig.followersCount } : {}),
    ...(sig.followingCount !== undefined ? { followingCount: sig.followingCount } : {}),
    hasDefaultAvatar: sig.hasDefaultAvatar,
    origin,
    ...(modelReason ? { modelReason } : {}),
    ts: Date.now(),
  };
  try {
    const list = await read();
    const next = trim([...list.filter((s) => s.id !== id), sample]);
    await chrome.storage.local.set({ [KEY]: next });
  } catch {
    /* 存储不可用 —— 非致命，但这条样本就丢了 */
  }
}

/**
 * 把一条「恢复显示」翻成负样本。
 *
 * 恢复时账号往往已经从页面上消失，拿不到完整特征，只能用处理记录里
 * 存下的那点信息。特征不全的负样本仍然远胜于没有 —— 昵称本身就是
 * baseline 的主要特征，而误判几乎都发生在昵称上。
 */
export async function recordRestoreAsNegative(rec: {
  id: string;
  handle: string;
  displayName?: string;
  tweetText?: string;
  reason?: string;
}): Promise<void> {
  try {
    const list = await read();
    const prev = list.find((s) => s.id === rec.id);
    const sample: TrainingSample = {
      // 优先沿用当初拉黑时抓到的完整快照，只把标签翻过来
      ...(prev ?? {
        id: rec.id,
        handle: rec.handle,
        displayName: rec.displayName ?? "",
        bio: "",
        recentTweets: rec.tweetText ? [rec.tweetText] : [],
        hasDefaultAvatar: false,
      }),
      label: "legit",
      origin: "restore",
      ...(rec.reason ? { modelReason: rec.reason } : {}),
      ts: Date.now(),
    };
    const next = trim([...list.filter((s) => s.id !== rec.id), sample]);
    await chrome.storage.local.set({ [KEY]: next });
  } catch {
    /* 非致命 */
  }
}

export async function getSamples(): Promise<TrainingSample[]> {
  return read();
}

export async function sampleCounts(): Promise<{ spam: number; legit: number }> {
  const list = await read();
  return {
    spam: list.filter((s) => s.label === "spam").length,
    legit: list.filter((s) => s.label === "legit").length,
  };
}

/** 导出为 JSONL —— 直接喂给 scripts/baseline/train.ts。 */
export async function exportJsonl(): Promise<string> {
  return (await read()).map((s) => JSON.stringify(s)).join("\n");
}
