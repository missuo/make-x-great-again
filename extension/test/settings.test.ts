import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CATEGORY_ACTIONS, getSettings } from "../lib/settings";

test("preserves X-native action settings across browser builds", async () => {
  const root = globalThis as unknown as { chrome?: unknown };
  const previousChrome = root.chrome;
  root.chrome = {
    storage: {
      local: {
        get: async () => ({
          "xss:settings": {
            actionMode: "mute",
            categoryActions: { porn: "block", crypto: "mute" },
          },
        }),
      },
    },
  };

  try {
    const settings = await getSettings();
    assert.equal(settings.actionMode, "mute");
    assert.equal(settings.categoryActions.porn, "block");
    assert.equal(settings.categoryActions.crypto, "mute");
    // 未存过的类别回落到默认值 —— 断言的是「合并行为」，不是某个具体
    // 默认动作，否则默认口径一变这个用例就会假失败。
    assert.equal(settings.categoryActions.gambling, DEFAULT_CATEGORY_ACTIONS.gambling);
  } finally {
    if (previousChrome === undefined) delete root.chrome;
    else root.chrome = previousChrome;
  }
});
