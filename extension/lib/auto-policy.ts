/** 一次命中的来源，决定它能否进入自动处理。 */
export type AutoSource = "baseline" | "llm" | "cache" | "fresh";

/**
 * 这条命中是否允许自动处理。
 *
 * 2026-08-12 大幅收窄。曾经这里有一整套分级门禁（autoScope 限定评论区、
 * autoTierMode 给「自动收录」条目封顶），服务对象是**公榜**和随公榜下发的
 * 官方关键词规则 —— 两份我们既不控制也审不了的数据。那两条来源已经整个
 * 移除（公榜里 27.7% 的条目由泛化词单独命中产生，是已确认的误杀来源），
 * 门禁也就没有了服务对象：留着只是让设置页多两屏选项，且每一项都指向
 * 一条永远不会发生的分支。
 *
 * 现在只剩两个来源，且两者同档：
 *   baseline —— 本扩展自己的判定，结构性高精度路径 + 已晋升的学习规则
 *   llm      —— 我们主动花钱求来的结论（调用点已滤掉 likely_spam/uncertain）
 * 够不到这两条的账号根本走不到这里：baseline 不表态就是 pass，直接放行。
 *
 * 缓存与中性判定永不自动处理。
 */
export function autoEligible(opts: { source: AutoSource }): boolean {
  return opts.source === "baseline" || opts.source === "llm";
}
