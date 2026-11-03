/**
 * 结构化键与来源适配（阶段 3 · 第 2 步）
 *
 * 本文件实现设计文档 v1.8 的：
 *  - §3.1 结构化 descKey（JSON 数组编码，杜绝字符串拼接歧义）
 *  - §3.1 createAggIdAllocator（循环碰撞检查 + 唯一签发口）
 *  - §4.8 validateWorkItem / toSourceEntry（18 字段运行时校验 + 深冻结）
 *  - §4.7 yearMeaning 生成
 *
 * 禁止事项：本文件不触碰适配器、不改 classifyError、不引入聚合判定逻辑。
 */
import type { Kind, WorkItem } from './types'

// ---------------------------------------------------------------------------
// §4.7 年份有效性（与 yearCompare 同源）
// ---------------------------------------------------------------------------

export const YEAR_MIN = 1900
export const YEAR_MAX = 2200

/** 有效年份：有限、整数、且在合理区间（决定能否进入 descKey / 参与佐证） */
export function isValidYear(y: unknown): y is number {
  return (
    typeof y === 'number' &&
    Number.isFinite(y) &&
    Number.isInteger(y) &&
    y >= YEAR_MIN &&
    y <= YEAR_MAX
  )
}

/** yearMeaning：标注该年份的语义是否可用于跨源佐证 */
export type YearMeaning = 'start' | 'unknown'

const YEAR_MEANING_TABLE: Readonly<Record<string, YearMeaning>> = Object.freeze({
  'anilist:anime': 'start', // seasonYear
  'jikan:anime': 'start', // aired.from
  'jikan:manga': 'start', // published.from
  'bilibili:anime': 'start', // listSeason 参数年
  'bilibili:manga': 'unknown', // ★ mangaSearch 的 year 语义未确认，必须 unknown
  'mangadex:manga': 'start', // attributes.year
})

/** 按 sourceId + kind 查表；表中无此组合 → 'unknown' */
export function yearMeaningOf(sourceId: string, kind: Kind): YearMeaning {
  return YEAR_MEANING_TABLE[`${sourceId}:${kind}`] ?? 'unknown'
}

// ---------------------------------------------------------------------------
// §3.1 结构化 descKey
// ---------------------------------------------------------------------------

/** 规范化匹配键：小写、去常见分隔与标点、去空白（仅用于键，绝不改原文） */
export function basicKey(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/[\s:：·・'’\-—–_/\\|]+/g, '')
    .trim()
}

/**
 * 结构化 descKey：JSON 数组编码 `[kind, matchKey, year|null]`。
 * 用 JSON.stringify 而非字符串拼接——标题含 `@y2020` / `#2` / 冒号 / 引号时不会互相吞并。
 * 无效年份一律编码为 null（与 §4.7.1 一致）。
 */
export function makeDescKey(kind: Kind, matchKey: string, year: unknown): string {
  return JSON.stringify([kind, matchKey, isValidYear(year) ? year : null])
}

// ---------------------------------------------------------------------------
// §4.8 18 字段运行时校验
// ---------------------------------------------------------------------------

type FieldRule = 'string' | 'stringOpt' | 'numberOpt' | 'stringArray' | 'kind' | 'year'

/** 18 个字段的类型规则（与 types.ts 的 WorkItem 一一对应） */
export const WORK_ITEM_RULES: Readonly<Record<keyof WorkItem, FieldRule>> = Object.freeze({
  sourceId: 'string',
  workId: 'string',
  kind: 'kind',
  title: 'string',
  titleNative: 'stringOpt',
  cover: 'stringOpt',
  coverColor: 'stringOpt',
  description: 'stringOpt',
  score: 'numberOpt',
  year: 'year',
  genres: 'stringArray',
  statusCn: 'stringOpt',
  formatCn: 'stringOpt',
  titleLang: 'stringOpt',
  descLang: 'stringOpt',
  episodes: 'numberOpt',
  chapters: 'numberOpt',
  favorites: 'numberOpt',
})

const WORK_ITEM_FIELDS = Object.keys(WORK_ITEM_RULES) as (keyof WorkItem)[]

/** 18 字段清单（只读导出，供测试断言长度 === 18） */
export const WORK_ITEM_FIELD_LIST: readonly (keyof WorkItem)[] = Object.freeze([
  ...WORK_ITEM_FIELDS,
])

export function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number' && Number.isNaN(v)) return 'NaN'
  return typeof v
}

/**
 * 校验一个候选 WorkItem。返回 null 表示通过；返回字符串表示拒绝原因。
 * ★ 不做任何隐式类型转换：title:2 直接拒绝，绝不 String(2)。
 */
export function validateWorkItem(it: unknown, warn: WarnReporter = defaultWarn): string | null {
  if (typeof it !== 'object' || it === null || Array.isArray(it)) return 'not-an-object'
  const o = it as Record<string, unknown>

  // 1) 未知字段：★ 只警告不拒绝（向前兼容未来字段，设计 §4.8 / 风险 R21）
  // ★ 必须用 hasOwnProperty：`k in WORK_ITEM_RULES` 会沿原型链命中
  //    toString / constructor / __proto__ / valueOf / hasOwnProperty 等内置键，
  //    导致这些未知字段被静默漏报（v1.8 实测：五个内置键 in 均为 true）
  for (const k of Object.keys(o)) {
    if (!Object.prototype.hasOwnProperty.call(WORK_ITEM_RULES, k)) {
      warn(`unknown field: ${k}`)
    }
  }

  // 2) 逐字段类型检查（18 个字段全部覆盖）
  for (const [f, rule] of Object.entries(WORK_ITEM_RULES) as [keyof WorkItem, FieldRule][]) {
    const v = o[f]
    switch (rule) {
      case 'string':
        if (typeof v !== 'string') return `${f}: expected string, got ${typeName(v)}`
        if ((f === 'sourceId' || f === 'workId') && v.trim() === '') return `${f}: must be non-empty`
        break
      case 'stringOpt':
        if (v !== undefined && v !== null && typeof v !== 'string')
          return `${f}: expected string|undefined, got ${typeName(v)}`
        break
      case 'numberOpt':
        if (v !== undefined && v !== null && (typeof v !== 'number' || Number.isNaN(v)))
          return `${f}: expected number|undefined, got ${typeName(v)}`
        break
      case 'stringArray':
        if (!Array.isArray(v)) return `${f}: expected string[], got ${typeName(v)}`
        if (v.some((e) => typeof e !== 'string')) return `${f}: array must contain only strings`
        break
      case 'kind':
        if (v !== 'anime' && v !== 'manga') return `${f}: must be 'anime' | 'manga', got ${typeName(v)}`
        break
      case 'year':
        if (v === null || v === undefined) break
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') break
        return `${f}: unsupported type ${typeName(v)}`
    }
  }
  return null
}

/**
 * ★ 规范化（v1.9 修复 / v1.10 收窄范围）：可选字段的 null 统一为 undefined。
 *
 * ★ 例外：`year` 不参与规范化（v1.10）。见下方 normalizeWorkItem 内注释。
 *
 * 原因：`strCompare`/`cmpNum` 把 null 与 undefined 视为相等（设计如此，表示"无值"），
 * 但二者在对象上是**可区分的原始值**。若不规范化，两条仅在 null/undefined 上不同的记录
 * 会得到 compareRecord===0，去重结果就退化为依赖输入顺序。
 *
 * 处理原则：既然比较器认为二者等价，就在**统一入口**把它们折叠成同一个规范值（undefined），
 * 保证"输出与输入顺序无关"，而不是在 pickBetter 里打补丁。
 * 注意：不修改调用方传入的对象（在拷贝上规范化）。
 */
function normalizeOptional<T extends string | number | undefined>(
  v: T | null,
): T | undefined {
  return v === null ? undefined : (v as T | undefined)
}

/** 规范化 18 字段中的可选字段（sourceId/workId/kind/title/genres 为必填，不参与） */
function normalizeWorkItem(item: WorkItem): WorkItem {
  // ★ 未知字段原样保留（设计 §4.8 / §9 v2 迁移策略「只加字段不删字段，未知字段原样保留」）。
  //    先拷贝全部自有可枚举键，再用规范化后的已知字段覆盖，避免扩展字段被静默丢弃。
  //
  // ★ 冻结边界契约（v1.11 明确，勿误读为"完整深冻结"）：
  //    - `{ ...item }` 是**浅拷贝**：只复制顶层自有可枚举属性，未知字段值仍与入参共享引用。
  //    - 未知字段的嵌套对象/嵌套数组**不做递归冻结**，也不会被 structuredClone 深拷贝。
  //    - 若调用方在传入后修改 `item.extension.inner`，SourceEntry.item.extension.inner 会同步变化。
  //    - 这不影响排序确定性：未知字段不参与 compareRecord / byFixedKey 的任何比较（见 §3.2），
  //      而参与比较的 18 个字段中唯一的引用类型 genres 已由 freezeWorkItem 单独冻结。
  //    - 设计 §3.2 同时规定：WorkItem 若未来新增对象字段，必须先在设计文档登记比较规则，
  //      届时需一并重新评估冻结边界。
  const out: Record<string, unknown> = { ...item }
  Object.assign(out, {
    sourceId: item.sourceId,
    workId: item.workId,
    kind: item.kind,
    title: item.title,
    genres: item.genres,
    titleNative: normalizeOptional(item.titleNative),
    cover: normalizeOptional(item.cover),
    coverColor: normalizeOptional(item.coverColor),
    description: normalizeOptional(item.description),
    score: normalizeOptional(item.score),
    // ★ v1.10 修复：year **不**规范化。
    // yearCompare 特意用档位 0(undefined) / 1(null) 区分二者，
    // 入口若把 null 抹成 undefined，byFixedKey 就永远无法复现该排序语义。
    year: item.year,
    statusCn: normalizeOptional(item.statusCn),
    formatCn: normalizeOptional(item.formatCn),
    titleLang: normalizeOptional(item.titleLang),
    descLang: normalizeOptional(item.descLang),
    episodes: normalizeOptional(item.episodes),
    chapters: normalizeOptional(item.chapters),
    favorites: normalizeOptional(item.favorites),
  })
  return out as unknown as WorkItem
}

export { normalizeWorkItem }

/**
 * 冻结 WorkItem。
 *
 * ★ 冻结范围（v1.11 明确，设计 §4.8「深冻结（顶层 + genres 数组）」）：
 *    - 冻结**顶层对象**（禁止增删改属性）
 *    - 冻结 **genres 数组**（禁止 push/splice 等原地修改，否则会改变比较结果）
 *    - **不**递归冻结其他任何嵌套结构；未知字段若携带嵌套对象，其内部仍可变
 *
 * 之所以只做到"顶层 + genres"：比较只读取 18 个字段，其中唯一引用类型是 genres。
 * 冻结目的是"尽早暴露下游意外写入导致的排序不稳定"，而非对任意扩展数据做不可变性保证。
 */
export function freezeWorkItem(item: WorkItem): Readonly<WorkItem> {
  const copy: WorkItem = { ...item }
  if (Array.isArray(copy.genres)) {
    copy.genres = Object.freeze([...copy.genres]) as string[]
  }
  return Object.freeze(copy)
}

// ---------------------------------------------------------------------------
// SourceEntry
// ---------------------------------------------------------------------------

export interface SourceEntry {
  readonly sourceId: string
  readonly workId: string
  readonly kind: Kind
  readonly title: string
  readonly titleNative?: string
  readonly cover?: string
  readonly coverColor?: string
  readonly description?: string
  readonly score?: number
  readonly year?: number
  readonly genres: readonly string[]
  readonly statusCn?: string
  readonly formatCn?: string
  readonly titleLang?: string
  readonly descLang?: string
  readonly episodes?: number
  readonly chapters?: number
  readonly favorites?: number
  /** 匹配用规范化标题键（仅内部使用，不展示） */
  readonly matchKey: string
  /** 年份语义：决定该年份能否参与跨源佐证 */
  readonly yearMeaning: YearMeaning
  /** 冻结后的原始条目 */
  readonly item: Readonly<WorkItem>
}

/** 诊断回调类型：非法条目被拒绝时上报（不打点、不抛错，保持纯函数） */
export type RejectReporter = (sourceId: string, reason: string) => void

/** 警告回调类型：未知字段等非致命问题（设计 §4.8：只警告不拒绝） */
export type WarnReporter = (message: string) => void

/** 默认警告实现：仅开发/诊断可见，生产环境静默（设计 §4.8 / 风险 R21） */
const defaultWarn: WarnReporter = (msg) => {
  if (import.meta.env.DEV) {
    console.warn(`[sources/entry] ${msg}`)
  }
}

/**
 * 统一转换：WorkItem → SourceEntry。
 * 校验失败返回 null（由调用方决定是否记录诊断），成功则返回深冻结条目。
 */
export function toSourceEntry(
  item: WorkItem,
  onReject?: RejectReporter,
  onWarn: WarnReporter = defaultWarn,
): SourceEntry | null {
  const err = validateWorkItem(item, onWarn)
  if (err) {
    onReject?.((item as Partial<WorkItem>)?.sourceId ?? 'unknown', err)
    return null
  }
  const normalized = normalizeWorkItem(item)
  const frozen = freezeWorkItem(normalized)
  return Object.freeze({
    sourceId: frozen.sourceId,
    workId: frozen.workId,
    kind: frozen.kind,
    title: frozen.title,
    titleNative: frozen.titleNative,
    cover: frozen.cover,
    coverColor: frozen.coverColor,
    description: frozen.description,
    score: frozen.score,
    year: frozen.year,
    genres: frozen.genres,
    statusCn: frozen.statusCn,
    formatCn: frozen.formatCn,
    titleLang: frozen.titleLang,
    descLang: frozen.descLang,
    episodes: frozen.episodes,
    chapters: frozen.chapters,
    favorites: frozen.favorites,
    matchKey: basicKey(frozen.title),
    yearMeaning: yearMeaningOf(frozen.sourceId, frozen.kind),
    item: frozen,
  })
}
