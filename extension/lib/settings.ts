// User-facing settings (chrome.storage.local, single object). Read at
// content-script start + live-updated via storage.onChanged. No PII.
import type { SpamCategory } from "./category";

/** How a confirmed spam account is handled when the user takes action:
 *  - "local": hide its posts only in this extension (display:none). Zero
 *    network — X never knows. Reversible from the options page. (default)
 *  - "mute":  X-native one-way mute. ta still exists for you, you just stop
 *    seeing them; ta is not notified; follow relationship is kept.
 *  - "block": X-native block. Mutual — breaks the follow relationship and
 *    hides you from each other. Strongest. */
export type ActionMode = "local" | "mute" | "block";

/** What happens automatically when an account on the public blacklist shows
 *  up in the timeline, per spam category:
 *  - "badge": only mark it (current shipped behavior) — user acts manually
 *  - "hide":  auto-hide locally (reversible from 处理记录)
 *  - "mute":  auto-hide + X-native mute (needs x.com permission)
 *  - "block": auto-hide + X-native block (needs x.com permission) */
export type CategoryAction = "badge" | "hide" | "mute" | "block";

export type CategoryActions = Record<SpamCategory, CategoryAction>;

export interface Settings {
  enabled: boolean; // master: passive detection on/off
  bubble: boolean; // show the corner bubble
  bubblePos: "tr" | "br"; // top-right / bottom-right
  actionMode: ActionMode; // what "隐藏" does to a flagged account
  categoryActions: CategoryActions; // per-category automatic action on list hits
  autoProcess: boolean; // master kill-switch for categoryActions auto hide/mute/block
  autoExpand: boolean; // pop the bubble card open when auto-processing starts (off = pill pulse only; better on narrow/mobile viewports)
  edgeBase: string; // advanced: override the service base URL — list/whitelist sync source, whitelist-apply backend AND outbound links
}

// 命中即拉黑 —— 本地部署的默认口径。
//
// 之所以敢把默认值从「仅标记」拉到「X 拉黑」，是因为判定源换了：命中不
// 再来自那份 27.7% 由泛化词单独产生的公榜，而是来自本地 baseline 的三条
// 结构性高精度路径（人工签字短语 / 高频模板短语 / 整名匹配批量模板）。
// 够不到这三条的账号 baseline 不表态，根本不会走到这里。
export const DEFAULT_CATEGORY_ACTIONS: CategoryActions = {
  porn: "block",
  crypto: "block",
  gambling: "block",
  resource: "block",
  marketing: "block",
  other: "block",
};

export const DEFAULTS: Settings = {
  enabled: true,
  bubble: true,
  bubblePos: "tr",
  actionMode: "block",
  categoryActions: { ...DEFAULT_CATEGORY_ACTIONS },
  autoProcess: true,
  autoExpand: true,
  edgeBase: "",
};

const KEY = "xss:settings";

/** Shallow merge + nested categoryActions merge (a stored partial object
 *  from an older version must not wipe the new keys). */
function withDefaults(partial: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULTS,
    ...(partial ?? {}),
    categoryActions: {
      ...DEFAULT_CATEGORY_ACTIONS,
      ...(partial?.categoryActions ?? {}),
    },
  };
}

export async function getSettings(): Promise<Settings> {
  try {
    const g = await chrome.storage.local.get(KEY);
    return withDefaults(g[KEY] as Partial<Settings>);
  } catch {
    return withDefaults(undefined);
  }
}

export async function setSetting<K extends keyof Settings>(k: K, v: Settings[K]): Promise<void> {
  try {
    const s = await getSettings();
    await chrome.storage.local.set({ [KEY]: { ...s, [k]: v } });
  } catch {
    /* non-fatal */
  }
}

/** Update the action for one spam category. */
export async function setCategoryAction(
  cat: keyof CategoryActions,
  action: CategoryAction,
): Promise<void> {
  const s = await getSettings();
  await setSetting("categoryActions", { ...s.categoryActions, [cat]: action });
}

/** Fires whenever settings change (any tab/page). Returns an unsubscribe. */
export function onSettingsChange(cb: (s: Settings) => void): () => void {
  const h = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && changes[KEY]) {
      cb(withDefaults(changes[KEY].newValue as Partial<Settings>));
    }
  };
  chrome.storage.onChanged.addListener(h);
  return () => chrome.storage.onChanged.removeListener(h);
}
