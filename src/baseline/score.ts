// Baseline 判定器 —— 服务端与扩展共用的纯函数，无 IO、无网络。
//
// 设计红线：模型只在「结构性高精度」的情况下定罪，其余一律不表态，
// 交给 LLM。宁可漏杀，不可误杀 —— 漏掉的账号可以靠上报补回来，误杀
// 一个正常人是不可逆的伤害。
//
// 三条定罪路径（且仅此三条）：
//   1. 人工点名短语命中 display_name / bio —— 维护者明确承担责任的一小撮
//   2. 训练挖出的 T1 短语命中 —— 挖掘按跨簇覆盖度产出候选，定罪权限须经
//      维护者在 data/baseline/approved-phrases.json 签字；任何 2 字泛化词
//      结构上都挖不出来（短语最小长度 4）
//   3. display_name 整名匹配上一个被 >=20 个账号复用、且本身 >=8 字符的模板簇
//
// 明确不定罪的信号（只加权）：handle 形态、账号年龄、默认头像、装饰
// emoji、T2 短语。其中 handle 形态在留出集上零假阳阈值召回仅 3.2%，
// 最佳准确率阈值下白名单假阳率高达 17.8% —— 单独用它定罪等于制造误杀。

import { decorCount, normalizeForMatch } from "./normalize.ts";

export interface BaselineModel {
  schema: number;
  generatedAt: number;
  params: { MIN_CLUSTER: number; JACCARD_MERGE: number; NGRAM: number };
  /** [短语, 跨簇数, 账号数, 主类别] —— 允许单独定罪 */
  autoban: [string, number, number, SpamCategory][];
  /** [短语, 跨簇数, 账号数, 主类别] —— 仅加权，永不单独定罪 */
  evidence: [string, number, number, SpamCategory][];
  /** 昵称模板簇：n=账号数, v=变体数, c=归一化质心, r=多个代表点, s=原始样例, cat=主类别 */
  clusters: { n: number; v: number; c: string; r?: string[]; s: string; cat: SpamCategory }[];
  /** 推文模板簇。整批色情号昵称是「普通中文名 + emoji」，垃圾特征只在
   *  推文里，且是一字不差的模板 —— 没有这一路，它们 100% 放行。 */
  tweetClusters?: { n: number; v: number; r: string[]; s: string; cat: SpamCategory }[];
  handleModel: { thr: number; weights: Record<string, number> } | null;
}

export interface ScoreInput {
  handle: string;
  displayName: string;
  bio?: string;
  recentTweets?: string[];
  triggeringComment?: string | undefined;
  /** 推文文本是 X 自己的机器翻译（原文不可得）。中文短语不得与之匹配，
   *  否则会把一条被翻成中文的正常外语推当成命中。 */
  tweetsTranslated?: boolean;
  accountAgeDays?: number;
  hasDefaultAvatar?: boolean;
}

export type Decision = "ban" | "llm" | "pass";

/** 与 extension/lib/category.ts 的 SpamCategory 一致 —— 消费端按类别配置动作。 */
export type SpamCategory = "porn" | "crypto" | "gambling" | "resource" | "marketing" | "other";

export interface ScoreResult {
  decision: Decision;
  score: number;
  /** 命中证据所属的主类别，供消费端执行分级动作。无命中时为 other。 */
  category: SpamCategory;
  /** 面向后台审阅的人类可读理由，每条都能追溯到具体证据 */
  reasons: string[];
}

/**
 * 维护者人工指定、允许单独定罪的短语。
 *
 * 这份列表是**主观的**，且刻意与训练挖掘出的 T1 分开存放 —— 挖掘结果
 * 靠计数说话，这里靠维护者担责。任何新增都必须是「在个人简介或昵称里
 * 出现即无正当用法」的招揽用语，不得放入 "同城" / "线下" / "主页" 这类
 * 单独出现完全正常的词。
 */
export interface CuratedPhrase {
  /** 归一化后要匹配的串。 */
  p: string;
  /** 该短语所属类别。缺省 porn —— 人工点名的绝大多数是色情招揽用语。 */
  cat?: SpamCategory;
  /** 匹配范围。缺省全字段（含推文）；"own" 只查昵称/简介。
   *
   *  区分的理由：招揽话术（同城上门）出现在推文里同样是招揽，但交易所
   *  返佣这类词在推文里可能是正常讨论（"这家返佣多少"），只有写进自己的
   *  昵称/简介才是身份声明。 */
  scope?: "own";
  /** 例外上下文：命中这些更长的串时不算数。
   *
   *  短词必须带例外表。"看福" 是维护者点名要封的（色情号的"看福利"话术），
   *  但它同时是"看福建 / 看福州 / 看福音"的子串 —— 没有例外表就会按地名
   *  封人。规则是：例外只能是**明确无辜**的更长搭配，不能用来兜底。 */
  not?: string[];
}

export const CURATED_HARD_BAN: readonly CuratedPhrase[] = [
  { p: "同城上门" },
  { p: "线下上门" },
  { p: "上门喝茶" },
  { p: "喝茶选妃" },
  { p: "约炮" },
  { p: "寻欢" },
  { p: "找炮友" },
  { p: "一夜情" },
  { p: "性伴侣" },
  // 2026-08-12 维护者点名：色情号的"福"= 福利（涩图/视频）话术。
  // 实测漏杀 @LFlynn54692「玩归玩闹归闹给你看福我不开玩笑」。
  { p: "看福", not: ["看福建", "看福州", "看福音", "看福气", "看福利待遇", "看福利政策"] },
  { p: "给你看福" },
  // 同一套文案的人称变体。对方把「我」换成「她」再掺随机字符和不同的
  // @导流目标，每条都成了独立小簇，全都够不到模板簇的 20 账号门槛 ——
  // 整簇匹配对这种打散手法无效，只能靠短语。2026-08-12 实测漏杀
  // 「比她好看的没她骚比她骚的没她好看@XXkk886」。
  { p: "好看的没我骚" },
  { p: "好看的没她骚" },
  { p: "我福不黑" },
  { p: "她福不黑" },
  // 2026-08-12 实测漏杀「刷了半天的X就她的主页h6能打了」。「主页能打」
  // 不是普通中文搭配，是这一族色情导流号的固定话术；原本只在诱饵规则的
  // 词表里，而那条规则要求同时有 @跳转 —— 这条没有 @，于是整条放行。
  { p: "主页能打" },
  // 2026-08-12 维护者点名：交易所返佣号把话术直接写进昵称
  // （"团子热币93返佣Visa卡可领"）。推文写的是无害闲聊，前面每条路径都
  // 放行 —— 唯一的证据就在昵称里。限定 own：推文里聊"返佣"是正常的。
  { p: "返佣", cat: "crypto", scope: "own" },
];

/**
 * 「@导流诱饵」的挑逗词表。
 *
 * 这类推文的结构是固定的：一句短挑逗 + @跳转到另一个账号 + 几个随机噪声
 * 字符（oy / mt / 7c / g-qp），没有任何链接。寄生账号往往看起来很正常
 * （英文名、真实头像），昵称和简介都干净，所以前面所有路径都抓不到。
 *
 * 单独出现这些词一律不定罪 —— "太涩了" 正是当初被我删掉的误杀规则之一。
 * 只有「短句 + @跳转 + 挑逗词」三者同时成立才算数：正常人回复里带 @ 很
 * 常见，说 "她太涩了" 也很常见，但两者叠加在一条 40 字以内的短回复里，
 * 就只剩这一种解释。
 */
const BAIT_TOKENS: readonly string[] = [
  "主页能打",
  "太涩了",
  "好涩",
  "她骚",
  "没她骚",
  "我的福",
  "看福",
  "骚货",
  "顶不住",
  "玩的开",
  "锐评",
];
/** 诱饵句的长度上限（归一化后）。超过这个长度就不是「一句话诱饵」了。 */
const BAIT_MAX_LEN = 44;
/** 极短的诱饵不需要噪声字符佐证 —— 那个长度装不下正常语义。 */
const BAIT_SHORT_LEN = 20;

/**
 * 乱码填充字符 —— 这类诱饵最稳定的指纹。
 *
 * 样本里无一例外都掺了 1-3 个字符的孤立字母数字串（fi / ga / mt / oy /
 * 7c / 2n / 5m），用来打散文本指纹、躲避平台的重复内容检测。正常中文
 * 回复里几乎不会出现这种孤立乱码。
 *
 * 没有这一条时，「@bot 这角色太涩了吧，官方也太会了…」这种正常动漫讨论
 * 会被误封 —— 它同样满足「短句 + @ + 挑逗词」。
 */
function hasGarbledFiller(raw: string): boolean {
  // 先摘掉 @handle 和链接，它们本来就是字母数字，不算噪声
  const stripped = raw
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:^|[^A-Za-z0-9_@])@[A-Za-z0-9_]{1,15}\b/g, " ");
  // 孤立的 1-3 位字母数字串：两侧都不是字母数字（中文、空白、emoji 均可）
  const runs = stripped.match(/(?<![A-Za-z0-9])[A-Za-z0-9]{1,3}(?![A-Za-z0-9])/g);
  return (runs?.length ?? 0) >= 1;
}

/** 中间带阈值：达到即送 LLM 判定，达不到就彻底放行（不消耗 LLM 预算）。 */
const LLM_THRESHOLD = 2;

// 模板簇定罪的两道结构门槛。没有这两道时，验收集里出现过 "ERIC"(14 个
// 账号)、"勃勃 CO"(8)、"硅硲居土"(9) 这种「伪模板」—— 短名字本来就会被
// 很多不相干的真人共用，把它当模板等于按名字封人。
//
// 长度门槛是主力：8 个字符以上的昵称被 20 个以上账号逐字复用，这件事
// 本身就只可能是批量生产。两道门槛都不涉及语义判断。
// 昵称模板定罪的门槛：长度与复用规模挂钩，短名字要求更强的复用证据。
//
// 固定 8 字下限挡住了 "ERIC"(14 个账号共用)、"硅谷居士"、"勃勃 CO" 这类
// 伪模板 —— 短名字本来就会被不相干的真人共用。但它也一并挡掉了
// "催情春男用听话"（7 字、97 个账号逐字复用），那明显是批量号。
//
// 分档解决：8 字以上按常规门槛；6-7 字必须有 50 个以上账号复用才算数。
// 6 字以下一律不认 —— 那个长度的重名太廉价，多少个账号共用都可能是巧合。
const CLUSTER_MIN_NAME_LEN = 6;
const CLUSTER_MIN_ACCOUNTS = 20;
const CLUSTER_SHORT_NAME_LEN = 8;
const CLUSTER_SHORT_MIN_ACCOUNTS = 50;

/** 该簇是否够格定罪（长度 × 复用规模）。 */
function clusterConvictable(nameLen: number, accounts: number): boolean {
  if (nameLen < CLUSTER_MIN_NAME_LEN) return false;
  if (nameLen >= CLUSTER_SHORT_NAME_LEN) return accounts >= CLUSTER_MIN_ACCOUNTS;
  return accounts >= CLUSTER_SHORT_MIN_ACCOUNTS;
}

// 推文模板定罪的门槛，比昵称更严：推文更长、更容易偶然重合，而且一条
// 被误判的推文背后是一个可能完全正常的账号。
// 相似度 0.75（昵称是 0.6）+ 归一化后至少 12 字，是为了确保命中的是
// 「整条模板」而不是碰巧共享几个词 —— "太涩了" 这种片段永远够不到。
const TWEET_MIN_LEN = 12;
const TWEET_SIM = 0.75;
const TWEET_MIN_ACCOUNTS = 20;

function shingles(s: string, n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

/**
 * 每个模板簇代表点的 shingle 集合，按模型缓存。
 *
 * 没有这层缓存时，每判定一个账号都要把全部 1864 个簇 × 至多 8 个代表点
 * 的 shingle 重新切一遍 —— 实测最坏情况 1.9ms/账号。内容脚本在时间线上
 * 逐个账号跑，滚动时反复触发，这个开销会直接变成页面卡顿。
 *
 * 同时预建 3-gram 倒排索引：只有与待测昵称共享至少一个 3-gram 的簇才可能
 * 达到 Jaccard 阈值，其余可以整个跳过。
 */
interface ClusterIndex {
  reps: { ci: number; sh: Set<string> }[];
  byGram: Map<string, number[]>;
}
const clusterIndexCache = new WeakMap<BaselineModel, ClusterIndex>();
const tweetIndexCache = new WeakMap<BaselineModel, ClusterIndex>();

/** 推文模板簇的同款索引。 */
function tweetIndex(model: BaselineModel): ClusterIndex {
  const cached = tweetIndexCache.get(model);
  if (cached) return cached;
  const reps: ClusterIndex["reps"] = [];
  const byGram = new Map<string, number[]>();
  (model.tweetClusters ?? []).forEach((c, ci) => {
    if (c.n < TWEET_MIN_ACCOUNTS) return;
    for (const rep of c.r) {
      if (rep.length < TWEET_MIN_LEN) continue;
      const sh = shingles(rep, model.params.NGRAM);
      const idx = reps.length;
      reps.push({ ci, sh });
      for (const g of sh) {
        const arr = byGram.get(g);
        if (arr) arr.push(idx);
        else byGram.set(g, [idx]);
      }
    }
  });
  const built = { reps, byGram };
  tweetIndexCache.set(model, built);
  return built;
}

function clusterIndex(model: BaselineModel): ClusterIndex {
  const cached = clusterIndexCache.get(model);
  if (cached) return cached;
  const reps: ClusterIndex["reps"] = [];
  const byGram = new Map<string, number[]>();
  model.clusters.forEach((c, ci) => {
    for (const rep of c.r ?? [c.c]) {
      if (!clusterConvictable(rep.length, c.n)) continue;
      const sh = shingles(rep, model.params.NGRAM);
      const idx = reps.length;
      reps.push({ ci, sh });
      for (const g of sh) {
        const arr = byGram.get(g);
        if (arr) arr.push(idx);
        else byGram.set(g, [idx]);
      }
    }
  });
  const built = { reps, byGram };
  clusterIndexCache.set(model, built);
  return built;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function handleFeatures(h: string): string[] {
  const s = `^${h.toLowerCase()}$`;
  const f: string[] = [];
  for (let i = 0; i + 2 <= s.length; i++) f.push(s.slice(i, i + 2));
  for (let i = 0; i + 3 <= s.length; i++) f.push(s.slice(i, i + 3));
  f.push(`len:${Math.min(20, h.length)}`);
  f.push(`digits:${Math.min(4, (h.match(/\d/g) ?? []).length)}`);
  f.push(`tail:${/[a-z]{4,}[a-z0-9]{4,}$/.test(h) ? 1 : 0}`);
  return f;
}

export function score(input: ScoreInput, model: BaselineModel): ScoreResult {
  const reasons: string[] = [];
  const name = normalizeForMatch(input.displayName);
  const bio = normalizeForMatch(input.bio);
  // 昵称与简介是账号自己写的、X 不会翻译的字段 —— 只有这两处允许定罪。
  const ownWords = `${name} ${bio}`;

  // ── 定罪路径 1：人工点名短语 ──────────────────────────────────────
  //
  // 匹配范围包含推文，不只是昵称和简介：这批话术本来就同时出现在两处，
  // 而扩展在时间线上常常拿不到 bio（要靠 React fiber，结构变了就取空）。
  // 只查昵称/简介的话，「玩归玩闹归闹给你看福我不开玩笑」这种整条证据
  // 都在推文里的账号会直接放行 —— 2026-08-11 实测漏杀 @LFlynn54692。
  //
  // 推文侧仍受翻译护栏约束：X 机翻的中文不是作者的措辞。
  const tweetText =
    !input.tweetsTranslated && (input.recentTweets?.length || input.triggeringComment)
      ? normalizeForMatch([...(input.recentTweets ?? []), input.triggeringComment ?? ""].join(" "))
      : "";
  for (const entry of CURATED_HARD_BAN) {
    const hit = normalizeForMatch(entry.p);
    if (!hit) continue;
    const inOwn = ownWords.includes(hit);
    const inTweet = entry.scope !== "own" && tweetText.includes(hit);
    if (!inOwn && !inTweet) continue;
    // 例外上下文：命中的其实是一个无辜的更长搭配（看福 vs 看福建）
    const haystack = `${ownWords} ${tweetText}`;
    if (entry.not?.some((ex) => haystack.includes(normalizeForMatch(ex)))) continue;
    return {
      decision: "ban",
      score: 100,
      category: entry.cat ?? "porn",
      reasons: [`${inOwn ? "昵称/简介" : "推文"}含人工指定招揽用语「${entry.p}」`],
    };
  }

  // ── 定罪路径 2：训练挖出的 T1 短语 ────────────────────────────────
  for (const [phrase, clusterDF, accountDF, cat] of model.autoban) {
    if (ownWords.includes(phrase)) {
      return {
        decision: "ban",
        score: 100,
        category: cat ?? "other",
        reasons: [
          `昵称/简介含高频模板短语「${phrase}」（横跨 ${clusterDF} 个独立模板、覆盖 ${accountDF} 个账号）`,
        ],
      };
    }
  }

  // ── 定罪路径 3：整名匹配已知批量模板 ──────────────────────────────
  if (name.length >= CLUSTER_MIN_NAME_LEN) {
    const sh = shingles(name, model.params.NGRAM);
    const idx = clusterIndex(model);
    // 倒排索引取候选：不共享任何 3-gram 的簇，Jaccard 必为 0，无需计算。
    const candidates = new Set<number>();
    for (const g of sh) for (const r of idx.byGram.get(g) ?? []) candidates.add(r);
    let bestSim = 0;
    let bestCluster: BaselineModel["clusters"][number] | null = null;
    for (const r of candidates) {
      const rep = idx.reps[r];
      if (!rep) continue;
      const sim = jaccard(sh, rep.sh);
      if (sim > bestSim) {
        bestSim = sim;
        bestCluster = model.clusters[rep.ci] ?? null;
      }
    }
    if (bestCluster && bestSim >= model.params.JACCARD_MERGE) {
      return {
        decision: "ban",
        score: 100,
        category: bestCluster.cat ?? "other",
        reasons: [
          `昵称匹配批量模板（相似度 ${(bestSim * 100).toFixed(0)}%，该模板被 ${bestCluster.n} 个账号复用）：${bestCluster.s}`,
        ],
      };
    }
  }

  // ── 定罪路径 4：推文整条匹配已知批量模板 ──────────────────────────
  //
  // 这一路是补一个实测出来的致命盲区：整批色情号的昵称是「普通中文名 +
  // 一个 emoji」（友枫🌸 / 诗珊🌸 / 碧凡🌸），不含任何招揽词，前三条路径
  // 全部放行；垃圾特征只在推文里，而且是一字不差的模板（"应该没人比我玩
  // 的开了吧我福不黑不信你看" 被 1475 个账号复用）。一屏 144 个账号零定罪
  // 就是这么来的。
  //
  // 翻译护栏在这里尤其重要：X 把外语推文机翻成中文后，中文模板可能与
  // 一条正常外语推的译文意外重合，而那完全不是作者本人的措辞。
  if (!input.tweetsTranslated && input.recentTweets?.length) {
    const tIdx = tweetIndex(model);
    if (tIdx.reps.length) {
      for (const raw of [...input.recentTweets, input.triggeringComment ?? ""]) {
        const t = normalizeForMatch(raw);
        if (t.length < TWEET_MIN_LEN) continue;
        const sh = shingles(t, model.params.NGRAM);
        const candidates = new Set<number>();
        for (const g of sh) for (const r of tIdx.byGram.get(g) ?? []) candidates.add(r);
        let bestSim = 0;
        let best: NonNullable<BaselineModel["tweetClusters"]>[number] | null = null;
        for (const r of candidates) {
          const rep = tIdx.reps[r];
          if (!rep) continue;
          const sim = jaccard(sh, rep.sh);
          if (sim > bestSim) {
            bestSim = sim;
            best = model.tweetClusters?.[rep.ci] ?? null;
          }
        }
        if (best && bestSim >= TWEET_SIM) {
          return {
            decision: "ban",
            score: 100,
            category: best.cat ?? "other",
            reasons: [
              `推文匹配批量模板（相似度 ${(bestSim * 100).toFixed(0)}%，该模板被 ${best.n} 个账号复用）：${best.s}`,
            ],
          };
        }
      }
    }
  }

  // ── 定罪路径 5：@导流诱饵 ─────────────────────────────────────────
  //
  // 结构定罪，不是词表定罪：短句 + @跳转 + 挑逗词，三者缺一不可。
  // 2026-08-12 实测漏杀三条，全是这个形态：
  //   「刷了半天的X oy就她的主页能打✈️了@tatekei250o」
  //   「+她太涩了mt我真顶不住 @leilaronson 7c」
  // 寄生账号昵称干净（blinggboii / mauricio mucchi），前四条路径全放行。
  if (!input.tweetsTranslated) {
    for (const raw of [...(input.recentTweets ?? []), input.triggeringComment ?? ""]) {
      if (!raw) continue;
      // @ 要在原文里找：归一化会把它连同噪声一起留下，但长度判断要用归一化后的
      if (!/(?:^|[^A-Za-z0-9_@])@[A-Za-z0-9_]{1,15}\b/.test(raw)) continue;
      const t = normalizeForMatch(raw);
      if (!t || t.length > BAIT_MAX_LEN) continue;
      const hit = BAIT_TOKENS.find((tok) => t.includes(normalizeForMatch(tok)));
      if (!hit) continue;
      // 三者之外还要第四个条件：乱码填充，或短到装不下正常语义。
      // 少了这一条，正常的动漫/影视讨论（同样是短句+@+"太涩了"）会被误封。
      if (t.length > BAIT_SHORT_LEN && !hasGarbledFiller(raw)) continue;
      return {
        decision: "ban",
        score: 100,
        category: "porn",
        reasons: [`@导流诱饵：短回复含挑逗词「${hit}」并 @跳转到另一账号`],
      };
    }
  }

  // ── 以下全部只加权，任何一条都不足以定罪 ──────────────────────────
  let s = 0;

  let evidenceHits = 0;
  let category: SpamCategory = "other";
  for (const [phrase, , accountDF, cat] of model.evidence) {
    if (evidenceHits >= 2) break;
    if (ownWords.includes(phrase)) {
      if (!evidenceHits) category = cat ?? "other";
      evidenceHits++;
      s += 2;
      reasons.push(`昵称/简介含模板短语「${phrase}」（${accountDF} 个已知账号使用）`);
    }
  }

  // 推文只作弱证据，且受翻译护栏约束
  if (!input.tweetsTranslated && input.recentTweets?.length) {
    const tweets = normalizeForMatch(input.recentTweets.join(" "));
    for (const [phrase, , , cat] of model.autoban) {
      if (tweets.includes(phrase)) {
        if (category === "other") category = cat ?? "other";
        s += 2;
        reasons.push(`推文含高频模板短语「${phrase}」`);
        break;
      }
    }
  }

  const decor = decorCount(input.displayName);
  if (decor >= 2) {
    s += 1;
    reasons.push(`昵称含 ${decor} 个装饰性符号（模板常用作分隔）`);
  }

  if (model.handleModel) {
    const hs = handleFeatures(input.handle).reduce(
      (acc, f) => acc + (model.handleModel?.weights[f] ?? 0),
      0,
    );
    if (hs > model.handleModel.thr) {
      s += 1;
      reasons.push("handle 形态接近批量注册号（弱信号）");
    }
  }

  if (typeof input.accountAgeDays === "number" && input.accountAgeDays < 30) {
    s += 1;
    reasons.push(`账号注册仅 ${input.accountAgeDays} 天`);
  }

  if (input.hasDefaultAvatar) {
    s += 1;
    reasons.push("使用默认头像");
  }

  return { decision: s >= LLM_THRESHOLD ? "llm" : "pass", score: s, category, reasons };
}
