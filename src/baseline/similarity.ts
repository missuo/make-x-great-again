// 整句模板相似度 —— 「把我亲手拉黑的这条原文存下来，后面像的就一起封」。
//
// ── 为什么不能用词片重合度（Jaccard）──────────────────────────────
//
// 实测这两条同源推文：
//   30+的cb体制内老师 已探路花样多 @tiagolvr7 1s
//   30+的al体制内老师 玩的就是返差 @Hop4Toy 9r
// Jaccard 只有 0.27。原因是它们的**后半段完全不同**（已探路花样多 /
// 玩的就是返差），共享的只有开头。Jaccard 把差异摊到整句上，这种
// 「固定开头 + 随机尾巴」的模板天然打不高分。
//
// 真正不变的是那段一字不差的共同前缀「30的体制内老师」，8 个字。
// 量它的工具是**最长公共子串**，不是词片集合。同一对样本 LCS 率 0.50。
//
// 两个都算，取大值：Jaccard 覆盖「同一批词换个顺序/轻微改写」，LCS 覆盖
// 「固定模板 + 随机尾巴」。垃圾团伙两种手法都在用。
//
// ── 噪声剥离是前提，不是优化 ──────────────────────────────────────
//
// 这类推文一定会掺 @跳转目标 和 1-3 个字符的随机乱码（cb / al / 1s / 9r），
// 目的就是打散文本指纹。不剥的话同一对样本相似度从 0.50 掉到 0.087 ——
// 也就是说，噪声剥离本身就是这套匹配能不能成立的前提。
//
// ── 误伤余量（实测）──────────────────────────────────────────────
//
//   目标模板 vs 目标变体          0.50
//   目标模板 vs 15 条正常中文推文  最高 0.19
//   正常推文 vs 正常推文           最高 0.17
//
// 0.50 与 0.19 之间是一大片空地，默认阈值取在中间偏低处仍有 2 倍余量。
// 但对照集只有 15 条手写样本，不是大规模验证 —— 所以阈值做成可调，
// 并且额外要求一个**绝对**的公共子串长度下限（正常样本最高只有 3 个字）。

import { normalizeForMatch } from "./normalize.ts";

/** 参与匹配的最短长度（剥噪声、归一化之后）。太短的句子任何两条都可能
 *  意外重合，而且短句本来就承载不了一个模板。
 *
 *  取 10 而不是 12：剥噪声越狠、剩下的正文越短，「刷了半天的就她主页能打」
 *  剥完只有 11 字，卡在 12 上会把整族一起挡掉。真正的地板是下面那条
 *  绝对公共子串长度 —— 比例门槛在短文本上容易虚高，长度门槛不该独自承担
 *  防误伤的职责。 */
export const TEMPLATE_MIN_LEN = 10;

/** 公共子串的**绝对**长度下限。比例是相对的，短文本上很容易虚高；
 *  这一条是硬地板。实测正常中文推文之间的最长公共子串只有 3 个字。 */
export const TEMPLATE_MIN_LCS = 6;

/**
 * 剥掉刻意加入的噪声，然后归一化。
 *
 * 顺序很重要：@handle 和孤立乱码要在**原文**上剥，因为它们的边界靠空白
 * 和标点界定，而归一化会把这些分隔符全部删掉。
 */
export function stripNoise(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw
    .replace(/https?:\/\/\S+/g, " ")
    // @跳转目标：每条都不一样，是纯噪声
    .replace(/(?:^|[^A-Za-z0-9_@])@[A-Za-z0-9_]{1,15}\b/g, " ")
    // 孤立的 1-3 位填充：cb / al / mt / oy / h6 / 1e / 9r / 1s。
    //
    // 判据是「含字母」而不是「全是字母」：h6 / 1e / 9r 都掺了数字，按
    // 纯字母判会整批漏掉。而**纯数字**的短串要保留 —— 30+ / 22岁 / 168cm
    // 里的数字是模板自身的内容，剥掉等于把真正的特征一起丢了。
    .replace(/(?<![A-Za-z0-9])(?![0-9]{1,3}(?![A-Za-z0-9]))[A-Za-z0-9]{1,3}(?![A-Za-z0-9])/g, " ");
  return normalizeForMatch(s);
}

/** 最长公共**子串**（连续），不是子序列。连续性是关键：模板的价值就在于
 *  那一段一字不差的复制，而子序列会把散落各处的巧合字符也算进来。 */
export function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  // 滚动一维数组：模板和推文都是几十字量级，但这个函数在时间线上会被
  // 反复调用，没必要留一个二维矩阵。
  let prev = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    const ca = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      if (ca === b[j - 1]) {
        const v = (prev[j - 1] ?? 0) + 1;
        cur[j] = v;
        if (v > best) best = v;
      }
    }
    prev = cur;
  }
  return best;
}

export function shingles(s: string, n = 3): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface SimilarityResult {
  /** 最终得分，取两种度量的大者。 */
  sim: number;
  lcs: number;
  lcsRatio: number;
  jac: number;
}

/**
 * 两段**已剥噪声、已归一化**的文本的相似度。
 *
 * 长度下限与公共子串下限在这里就判掉：不满足时直接返回 0，调用方无需
 * 再各自记得判一遍 —— 那种「护栏散落在调用点」的写法迟早会漏一处。
 */
export function similarity(a: string, b: string): SimilarityResult {
  const zero: SimilarityResult = { sim: 0, lcs: 0, lcsRatio: 0, jac: 0 };
  if (a.length < TEMPLATE_MIN_LEN || b.length < TEMPLATE_MIN_LEN) return zero;
  const lcs = longestCommonSubstring(a, b);
  if (lcs < TEMPLATE_MIN_LCS) return zero;
  const lcsRatio = lcs / Math.min(a.length, b.length);
  const jac = jaccard(shingles(a), shingles(b));
  return { sim: Math.max(lcsRatio, jac), lcs, lcsRatio, jac };
}
