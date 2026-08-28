// Local public-member index — backed by the remotely-synced list cache in
// chrome.storage.local (see list-sync.ts). Provides O(1) lookup by numeric
// userId and handle, and hot-swaps when the background sync stores a newer
// list (no page reload needed).
import { CATEGORY_ZH, type SpamCategory, categoryFromCode } from "./category";
import {
  LIST_KEY,
  type LiteRow,
  type StoredList,
  type StoredWhitelist,
  WL_KEY,
  getStoredList,
  getStoredWhitelist,
  validateLiteArtifact,
} from "./list-sync";
import { setLocalRules } from "./local-rules";
import type { Label, Verdict } from "./types";

const CODE_TO_LABEL: Record<string, Label> = { p: "porn_bot", s: "spam" };

export interface IndexEntry {
  userId: string;
  handle: string;
  verdict: Verdict;
  /** Server-assigned spam category (LLM / maintainer-curated). Drives the
   *  per-category action policy in settings.categoryActions. */
  category: SpamCategory;
  /** Publish provenance from the lite artifact's 3rd code char:
   *  'confirmed' = a human (maintainer) reviewed this entry ('h');
   *  'auto'      = AI/rule/mention auto-publish, or an old artifact without
   *                the tier char. Display-only on the client (弹层里的
   *                人工确认/自动收录)；being on the published list at all is
   *                what makes an entry auto-actable. */
  tier: "confirmed" | "auto";
  source: "curated" | "community";
  updatedAt: string; // ISO date
}

// ---- In-memory lookup structures ----
// Keep the original compact lite tuples in the maps and expand only an
// actual hit. Materializing a Verdict/reasons/date object for every one of
// 100k+ entries costs tens of megabytes per X tab on iOS.
type CompactIndexEntry = LiteRow;
let userIdMap: Map<string, CompactIndexEntry> | null = null;
let handleMap: Map<string, CompactIndexEntry> | null = null;
let indexUpdatedAt = new Date(0).toISOString();
// Official whitelist — accounts here are never returned by lookupLocal,
// whatever the blacklist says. Safety valve for false positives / appeals.
let wlIds = new Set<string>();
let wlHandles = new Set<string>();
let warmed = false;

function buildWhitelist(wl: StoredWhitelist): void {
  const ids = new Set<string>();
  const handles = new Set<string>();
  for (const [uid, handle] of wl.entries) {
    if (uid) ids.add(uid);
    if (handle) handles.add(handle.toLowerCase());
  }
  wlIds = ids;
  wlHandles = handles;
}

export function indexEntryFromRow(row: LiteRow, updatedAt: string): IndexEntry | null {
  const [userId, handle, code] = row;
  const label = CODE_TO_LABEL[String(code)[0] ?? ""];
  if (!label) return null;
  const category = categoryFromCode(String(code)[1]);
  const tier = String(code)[2] === "h" ? "confirmed" : "auto";
  return {
    userId,
    handle,
    verdict: {
      label,
      confidence: 1,
      reasons: [
        `公共黑名单收录 · ${CATEGORY_ZH[category]}${tier === "confirmed" ? " · 人工确认" : " · 自动收录"}`,
      ],
    },
    category,
    tier,
    source: "curated",
    updatedAt,
  };
}

function buildMaps(list: StoredList): void {
  const nextById = new Map<string, CompactIndexEntry>();
  const nextByHandle = new Map<string, CompactIndexEntry>();
  for (const row of list.entries) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const [userId, handle, code] = row;
    if (!CODE_TO_LABEL[String(code)[0] ?? ""]) continue;
    if (userId) nextById.set(userId, row);
    if (handle) nextByHandle.set(handle.toLowerCase(), row);
  }
  userIdMap = nextById;
  handleMap = nextByHandle;
  indexUpdatedAt = new Date(list.fetchedAt).toISOString();
  setLocalRules(list.rules);
}

// Hot-swap: when the background sync writes a newer list, every open context
// rebuilds its maps without a reload.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[LIST_KEY]?.newValue) buildMaps(changes[LIST_KEY].newValue as StoredList);
    if (changes[WL_KEY]?.newValue) buildWhitelist(changes[WL_KEY].newValue as StoredWhitelist);
  });
} catch {
  /* not an extension context (tests) — non-fatal */
}

async function getBundledSafariList(): Promise<StoredList | null> {
  if (import.meta.env?.SAFARI !== true) return null;
  try {
    const response = await fetch(chrome.runtime.getURL("blacklist-data.json"));
    if (!response.ok) throw new Error(`blacklist-data.json returned ${response.status}`);
    const raw = (await response.json()) as Record<string, unknown>;
    // Tolerant validation, same as the network-sync path: the packaged
    // snapshot is sanitized at build time, but a stray invalid row must not
    // void the whole offline fallback.
    const parsed = validateLiteArtifact(raw, { dropInvalidEntries: true });
    if (!parsed.ok) throw new Error(parsed.error);
    const generatedAt =
      typeof raw.generatedAt === "number" && Number.isFinite(raw.generatedAt)
        ? raw.generatedAt
        : Date.now();
    return {
      version: parsed.value.version ?? `bundled-${generatedAt}-${parsed.value.entries.length}`,
      fetchedAt: generatedAt,
      count: parsed.value.entries.length,
      entries: parsed.value.entries,
      ...(parsed.value.rules ? { rules: parsed.value.rules } : {}),
    };
  } catch (error) {
    console.error("Failed to load bundled Safari blacklist fallback:", error);
    return null;
  }
}

function requestBackgroundSync(): void {
  try {
    // Fire-and-forget: background owns the download. Safari starts with its
    // packaged snapshot, then receives newer versions via storage.onChanged.
    void chrome.runtime.sendMessage({ type: "list-sync" });
  } catch {
    /* background unavailable (tests) — keep the current maps */
  }
}

/** Warm the local index from the synced cache. Safari also carries a packaged
 *  snapshot because its background worker/storage may not be ready on the
 *  first page load; remote sync still replaces it as soon as it succeeds. */
export async function warmLocalIndex(): Promise<void> {
  if (warmed) return;
  // 远端黑名单已停用 —— 只预热白名单。
  //
  // 以前这里在拿不到黑名单缓存时会去 fetch 打包的 Safari 快照，再触发一次
  // 后台同步。黑名单停用后缓存永远是空的，那条兜底就变成了每次页面加载都
  // 白跑一遍：多一次注定失败的 runtime fetch，多一次没意义的同步请求。
  // 黑名单已经不参与判定了，加载它没有任何意义。
  const wl = await getStoredWhitelist();
  if (wl) buildWhitelist(wl);
  userIdMap ??= new Map();
  handleMap ??= new Map();
  warmed = true;
  // 白名单仍需保持新鲜：它是对 baseline / 大模型误判的最后一道保险。
  requestBackgroundSync();
}

/** Synchronous lookup by numeric userId. Returns null if not found. */
export function lookupByUserId(userId: string): IndexEntry | null {
  const row = userIdMap?.get(userId);
  return row ? indexEntryFromRow(row, indexUpdatedAt) : null;
}

/** Synchronous lookup by handle (case-insensitive). Returns null if not found. */
export function lookupByHandle(handle: string): IndexEntry | null {
  const row = handleMap?.get(handle.toLowerCase());
  return row ? indexEntryFromRow(row, indexUpdatedAt) : null;
}

/** Official-whitelist membership — shared guard for every local detection
 *  path (list lookup AND local keyword rules). */
export function isWhitelisted(userId?: string, handle?: string): boolean {
  if (userId && wlIds.has(userId)) return true;
  if (handle && wlHandles.has(handle.toLowerCase())) return true;
  return false;
}

/** Lookup by userId first, fall back to handle. Whitelisted accounts are
 *  never reported as hits. */
export function lookupLocal(userId?: string, handle?: string): IndexEntry | null {
  if (userId && wlIds.has(userId)) return null;
  if (handle && wlHandles.has(handle.toLowerCase())) return null;
  if (userId) {
    const byId = lookupByUserId(userId);
    if (byId) return byId;
  }
  if (handle) {
    return lookupByHandle(handle);
  }
  return null;
}

/** Total entries in the loaded index. */
export function indexSize(): number {
  return userIdMap ? userIdMap.size : 0;
}
