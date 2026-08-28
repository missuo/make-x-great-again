// Baseline 验收 —— 回答两个问题，一个都不能省：
//   1. 覆盖率：模型能独立处理掉多少，剩多少要花 LLM
//   2. 假阳性：模型会不会封掉本来正常的账号
//
// 假阳性测试集用的是公榜里 AI 自己判为 legit / uncertain 的那批条目 ——
// 它们是「已经被挂上榜但判定说不是 spam」的账号，即已知误杀嫌疑样本。
// 这不是完美的负样本集（它有噪声），但它是我们手上唯一一批真实的、
// 带 display_name 的疑似正常账号，比任何合成数据都可信。
//
// 用法: npx tsx scripts/baseline/eval.ts <input.jsonl> <model.json>

import fs from "node:fs";
import { type BaselineModel, score } from "../../src/baseline/score.ts";

const [inPath, modelPath] = process.argv.slice(2);
if (!inPath || !modelPath) {
  console.error("usage: npx tsx scripts/baseline/eval.ts <input.jsonl> <model.json>");
  process.exit(1);
}

const model = JSON.parse(fs.readFileSync(modelPath, "utf8")) as BaselineModel;
const rows = fs
  .readFileSync(inPath, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Record<string, string>);

// evidence_text 是触发判定的那条公开文本 —— 不传它就完全测不到推文
// 模板这条路径，覆盖率会被系统性低估。
const toInput = (r: Record<string, string>) => ({
  handle: r.handle ?? "",
  displayName: r.display_name ?? "",
  recentTweets: r.evidence_text ? [r.evidence_text] : [],
});

// ── 1. 覆盖率 ────────────────────────────────────────────────────────
const tally = { ban: 0, llm: 0, pass: 0 };
const banReason = new Map<string, number>();
for (const r of rows) {
  const res = score(toInput(r), model);
  tally[res.decision]++;
  if (res.decision === "ban") {
    const first = res.reasons[0] ?? "";
    const kind = first.startsWith("推文匹配批量模板")
      ? "推文模板匹配"
      : first.startsWith("昵称匹配批量模板")
      ? "昵称模板匹配"
      : first.includes("人工指定")
        ? "人工点名短语"
        : "T1 高频短语";
    banReason.set(kind, (banReason.get(kind) ?? 0) + 1);
  }
}
const pct = (n: number) => `${((n / rows.length) * 100).toFixed(1)}%`;
console.log(`=== 覆盖率（在 ${rows.length} 条公榜条目上）===`);
console.log(`  模型直接定罪 : ${tally.ban}  ${pct(tally.ban)}`);
console.log(`  送 LLM 判定  : ${tally.llm}  ${pct(tally.llm)}`);
console.log(`  放行(不表态) : ${tally.pass}  ${pct(tally.pass)}`);
console.log("\n  定罪路径分布:");
for (const [k, v] of [...banReason].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(14)} ${v}`);
}

// ── 2. 假阳性 ────────────────────────────────────────────────────────
const suspects = rows.filter((r) => r.verdict_label === "legit" || r.verdict_label === "uncertain");
console.log(`\n=== 假阳性测试（AI 判为 legit/uncertain 的 ${suspects.length} 条）===`);
const sTally = { ban: 0, llm: 0, pass: 0 };
const banned: { r: Record<string, string>; why: string }[] = [];
for (const r of suspects) {
  const res = score(toInput(r), model);
  sTally[res.decision]++;
  if (res.decision === "ban") banned.push({ r, why: res.reasons[0] ?? "" });
}
console.log(`  仍被定罪 : ${sTally.ban}  (${((sTally.ban / Math.max(1, suspects.length)) * 100).toFixed(1)}%)`);
console.log(`  送 LLM   : ${sTally.llm}`);
console.log(`  放行     : ${sTally.pass}  ← 这些账号会被 baseline 主动放过`);
if (banned.length) {
  console.log("\n  仍被定罪的样例（逐条人工核对）:");
  for (const b of banned.slice(0, 20)) {
    console.log(`    @${b.r.handle} ${JSON.stringify(b.r.display_name)} [${b.r.verdict_label}]`);
    console.log(`       ${b.why}`);
  }
}

// ── 3. 与现有公榜的差异 ─────────────────────────────────────────────
// 现有公榜的每一条都是「已被判定为 spam」。baseline 放行的那些，就是
// 按新口径应该从公榜下架的候选。
console.log(`\n=== 清洗口径预演 ===`);
console.log(`  按 baseline 保留（定罪）      : ${tally.ban}`);
console.log(`  退回 LLM 复核后再定           : ${tally.llm}`);
console.log(`  直接下架（baseline 不认可）   : ${tally.pass}`);
