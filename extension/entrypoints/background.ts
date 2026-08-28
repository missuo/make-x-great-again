// Background service worker: owns the remote blocklist sync (download-only —
// a public artifact GET; nothing about the user is ever uploaded) and serves
// local health/stats lookups for the popup.
import type { DistillLogEntry } from "../lib/learned-store";
import { syncIfStale, syncList } from "../lib/list-sync";
import type { BgRequest, BgResponse, DryRunResult, Signals } from "../lib/types";

// ---- GitHub Device Flow (v0.4's login interaction, restored for the
// whitelist self-service). Public device-flow client id — NOT a secret
// (device flow has no client secret by design). The fetches live in the
// background because github.com's device endpoints don't serve CORS; the
// options page requests the optional github.com host permission first.
const GH_CLIENT_ID = "Ov23liP2AbdNePTyKUEA";

async function ghStart() {
  const r = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: GH_CLIENT_ID, scope: "read:user" }),
  });
  return (await r.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
  };
}

async function ghPoll(deviceCode: string) {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: GH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const j = (await r.json()) as { access_token?: string; error?: string };
  if (!j.access_token) return { pending: j.error ?? "pending" };
  const { setGh } = await import("../lib/auth");
  const u = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${j.access_token}`, accept: "application/vnd.github+json" },
  });
  const user = (await u.json()) as { login?: string };
  await setGh(j.access_token, user.login ?? "github");
  return { login: user.login ?? "github" };
}

/**
 * 自学习循环 1：从一个用户亲手确认的垃圾账号里蒸馏可复用规则。
 *
 * 每一条分支都写日志，包括「没配 AI」和「模型一条签名都没给」。
 * 「没学到规则」在外部看来是同一种沉默，但底下是四种完全不同的原因，
 * 分不出来就没法排查 —— 这个函数的返回值和日志就是唯一的诊断入口。
 *
 * 任何失败都不向上抛：蒸馏是锦上添花，绝不能影响用户已经做出的那次拉黑。
 */
async function runDistill(sig: Signals, note?: string): Promise<DistillLogEntry> {
  const { appendDistillLog } = await import("../lib/learned-store");
  const sample = [sig.displayName, sig.bio, sig.triggeringComment ?? sig.recentTweets[0] ?? ""]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 200);
  const base = { ts: Date.now(), handle: sig.handle, displayName: sig.displayName, sample };

  const write = async (e: DistillLogEntry) => {
    await appendDistillLog(e);
    return e;
  };

  try {
    const { distill, llmEnabled } = await import("../lib/llm");
    if (!(await llmEnabled())) {
      return write({ ...base, status: "not_configured", added: [], rejected: [] });
    }
    const sigs = await distill({
      handle: sig.handle,
      displayName: sig.displayName,
      bio: sig.bio,
      recentTweets: sig.recentTweets,
      triggeringComment: sig.triggeringComment,
      note,
    });
    if (!sigs.length) {
      return write({ ...base, status: "no_signatures", added: [], rejected: [] });
    }
    const { addDrafts } = await import("../lib/learned-store");
    const report = await addDrafts(sigs);
    const { describeRule } = await import("../../src/baseline/learned.ts");
    return write({
      ...base,
      status: report.added.length ? "added" : "all_rejected",
      added: report.added.map(describeRule),
      rejected: report.rejected,
    });
  } catch (e) {
    return write({
      ...base,
      status: "error",
      added: [],
      rejected: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * 试学：跑完整的蒸馏 + 准入体检，但**不写任何东西**。
 *
 * 存在的理由是可诊断性。「没学到规则」有四种原因（没配 AI、调用失败、
 * 模型没给签名、签名被体检拦下），它们在外部表现完全一致，但需要完全
 * 不同的处理。这个入口把四选一压成一次点击，而且不需要真拉黑一个人。
 */
async function dryRunDistill(sample: {
  displayName: string;
  bio: string;
  tweet: string;
}): Promise<DryRunResult> {
  try {
    const { distill, llmEnabled } = await import("../lib/llm");
    if (!(await llmEnabled())) {
      return { status: "not_configured", signatures: [], checks: [] };
    }
    const sigs = await distill({
      handle: "preview",
      displayName: sample.displayName,
      bio: sample.bio,
      recentTweets: sample.tweet ? [sample.tweet] : [],
    });
    const signatures = sigs.map((s) => ({
      terms: s.terms,
      field: s.field,
      cat: s.cat,
      why: s.why,
    }));
    if (!sigs.length) return { status: "no_signatures", signatures, checks: [] };
    // 体检用**真实**的负样本与现存规则，否则试学结果和真跑不一致，
    // 那比没有这个功能更糟。
    const { getRules, negativeCorpus } = await import("../lib/learned-store");
    const { admit } = await import("../../src/baseline/learned.ts");
    const { getThresholds } = await import("../lib/learned-store");
    const guards = {
      negatives: await negativeCorpus(),
      existing: await getRules(),
      thresholds: await getThresholds(),
    };
    return {
      status: "ok",
      signatures,
      checks: sigs.map((d) => {
        const got = admit(d, guards);
        return got.ok
          ? { terms: d.terms, ok: true }
          : { terms: d.terms, ok: false, reason: got.reason };
      }),
    };
  } catch (e) {
    return {
      status: "error",
      signatures: [],
      checks: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

const SYNC_ALARM = "xss:list-sync";
// 6h cadence matches the server's mirror cron; the artifact itself only
// changes when the confirmed set changes, and version-match syncs are a
// single small meta GET.
const SYNC_PERIOD_MIN = 360;

export default defineBackground(() => {
  const ensureAlarm = () => {
    try {
      chrome.alarms.create(SYNC_ALARM, {
        periodInMinutes: SYNC_PERIOD_MIN,
        delayInMinutes: 1,
      });
    } catch {
      /* non-fatal */
    }
  };

  chrome.runtime.onInstalled.addListener(() => {
    ensureAlarm();
    void syncList(true); // fresh install / update → fetch immediately
  });
  chrome.runtime.onStartup.addListener(() => {
    ensureAlarm();
    void syncIfStale();
  });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === SYNC_ALARM) void syncList();
  });

  chrome.runtime.onMessage.addListener(
    (msg: BgRequest, _s: chrome.runtime.MessageSender, sendResponse: (r: BgResponse) => void) => {
      (async () => {
        try {
          if (msg.type === "health") {
            const { indexSize, warmLocalIndex } = await import("../lib/local-index");
            const { getStoredList } = await import("../lib/list-sync");
            await warmLocalIndex();
            const stored = await getStoredList();
            sendResponse({
              ok: true,
              data: {
                records: stored?.count ?? indexSize(),
                listVersion: stored?.version ?? null,
                listFetchedAt: stored?.fetchedAt ?? null,
              },
            });
          } else if (msg.type === "list-sync") {
            sendResponse({ ok: true, data: await syncList(!!msg.force) });
          } else if (msg.type === "stats") {
            const { getStats } = await import("../lib/stats");
            sendResponse({ ok: true, data: await getStats() });
          } else if (msg.type === "records") {
            sendResponse({ ok: true, data: { records: [] } });
          } else if (msg.type === "gh_start") {
            sendResponse({ ok: true, data: await ghStart() });
          } else if (msg.type === "gh_poll") {
            sendResponse({ ok: true, data: await ghPoll(msg.deviceCode) });
          } else if (msg.type === "open_options") {
            chrome.runtime.openOptionsPage();
            sendResponse({ ok: true });
          } else if (msg.type === "classify") {
            // baseline 中间带兜底。判定结果直接回给内容脚本，由它决定动作
            // 并写入本地缓存 —— background 不落库，保持无状态。
            const { classify, llmEnabled } = await import("../lib/llm");
            if (!(await llmEnabled())) {
              sendResponse({ ok: false, error: "llm_not_configured" });
            } else {
              const verdict = await classify(msg.sig);
              sendResponse({ ok: true, data: verdict });
            }
          } else if (msg.type === "distill") {
            sendResponse({ ok: true, data: await runDistill(msg.sig, msg.note) });
          } else if (msg.type === "distill_test") {
            sendResponse({ ok: true, data: await dryRunDistill(msg.sample) });
          } else if (msg.type === "consolidate") {
            const { consolidate, llmEnabled } = await import("../lib/llm");
            if (!(await llmEnabled())) {
              sendResponse({ ok: false, error: "llm_not_configured" });
            } else {
              const { getRules, negativeCorpus } = await import("../lib/learned-store");
              const rules = (await getRules()).filter((r) => r.status !== "retired");
              if (!rules.length) {
                sendResponse({ ok: true, data: { retire: [], merge: [], notes: [] } });
              } else {
                sendResponse({
                  ok: true,
                  data: await consolidate(
                    rules,
                    (await negativeCorpus()).map((n) => n.text),
                  ),
                });
              }
            }
          } else if (msg.type === "llm_test") {
            const { testConnection } = await import("../lib/llm");
            sendResponse({ ok: true, data: await testConnection() });
          } else if (msg.type === "report") {
            // Authenticated POST /v1/report from the SHARED extension origin
            // (same path the whitelist-apply flow uses), not the content
            // script — x.com's CORS/CSP would otherwise block it.
            const { getGhToken } = await import("../lib/auth");
            const { edgeBase } = await import("../lib/list-sync");
            const token = await getGhToken();
            if (!token) {
              sendResponse({ ok: false, error: "no_token" });
            } else {
              const base = await edgeBase();
              const res = await fetch(`${base}/v1/report`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify(msg.sig),
              });
              let body: unknown = {};
              try {
                body = await res.json();
              } catch {
                /* non-JSON error page */
              }
              sendResponse({ ok: true, data: { status: res.status, body } });
            }
          } else {
            sendResponse({ ok: false, error: "unknown message" });
          }
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true; // async response
    },
  );
});
