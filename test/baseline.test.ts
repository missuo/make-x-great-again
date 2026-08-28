import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { decorCount, normalizeForMatch } from "../src/baseline/normalize.ts";
import { type BaselineModel, score } from "../src/baseline/score.ts";

// 一个最小模型：真实模型由 scripts/baseline/train.mjs 从公榜训出，这里只
// 需要足以驱动三条定罪路径的结构。
const model: BaselineModel = {
  schema: 1,
  generatedAt: 0,
  params: { MIN_CLUSTER: 8, JACCARD_MERGE: 0.6, NGRAM: 3 },
  autoban: [["处男无偿", 66, 1758, "porn"]],
  evidence: [["查看主页简介", 26, 471, "porn"]],
  clusters: [
    {
      n: 402,
      v: 2,
      c: "附近好友约见真实资源点我头像",
      r: ["附近好友约见真实资源点我头像"],
      s: "附近好友约见👑真实资源💋点我头像",
      cat: "porn",
    },
    // 伪模板：短名字被很多真人共用。必须永远不定罪。
    { n: 14, v: 1, c: "eric", r: ["eric"], s: "ERIC", cat: "other" },
  ],
  handleModel: null,
};

const at = (displayName: string, extra: Partial<Parameters<typeof score>[0]> = {}) =>
  score({ handle: "someone", displayName, ...extra }, model);

test("归一化：中和形近字、零宽字符、全角与装饰符号", () => {
  // 上→丄、门→椚 是公榜数据里可直接观察到的规避手法
  assert.equal(normalizeForMatch("同城丄门"), "同城上门");
  assert.equal(normalizeForMatch("桐城上椚"), "桐城上门");
  // 零宽字符插在词中间打断匹配
  assert.equal(normalizeForMatch("同城‌上门"), "同城上门");
  // 全角、装饰 emoji、分隔符
  assert.equal(normalizeForMatch("同城🌸上门｜"), "同城上门");
  // 拼音替换
  assert.equal(normalizeForMatch("chu男无偿"), "处男无偿");
  assert.equal(normalizeForMatch("约p"), "约炮");
  assert.equal(decorCount("罗琦🌸同城上门♥极品外围"), 2);
});

test("定罪路径 1：人工点名短语命中昵称或简介", () => {
  assert.equal(at("罗琦🌸同城上门♥极品外围").decision, "ban");
  // 形近字变体走同一条路径
  assert.equal(at("周诗🌸同城丄门🌸外围喝🍵").decision, "ban");
  // 简介命中同样定罪
  assert.equal(at("小雨", { bio: "寻欢请私信" }).decision, "ban");
});

test("定罪路径 2：T1 高频短语，理由带可核对的统计口径", () => {
  const r = at("琳琳🌸chu男无偿🌸");
  assert.equal(r.decision, "ban");
  assert.match(r.reasons[0] ?? "", /处男无偿/);
  assert.match(r.reasons[0] ?? "", /1758 个账号/);
});

test("定罪路径 3：整名匹配批量模板", () => {
  const r = at("附近好友约见👑真实资源💋点我头像");
  assert.equal(r.decision, "ban");
  // 类别必须随判定一起返回 —— 消费端按类别执行分级动作
  assert.equal(r.category, "porn");
});

test("泛化词单独出现绝不定罪 —— 这是旧规则集误杀的根源", () => {
  // 这些词都曾是线上规则，合计命中 13,834 个账号且零 AI 复核。
  // 任何一条重新具备单独定罪能力，这个测试就必须失败。
  for (const name of [
    "同城生活指南",
    "北京线下活动召集",
    "我的主页有更多内容",
    "详见简介",
    "免费资源分享",
    "VPN 测评博主",
    "Visa 卡研究",
    "人肉搜索观察",
  ]) {
    assert.notEqual(at(name).decision, "ban", `不应定罪: ${name}`);
  }
});

test("短名字构成的伪模板不得定罪", () => {
  // 模型里确实有一个 n=14 的 "ERIC" 簇，但长度门槛必须拦住它
  assert.notEqual(at("ERIC").decision, "ban");
  assert.notEqual(at("勃勃 CO").decision, "ban");
});

test("正常账号：无信号则彻底放行，不消耗 LLM 预算", () => {
  const r = score(
    {
      handle: "btc_jx",
      displayName: "BTC 江湖",
      bio: "分享行情观察，不荐币。",
      accountAgeDays: 1200,
    },
    model,
  );
  assert.equal(r.decision, "pass");
  assert.equal(r.score, 0);
});

test("弱信号叠加只送 LLM，绝不直接定罪", () => {
  const r = score(
    {
      handle: "irishumee6vd",
      displayName: "Sophie 🌸🌈",
      accountAgeDays: 3,
      hasDefaultAvatar: true,
    },
    model,
  );
  assert.equal(r.decision, "llm");
  assert.ok(r.score >= 2);
});

test("翻译护栏：X 机翻的推文不参与中文短语匹配", () => {
  const withGuard = score(
    {
      handle: "someone",
      displayName: "Normal Name",
      recentTweets: ["处男无偿"],
      tweetsTranslated: true,
    },
    model,
  );
  assert.equal(withGuard.score, 0);
});

// ── 以下用真实训练产物验收 ──────────────────────────────────────────
// 上面的用例跑的是手搓的最小模型，验的是判定逻辑；这一组直接加载
// data/baseline/model.json，验的是「实际发出去的那份模型」的行为。
// 判定逻辑对但模型内容错，用户一样会被误杀。
const realModel = JSON.parse(
  fs.readFileSync(new URL("../data/baseline/model.json", import.meta.url), "utf8"),
) as BaselineModel;
const signoff = JSON.parse(
  fs.readFileSync(new URL("../data/baseline/approved-phrases.json", import.meta.url), "utf8"),
) as { approved: string[]; never_approve: string[] };

const real = (displayName: string, bio = "") =>
  score({ handle: "someone", displayName, bio }, realModel);

test("真实模型：普通中文昵称不得被定罪", () => {
  // 维护者点名确认过的正常账号形态 —— 短名字、常见词、看起来像号但不是
  for (const name of [
    "博博",
    "CDCO",
    "硅谷居士",
    "ERIC",
    "BTC 江湖",
    "Jill Woolf",
    "- 大洋 ｜买美股上币安",
    "同城生活指南",
    "北京线下沙龙",
    "免费资源分享",
    "VPN 测评",
  ]) {
    assert.notEqual(real(name).decision, "ban", `不应定罪: ${name}`);
  }
});

test("真实模型：已签字的招揽话术必须定罪", () => {
  for (const name of [
    "罗琦🌸同城上门♥极品外围",
    "周诗🌸同城丄门🌸外围喝🍵", // 形近字变体
    "琳琳🌸chu男无偿🌸", // 拼音替换
    "💎真实约见❗️附近好友匹配💓",
    "线下资源🌈1-5线同步更新🌈看简介",
  ]) {
    assert.equal(real(name).decision, "ban", `应当定罪: ${name}`);
  }
  // 简介命中同样定罪
  assert.equal(real("小雨", "同城上门，详聊").decision, "ban");
});

test("真实模型：never_approve 名单里的词一条都不得具备定罪能力", () => {
  // 这些是旧规则集里真实存在过的条目，合计误伤 13834 个账号。
  // 任何一条重新出现在 autoban 里，或单独出现就能定罪，测试必须失败。
  const banPhrases = new Set(realModel.autoban.map(([p]) => p));
  for (const word of signoff.never_approve) {
    assert.ok(!banPhrases.has(word), `${word} 不得进入 autoban`);
    assert.notEqual(real(`我是${word}爱好者`).decision, "ban", `${word} 单独出现不得定罪`);
  }
});

test("真实模型：签字文件与产物一致，无静默失效条目", () => {
  const banPhrases = new Set(realModel.autoban.map(([p]) => p));
  const missing = signoff.approved.filter((p) => !banPhrases.has(p));
  assert.deepEqual(missing, [], `签字了但未生效: ${missing.join(", ")}`);
  // 反向：产物里不能出现没签过字的定罪短语
  const unsigned = [...banPhrases].filter((p) => !signoff.approved.includes(p));
  assert.deepEqual(unsigned, [], `未签字却有定罪权: ${unsigned.join(", ")}`);
});

test("真实模型：推文模板必须定罪 —— 昵称无招揽词的整批色情号", () => {
  // 2026-08-08 实测盲区：这批号昵称是「普通中文名 + 一个 emoji」，
  // 不含任何招揽词，昵称路径 100% 放行；垃圾特征只在推文里，且是一字
  // 不差的模板。一屏 144 个账号零定罪就是这么来的。
  const cases: [string, string][] = [
    ["友枫🌸", "应该没人比我玩的开了吧🌸🍒 我福不黑不信你看"],
    ["惜天🌸", "我果然太涩了🌸🎬 有人想锐评一下我的福嘛"],
    ["凌晴🌸", "比我好看的没我骚🌸🧊比我骚的没我好看"],
  ];
  for (const [displayName, tweet] of cases) {
    const r = score({ handle: "x", displayName, recentTweets: [tweet] }, realModel);
    assert.equal(r.decision, "ban", `应当定罪: ${displayName} / ${tweet}`);
  }
  // 断言「模板匹配」这条路径本身还活着。必须挑一条**只有它能抓**的样本：
  // 上面三条都含人工点名短语（我福不黑 / 好看的没我骚 / 锐评），会被更高
  // 优先级的路径接走，用它们断言路径等于什么都没测。
  const onlyTemplate = score(
    {
      handle: "x",
      displayName: "某某",
      recentTweets: [
        "22岁女大 身高168cm 接线下 口嗨的勿扰 喝🍵可以深入哟 ~桐👩‍🙅城🌸上🖤椚~下方👇👇可联系✈",
      ],
    },
    realModel,
  );
  assert.equal(onlyTemplate.decision, "ban");
  assert.match(onlyTemplate.reasons[0] ?? "", /推文匹配批量模板/);
});

test("真实模型：翻译护栏 —— X 机翻的推文不得据以定罪", () => {
  // 中文模板可能与一条正常外语推的机翻译文意外重合，而那不是作者的措辞。
  const r = score(
    {
      handle: "x",
      displayName: "Someone",
      recentTweets: ["应该没人比我玩的开了吧 我福不黑不信你看"],
      tweetsTranslated: true,
    },
    realModel,
  );
  assert.notEqual(r.decision, "ban");
});

test("真实模型：短昵称按复用规模分档，重名真人不被误伤", () => {
  // 97 个账号逐字复用的 7 字昵称 → 定罪
  assert.equal(real("🌸催情🌸春🌸男用🌸听话🌸").decision, "ban");
  // 短且复用少的普通名字 → 放行
  for (const n of ["ERIC", "博博", "CDCO", "硅谷居士", "zhuozhuo", "wang peng", "Mick"]) {
    assert.notEqual(real(n).decision, "ban", `不应定罪: ${n}`);
  }
});

test("真实模型：人工点名短语也覆盖推文（证据只在推文里的账号）", () => {
  // 2026-08-11 实测漏杀 @LFlynn54692：昵称 "kitty🍊" 无招揽词，扩展在
  // 时间线上又拿不到 bio（靠 React fiber，结构变了就取空），整条证据只在
  // 推文里。只查昵称/简介的话这类账号直接放行。
  const r = score(
    {
      handle: "LFlynn54692",
      displayName: "kitty🍊",
      recentTweets: ["玩归玩闹归闹😍给你看福我不开玩笑"],
    },
    realModel,
  );
  assert.equal(r.decision, "ban");
  assert.match(r.reasons[0] ?? "", /推文含人工指定招揽用语/);
});

test("真实模型：短词的例外上下文 —— 看福 不得误伤地名与正常搭配", () => {
  // "看福" 是维护者点名要封的，但它同时是"看福建/看福州/看福音"的子串。
  // 没有例外表就会按地名封人。
  for (const tweet of [
    "今天去看福建的朋友",
    "带你看福州的变化",
    "我在看福音书",
    "看福利待遇请点主页",
  ]) {
    const r = score({ handle: "x", displayName: "某某", recentTweets: [tweet] }, realModel);
    assert.notEqual(r.decision, "ban", `不应定罪: ${tweet}`);
  }
});

test("真实模型：@导流诱饵 —— 靠结构定罪，不靠堆词表", () => {
  // 2026-08-12 实测漏杀的一整类：短挑逗 + @跳转 + 乱码填充，无链接。
  // 寄生账号看起来完全正常（英文名、真实头像、昵称简介都干净），
  // 前四条判定路径全部放行。
  const baits = [
    "sao货fi 没人比她sao❣️ @77_chaaan 5m",
    "刷了半天的X ga就她主页能打✈️了@rezze_chan 2n",
    "刷了半天的X oy就她的主页能打✈️了@tatekei250o",
    "+她太涩了mt我真顶不住 @leilaronson 7c",
    "比她好看的没她骚比她骚的没她好看@ffoo8899 🤠",
  ];
  for (const tw of baits) {
    const r = score({ handle: "x", displayName: "Sara", recentTweets: [tw] }, realModel);
    assert.equal(r.decision, "ban", `应当定罪: ${tw}`);
  }
});

test("真实模型：带 @ 的正常回复不得被诱饵规则误伤", () => {
  // 「短句 + @ + 挑逗词」三条件不足以定罪 —— 正常的动漫/影视讨论同样满足。
  // 第四个条件（乱码填充字符）才是这类诱饵真正的指纹。
  const innocent = [
    "@bot 这角色太涩了吧，官方也太会了，不过我还是更喜欢前作的人设风格和剧情安排呢",
    "@friend 这部片子真的好看，推荐给你",
    "@colleague 这个骚操作我服了",
    "@老王 明天一起吃饭？",
    "@team PR 已经 merge 了，v2 分支可以拉了",
  ];
  for (const tw of innocent) {
    const r = score({ handle: "x", displayName: "某某", recentTweets: [tw] }, realModel);
    assert.notEqual(r.decision, "ban", `不应定罪: ${tw}`);
  }
});

test("真实模型：诱饵规则同样受翻译护栏约束", () => {
  const r = score(
    {
      handle: "x",
      displayName: "Someone",
      recentTweets: ["+她太涩了mt我真顶不住 @leilaronson 7c"],
      tweetsTranslated: true,
    },
    realModel,
  );
  assert.notEqual(r.decision, "ban");
});

test("拼音 sao 紧邻汉字时归一化成骚 —— 实测漏杀的人称变体", () => {
  const r = score(
    { handle: "x1", displayName: "小美", recentTweets: ["比我好看的没我Sao🌘😎比我Sao的没我好看"] },
    model,
  );
  assert.equal(r.decision, "ban");
});

test("纯英文语境的 sao/pao 不被改写", () => {
  assert.equal(normalizeForMatch("Sao Paulo travel"), "saopaulotravel");
  const r = score({ handle: "traveler", displayName: "Sao Paulo Guide", bio: "Paolo" }, model);
  assert.notEqual(r.decision, "ban");
});

test("昵称含返佣直接定罪且归入 crypto", () => {
  const r = score({ handle: "ELCULIAU", displayName: "团子热币93返佣Visa卡可领" }, model);
  assert.equal(r.decision, "ban");
  assert.equal(r.category, "crypto");
});

test("推文里聊返佣不定罪 —— 该短语限定昵称/简介", () => {
  const r = score(
    { handle: "trader", displayName: "老王", recentTweets: ["这家交易所返佣多少？"] },
    model,
  );
  assert.notEqual(r.decision, "ban");
});
