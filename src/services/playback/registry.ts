/**
 * 播放源注册表（阶段3·第2步·播放源适配层 · 批次①）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么独立于 sources/registry.ts（用户裁定 §1）
 * ══════════════════════════════════════════════════════════════════════
 *   SourceAdapter            PlaybackSourceResolver
 *   ──────────────────────   ────────────────────────────
 *   作品 / 章节 / 图片        剧集 / 播放候选 / 临时地址
 *   长生命周期（可缓存）      短生命周期（URL 分钟级过期）
 *   公开数据，安全要求低      **临时 URL 绝不持久化，安全要求高**
 *
 * ⇒ 接口分离、注册独立。允许共用 sourceId 与启用开关，但不合并适配器。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 两处刻意与 sources/registry.ts 不同（不是疏漏）
 * ══════════════════════════════════════════════════════════════════════
 * 1. `getResolver` 找不到时返回 `undefined`，**不回退首个**
 *    sources 的 `getSource` 会回退 `SOURCES[0]`。播放场景下回退首个
 *    会导致「想播 A 源却播了 B 源」，属内容错配，绝不可接受。
 *
 * 2. 首版**空表**（0 个播放源），且空表是**正常状态**
 *    尚无通过准入的播放源。空表必须安全：`enabledResolvers()` 返回 `[]`，
 *    上层返回 `NO_RESOLVER_ENABLED`，**不抛未捕获异常**。
 */
import type { PlaybackSourceResolver } from './PlaybackService'
import { isSourceEnabled } from '../sources/settings'

/**
 * 播放源优先级：数字越小越优先。
 *
 * 新增播放源在此追加；排名必须为非负唯一整数。
 * **首版为空** —— 尚无通过准入的播放源（见 §1.3.1）。
 */
export const PLAYBACK_ORDER: Readonly<Record<string, number>> = Object.freeze({
  // 暂无
})

/**
 * 未知播放源统一排名：运行时取已知最大值 + 1（不硬编码）。
 * 空表时取 0，保证「未知来源」也能得到一个确定的比较值。
 */
export const UNKNOWN_PLAYBACK_RANK: number =
  Object.keys(PLAYBACK_ORDER).length === 0
    ? 0
    : Math.max(...Object.values(PLAYBACK_ORDER)) + 1

/**
 * 全部播放解析器（不受开关影响）。
 *
 * 注册方式：静态数组（与 sources/registry.ts 一致）。
 * 不做运行时动态注册——避免初始化顺序不确定性。
 *
 * 新增播放源 = 本数组追加一项 + `PLAYBACK_ORDER` 加排名（两处都要改，
 * 构建期断言保证一致）。
 */
export const PLAYBACK_RESOLVERS: PlaybackSourceResolver[] = []

/**
 * 按 id 取解析器。
 *
 * 🔴 找不到返回 `undefined`，**不静默回退首个**（见文件头 §1）。
 */
export function getResolver(id: string): PlaybackSourceResolver | undefined {
  return PLAYBACK_RESOLVERS.find((r) => r.sourceId === id)
}

/**
 * 按用户开关过滤后的解析器列表。
 *
 * 复用 `sources/settings.ts` 的 `isSourceEnabled`，**不新建存储键**：
 * 用户心智上「某来源关掉」应是整体的，不该分「内容开关」和「播放开关」。
 *
 * ⚠️ 已知副作用：若播放源 id 与内容源 id 相同，禁用内容源会连带禁用播放源。
 *    要求播放源 id **不得与内容源 id 冲突**（见方案 §9.3 边界）。
 */
export function enabledResolvers(): PlaybackSourceResolver[] {
  return PLAYBACK_RESOLVERS.filter((r) => isSourceEnabled(r.sourceId))
}

/**
 * 取播放源排名。未登记的 id 一律 `UNKNOWN_PLAYBACK_RANK`。
 *
 * 用 hasOwnProperty 而非 `??`：防止 "constructor" / "__proto__" 等
 * 原型链键被误判为已知来源（与 sources/registry.ts 的 rank() 同构）。
 */
export function playbackRank(sourceId: string): number {
  return Object.prototype.hasOwnProperty.call(PLAYBACK_ORDER, sourceId)
    ? PLAYBACK_ORDER[sourceId]
    : UNKNOWN_PLAYBACK_RANK
}

// ---- 构建期/加载期断言：注册表必须自洽（失败立即抛出，避免带病运行）----
;(function assertPlaybackRegistry(): void {
  const values = Object.values(PLAYBACK_ORDER)
  if (values.length > 0 && !(UNKNOWN_PLAYBACK_RANK > Math.max(...values))) {
    throw new Error('[playback/registry] UNKNOWN_PLAYBACK_RANK 必须大于所有已知排名')
  }
  if (new Set(values).size !== values.length) {
    throw new Error('[playback/registry] PLAYBACK_ORDER 排名必须唯一')
  }
  if (values.some((v) => !Number.isInteger(v) || v < 0)) {
    throw new Error('[playback/registry] PLAYBACK_ORDER 必须为非负整数')
  }
  if (PLAYBACK_RESOLVERS.some((r) => !r.sourceId || !r.sourceName)) {
    throw new Error('[playback/registry] 解析器必须提供非空 sourceId 与 sourceName')
  }
  if (new Set(PLAYBACK_RESOLVERS.map((r) => r.sourceId)).size !== PLAYBACK_RESOLVERS.length) {
    throw new Error('[playback/registry] 解析器 id 必须唯一')
  }
})()
