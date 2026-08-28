// Baseline 模型训练 —— 从公榜正样本里学出「模板簇 + 跨簇短语表」。
//
// 为什么不是普通的二分类器：我们没有负样本（白名单 2023 条且不含
// display_name）。用纯正样本训判别式模型，只会把生成这些标签的坏规则
// （"同城"/"vpn"/"主页" 单词命中）固化成不可解释的权重 —— 比现状更糟。
//
// 这里学的是「该账号是否属于一个被大量复用的批量模板」，这个问题正样本
// 自己就能回答，且高精度是结构性的：定罪需要整名匹配上模板，不是命中
// 一个碎片词。不属于任何模板 → 模型不表态，交给 LLM。
//
// 归一化逻辑从 src/baseline/normalize.ts 导入 —— 训练与推理必须共用同一份
// 实现，各存一份副本迟早会分叉，而分叉会静默地让整个模型失效。
//
// 用法: npx tsx scripts/baseline/train.ts <input.jsonl> [out.json]

import fs from "node:fs";
import path from "node:path";

import { decorCount, normalizeForMatch } from "../../src/baseline/normalize.ts";

// ── 超参 ────────────────────────────────────────────────────────────
const MIN_NAME_LEN = 4;      // 太短的名字没有模板信息量
const NGRAM = 3;             // 相似度用的字符 n-gram
const JACCARD_MERGE = 0.6;   // 建簇阈值
const MIN_CLUSTER = 8;       // 少于这么多账号复用 → 不算「批量模板」
const PHRASE_MIN_LEN = 4;    // 强短语最短长度。这一条同时自动淘汰了
                             // "同城"/"主页"/"简介"/"资源"/"线下" 这类
                             // 2 字泛化词 —— 不需要任何人工判断。
const PHRASE_MIN_CLUSTER_DF = 5;  // 至少横跨这么多个独立模板簇才算「耐用」
const PHRASE_MIN_ACCOUNT_DF = 50; // 账号量门槛。剔掉「跨簇数虚高但总量极小」
                                  // 的碎片（如 "小舟免费"：12 簇 / 15 账号，
                                  // 只是币圈簇里人名变体的切片，不是真短语）。
// 自动封禁档的门槛。同时满足这两条的短语才允许单独定罪 —— 对应你说的
// 「词频很高的那批毫无疑问直接 ban」。两条都是纯计数，不含人工判断。
const AUTOBAN_MIN_CLUSTER_DF = 20;
const AUTOBAN_MIN_ACCOUNT_DF = 1000;
// 推文模板：比昵称更严。推文更长、变体更多，且「正常人偶然写出同一句话」
// 的风险随句子变短急剧上升，所以最短长度和相似度门槛都提高。
const TWEET_MIN_LEN = 10;
const TWEET_JACCARD = 0.7;
const TWEET_MIN_CLUSTER = 20;

/** 该组样本里占比最高的类别。并列时取账号数最多的那个，确定性可复现。 */
function dominantCategory(members) {
  const tally = new Map();
  for (const m of members)
    for (const [c, n] of m.cats) tally.set(c, (tally.get(c) ?? 0) + n);
  let best = "other";
  let bestN = -1;
  for (const [c, n] of [...tally].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  return best;
}

const shingles = (s, n = NGRAM) => {
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
};

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ── 读取正样本 ──────────────────────────────────────────────────────
const inPath = process.argv[2];
const outPath = process.argv[3] ?? "data/baseline/model.json";
const APPROVED_PATH = "data/baseline/approved-phrases.json";
// 人工标注样本（扩展「处理记录」导出的 jsonl）。第 4 个参数，可选。
const SAMPLES_PATH = process.argv[4] ?? "data/baseline/human-samples.jsonl";
if (!inPath) {
  console.error("usage: npx tsx scripts/baseline/train.ts <input.jsonl> [out.json]");
  process.exit(1);
}
const rows = fs
  .readFileSync(inPath, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
console.log(`读入 ${rows.length} 条公榜条目`);

// 只用有内容证据的条目建模。没有 display_name 的行提供不了任何可学的
// 特征，把它们算进来只会让「模型覆盖率」这个数字虚高。
const named = rows.filter((r) => (r.display_name ?? "").trim());
console.log(`其中带 display_name: ${named.length}`);

// 按归一化名去重 —— 模板复用次数是要学的信号，但建簇时同一串文案只需
// 要一个代表，否则 O(n²) 比较里全是自己跟自己比。
const byNorm = new Map();
for (const r of named) {
  const n = normalizeForMatch(r.display_name);
  if (n.length < MIN_NAME_LEN) continue;
  let e = byNorm.get(n);
  if (!e)
    byNorm.set(
      n,
      (e = { norm: n, raw: r.display_name, count: 0, decor: decorCount(r.display_name), cats: new Map() }),
    );
  e.count++;
  // 类别随样本一起统计 —— 扩展的「自动处理策略」是按类别配置的，
  // 模型只给出「是 spam」而不给类别，消费端就没法执行分级动作。
  const cat = r.category ?? "other";
  e.cats.set(cat, (e.cats.get(cat) ?? 0) + 1);
}
const uniq = [...byNorm.values()].sort((a, b) => b.count - a.count);
console.log(`归一化后不重复名字: ${uniq.length}`);

// ── 建簇：按 n-gram 倒排索引找候选，避免 O(n²) 全比 ─────────────────
for (const u of uniq) u.sh = shingles(u.norm);
const inverted = new Map();
uniq.forEach((u, i) => {
  for (const g of u.sh) {
    let arr = inverted.get(g);
    if (!arr) inverted.set(g, (arr = []));
    if (arr.length < 4000) arr.push(i); // 超高频 n-gram 截断，防爆炸
  }
});

const parent = uniq.map((_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

for (let i = 0; i < uniq.length; i++) {
  const cand = new Set();
  for (const g of uniq[i].sh) for (const j of inverted.get(g) ?? []) if (j > i) cand.add(j);
  for (const j of cand) {
    if (find(i) === find(j)) continue;
    if (jaccard(uniq[i].sh, uniq[j].sh) >= JACCARD_MERGE) union(i, j);
  }
  if (i % 20000 === 0) console.log(`  建簇进度 ${i}/${uniq.length}`);
}

const groups = new Map();
uniq.forEach((u, i) => {
  const r = find(i);
  let g = groups.get(r);
  if (!g) groups.set(r, (g = []));
  g.push(u);
});

// 簇「规模」= 复用该模板的账号总数（不是不重复名字数）
const clusters = [...groups.values()]
  .map((members) => {
    const accounts = members.reduce((s, m) => s + m.count, 0);
    const ranked = members.slice().sort((a, b) => b.count - a.count);
    // 多代表点：一个簇是靠传递合并连起来的，只存单一质心会让「链条远端」
    // 的成员在推理时匹配不上（币圈簇 960 账号 / 577 变体就是这种形态）。
    // 存前 N 个最常见变体作为代表，推理时取最大相似度。
    const reps = ranked.slice(0, 8).map((m) => m.norm);
    return {
      accounts,
      variants: members.length,
      centroid: ranked[0].norm,
      reps,
      sample: ranked[0].raw,
      category: dominantCategory(members),
      members,
    };
  })
  .filter((c) => c.accounts >= MIN_CLUSTER)
  .sort((a, b) => b.accounts - a.accounts);

console.log(`\n达到 ${MIN_CLUSTER} 账号门槛的模板簇: ${clusters.length}`);
console.log(`被模板簇覆盖的账号: ${clusters.reduce((s, c) => s + c.accounts, 0)} / ${named.length}`);

console.log("\n=== 最大的 15 个模板簇 ===");
for (const c of clusters.slice(0, 15)) {
  console.log(`  ${String(c.accounts).padStart(5)} 账号 / ${String(c.variants).padStart(4)} 变体  ${JSON.stringify(c.sample).slice(0, 60)}`);
}

// ── 挖掘跨簇短语 ────────────────────────────────────────────────────
// 一个短语的价值不在于它出现了多少次，而在于它横跨多少个「相互独立」的
// 模板簇。只在一个簇里出现 = 那串文案的一部分，换个模板就失效；横跨很多
// 簇 = 这门生意绕不开的词。这个判据把主观判断排除在外。
const coverage = new Map(); // phrase -> Set<clusterIndex>
const accountDF = new Map();
const phraseCats = new Map(); // phrase -> Map<category, count>
clusters.forEach((c, ci) => {
  for (const m of c.members) {
    const cjk = m.norm.replace(/[^一-鿿]/g, "");
    const seen = new Set();
    for (let k = PHRASE_MIN_LEN; k <= 8; k++)
      for (let i = 0; i + k <= cjk.length; i++) seen.add(cjk.slice(i, i + k));
    for (const g of seen) {
      let cov = coverage.get(g);
      if (!cov) coverage.set(g, (cov = new Set()));
      cov.add(ci);
      accountDF.set(g, (accountDF.get(g) ?? 0) + m.count);
      let pc = phraseCats.get(g);
      if (!pc) phraseCats.set(g, (pc = new Map()));
      for (const [c, n] of m.cats) pc.set(c, (pc.get(c) ?? 0) + n);
    }
  }
});

const topCategory = (tally) => {
  let best = "other";
  let bestN = -1;
  for (const [c, n] of [...(tally ?? new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  return best;
};

let phrases = [...coverage]
  .filter(([p, cov]) => cov.size >= PHRASE_MIN_CLUSTER_DF && (accountDF.get(p) ?? 0) >= PHRASE_MIN_ACCOUNT_DF)
  .map(([phrase, cov]) => ({
    phrase,
    cov,
    clusterDF: cov.size,
    accountDF: accountDF.get(phrase) ?? 0,
    category: topCategory(phraseCats.get(phrase)),
  }))
  // 长的优先：同覆盖度下更长的短语误伤面更小
  .sort((a, b) => b.clusterDF - a.clusterDF || b.phrase.length - a.phrase.length);

// 冗余折叠：若一个短语被已保留的某条包含（或包含已保留的某条），且两者
// 覆盖的模板簇集合完全一致，说明它们是同一个证据的不同切片 —— 只留最长
// 的那条。这自动消掉了 "城上门外"/"上门外围"/"同城上门外围" 这种切片群。
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const kept = [];
for (const p of phrases) {
  const dup = kept.some(
    (k) =>
      sameSet(k.cov, p.cov) && (k.phrase.includes(p.phrase) || p.phrase.includes(k.phrase)),
  );
  if (!dup) kept.push(p);
}
phrases = kept;

// 计数能选出「高频且跨模板」的短语，但分不开语境 —— "点击主页"(17612
// 账号) 与 "同城上门"(37769 账号) 的统计特征几乎一致，而在中文 X 的实际
// 语境里前者同样是色情招揽的固定说法。这只有人能判断。
//
// 所以计数门槛只用来**推荐审阅范围**，不限制授权范围：任何被挖掘出的
// 短语都可以签字。这把主观判断压缩到一份一眼能看完的文件，而不是散落在
// 20 万条记录里的逐条人工决定。
const recommended = phrases.filter(
  (p) => p.clusterDF >= AUTOBAN_MIN_CLUSTER_DF && p.accountDF >= AUTOBAN_MIN_ACCOUNT_DF,
);
let approvedSet = new Set();
let signoff = null;
try {
  signoff = JSON.parse(fs.readFileSync(APPROVED_PATH, "utf8"));
  approvedSet = new Set(signoff.approved ?? []);
} catch {
  console.log(`\n[warn] 未找到签字文件 ${APPROVED_PATH} —— 本次不授予任何短语自动封禁权限`);
}
// 授权范围 = 全部挖掘结果 ∩ 签字文件（不受计数门槛限制）
const autoban = phrases.filter((p) => approvedSet.has(p.phrase));
const pending = recommended.filter((p) => !approvedSet.has(p.phrase));
// 签字文件里写了、但本轮训练没挖到的短语：多半是数据变化导致该短语跌出
// 挖掘范围，必须显式报出来，否则会静默失去定罪能力。
const orphaned = [...approvedSet].filter((p) => !phrases.some((x) => x.phrase === p));
// 未签字的候选降级为证据档，不会凭空获得定罪能力
const evidence = phrases.filter((p) => !autoban.includes(p));

console.log(`\n跨簇短语合计: ${phrases.length}`);
console.log(`\n=== T1 自动封禁档（已签字）: ${autoban.length} 条 ===`);
for (const p of autoban)
  console.log(`  簇${String(p.clusterDF).padStart(4)} / 账号${String(p.accountDF).padStart(6)}  ${p.phrase}`);
if (orphaned.length) {
  console.log(`\n[warn] 签字文件里有 ${orphaned.length} 条短语本轮未被挖出，已静默失效：`);
  console.log(`  ${orphaned.join(" / ")}`);
}
if (pending.length) {
  console.log(`\n=== 推荐审阅的候选: ${pending.length} 条（未签字，只作证据加权）===`);
  for (const p of pending)
    console.log(`  簇${String(p.clusterDF).padStart(4)} / 账号${String(p.accountDF).padStart(6)}  ${p.phrase}`);
  console.log(`  → 审阅后把要授权的加进 ${APPROVED_PATH} 的 approved 数组，重新训练即可生效`);
}
console.log(`\n=== T2 证据加权档 TOP25（共 ${evidence.length} 条，不单独定罪）===`);
for (const p of evidence.slice(0, 25))
  console.log(`  簇${String(p.clusterDF).padStart(4)} / 账号${String(p.accountDF).padStart(6)}  ${p.phrase}`);

// ── 推文模板聚类 ────────────────────────────────────────────────────
//
// 只挖昵称是个致命盲区：整批色情号的昵称就是「普通中文名 + 一个 emoji」
// （友枫🌸 / 诗珊🌸 / 碧凡🌸），毫无招揽词；垃圾特征全在推文里，而且是
// 一字不差的模板 —— "应该没人比我玩的开了吧我福不黑不信你看" 有 603 个
// 账号在用。这类账号昵称路径 100% 放行，实测一屏 144 个账号零定罪。
//
// 判据和昵称簇同构：整条推文匹配上一个被大量账号逐字复用的模板才定罪，
// 不是命中某个碎片词。"太涩了" 这种三字片段永远够不到 —— 正常人会说，
// 而完整模板不会有人无意间打出来。
const tweetByNorm = new Map();
for (const r of rows) {
  const raw = (r.evidence_text ?? "").trim();
  if (!raw) continue;
  const n = normalizeForMatch(raw);
  if (n.length < TWEET_MIN_LEN) continue;
  let e = tweetByNorm.get(n);
  if (!e) tweetByNorm.set(n, (e = { norm: n, raw, count: 0, cats: new Map() }));
  e.count++;
  const cat = r.category ?? "other";
  e.cats.set(cat, (e.cats.get(cat) ?? 0) + 1);
}
const tweetUniq = [...tweetByNorm.values()].sort((a, b) => b.count - a.count);
console.log(`\n推文文本（归一化后不重复）: ${tweetUniq.length}`);

for (const u of tweetUniq) u.sh = shingles(u.norm);
const tInverted = new Map();
tweetUniq.forEach((u, i) => {
  for (const g of u.sh) {
    const arr = tInverted.get(g);
    if (arr) { if (arr.length < 4000) arr.push(i); } else tInverted.set(g, [i]);
  }
});
const tParent = tweetUniq.map((_, i) => i);
const tFind = (x) => { while (tParent[x] !== x) { tParent[x] = tParent[tParent[x]]; x = tParent[x]; } return x; };
const tUnion = (a, b) => { const ra = tFind(a), rb = tFind(b); if (ra !== rb) tParent[ra] = rb; };
for (let i = 0; i < tweetUniq.length; i++) {
  const cand = new Set();
  for (const g of tweetUniq[i].sh) for (const j of tInverted.get(g) ?? []) if (j > i) cand.add(j);
  for (const j of cand) {
    if (tFind(i) === tFind(j)) continue;
    if (jaccard(tweetUniq[i].sh, tweetUniq[j].sh) >= TWEET_JACCARD) tUnion(i, j);
  }
}
const tGroups = new Map();
tweetUniq.forEach((u, i) => {
  const r = tFind(i);
  const g = tGroups.get(r);
  if (g) g.push(u); else tGroups.set(r, [u]);
});
const tweetClusters = [...tGroups.values()]
  .map((members) => {
    const accounts = members.reduce((sum, m) => sum + m.count, 0);
    const ranked = members.slice().sort((a, b) => b.count - a.count);
    return {
      accounts,
      variants: members.length,
      reps: ranked.slice(0, 8).map((m) => m.norm),
      sample: ranked[0].raw,
      category: dominantCategory(members),
      members,
    };
  })
  .filter((c) => c.accounts >= TWEET_MIN_CLUSTER)
  .sort((a, b) => b.accounts - a.accounts);

console.log(`达到 ${TWEET_MIN_CLUSTER} 账号门槛的推文模板簇: ${tweetClusters.length}`);
console.log(`覆盖账号: ${tweetClusters.reduce((s, c) => s + c.accounts, 0)}`);
console.log("\n=== 最大的 10 个推文模板 ===");
for (const c of tweetClusters.slice(0, 10)) {
  console.log(`  ${String(c.accounts).padStart(5)} 账号 / ${String(c.variants).padStart(4)} 变体  ${JSON.stringify(c.sample.replace(/\s+/g, " ").slice(0, 56))}`);
}

// ── 推文/简介语料的跨簇短语 ──────────────────────────────────────────
//
// 短语挖掘原本只跑在昵称上，这是个泛化盲区：那批「已入驻约炮平台…」的
// 模板有上万个账号，但只要对方换一条新文案（换 URL、换措辞），整簇匹配
// 就失效 —— 2026-08-11 实测漏掉的 @LFlynn54692 正是这样，简介是新变体，
// 与已知簇相似度只有 33%。
//
// 而这些新变体绕不开同一批词：约炮平台 / 涩播 / 寻固炮 / 真人认证。
// 判据和昵称短语完全一致 —— 横跨多少个**相互独立**的模板簇才算耐用，
// 只在一个簇里出现的就是那串文案的碎片，换模板即失效。
const tCoverage = new Map();
const tAccountDF = new Map();
const tPhraseCats = new Map();
tweetClusters.forEach((c, ci) => {
  for (const m of c.members ?? []) {
    const cjk = m.norm.replace(/[^一-鿿]/g, "");
    const seen = new Set();
    for (let k = PHRASE_MIN_LEN; k <= 8; k++)
      for (let i = 0; i + k <= cjk.length; i++) seen.add(cjk.slice(i, i + k));
    for (const g of seen) {
      let cov = tCoverage.get(g);
      if (!cov) tCoverage.set(g, (cov = new Set()));
      cov.add(ci);
      tAccountDF.set(g, (tAccountDF.get(g) ?? 0) + m.count);
      let pc = tPhraseCats.get(g);
      if (!pc) tPhraseCats.set(g, (pc = new Map()));
      for (const [cat, n] of m.cats) pc.set(cat, (pc.get(cat) ?? 0) + n);
    }
  }
});

let tweetPhrases = [...tCoverage]
  .filter(([g, cov]) => cov.size >= PHRASE_MIN_CLUSTER_DF && (tAccountDF.get(g) ?? 0) >= PHRASE_MIN_ACCOUNT_DF)
  .map(([phrase, cov]) => ({
    phrase,
    cov,
    clusterDF: cov.size,
    accountDF: tAccountDF.get(phrase) ?? 0,
    category: topCategory(tPhraseCats.get(phrase)),
  }))
  .sort((a, b) => b.clusterDF - a.clusterDF || b.phrase.length - a.phrase.length);

const tKept = [];
for (const p of tweetPhrases) {
  const dup = tKept.some(
    (k) => sameSet(k.cov, p.cov) && (k.phrase.includes(p.phrase) || p.phrase.includes(k.phrase)),
  );
  if (!dup) tKept.push(p);
}
tweetPhrases = tKept;

const tweetAutoban = tweetPhrases.filter((p) => approvedSet.has(p.phrase));
const tweetEvidence = tweetPhrases.filter((p) => !approvedSet.has(p.phrase));
console.log(`\n=== 推文/简介跨簇短语: ${tweetPhrases.length} 条（已签字 ${tweetAutoban.length}）===`);
for (const p of tweetPhrases.slice(0, 25)) {
  const mark = approvedSet.has(p.phrase) ? "✍️" : "  ";
  console.log(`  ${mark} 簇${String(p.clusterDF).padStart(4)} / 账号${String(p.accountDF).padStart(6)}  ${p.phrase}`);
}

// ── handle 形态分类器（唯一有真实负样本的部分）─────────────────────
// 白名单的 2023 个 handle 是我们手上仅有的真实负样本 —— 它们不含
// display_name，做不了文本分类，但 handle 本身就是特征：批量注册号是
// "英文名 + 随机后缀"（irishumee6vd / octaviastehvwa），真人 handle 不是。
// 这里训一个字符 n-gram 朴素贝叶斯，留出 20% 做验证，指标如实报告。
// 它只贡献权重，永不单独定罪 —— 一个随机 handle 不是罪证。
function handleFeatures(h) {
  const s = `^${h.toLowerCase()}$`;
  const f = [];
  for (let i = 0; i + 2 <= s.length; i++) f.push(s.slice(i, i + 2));
  for (let i = 0; i + 3 <= s.length; i++) f.push(s.slice(i, i + 3));
  f.push(`len:${Math.min(20, h.length)}`);
  f.push(`digits:${Math.min(4, (h.match(/\d/g) ?? []).length)}`);
  f.push(`tail:${/[a-z]{4,}[a-z0-9]{4,}$/.test(h) ? 1 : 0}`);
  return f;
}

function trainNB(pos, neg) {
  const cp = new Map(), cn = new Map();
  const add = (m, fs) => { for (const f of fs) m.set(f, (m.get(f) ?? 0) + 1); };
  for (const h of pos) add(cp, handleFeatures(h));
  for (const h of neg) add(cn, handleFeatures(h));
  const vocab = new Set([...cp.keys(), ...cn.keys()]);
  const tp = [...cp.values()].reduce((a, b) => a + b, 0);
  const tn = [...cn.values()].reduce((a, b) => a + b, 0);
  const w = new Map();
  for (const f of vocab) {
    // 加一平滑后的对数似然比
    const lp = Math.log(((cp.get(f) ?? 0) + 1) / (tp + vocab.size));
    const ln = Math.log(((cn.get(f) ?? 0) + 1) / (tn + vocab.size));
    w.set(f, lp - ln);
  }
  return w;
}
const scoreHandle = (w, h) => handleFeatures(h).reduce((s, f) => s + (w.get(f) ?? 0), 0);

let handleModel = null;
try {
  const wl = JSON.parse(fs.readFileSync("data/whitelist/v1.json", "utf8")).list
    .map((e) => e.handle).filter(Boolean);
  const blAll = [...new Set(rows.map((r) => r.handle).filter(Boolean))];
  // 平衡采样：负样本只有 2023 条，正样本按同量抽（确定性抽样，可复现）
  const bl = blAll.filter((_, i) => i % Math.max(1, Math.floor(blAll.length / wl.length)) === 0)
    .slice(0, wl.length);
  const split = (a) => [a.filter((_, i) => i % 5 !== 0), a.filter((_, i) => i % 5 === 0)];
  const [posTr, posTe] = split(bl);
  const [negTr, negTe] = split(wl);
  const w = trainNB(posTr, negTr);

  // 阈值扫描 + 留出集指标
  const sp = posTe.map((h) => scoreHandle(w, h));
  const sn = negTe.map((h) => scoreHandle(w, h));
  let best = { thr: 0, acc: 0 };
  for (const thr of [...sp, ...sn].sort((a, b) => a - b)) {
    const acc = (sp.filter((x) => x > thr).length + sn.filter((x) => x <= thr).length) / (sp.length + sn.length);
    if (acc > best.acc) best = { thr, acc };
  }
  // AUC（Mann-Whitney）
  let wins = 0;
  for (const a of sp) for (const b of sn) wins += a > b ? 1 : a === b ? 0.5 : 0;
  const auc = wins / (sp.length * sn.length);
  // 在 best.thr 下的精确率 —— 我们真正在意的是「判成 spam 的里面有多少是错的」
  const tp2 = sp.filter((x) => x > best.thr).length;
  const fp2 = sn.filter((x) => x > best.thr).length;
  // 我们真正要用的阈值不是「准确率最高」，而是「白名单一个都不误伤」。
  // 在这个点上还能召回多少，才是这个特征的真实价值。
  const strictThr = Math.max(...sn);
  const strictRecall = sp.filter((x) => x > strictThr).length / sp.length;
  console.log(`\n=== handle 形态分类器（留出集 ${posTe.length} 正 / ${negTe.length} 负）===`);
  console.log(`  AUC          : ${auc.toFixed(4)}`);
  console.log(`  最佳准确率   : ${(best.acc * 100).toFixed(1)}%  @ thr=${best.thr.toFixed(2)}`);
  console.log(`  该阈值精确率 : ${(tp2 / Math.max(1, tp2 + fp2) * 100).toFixed(1)}%   假阳 ${fp2}/${negTe.length}  ← 单独定罪不可接受`);
  console.log(`  零假阳阈值   : ${strictThr.toFixed(2)}  召回仅 ${(strictRecall * 100).toFixed(1)}%`);
  console.log(`  → 结论：handle 形态只作加权信号，永不单独定罪。`);
  // 只导出权重最大的一批，控制体积
  const top = [...w].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6000);
  handleModel = {
    // 导出的是零假阳阈值 —— 运行时按这个点用，宁可少召回
    thr: strictThr,
    bestAccThr: best.thr,
    auc: Number(auc.toFixed(4)),
    acc: Number(best.acc.toFixed(4)),
    strictRecall: Number(strictRecall.toFixed(4)),
    weights: Object.fromEntries(top),
  };
} catch (e) {
  console.log(`\n[warn] handle 分类器跳过: ${e.message}`);
}

// ── 人工标注样本：正样本补录，负样本作误杀红线 ──────────────────────
//
// 用户手动拉黑 = 人已 review 过的正样本；「恢复显示」= 人已 review 过的
// 负样本。后者是这套体系里唯一的真实负样本来源 —— 公开白名单只有 2023 条
// 且不含 display_name，没有它就训不出判别式模型。
//
// 这里先用它做一件立刻有价值的事：**把负样本当成误杀红线**。任何已签字的
// 定罪短语，只要命中了用户亲手标为正常的账号，就必须报出来 —— 那是一条
// 正在制造误杀的规则，而用户已经用行动告诉我们它错了。
let humanSamples = [];
try {
  humanSamples = fs
    .readFileSync(SAMPLES_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
} catch {
  /* 没有导出过样本 —— 正常，跳过 */
}

if (humanSamples.length) {
  const pos = humanSamples.filter((s) => s.label === "spam");
  const neg = humanSamples.filter((s) => s.label === "legit");
  console.log(`\n=== 人工标注样本: ${humanSamples.length} 条（正 ${pos.length} / 负 ${neg.length}）===`);

  const violations = [];
  for (const sample of neg) {
    const text = normalizeForMatch(`${sample.displayName ?? ""} ${sample.bio ?? ""}`);
    for (const p of autoban) {
      if (text.includes(p.phrase)) {
        violations.push({ phrase: p.phrase, handle: sample.handle, name: sample.displayName });
      }
    }
  }
  if (violations.length) {
    console.log(`\n‼️  误杀红线告警：${violations.length} 条 —— 已签字短语命中了你亲手标为正常的账号`);
    for (const v of violations) {
      console.log(`    「${v.phrase}」命中 @${v.handle} ${JSON.stringify(v.name)}`);
    }
    console.log(`    → 请从 ${APPROVED_PATH} 的 approved 里撤下这些短语，或收窄为更长的搭配`);
  } else if (neg.length) {
    console.log(`  ✅ 无误杀：${neg.length} 个人工标注的正常账号，没有一个被已签字短语命中`);
  }

  // 正样本里那些 baseline 当前漏掉的 —— 就是下一轮要补强的方向
  const missed = pos.filter((sample) => {
    const text = normalizeForMatch(`${sample.displayName ?? ""} ${sample.bio ?? ""}`);
    return !autoban.some((p) => text.includes(p.phrase));
  });
  if (missed.length) {
    console.log(`\n  漏杀参考：${missed.length}/${pos.length} 个你手动处理的账号，短语表没覆盖到`);
    for (const m of missed.slice(0, 10)) {
      console.log(`    @${m.handle} ${JSON.stringify(m.displayName)}`);
    }
    console.log(`    → 这些是模型该学但还没学到的；样本攒够后可用于训练判别式分类器`);
  }
}

// ── 导出模型 ────────────────────────────────────────────────────────
const model = {
  schema: 1,
  generatedAt: Date.now(),
  source: { file: path.basename(inPath), rows: rows.length, named: named.length },
  params: {
    MIN_NAME_LEN, NGRAM, JACCARD_MERGE, MIN_CLUSTER, PHRASE_MIN_LEN,
    PHRASE_MIN_CLUSTER_DF, PHRASE_MIN_ACCOUNT_DF,
    AUTOBAN_MIN_CLUSTER_DF, AUTOBAN_MIN_ACCOUNT_DF,
  },
  tweetAutoban: tweetAutoban.map((p) => [p.phrase, p.clusterDF, p.accountDF, p.category]),
  tweetEvidence: tweetEvidence.map((p) => [p.phrase, p.clusterDF, p.accountDF, p.category]),
  tweetClusters: tweetClusters.map((c) => ({
    n: c.accounts,
    v: c.variants,
    r: c.reps,
    s: c.sample.replace(/\s+/g, " ").slice(0, 80),
    cat: c.category,
  })),
  clusters: clusters.map((c) => ({
    n: c.accounts,
    v: c.variants,
    c: c.centroid,
    r: c.reps,
    s: c.sample,
    cat: c.category,
  })),
  // T1: 允许单独定罪。T2: 只作加权证据，永不单独定罪。
  handleModel,
  humanSamples: { total: humanSamples.length,
    spam: humanSamples.filter((s) => s.label === "spam").length,
    legit: humanSamples.filter((s) => s.label === "legit").length },
  autoban: autoban.map((p) => [p.phrase, p.clusterDF, p.accountDF, p.category]),
  pendingSignoff: pending.map((p) => [p.phrase, p.clusterDF, p.accountDF, p.category]),
  evidence: evidence.map((p) => [p.phrase, p.clusterDF, p.accountDF, p.category]),
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(model));
console.log(`\n模型写入 ${outPath}  (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
