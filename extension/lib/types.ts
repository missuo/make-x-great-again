export type Label = "spam" | "porn_bot" | "likely_spam" | "uncertain" | "legit";

export interface Verdict {
  label: Label;
  confidence: number;
  reasons: string[];
}

export interface CurationRecord {
  userId: string;
  handle: string;
  verdict: Verdict;
  reviewStatus: string;
  model: string;
}

/** Signals scraped passively from the rendered DOM. */
export interface Signals {
  isProfile: boolean;
  userId?: string;
  handle: string;
  displayName: string;
  bio: string;
  hasDefaultAvatar: boolean;
  avatarUrl?: string;
  recentTweets: string[];
  triggeringComment?: string;
  threadTopic?: string;
  accountAgeDays?: number;
  followersCount?: number;
  followingCount?: number;
  /** The tweet texts above are X machine-translations, not the author's own
   *  words (original unavailable in the DOM). Consumers must not treat the
   *  surface language as an author signal. */
  tweetsTranslated?: boolean;
}

/** Background messages. "list-sync" triggers the public blocklist download
 *  (read-only GET of the official artifact; nothing is uploaded). */
export type BgRequest =
  | { type: "health" }
  | { type: "stats" }
  | { type: "records" }
  | { type: "list-sync"; force?: boolean }
  // GitHub Device Flow (whitelist self-service login). Runs in the
  // background: github.com's device endpoints don't serve CORS, so the
  // fetches need the optional github.com host permission granted first.
  | { type: "gh_start" }
  | { type: "gh_poll"; deviceCode: string }
  // Content script asks the background to open the options page (e.g. a report
  // needs GitHub authorization the user hasn't granted yet).
  | { type: "open_options" }
  // 举报: the authenticated POST to /v1/report MUST run in the background —
  // a content-script fetch is bound by x.com's CORS/CSP, whereas the SW shares
  // the extension origin the whitelist-apply flow already reports from.
  | { type: "report"; sig: Signals }
  // baseline 判为「中间带」的账号交给大模型兜底。必须在 background 里跑：
  // x.com 的 CSP 会挡掉内容脚本的跨源 fetch。
  | { type: "classify"; sig: Signals }
  // 自学习：用户确认一个垃圾账号后，让大模型从中蒸馏可复用的规则。
  // 同样必须在 background 里跑（跨源 fetch），且不阻塞内容脚本。
  | { type: "distill"; sig: Signals; note?: string }
  // 设置页的「试学」：拿一条样本走完整蒸馏 + 准入体检但**不落库**。
  // 它把「没学到规则」的四种原因压成一次点击就能看清 —— 不必真去拉黑
  // 一个人，也不必去翻 service worker 的控制台。
  | { type: "distill_test"; sample: { displayName: string; bio: string; tweet: string } }
  // 设置页发起的规则库通审，产出提案供人工确认。
  | { type: "consolidate" }
  // 设置页的「测试连接」。
  | { type: "llm_test" };

/** 试学结果。放在 types 而不是 background 里：设置页只需要这个形状，
 *  从 entrypoint 引类型会把整个 background 模块拖进 options 的依赖图。 */
export interface DryRunResult {
  status: "ok" | "no_signatures" | "not_configured" | "error";
  /** AI 原样返回的签名，含被体检拒掉的 —— 「模型给了但被拦下」和「模型
   *  什么都没给」是两个完全不同的问题，必须能分开看。 */
  signatures: { terms: string[]; field: string; cat: string; why: string }[];
  /** 每条签名的体检结论。 */
  checks: { terms: string[]; ok: boolean; reason?: string }[];
  error?: string;
}

export interface BgResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}
