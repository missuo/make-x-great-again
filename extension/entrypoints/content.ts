import { PROMOTE_MIN_ACCOUNTS, describeRule } from "../../src/baseline/learned.ts";
import { hideAccountSurface } from "../lib/account-surface";
import { autoEligible } from "../lib/auto-policy";
import { type LocalVerdict, baselineStats, scoreSignals } from "../lib/baseline";
import { addBlocked, isBlockedSync, warm as warmBlocklist } from "../lib/blocklist";
import { BRAND } from "../lib/brand";
import { type Cached, cacheGet, cacheSet, signalsHash } from "../lib/cache";
import { CATEGORY_ZH } from "../lib/category";
import {
  extractFromArticle,
  extractProfile,
  extractThreadTopic,
  viewerHandle,
} from "../lib/detect";
import { type DistillLogEntry, learnedRules, warmLearned } from "../lib/learned-store";
import { LIST_KEY, WL_KEY } from "../lib/list-sync";
import { type IndexEntry, isWhitelisted, warmLocalIndex } from "../lib/local-index";
import {
  type ActionMode,
  type CategoryAction,
  type Settings,
  getSettings,
  onSettingsChange,
  setSetting,
} from "../lib/settings";
import { bumpStat } from "../lib/stats";
import {
  type PendingXAction,
  addBlockRecord,
  addPendingAction,
  bumpStats,
  clearPendingAction,
  getPendingActions,
  updateBlockRecord,
} from "../lib/store";
import { recordSample } from "../lib/training";
import type { Signals, Verdict } from "../lib/types";
import {
  type BadgeSource,
  type Finding,
  STYLE,
  createActingBadge,
  createBadge,
  createBubble,
} from "../lib/ui";

/**
 * 手动拉黑 → 后台蒸馏出候选规则。
 *
 * 整条链路都是 fire-and-forget：蒸馏失败（没配大模型、网络断了、返回的
 * JSON 不合法）绝不能影响用户已经完成的那次拉黑。学不到就下次再学。
 *
 * 但**每一次都要在页面控制台留话**。之前只在学到东西时打日志，于是
 * 「没配 AI」「模型没给签名」「签名被体检拒了」「网络挂了」四种情况在
 * 用户看来完全一样，都是沉默 —— 而它们需要的处理完全不同。同一条记录
 * 也会落进设置页的「最近学习记录」，因为 service worker 的控制台不是
 * 用户会去看的地方。
 */
function distillFromManual(sig: Signals): void {
  void (async () => {
    let log: DistillLogEntry | undefined;
    try {
      const resp = await chrome.runtime.sendMessage({ type: "distill", sig });
      log = resp?.data as DistillLogEntry | undefined;
    } catch {
      /* 后台不可用 */
    }
    if (!log) {
      console.info(`[MXGA] 学习 @${sig.handle} —— 后台无响应，本次未学习`);
      return;
    }
    const tail = " · 详见设置页「模型学习 → 最近学习记录」";
    switch (log.status) {
      case "added":
        console.info(
          `[MXGA] 从 @${sig.handle} 学到 ${log.added.length} 条候选规则：${log.added.join("；")}`,
        );
        break;
      case "all_rejected":
        console.info(
          `[MXGA] 学习 @${sig.handle} —— AI 给出的候选全部未通过准入体检：${log.rejected
            .map((r) => `「${r.terms.join("+")}」${r.reason}`)
            .join("；")}`,
        );
        break;
      case "no_signatures":
        console.info(`[MXGA] 学习 @${sig.handle} —— AI 认为它身上没有可复用的特征${tail}`);
        break;
      case "not_configured":
        console.info(`[MXGA] 学习 @${sig.handle} —— 尚未配置 AI 判定接口，无法学习${tail}`);
        break;
      default:
        console.info(`[MXGA] 学习 @${sig.handle} 失败：${log.error ?? "未知错误"}${tail}`);
    }
  })();
}

/**
 * 手动拉黑 → 把那条推文原文留存为模板规则。
 *
 * 和蒸馏刻意分开：蒸馏依赖 AI，会因为没配接口、网络故障、或模型认为
 * 「抽不出可复用特征」而一无所获；这一路是纯本地计算，只要按了拉黑就
 * 一定留下证据。同一批号往往只换句尾和 @目标，靠相似度就能覆盖。
 */
function captureTemplateFromManual(sig: Signals): void {
  void (async () => {
    try {
      const { captureTemplate } = await import("../lib/learned-store");
      const tweet = sig.triggeringComment || sig.recentTweets[0];
      const rep = await captureTemplate(tweet);
      if (rep.added.length) {
        console.info(`[MXGA] 已留存推文模板，后续相似推文将直接处理：${tweet?.slice(0, 40)}`);
      } else if (rep.rejected.length) {
        console.info(`[MXGA] 推文模板未留存：${rep.rejected[0]?.reason}`);
      }
    } catch {
      /* 非致命 */
    }
  })();
}

/** "误判申诉" — opens the GitHub appeal issue template, PRE-FILLED with the
 *  account's handle / user id / title so the user only writes the reason and
 *  submits. Zero remote requests from the extension itself; the appeal is
 *  filed on GitHub (the template field ids are handle / userid). */
function openAppeal(appeal?: { handle: string; userId?: string }): void {
  let url = BRAND.appealNewIssue;
  if (appeal?.handle) {
    const p = new URLSearchParams();
    p.set("handle", `@${appeal.handle}`);
    if (appeal.userId) p.set("userid", appeal.userId);
    p.set("title", `[Appeal] @${appeal.handle} wrongly listed`);
    url += `&${p.toString()}`;
  }
  window.open(url, "_blank", "noopener");
}

/** Cap on how many interrupted (queue-died) X-actions we resume per load, so a
 *  huge backlog can't fire a burst of X calls at once. The global x-action
 *  lock still paces each one; anything beyond the cap settles on later loads. */
const RESUME_MAX = 50;

/** Report an unlisted account to the public review queue. GitHub-authed
 *  contribution: the token gates who can report (server enforces a 90-day
 *  account-age floor, 10/hour rate limit, one-vote-per-target dedup, reporter
 *  bans, and — auto-publish being off — every report just queues for a
 *  maintainer to confirm). The extension only surfaces the outcome; it never
 *  auto-lists anything. Returns a short line for the popover to show inline. */
async function reportSpam(sig: Signals): Promise<{ ok: boolean; message: string }> {
  // The POST runs in the BACKGROUND (see BgRequest "report"): a content-script
  // fetch to the edge Worker is bound by x.com's CORS/CSP; the SW shares the
  // extension origin the whitelist-apply flow already reports from.
  let resp:
    | { ok: boolean; error?: string; data?: { status: number; body: ReportBody } }
    | undefined;
  try {
    resp = await chrome.runtime.sendMessage({ type: "report", sig });
  } catch {
    return { ok: false, message: "网络错误，举报未提交" };
  }
  if (!resp || !resp.ok) {
    if (resp?.error === "no_token") {
      try {
        chrome.runtime.sendMessage({ type: "open_options" });
      } catch {
        /* best-effort */
      }
      return { ok: false, message: "举报需先在设置页用 GitHub 授权（已为你打开设置）" };
    }
    return { ok: false, message: "网络错误，举报未提交" };
  }
  const { status, body } = resp.data ?? { status: 0, body: {} as ReportBody };
  if (status >= 200 && status < 300 && body.ok) {
    if (body.duplicate) return { ok: true, message: "你已举报过该账号，感谢" };
    if (body.status === "whitelisted")
      return { ok: true, message: "该账号已被官方列入白名单，举报已忽略" };
    if (body.status === "viewer_ignored")
      return { ok: true, message: "这是你自己的账号，举报已忽略" };
    return { ok: true, message: "已举报，进入人工审核队列，感谢贡献" };
  }
  switch (status) {
    case 401:
      try {
        chrome.runtime.sendMessage({ type: "open_options" });
      } catch {
        /* best-effort */
      }
      return { ok: false, message: "GitHub 授权已失效，请在设置页重新授权" };
    case 403:
      return { ok: false, message: "你的举报权限已被限制" };
    case 429:
      return { ok: false, message: "举报过于频繁，请稍后再试" };
    case 503:
      return { ok: false, message: "服务暂未就绪，请稍后再试" };
    default:
      return { ok: false, message: "举报失败，请稍后重试" };
  }
}

interface ReportBody {
  ok?: boolean;
  status?: string;
  duplicate?: boolean;
  error?: string;
}

function articleOf(node: Element | null): HTMLElement | null {
  return (node?.closest("article") as HTMLElement) ?? null;
}

/** User-facing verb for the configured action mode. */
function actionVerb(mode: ActionMode): string {
  return mode === "block" ? "拉黑" : mode === "mute" ? "静音" : "隐藏";
}

/** How many spam categories currently escalate beyond "badge" — shown as the
 *  hint next to the bubble's 自动处理 switch. */
function autoCategoryCount(s: Settings): number {
  return Object.values(s.categoryActions).filter((a) => a !== "badge").length;
}

/** Fire X's native mute/block (best-effort, paced) with one retry. The local
 *  hide/record is applied separately and always — the X call rides on top.
 *  Returns false only when the native X action definitively failed (used by
 *  the bubble's batch panel to surface a per-row 重试 state). */
async function applyXAction(mode: ActionMode, sig: Signals): Promise<boolean> {
  if (mode === "local") return true;

  // Load the mutation client only after the user explicitly chooses a native
  // X action and grants the optional host permission.
  const { performXAction, retryDelayForAttempt } = await import("../lib/x-action");
  const attempt = await performXAction(mode, sig.userId, sig.handle);
  if (attempt.ok) return true;
  const delay = retryDelayForAttempt(attempt, 1);
  if (delay > 0) {
    await new Promise((r) => setTimeout(r, delay));
    const second = await performXAction(mode, sig.userId, sig.handle); // one best-effort retry
    return second.ok;
  }
  return false;
}

/** Cheap author handle from the User-Name link href — no fiber walk, no
 *  innerText. Used both as the scan() skip key and to re-verify a captured
 *  anchor before a delayed hide fires (X recycles article nodes). */
function handleFromArticle(art: HTMLElement): string | undefined {
  const nameBlock = art.querySelector<HTMLElement>('[data-testid="User-Name"]');
  if (!nameBlock) return undefined;
  for (const a of nameBlock.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')) {
    const s = (a.getAttribute("href") ?? "").split("/").filter(Boolean);
    if (s.length === 1 && /^[A-Za-z0-9_]{1,15}$/.test(s[0] ?? "")) return s[0];
  }
  return undefined;
}

/** Where a scanned account was seen. Auto actions are scoped by this:
 *  - "reply"   — a NON-focal article on a status page: someone replying under
 *                a tweet. This is where the spam wave lives → auto-actable.
 *  - "feed"    — the account's own post in a timeline / search / the focal
 *                tweet itself. Detect + badge only under the default scope.
 *  - "profile" — the profile header on the account's own page. Badge only. */
type ScanContext = "reply" | "feed" | "profile";

/** Status id of the tweet the current page is focused on, or null when not
 *  on a /user/status/<id> page. */
function focalStatusId(): string | null {
  const m = location.pathname.match(/^\/[^/]+\/status\/(\d+)/);
  return m?.[1] ?? null;
}

/** Status id of an article, read from its timestamp permalink. Null when the
 *  article carries no <time> link (fail-safe → treated as non-reply). */
function articleStatusId(art: HTMLElement): string | null {
  for (const a of art.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')) {
    if (!a.querySelector("time")) continue;
    const m = (a.getAttribute("href") ?? "").match(/\/status\/(\d+)/);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Each inline badge gets its own shadow host so X CSS can't touch it. */
function mountBadge(anchor: HTMLElement, build: () => HTMLElement) {
  const host = document.createElement("span");
  host.className = "xss-mount";
  // The profile header's UserName block is a flex container with the default
  // align-items:stretch — an unpinned host (and the badge inside it, via the
  // host's own default stretch) inflates to the full two-line row height and
  // renders as a giant capsule. Pin both axes to content size.
  host.style.cssText =
    "display:inline-flex;align-items:center;align-self:center;vertical-align:middle;flex:none;";
  const sr = host.attachShadow({ mode: "open" });
  const st = document.createElement("style");
  st.textContent = STYLE;
  sr.append(st, build());
  anchor.appendChild(host);
}

function clearMounts(anchor: HTMLElement) {
  anchor.querySelectorAll(":scope > .xss-mount, :scope > .xss-pending").forEach((n) => n.remove());
}

// ---- 5-second preview undo queue (PENDING_MS) ----
const PENDING_MS = 5000;

interface PendingAction {
  key: string;
  sig: Signals;
  anchor: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
  ts: number;
  /** Per-action override of settings.actionMode — the popover's secondary
   *  隐藏 button schedules a local-only hide even when the mode is block. */
  mode?: ActionMode;
  /** Triggering tweet, captured while the DOM anchor is still alive —
   *  lands in the 处理记录 audit trail. */
  tweetId?: string;
  tweetText?: string;
}

export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  cssInjectionMode: "ui",
  async main(ctx) {
    let bubbleApi: ReturnType<typeof createBubble> | null = null;
    let dismissed = false;
    const anchorByKey = new Map<string, HTMLElement>();
    const nodeHandle = new WeakMap<HTMLElement, string>(); // virtualization-safe
    let findings: Finding[] = [];
    const pendingActions = new Map<string, PendingAction>();
    const inFlight = new Set<string>(); // keys currently in process()
    const hitPublicSeen = new Set<string>(); // hitPublic stat: once per account

    let settings = await getSettings();
    if (!settings.enabled) return; // master off → don't init (applies next load)
    // Build marker — confirms which content-script build is live in this tab
    // (reloading the unpacked extension does NOT refresh already-open tabs).
    console.info(
      // 构建标识必须随每次改动更新：上一次排查里，页面上挂着的旧脚本打出了
      // 和新版一模一样的这行，导致「扩展重载了但标签页没重载」看起来像是
      // 判定失效。带上模型规模，顺便一眼确认 baseline 真的加载进来了。
      // 构建标识必须能回答「我加载的是不是新版本」。上一轮排查里，
      // 「没学到规则」和「装的还是旧构建」在外部看来完全一样 —— 把学习
      // 层的状态直接写进这一行，这个歧义就不会再出现。
      `[MXGA] content script ready · build 2026-08-12 (self-learning) · 模板 ${baselineStats().clusters} 簇 / 定罪短语 ${baselineStats().phrases} 条 · 学习规则 ${learnedRules().length} 条（可信 ${learnedRules().filter((r) => r.status === "trusted").length}）`,
    );

    // 判定计数。只打非 pass 的日志会留下一个致命的观测盲区：「扫到了但
    // 全部放行」和「根本没扫到账号」在控制台里长得一模一样，排查时无法
    // 区分。定期汇总一次，让「在工作但很安静」可被证实。
    const tally = { ban: 0, llm: 0, pass: 0 };
    // 抽样保留 baseline 实际收到的输入。判定全放行时，必须能分清是「确实
    // 没有垃圾号」还是「输入是空的」—— baseline 几乎全靠 displayName，
    // 昵称提取失败会导致 100% 放行，而这在计数上和前者一模一样。
    const seen: string[] = [];
    let lastTallyTotal = 0;
    const tallyTimer = setInterval(() => {
      const total = tally.ban + tally.llm + tally.pass;
      if (total === lastTallyTotal) return; // 没有新增就不刷屏
      lastTallyTotal = total;
      console.info(
        `[MXGA] 已评估 ${total} 个账号 · 定罪 ${tally.ban} · 送大模型 ${tally.llm} · 放行 ${tally.pass}`,
      );
      if (seen.length) {
        console.info(
          `[MXGA] baseline 看到的输入抽样（昵称为空说明提取失败）:\n  ${seen.join("\n  ")}`,
        );
        seen.length = 0;
      }
    }, 10_000);
    ctx.onInvalidated?.(() => clearInterval(tallyTimer));

    // 孤儿脚本自检。
    //
    // 重载扩展不会踢掉已经注入页面的旧内容脚本，而 X 是 SPA，站内跳转也
    // 不会重新注入 —— 于是旧脚本继续跑，它的 chrome.runtime 已经失效，
    // 存储读不到、消息发不出，表现就是「什么都不发生」。整整一轮排查卡在
    // 这里，因为它**静默**失败：控制台只有一条 chrome-extension://invalid/。
    // 与其让下一次再猜一遍，不如让它自己喊出来。
    const orphanCheck = setInterval(() => {
      if (chrome.runtime?.id) return;
      clearInterval(orphanCheck);
      console.error(
        "[MXGA] 扩展上下文已失效 —— 本页运行的是旧版内容脚本，所有检测与处理都不会生效。请刷新此页面。",
      );
    }, 5000);
    ctx.onInvalidated?.(() => clearInterval(orphanCheck));
    onSettingsChange((s) => {
      const modeChanged = s.actionMode !== settings.actionMode;
      settings = s;
      // Keep the bubble's 自动处理 switch + hint in sync (options page or
      // another tab may have flipped it).
      bubbleApi?.setAutoProcess(s.autoProcess, autoCategoryCount(s));
      bubbleApi?.setAutoExpand(s.autoExpand);
      if (modeChanged) {
        // Mounted badges rendered the OLD verb into their buttons, but a
        // click executes the CURRENT actionMode — a button reading 隐藏 must
        // never actually 拉黑. Sync the bubble's label and drop every
        // non-pending badge so the next scan re-renders with the real verb.
        bubbleApi?.setVerb(actionVerb(s.actionMode));
        for (const host of document.querySelectorAll<HTMLElement>(".xss-mount")) {
          if (host.shadowRoot?.querySelector(".xss-badge.pending")) continue;
          host.remove();
        }
        scan();
      }
    });

    // Warm local data structures
    await warmBlocklist();
    await warmLocalIndex();
    // 学到的规则也要预热：判定是同步的，拿不到就等于这一层不存在。
    await warmLearned();

    const keyOf = (s: Signals) => s.userId || `h:${s.handle}`;

    /** Schedule a hide action with a 5-second undo window. `mode` overrides
     *  settings.actionMode for this one action (popover 隐藏 → "local"). */
    function scheduleHide(key: string, sig: Signals, anchor: HTMLElement, mode?: ActionMode) {
      if (pendingActions.has(key)) return; // already pending
      // Tag the row so executeHide can still find it if X recycles the node.
      const art = articleOf(anchor);
      art?.setAttribute("data-xss-key", key);
      const tweetId = art ? articleStatusId(art) : null;
      const tweetText = sig.triggeringComment || sig.recentTweets[0];
      const timer = setTimeout(() => {
        try {
          void executeHide(key, sig).catch(() => {});
        } finally {
          pendingActions.delete(key);
          // The undo window has settled even if X recycled the target or a
          // synchronous DOM lookup failed. Never leave a permanent "5秒后"
          // badge claiming an action is still pending.
          clearMounts(anchor);
        }
      }, PENDING_MS);
      pendingActions.set(key, {
        key,
        sig,
        anchor,
        timer,
        ts: Date.now(),
        ...(mode ? { mode } : {}),
        ...(tweetId ? { tweetId } : {}),
        ...(tweetText ? { tweetText } : {}),
      });
      // Update UI to show pending state
      badgeForPending(anchor, sig, mode);
    }

    /** Cancel a pending hide action (user clicked undo). */
    function cancelPending(key: string) {
      const pending = pendingActions.get(key);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingActions.delete(key);
      articleOf(pending.anchor)?.removeAttribute("data-xss-key");
      // Restore the badge to its previous state
      clearMounts(pending.anchor);
    }

    /** Execute the action (after the preview window expires, or immediately
     *  from the bubble's batch panel). The local record + visual hide always
     *  happen (so the row stays gone across navigation); if the user opted
     *  into "mute"/"block", X's native action rides on top via the user's
     *  own session (best-effort, paced). Everything up to the X call runs
     *  synchronously; the returned promise resolves once the native action
     *  settled (true = local-only mode or X action succeeded). */
    function executeHide(key: string, sig: Signals): Promise<boolean> {
      const pend = pendingActions.get(key);
      const mode = pend?.mode ?? settings.actionMode;
      // Triggering-tweet audit trail: prefer what scheduleHide captured live,
      // else the finding (bubble batch path — pending already cleared).
      const fin = findings.find((x) => (x.userId || `h:${x.handle}`) === key);
      const tweetId = pend?.tweetId ?? fin?.tweetId;
      const tweetText = pend?.tweetText ?? fin?.snippet;
      void addBlocked(key);
      if (sig.userId) void addBlocked(sig.userId);
      // 人工确认的正样本 —— 用户亲手判断过，这是训练集里质量最高的一档。
      // 快照必须在这里抓：账号随后就从页面消失，事后无从还原特征。
      void recordSample(sig, "spam", "manual");
      // 自学习循环 1：让大模型从这个账号身上蒸馏可复用签名。只对**手动**
      // 拉黑做 —— 自动处理是模型自己的判断，拿它去教自己会正反馈跑偏；
      // 手动拉黑背后是一次真人 review，这才是新信息的来源。
      void distillFromManual(sig);
      // 与蒸馏并行的第二条路：把这条推文原文本身留存为模板规则。
      // 纯本地、不联网 —— AI 抽不出关键词（或根本没配）时，它是唯一
      // 仍然会留下证据的一路。同一批号只换尾巴时靠相似度就能抓住。
      void captureTemplateFromManual(sig);
      void addBlockRecord({
        id: key,
        handle: sig.handle,
        ...(sig.displayName ? { displayName: sig.displayName } : {}),
        ...(sig.avatarUrl ? { avatarUrl: sig.avatarUrl } : {}),
        ...(tweetId ? { tweetId } : {}),
        ...(tweetText ? { tweetText } : {}),
        ...(mode === "mute" || mode === "block" ? { xAction: mode } : {}),
        source: "manual",
        ts: Date.now(),
      });
      void bumpStats({ blocks: 1 });
      void bumpStat("blocked");
      // X recycles article nodes: only hide via the captured anchor if it
      // still belongs to this account; otherwise use the tagged row, else
      // abort the DOM hide (the block itself is already recorded).
      const anchor = pendingActions.get(key)?.anchor ?? anchorByKey.get(key) ?? null;
      const art = articleOf(anchor);
      const sameAuthor =
        !!art && handleFromArticle(art)?.toLowerCase() === sig.handle.toLowerCase();
      // Profile badges are not inside an article. Their captured UserName
      // anchor is still the authoritative target; hideAccountSurface resolves
      // it to the profile header. Article anchors retain the author/recycling
      // guard before falling back to the tagged row.
      const target =
        sameAuthor || (!!anchor && !art)
          ? anchor
          : document.querySelector(`[data-xss-key="${CSS.escape(key)}"]`);
      if (target) hideAccountSurface(target);
      // If this account is a live bubble finding (a listed hit the user chose
      // to handle from the badge popover rather than the batch panel), drive
      // its row to "done" so it stops offering an actionable button and joins
      // the 已处理 record — otherwise the row stalls at "待处理" forever and is
      // dropped on the next SPA navigation.
      bubbleApi?.markManual(key, actionVerb(mode));
      // Track the not-yet-fired X action so a mid-batch navigation/reload can
      // resume it rather than leave the account locally-hidden-only (same
      // guarantee as the auto queue). Local mode makes no X call — skip.
      if (mode === "mute" || mode === "block") {
        void addPendingAction({ id: key, handle: sig.handle, action: mode, ts: Date.now() });
      }
      // Mirror the auto path: when the native X action fails, the 处理记录
      // row must say so — the user clicked 拉黑/静音 and only got a local
      // hide, and the record is the one place that can state it honestly.
      return applyXAction(mode, sig).then((ok) => {
        if (mode === "mute" || mode === "block") void clearPendingAction(key);
        if (!ok) {
          void updateBlockRecord(key, {
            reason: `手动${actionVerb(mode)}（X 动作失败，仅本地隐藏）`,
            // 动作没成功就不能留 xAction，否则恢复时会去解除一个从未生效的拉黑
            xAction: undefined,
          });
        }
        return ok;
      });
    }

    function badgeForPending(anchor: HTMLElement, sig: Signals, mode?: ActionMode) {
      clearMounts(anchor);
      const verb = actionVerb(mode ?? settings.actionMode);
      mountBadge(anchor, () => {
        const el = document.createElement("span");
        el.className = "xss-badge pending";
        el.innerHTML = `<span style="color:var(--warn)">⏳ 5秒后${verb}</span>
          <button data-undo style="margin-left:6px;padding:1px 6px;border:1px solid var(--warn);background:transparent;color:var(--warn);border-radius:4px;font-size:10px;cursor:pointer">撤销</button>`;
        el.querySelector("[data-undo]")?.addEventListener("click", (e) => {
          e.stopPropagation();
          cancelPending(keyOf(sig));
        });
        return el;
      });
    }

    // ---- Visible auto-processing queue (the v0.4 爽感 path) ----
    // Auto hits do NOT vanish silently: each account is queued and worked
    // ONE AT A TIME — in-place pulsing "拉黑中" badge on the tweet, live
    // queued→processing→done row states in the bubble (which auto-opens),
    // then an animated collapse of the cell. The decision itself is recorded
    // up-front, so only the theater is deferred, never the protection.
    const AUTO_MIN_ACT_MS = 900; // every item is visibly "worked" this long
    const AUTO_SETTLE_MS = 240; // beat between items (v0.4: 180ms)
    // Roster-first: the page scan surfaces hits one by one, so the sweep
    // waits out a short gather window — the bubble fills with 排队中 rows
    // FIRST, then the cleanup walks through them. Capped so a trickle of
    // late hits can't stall the start forever.
    const AUTO_GATHER_MS = 1600;
    const AUTO_GATHER_MAX_MS = 4000;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    interface AutoItem {
      key: string;
      sig: Signals;
      action: CategoryAction;
      verb: string;
      anchor: HTMLElement;
      verdict: Verdict;
      categoryZh: string;
      tweetId?: string;
    }
    const autoQueue: AutoItem[] = [];
    // Keys owned by the queue — step 0's insta-hide must spare the cell the
    // animation is (about to be) playing on.
    const autoActing = new Set<string>();
    let autoDraining = false;

    function mountActing(anchor: HTMLElement, verb: string, queued: boolean) {
      clearMounts(anchor);
      mountBadge(anchor, () => createActingBadge(verb, queued));
    }

    /** X recycles article nodes: trust the captured anchor only while it
     *  still renders this account, else fall back to the tagged row. */
    function autoTarget(it: AutoItem): HTMLElement | null {
      const art = articleOf(it.anchor);
      const same = !!art && handleFromArticle(art)?.toLowerCase() === it.sig.handle.toLowerCase();
      if (same) return it.anchor;
      return document.querySelector<HTMLElement>(`[data-xss-key="${CSS.escape(it.key)}"]`);
    }

    function enqueueAuto(it: AutoItem) {
      if (autoActing.has(it.key)) return;
      autoActing.add(it.key);
      // Record FIRST — the protection survives navigation even if the
      // animation never gets to play.
      void addBlocked(it.key);
      if (it.sig.userId) void addBlocked(it.sig.userId);
      // 自动处理只算弱正样本：没人复核过，训练时应当降权。用户若随后
      // 点了「恢复显示」，这条会被同 id 覆盖成负样本。
      void recordSample(it.sig, "spam", "auto", it.verdict?.reasons?.[0]);
      // The 处理记录 row too: the id lands in xss:blocked above, and a record
      // is the only UI path back (恢复显示). Writing it after the paced X
      // action left a window (tab close mid-queue) that produced permanently
      // hidden accounts with no recover entry. The X-failure annotation is
      // patched in later by the drain loop.
      const tweetText = it.sig.triggeringComment || it.sig.recentTweets[0];
      void addBlockRecord({
        id: it.key,
        handle: it.sig.handle,
        ...(it.sig.displayName ? { displayName: it.sig.displayName } : {}),
        ...(it.sig.avatarUrl ? { avatarUrl: it.sig.avatarUrl } : {}),
        ...(it.tweetId ? { tweetId: it.tweetId } : {}),
        ...(tweetText ? { tweetText } : {}),
        verdict: it.verdict,
        // 证据进记录，而不只是「类别 · 动作」。处理记录是唯一的复核入口，
        // 一条看不出凭什么发生的自动处理，等于没法复核。
        reason: [`${it.categoryZh} · 自动${it.verb}`, it.verdict?.reasons?.[0]]
          .filter(Boolean)
          .join(" · "),
        ...(it.action === "mute" || it.action === "block" ? { xAction: it.action } : {}),
        source: "auto",
        ts: Date.now(),
      });
      // Track the not-yet-fired X action separately (see PendingXAction): a
      // mid-queue reload can then tell a queued account apart from a completed
      // one — resuming it instead of falsely counting it as 已处理. Local-only
      // hides need no X call, so nothing to track.
      if (it.action === "mute" || it.action === "block") {
        void addPendingAction({
          id: it.key,
          handle: it.sig.handle,
          action: it.action,
          ts: Date.now(),
        });
      }
      void bumpStats({ blocks: 1 });
      void bumpStat("blocked");
      anchorByKey.set(it.key, it.anchor);
      articleOf(it.anchor)?.setAttribute("data-xss-key", it.key);
      mountActing(it.anchor, it.verb, true);
      bubbleApi?.markAuto(it.key, "queued", it.verb);
      autoQueue.push(it);
      scheduleDrain();
    }

    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let gatherStart = 0;
    /** Debounced sweep start: every new hit extends the gather window by
     *  AUTO_GATHER_MS, bounded by AUTO_GATHER_MAX_MS from the first hit. */
    function scheduleDrain() {
      if (autoDraining) return; // mid-sweep hits just join the tail
      const now = Date.now();
      if (!gatherStart) gatherStart = now;
      const delay = Math.min(AUTO_GATHER_MS, Math.max(0, gatherStart + AUTO_GATHER_MAX_MS - now));
      clearTimeout(drainTimer);
      drainTimer = setTimeout(() => void drainAuto(), delay);
    }

    async function drainAuto() {
      if (autoDraining) return;
      autoDraining = true;
      gatherStart = 0;
      try {
        await drainAutoLoop();
      } finally {
        autoDraining = false;
      }
      // A hit that landed exactly as the loop exited would otherwise sit
      // until the next enqueue — sweep it into a fresh (short) round.
      if (autoQueue.length) scheduleDrain();
    }

    async function drainAutoLoop() {
      while (autoQueue.length) {
        const it = autoQueue.shift();
        if (!it) break;
        // One broken item (dead DOM node, render error) must not strand the
        // rest of the queue — fail it and move on.
        try {
          const t0 = Date.now();
          const acting = autoTarget(it);
          if (acting) mountActing(acting, it.verb, false);
          bubbleApi?.markAuto(it.key, "processing", it.verb);
          const xOk =
            it.action === "mute" || it.action === "block"
              ? await applyXAction(it.action, it.sig)
              : true;
          if (!xOk)
            console.warn(`[MXGA] 自动${it.verb}：X 原生动作失败`, it.sig.handle, it.sig.userId);
          // Even the instant local-hide mode dwells long enough to be SEEN.
          const dwell = AUTO_MIN_ACT_MS - (Date.now() - t0);
          if (dwell > 0) await sleep(dwell);
          // Hide the real tweet INSTANTLY — the processing theater (fade /
          // shrink / fly-into-chip) belongs to the corner bubble; animating
          // the page's own DOM competes with X's scroll/virtualizer and reads
          // as jank on the timeline.
          hideAccountSurface(autoTarget(it));
          // The action has now SETTLED (attempted) — drop its pending marker so
          // it stops being a resume candidate; only items whose queue died
          // before this point stay pending. On X failure, annotate the record.
          if (it.action === "mute" || it.action === "block") {
            void clearPendingAction(it.key);
            if (!xOk) {
              void updateBlockRecord(it.key, {
                reason: [
                  `${it.categoryZh} · 自动${it.verb}（X 动作失败，仅本地隐藏）`,
                  it.verdict?.reasons?.[0],
                ]
                  .filter(Boolean)
                  .join(" · "),
                xAction: undefined,
              });
            }
          }
          bubbleApi?.markAuto(it.key, xOk ? "done" : "failed", it.verb);
        } catch (e) {
          console.warn(`[MXGA] 自动${it.verb}处理异常`, it.sig.handle, e);
          try {
            bubbleApi?.markAuto(it.key, "failed", it.verb);
          } catch {
            /* bubble unavailable — the record above still stands */
          }
        } finally {
          autoActing.delete(it.key);
        }
        await sleep(AUTO_SETTLE_MS);
      }
    }

    /** Resume mute/block actions whose paced queue died with a previous page
     *  (mid-queue navigation / reload / tab close). Their local hide + record
     *  persisted, but the X-action never fired — re-run it best-effort (the
     *  x-action lock paces these across tabs), then settle the pending marker
     *  so it stops being a resume candidate. Runs once per load; each entry is
     *  attempted at most once, then cleared regardless of outcome. */
    async function resumeInterrupted(pending: PendingXAction[]) {
      // The user switched the mode to local (no more X actions) — honor that:
      // just settle the markers so these move into the normal 已处理 history.
      if (settings.actionMode === "local") {
        for (const p of pending) void clearPendingAction(p.id);
        return;
      }
      for (const p of pending.slice(0, RESUME_MAX)) {
        if (p.action !== "mute" && p.action !== "block") {
          void clearPendingAction(p.id);
          continue;
        }
        const sig = {
          handle: p.handle,
          ...(/^\d+$/.test(p.id) ? { userId: p.id } : {}),
        } as Signals;
        const ok = await applyXAction(p.action, sig).catch(() => false);
        if (!ok) {
          void updateBlockRecord(p.id, {
            reason: `自动${p.action === "block" ? "拉黑" : "静音"}（X 动作失败，仅本地隐藏）`,
          });
        }
        void clearPendingAction(p.id);
      }
    }

    function pushFinding(
      sig: Signals,
      v: Verdict,
      source: string,
      meta?: { categoryZh?: string; tweetId?: string; tier?: "confirmed" | "auto" },
    ) {
      if (!["spam", "porn_bot", "likely_spam"].includes(v.label)) return;
      const id = keyOf(sig);
      // Dedupe by key AND by handle: the same account can be scanned once
      // WITH a uid (article fiber walk) and once without (profile header),
      // producing two different keys — the bubble then listed it twice.
      const h = sig.handle.toLowerCase();
      if (
        findings.some((f) => (f.userId || `h:${f.handle}`) === id || f.handle.toLowerCase() === h)
      )
        return;
      const snippet = sig.triggeringComment || sig.recentTweets[0] || sig.bio;
      findings.push({
        handle: sig.handle,
        verdict: v,
        source,
        ...(meta?.categoryZh ? { categoryZh: meta.categoryZh } : {}),
        ...(meta?.tweetId ? { tweetId: meta.tweetId } : {}),
        ...(meta?.tier ? { tier: meta.tier } : {}),
        ...(sig.userId ? { userId: sig.userId } : {}),
        ...(sig.avatarUrl ? { avatarUrl: sig.avatarUrl } : {}),
        ...(sig.displayName ? { displayName: sig.displayName } : {}),
        ...(snippet ? { snippet } : {}),
      });
      if (!dismissed) bubbleApi?.update(findings);
    }

    function badgeFor(
      anchor: HTMLElement,
      key: string,
      sig: Signals,
      v: Verdict | null,
      note?: string,
      source: BadgeSource = "fresh",
    ) {
      // Anchors are kept ONLY for hit accounts (executeHide's fallback and
      // onReviewEach are the sole consumers, and both operate on findings).
      // Registering every scanned account used to pin each author's
      // unmounted article subtree for the whole page lifetime; the neutral
      // ghost badge's manual flow captures its own anchor via scheduleHide.
      if (v) anchorByKey.set(key, anchor);
      clearMounts(anchor);
      mountBadge(anchor, () =>
        createBadge(
          v,
          {
            // The popover exposes the full ladder; the clicked mode overrides
            // settings.actionMode for this one account (default = configured).
            onAct: (mode) => scheduleHide(key, sig, anchor, mode),
            onAppeal: () =>
              openAppeal({ handle: sig.handle, ...(sig.userId ? { userId: sig.userId } : {}) }),
            onReport: () => reportSpam(sig),
          },
          note,
          source,
          settings.actionMode,
        ),
      );
    }

    function renderCached(anchor: HTMLElement, key: string, sig: Signals, c: Cached) {
      badgeFor(anchor, key, sig, c.verdict, undefined, "cache");
      pushFinding(sig, c.verdict, "cache");
    }

    /** 一次定罪的渲染与执行。来源只可能是本地 baseline 或大模型判定 ——
     *  公榜与官方关键词规则两条来源已整个移除。 */
    function renderHit(
      anchor: HTMLElement,
      key: string,
      sig: Signals,
      entry: IndexEntry,
      badgeSource: "baseline" | "llm",
    ) {
      if (!hitPublicSeen.has(key)) {
        hitPublicSeen.add(key);
        void bumpStat("hitPublic");
      }
      // Triggering tweet for the audit trail (null on profile headers).
      const hitArt = articleOf(anchor);
      const hitTweetId = hitArt ? articleStatusId(hitArt) : null;
      // 自动处理决策链（两道闸，互不干扰）：
      //   1. 来源资格 —— autoEligible()：只有 baseline / 大模型判定算数，
      //      缓存与中性判定永不自动处理。
      //   2. 总开关 —— settings.autoProcess（气泡与设置页同步）。
      //   3. 动作 —— 按类别配置（仅标记 / 本地隐藏 / X 静音 / X 拉黑）。
      // 自动处理一律可在「处理记录」撤销；静音/拉黑与手动路径一样走用户
      // 自己的 X 登录态。
      const action = autoEligible({ source: badgeSource })
        ? (settings.categoryActions[entry.category] ?? "badge")
        : "badge";
      // 自动处理 master switch off → everything degrades to mark-only,
      // regardless of the per-category policy.
      if (action === "badge" || !settings.autoProcess) {
        badgeFor(anchor, key, sig, entry.verdict, undefined, badgeSource);
        pushFinding(sig, entry.verdict, "local-index", {
          categoryZh: CATEGORY_ZH[entry.category],
          ...(hitTweetId ? { tweetId: hitTweetId } : {}),
        });
        return;
      }
      // Auto-processed accounts still show up in the bubble panel — as
      // display-only rows driven through markAuto (checkbox disabled,
      // button is a status chip). Chips + radar pill counts follow.
      pushFinding(sig, entry.verdict, "local-index", {
        categoryZh: CATEGORY_ZH[entry.category],
        ...(hitTweetId ? { tweetId: hitTweetId } : {}),
      });
      const verb = action === "mute" ? "静音" : action === "block" ? "拉黑" : "隐藏";
      // The visible queue owns everything from here: records up-front, then
      // in-place badge → paced X action → animated collapse → bubble row
      // states. The 处理记录 line is written after the X action settles so it
      // can state honestly whether the native mute/block actually landed.
      enqueueAuto({
        key,
        sig,
        action,
        verb,
        anchor,
        verdict: entry.verdict,
        categoryZh: CATEGORY_ZH[entry.category],
        ...(hitTweetId ? { tweetId: hitTweetId } : {}),
      });
    }

    /**
     * baseline 中间带 → 大模型判定 → 落缓存 → 按结果决定动作。
     *
     * 只有 spam / porn_bot 才执行动作。likely_spam / uncertain 一律只标记：
     * 实测这个模型的 confidence 恒为 0.85（未校准），所以不能靠置信度阈值
     * 把握精度，只能靠标签本身 —— 而 likely_spam 按定义就是「不确定」。
     */
    async function classifyLlm(
      anchor: HTMLElement,
      key: string,
      sig: Signals,
      base: LocalVerdict,
      ctx: ScanContext,
    ) {
      let verdict: Verdict | undefined;
      try {
        const resp = await chrome.runtime.sendMessage({ type: "classify", sig });
        if (resp?.ok) verdict = resp.data as Verdict;
      } catch {
        /* background 不可用 / 网络错误 —— 下面按未判定处理 */
      }
      // 判不出来就不判 —— 绝不因为「模型没答上来」而默认成 spam。
      if (!verdict) {
        console.info(`[MXGA] 大模型未给出判定 @${sig.handle} —— 按未判定处理，不做任何动作`);
        badgeFor(anchor, key, sig, null);
        return;
      }
      console.info(
        `[MXGA] 大模型 @${sig.handle} → ${verdict.label} ${verdict.confidence} · ${verdict.reasons[0] ?? ""}`,
      );
      // 落缓存：账号级，避免同一个账号在别的推文下再烧一次调用。
      void cacheSet(key, {
        verdict,
        signalsHash: signalsHash(sig),
        model: "llm",
        ts: Date.now(),
        handle: sig.handle,
        displayName: sig.displayName,
        ...(sig.avatarUrl ? { avatarUrl: sig.avatarUrl } : {}),
      });
      // detections 就是「已执行的 LLM 判定次数」，复用它而不是另造字段
      void bumpStats({ detections: 1, label: verdict.label });

      const actionable = verdict.label === "spam" || verdict.label === "porn_bot";
      // 自学习循环 3：这次送审若是被某条候选规则提起来的，把结果记到它头上。
      //
      // 只认两个明确的极端：spam/porn_bot 记一次确认，legit 当场退役。
      // likely_spam / uncertain 什么都不记 —— 模型自己都没想好，不该拿它
      // 去推动一条规则升级或退役。
      if (base.learnedRuleId && (actionable || verdict.label === "legit")) {
        void (async () => {
          const { recordOutcome } = await import("../lib/learned-store");
          const after = await recordOutcome(
            base.learnedRuleId as string,
            key,
            actionable ? "spam" : "legit",
            verdict.label === "legit" ? `大模型判定 @${sig.handle} 为正常账号` : undefined,
          );
          if (after?.status === "trusted" && after.confirms === PROMOTE_MIN_ACCOUNTS) {
            console.info(`[MXGA] 学习规则已晋升为可自动定罪：${describeRule(after)}`);
          } else if (after?.status === "retired") {
            console.info(`[MXGA] 学习规则已退役：${describeRule(after)} · ${after.retiredReason}`);
          }
        })();
      }
      if (!actionable) {
        badgeFor(anchor, key, sig, verdict, undefined, "llm");
        pushFinding(sig, verdict, "llm");
        return;
      }
      renderHit(
        anchor,
        key,
        sig,
        {
          userId: sig.userId ?? "",
          handle: sig.handle,
          verdict,
          // baseline 的中间带证据带着类别；模型只回标签，用前者补齐。
          category: base.category,
          tier: "confirmed",
          source: "curated",
          updatedAt: new Date().toISOString(),
        },
        "llm",
      );
    }

    async function process(sig: Signals, anchor: HTMLElement, ctx: ScanContext = "feed") {
      const key = keyOf(sig);
      if (inFlight.has(key)) return; // a concurrent scan is already on it
      inFlight.add(key);
      try {
        // 0. Already blocked → hide, never render again. Exception: the cell
        //    the visible auto queue is working on (it was recorded up-front)
        //    — its animation owns the hide; OTHER cells by the same account
        //    still vanish instantly.
        // Check every id form the account may have been recorded under: the
        // same account can surface with a uid (fiber walk) or handle-only
        // (profile header), and a hit stored under one form must short-circuit
        // the other — otherwise it gets auto-processed twice and 恢复显示
        // (which deletes one id) never actually un-hides it.
        if (
          isBlockedSync(key) ||
          (sig.userId && isBlockedSync(sig.userId)) ||
          isBlockedSync(`h:${sig.handle}`)
        ) {
          if (autoActing.has(key) && articleOf(anchor)?.getAttribute("data-xss-key") === key)
            return;
          hideAccountSurface(anchor);
          return;
        }

        // 1. Check pending undo queue — skip if already scheduled.
        if (pendingActions.has(key)) return;

        // 2. 白名单压倒下面的一切。公榜切掉之后它依然保留 —— 它只会
        //    「阻止」动作，从不产生动作，是对 baseline / 大模型自身误判
        //    的最后一道保险。同时也拦住 v0.4 时代残留的缓存判定。
        if (isWhitelisted(sig.userId, sig.handle)) {
          badgeFor(anchor, key, sig, null);
          return;
        }

        // 2.5 本地 baseline —— 排在远端公榜之前，因为它是我们自己的判定。
        //     公榜里 27.7% 的条目由泛化词（"同城"/"vpn"/"主页"）单独命中
        //     产生，是已确认的误杀来源；baseline 只在三条结构性高精度路径
        //     上定罪，够不到就不表态。让本地判定先说话，命中即执行。
        const base = scoreSignals(sig);
        tally[base.decision]++;
        if (seen.length < 8) {
          seen.push(
            `@${sig.handle} 昵称=${JSON.stringify(sig.displayName)} 简介=${JSON.stringify((sig.bio ?? "").slice(0, 40))} 推文数=${sig.recentTweets.length} 年龄=${sig.accountAgeDays ?? "?"}`,
          );
        }
        if (base.decision !== "pass") {
          // 判定留痕。没有这个，「安静」和「坏了」在外部看来完全一样 ——
          // 上一次排查就卡在这里。也让每一条处理当场可复核，而不用事后
          // 去翻处理记录。
          console.info(
            `[MXGA] baseline ${base.decision} @${sig.handle} ${JSON.stringify(sig.displayName)} · ${base.reasons[0] ?? ""}`,
          );
        }
        if (base.decision === "ban") {
          renderHit(
            anchor,
            key,
            sig,
            {
              userId: sig.userId ?? "",
              handle: sig.handle,
              verdict: {
                label: base.category === "porn" ? "porn_bot" : "spam",
                confidence: 1,
                // 写出命中的**具体**证据（哪条短语 / 哪个模板 / 相似度多少）。
                //
                // 这里曾经只写「本地模型命中 · 类别」，理由是垃圾号会截图
                // 自己的封禁页、泄露关键词等于送出绕过配方。但那个取舍把
                // 审计能力一起掐掉了：维护者自己也看不出一条处理凭什么发生，
                // 于是「误判可在处理记录复核」就成了一句空话。证据必须留下 ——
                // 一条无法复核的自动处理，和一条错误的自动处理一样危险。
                reasons: base.reasons.length
                  ? base.reasons
                  : [`本地模型命中 · ${CATEGORY_ZH[base.category]}`],
              },
              category: base.category,
              tier: "confirmed",
              source: "curated",
              updatedAt: new Date().toISOString(),
            },
            "baseline",
          );
          return;
        }

        // 3.（已移除）远端公榜查询。
        //    公榜里 27.7% 的条目由泛化词（"同城"/"vpn"/"主页"）单独命中
        //    产生，是已确认的误杀来源；而且它把 senumy_ipa 这类正常账号
        //    标成了 human 层（最高信任档），扩展会照单执行。既然判定已经
        //    由本地 baseline + 大模型接管，就没有理由再让一份我们既不控制
        //    也审不了的名单替用户做不可逆的动作。

        // 4. v0.4-era persistent cache, read-only since v0.5 (spam reused
        //    as-is; legit/uncertain only if signals unchanged so new evidence
        //    can still re-trigger).
        const cached = await cacheGet(key);
        if (cached) {
          const spammy = ["spam", "porn_bot", "likely_spam"].includes(cached.verdict.label);
          if (spammy || cached.signalsHash === signalsHash(sig)) {
            renderCached(anchor, key, sig, cached);
            void bumpStats({ cacheHits: 1 });
            return;
          }
        }

        // 4.5（已移除）随公榜下发的官方关键词规则。它们和公榜同源，
        //     "同城" / "vpn" / "主页" / "应该没人" 这些正是误杀来源。
        //     本地 baseline 的短语表取而代之，且每条都要签字。

        // 5. baseline 中间带 → 大模型兜底。
        //    刻意排在公榜 / 缓存 / 规则之后：那三条都能免费给出答案，已知
        //    账号绝不该烧一次调用。走到这里的才是真正的「不认识且有信号」。
        if (base.decision === "llm") {
          await classifyLlm(anchor, key, sig, base, ctx);
          return;
        }

        // 6. 三条路径都没命中，baseline 也不表态 → 中性状态，不做任何判断。
        badgeFor(anchor, key, sig, null);
      } finally {
        inFlight.delete(key);
      }
    }

    // ── 撤销通道 ──────────────────────────────────────────────────────
    // 设置页跑在扩展自己的上下文里，拿不到 x.com 的 ct0 cookie，所以无法
    // 直接调 X 的接口。它把撤销请求发到这里，由内容脚本用页面登录态执行。
    // 这条通道只做「解除」，不做「施加」—— 一个只能撤销的入口不需要额外
    // 的防误用考量。
    chrome.runtime.onMessage.addListener(
      (
        msg: { type?: string; kind?: string; userId?: string; handle?: string },
        _sender,
        sendResponse: (r: { ok: boolean; error?: string }) => void,
      ) => {
        // 必须显式返回 false：返回 true 表示「稍后会异步回复」，而这个
        // 监听器只处理 mxga-undo-x，其余消息若让通道悬着，Chrome 会抛
        // "message channel closed before a response was received"。
        if (msg?.type !== "mxga-undo-x") return false;
        void (async () => {
          try {
            const kind = msg.kind === "mute" ? "unmute" : "unblock";
            const { performXAction } = await import("../lib/x-action");
            const attempt = await performXAction(kind, msg.userId, msg.handle);
            // 404 = 本来就没拉黑/静音，对「撤销」而言等同成功。
            sendResponse({ ok: attempt.ok || attempt.status === 404 });
          } catch (e) {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        })();
        return true; // async
      },
    );

    // Persist the logged-in viewer's own handle for the options page's
    // whitelist self-service flow (apply for YOUR account only).
    let lastViewer: string | undefined;
    function captureViewer() {
      const v = viewerHandle();
      if (v && v !== lastViewer) {
        lastViewer = v;
        try {
          void chrome.storage.local.set({ "xss:viewer": { handle: v, ts: Date.now() } });
        } catch {
          /* non-fatal */
        }
      }
    }

    function scan() {
      captureViewer();
      const p = extractProfile();
      if (p) {
        const el = document.querySelector<HTMLElement>('[data-testid="UserName"]');
        if (el) {
          // Same skip rule as articles: untouched account + live mount → done.
          const hasMount = !!el.querySelector(":scope > .xss-mount");
          if (nodeHandle.get(el) !== p.handle || !hasMount) {
            if (nodeHandle.get(el) !== p.handle) clearMounts(el);
            nodeHandle.set(el, p.handle);
            void process(p, el, "profile");
          }
        }
      }
      // Account-keyed, NOT node-tagged: X virtualizes the list and recycles
      // <article> nodes, so a permanent per-node flag would skip recycled
      // (new) spam. Re-evaluate a node when its account changed or our badge
      // is missing; account-level cache/in-flight keep it cheap. Cheap key
      // first (link href only) — full extraction (fiber walk, innerText)
      // runs only for nodes that actually need (re-)processing.
      const topic = extractThreadTopic();
      // Reply detection: on a /user/status/<id> page every article whose own
      // permalink id differs from the focal id is a conversation reply — the
      // context where auto actions are allowed by default. Everything else
      // (home/list/search feeds, the focal tweet itself) is "feed".
      const focal = focalStatusId();
      for (const art of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
        const handle = handleFromArticle(art);
        const nameBlock = art.querySelector<HTMLElement>('[data-testid="User-Name"]');
        if (!handle || !nameBlock) continue;
        const hasMount = !!nameBlock.querySelector(":scope > .xss-mount");
        if (nodeHandle.get(art) === handle && hasMount) continue;
        const info = extractFromArticle(art);
        if (!info) continue;
        if (topic && !info.threadTopic) info.threadTopic = topic;
        if (nodeHandle.get(art) !== handle) clearMounts(nameBlock); // recycled node
        nodeHandle.set(art, handle);
        const sid = focal ? articleStatusId(art) : null;
        const ctx: ScanContext = focal && sid && sid !== focal ? "reply" : "feed";
        void process(info, nameBlock, ctx);
      }
    }

    const ui = await createShadowRootUi(ctx, {
      name: "xss-bubble",
      position: "overlay",
      anchor: "body",
      onMount(container) {
        const st = document.createElement("style");
        st.textContent = STYLE;
        container.appendChild(st);
        const bubble = createBubble(
          {
            onProcess(keys: string[], onProgress: (key: string, ok: boolean) => void) {
              // Batch panel: the user explicitly confirmed, so act immediately
              // (no 5s undo window). Sequential await keeps the native X
              // mute/block calls on x-action's global pacing; the bubble's
              // chips/progress/rows advance on every onProgress callback.
              void (async () => {
                for (const key of keys) {
                  const f = findings.find((x) => (x.userId || `h:${x.handle}`) === key);
                  if (!f) {
                    onProgress(key, false);
                    continue;
                  }
                  const sig: Signals = {
                    isProfile: false,
                    handle: f.handle,
                    displayName: f.displayName ?? "",
                    bio: "",
                    hasDefaultAvatar: false,
                    recentTweets: [],
                    ...(f.userId ? { userId: f.userId } : {}),
                    ...(f.avatarUrl ? { avatarUrl: f.avatarUrl } : {}),
                  };
                  // Take over any pending 5s-undo for this account — the batch
                  // action supersedes the preview window.
                  const pending = pendingActions.get(key);
                  if (pending) {
                    clearTimeout(pending.timer);
                    pendingActions.delete(key);
                  }
                  const ok = await executeHide(key, sig).catch(() => false);
                  onProgress(key, ok);
                }
              })();
            },
            onReviewEach() {
              const first = findings[0];
              if (first) {
                anchorByKey
                  .get(first.userId || `h:${first.handle}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            },
            onDismiss() {
              dismissed = true;
            },
            onAppeal(appeal) {
              openAppeal(appeal);
            },
            onToggleAuto(v: boolean) {
              // Persist; the onSettingsChange listener updates `settings` (and
              // echoes the new state back into the bubble, a no-op here).
              void setSetting("autoProcess", v);
            },
          },
          settings.bubblePos,
          actionVerb(settings.actionMode),
          {
            autoProcess: settings.autoProcess,
            autoCategoryCount: autoCategoryCount(settings),
            autoExpand: settings.autoExpand,
          },
        );
        container.appendChild(bubble.el);
        if (!settings.bubble) bubble.el.style.display = "none";
        bubbleApi = bubble;
        // The bubble's 已处理 list is SESSION-scoped: it persists across SPA
        // navigation (the content script and its in-memory archive live on),
        // but a full reload / freshly-opened X must start clean — resurrecting
        // the whole all-time history here read as "记录没清掉". The permanent
        // audit trail lives in the options 处理记录 page, not the corner bubble.
        //
        // We still read the pending-actions key: an X mute/block whose paced
        // queue died mid-flight (navigation / reload / tab close) never fired,
        // so resume it best-effort. This is protection follow-through, NOT
        // history display — resumed accounts are not seeded into 已处理.
        void getPendingActions().then((pending) => {
          if (pending.length) void resumeInterrupted(pending);
        });
        return bubble;
      },
    });
    ui.mount();

    // SPA navigation: flush pending hides (the user already chose to hide;
    // the block is recorded even if the row's DOM is gone), then drop all
    // per-page state so detached DOM nodes can be garbage-collected.
    ctx.addEventListener(window, "wxt:locationchange", () => {
      for (const [key, p] of pendingActions) {
        clearTimeout(p.timer);
        void executeHide(key, p.sig);
      }
      pendingActions.clear();
      anchorByKey.clear();
      findings = [];
      // Collapse the card and archive this page's processed rows — the
      // bubble follows the user across SPA navigations, so a stale open
      // panel over a new page reads as broken; the session's records stay
      // viewable in the 已处理 tab until a hard reload.
      bubbleApi?.pageReset();
    });

    let debounce: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(scan, 600);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    ctx.onInvalidated(() => {
      observer.disconnect();
      clearTimeout(debounce);
    });
    // Periodic tick so newly virtualized rows are revisited even when the
    // user stops scrolling (no new DOM mutations). ctx-bound: stops when
    // the content script is invalidated.
    ctx.setInterval(scan, 4000);
    // List / whitelist hot-swap (background sync or 立即更新): the lookup
    // maps already rebuilt via local-index's own onChanged hook, but rows
    // rendered with the OLD data keep their badge (scan skips mounted
    // nodes). Drop every neutral badge so the next scan re-evaluates the
    // page against the fresh list. Pending/hidden rows are untouched.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || (!changes[LIST_KEY] && !changes[WL_KEY])) return;
        for (const host of document.querySelectorAll<HTMLElement>(".xss-mount")) {
          // Badges live in the host's shadow root; keep pending-undo flows.
          if (host.shadowRoot?.querySelector(".xss-badge.pending")) continue;
          host.remove();
        }
        scan();
      });
    } catch {
      /* non-fatal */
    }
    scan();
  },
});
