/**
 * 来源注册表（阶段 3 · 第 1 步）
 *
 * 职责边界（本步严格限定）：
 *  - 维护 SOURCE_ORDER / UNKNOWN_RANK / rank()（动态，不硬编码 9）
 *  - 提供 SOURCES 列表与按 id 查找
 *  - 提供 enabled 过滤能力（供首页与后续搜索链路使用）
 *  - **不含**任何聚合逻辑（aggregate/SourceEntry 属于第 2 步）
 *
 * 与旧 index.ts 的关系：index.ts 保留原 SOURCE_ORDER 导出以兼容既有引用，
 * 但其值来源改为本模块的同一常量对象，避免两处漂移。
 */
import type { SourceAdapter } from './types'
import anilist from './anilist'
import jikan from './jikan'
import bilibili from './bilibili'
import mangadex from './mangadex'
import bangumi from './bangumi'
import mangabaka from './mangabaka'
import terraHistoricus from './terraHistoricus'
import { isSourceEnabled } from './settings'

/**
 * 来源优先级表：数字越小越优先（中文内容优先展示）。
 * 新增来源在此追加；排名必须为非负唯一整数。
 *
 * mangabaka = 5：新来源先取最低优先级，不冲击首页既有排序。
 *
 * terra-historicus = 6（阶段3·第4步）：泰拉记事社，鹰角网络官方免费漫画。
 * 追加为最大排名，**不重排既有来源**；UNKNOWN_RANK 由 6 变 7（max+1 动态计算），
 * "未知来源排最后"的语义不变。
 */
export const SOURCE_ORDER: Readonly<Record<string, number>> = Object.freeze({
  bangumi: 0,
  bilibili: 1,
  mangadex: 2,
  anilist: 3,
  jikan: 4,
  mangabaka: 5,
  'terra-historicus': 6,
})

/**
 * 未知来源统一排名：**运行时**取已知最大值 + 1。
 * 不硬编码 9——将来新增排名 9/10/99 的来源也不会破坏"未知排最后"的语义。
 */
export const UNKNOWN_RANK: number = Math.max(...Object.values(SOURCE_ORDER)) + 1

/**
 * 取来源排名。SOURCES_ORDER 中不存在的 id（含空串、未来来源）一律 UNKNOWN_RANK。
 * 用 hasOwnProperty 而非 `??`：防止 "constructor"/"__proto__" 等原型链键被误判为已知来源。
 */
export function rank(sourceId: string): number {
  return Object.prototype.hasOwnProperty.call(SOURCE_ORDER, sourceId)
    ? SOURCE_ORDER[sourceId]
    : UNKNOWN_RANK
}

/** 全部来源适配器（不受开关影响；开关过滤见 enabledSources） */
export const SOURCES: SourceAdapter[] = [bangumi, bilibili, mangadex, anilist, jikan, mangabaka, terraHistoricus]

/** 来源显示名映射 */
export const SOURCE_NAMES: Record<string, string> = Object.fromEntries(
  SOURCES.map((s) => [s.id, s.name]),
)

/** 按 id 取适配器（找不到时回退首个，保持既有行为） */
export const getSource = (id: string): SourceAdapter =>
  SOURCES.find((s) => s.id === id) ?? SOURCES[0]

/**
 * 按用户开关过滤后的来源列表（保持 registry 顺序 = SOURCE_ORDER 语义）。
 * 首页与聚合链路统一从这里取，保证"禁用后不再发起请求"。
 */
export function enabledSources(): SourceAdapter[] {
  return SOURCES.filter((s) => isSourceEnabled(s.id))
}

/** 判断某来源当前是否启用（未知 id 视为启用，避免误伤未来来源） */
export function isEnabled(sourceId: string): boolean {
  return isSourceEnabled(sourceId)
}

// ---- 构建期/加载期断言：排名表必须自洽（失败立即抛出，避免带病运行）----
;(function assertRegistry(): void {
  const values = Object.values(SOURCE_ORDER)
  if (!(UNKNOWN_RANK > Math.max(...values))) {
    throw new Error('[registry] UNKNOWN_RANK 必须大于所有已知排名')
  }
  if (new Set(values).size !== values.length) {
    throw new Error('[registry] SOURCE_ORDER 排名必须唯一')
  }
  if (values.some((v) => !Number.isInteger(v) || v < 0)) {
    throw new Error('[registry] SOURCE_ORDER 必须为非负整数')
  }
  if (SOURCES.some((s) => !s.id)) {
    throw new Error('[registry] 来源适配器必须提供非空 id')
  }
})()
