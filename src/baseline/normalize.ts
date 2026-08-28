// 文本归一化 —— 强短语匹配前的必经一步。
//
// 公榜数据里可以直接观察到对方在做形近字规避：上→丄、门→椚、炮→萢、
// 处→chu、约炮→曰p。任何不做归一化的短语表配好当天就会被绕过，所以
// 归一化是短语规则的前提，不是可选优化。
//
// 归一化只用于「匹配」；原文始终保留，用于后台审阅时展示证据。
//
// 本文件里的字符类一律用 \u 转义书写：这些区间大量涉及零宽字符和变体
// 选择符，直接写字面量会在源码里留下肉眼不可见的内容，既无法 review
// 也容易被编辑器改坏。

/** 观察自公榜真实数据的形近替换表（键=变体，值=本字）。 */
const HOMOGLYPHS: Record<string, string> = {
  丄: "上",
  椚: "门",
  萢: "炮",
  垍: "址",
  堿: "域",
  // 同音 / 拆字替换
  曰: "约",
  祢: "你",
  巭: "夫",
};

/** 拉丁化替换：用拼音片段绕开中文匹配（chu男 = 处男、sao货 = 骚货）。
 *
 *  sao / pao 这两个音节额外放宽到「紧邻任意汉字」：实测漏杀
 *  「比我好看的没我Sao😎比我Sao的没我好看」—— 拼音后面跟的是「比」和
 *  「的」，不在原来的 货/逼/友 白名单里，整条话术就此绕过。
 *
 *  紧邻汉字是关键护栏：分隔符在上一步已被剥掉，所以纯英文语境里的
 *  "Sao Paulo" 归一化成 "saopaulo"，两侧都不是汉字，不受影响。 */
const LATIN_SUBS: [RegExp, string][] = [
  [/chu(?=男|女)/g, "处"],
  [/(?<=[\u4e00-\u9fff])sao|sao(?=[\u4e00-\u9fff])/g, "骚"],
  [/(?<=[\u4e00-\u9fff])pao|pao(?=[\u4e00-\u9fff])/g, "炮"],
  [/约\s*p\b/g, "约炮"],
  [/固\s*p\b/g, "固炮"],
  [/\bp\s*友/g, "炮友"],
];

// 零宽字符 / 双向控制符 / 变体选择符 —— 插在词中间用来打断连续匹配。
// 写成并集而非单个字符类，且变体选择符用 Unicode 属性表达：它们是组合
// 字符，塞进字符类里语义有歧义（biome noMisleadingCharacterClass）。
const INVISIBLE = /[\u200b-\u200f]|[\u202a-\u202e]|[\u2060-\u2064]|\ufeff|\p{Variation_Selector}/gu;
// 装饰性符号：emoji、箭头、几何图形、CJK 标点空白。剥离后参与匹配，
// 但它们的数量本身是一个信号（模板惯用 emoji 作分隔）。
const DECOR =
  /\p{Extended_Pictographic}|[\u2190-\u21ff]|[\u25a0-\u27bf]|[\u2b00-\u2bff]|[\u3000-\u303f]/gu;
// 全角 ASCII（U+FF01–U+FF5E）→ 半角。
const FULLWIDTH = /[\uff01-\uff5e]/g;
// 分隔符与空白：模板用它们把词切开躲避连续匹配。
const SEPARATORS = /[\s\u00b7\u30fb.。,，、_\-|/\\~*+]+/g;
// CJK 统一表意文字 —— 形近字替换只在这个区间内做。
const CJK = /[\u4e00-\u9fff]/g;

/**
 * 词内填充字符 —— 夹在两个汉字之间的 1-3 位字母数字。
 *
 * 2026-08-12 实测漏杀「刷了半天的X就她的主页h6能打了」：对方把 h6 插进
 * 「主页能打」**内部**，连续匹配当场失效。这和形近字替换是同一类手法，
 * 归一化不处理它，任何短语表配好当天就会被绕过。
 *
 * 三条护栏让它足够窄：
 *   - 必须**两侧都是汉字** —— 纯英文语境（"Sao Paulo"）完全不受影响
 *   - 只吃 1-3 位 —— 4 位以上的整词（"打开word文档"）原样保留，因为
 *     正则要求整段被汉字夹住，回溯时更长的串自然匹配不上
 *   - **纯数字不吃** —— "线下资源1-5线同步更新" 里的 1-5 是话术自身的
 *     内容，剥掉会让一条已签字的短语当场失效（实测回归）
 *   - 排在拼音替换**之后** —— 否则「没我sao比」里的 sao 会先被当成填充
 *     删掉，今天早些时候刚修好的拼音规避又会回来
 */
const INFIX_FILLER =
  /(?<=[\u4e00-\u9fff])(?![0-9]{1,3}(?=[\u4e00-\u9fff]))[a-z0-9]{1,3}(?=[\u4e00-\u9fff])/g;

/** 匹配用归一化文本。幂等。 */
export function normalizeForMatch(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.normalize("NFKC");
  s = s.replace(INVISIBLE, "");
  s = s.replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(DECOR, "");
  s = s.replace(SEPARATORS, "");
  s = s.toLowerCase();
  s = s.replace(CJK, (c) => HOMOGLYPHS[c] ?? c);
  for (const [re, to] of LATIN_SUBS) s = s.replace(re, to);
  s = s.replace(INFIX_FILLER, "");
  return s;
}

/** 装饰符号数量 —— display_name 用 🌸🌈🍑 当分隔符是极强的模板特征
 *  （样本中 🌸 出现 1783 次），但它单独不足以定罪，只作加权信号。 */
export function decorCount(raw: string | null | undefined): number {
  if (!raw) return 0;
  return (raw.match(DECOR) ?? []).length;
}
