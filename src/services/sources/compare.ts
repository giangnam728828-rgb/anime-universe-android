/**
 * 确定性比较器（阶段 3 · 第 2 步）
 *
 * 实现设计文档 v1.8 §3.2 与 §4.7.2：
 *  - strCompare：UTF-16 码元序（JS 原生 `<`/`>`），不用 localeCompare
 *  - cmpNum：undefined/null/NaN 最小且彼此相等；±Infinity 按数值
 *  - arrayCompare：长度优先，再逐元素 strCompare
 *  - yearCompare：类型化八档分档，只有原始值相同才返回 0
 *  - compareRecord：**唯一权威顺序**，18 字段各出现一次
 *  - byFixedKey：额外比较动态 rank，再转 compareRecord
 *  - compareFullRecord：直接转发 compareRecord
 *
 * ★ 关键：比较器选择**完全由字段名决定**，绝不按运行时类型动态切换，
 *   因此等价关系（自反/对称/传递）在全域成立。非法类型由 entry.ts 的校验层拒绝。
 */
import type { WorkItem } from './types'
import { rank } from './registry'

// ---------------------------------------------------------------------------
// 基础比较器
// ---------------------------------------------------------------------------

/** 字符串：UTF-16 码元序；undefined/null 最小且彼此相等 */
export function strCompare(a?: string | null, b?: string | null): number {
  const x = a ?? null
  const y = b ?? null
  if (x === null && y === null) return 0
  if (x === null) return -1
  if (y === null) return 1
  return x < y ? -1 : x > y ? 1 : 0
}

/** 数值：undefined/null/NaN → 无效（最小，彼此相等）；±Infinity 按数值参与 */
export function cmpNum(a?: number | null, b?: number | null): number {
  const bad = (v: unknown) => v === undefined || v === null || Number.isNaN(v as number)
  const ba = bad(a)
  const bb = bad(b)
  if (ba && bb) return 0
  if (ba) return -1
  if (bb) return 1
  const x = a as number
  const y = b as number
  return x < y ? -1 : x > y ? 1 : 0
}

/** 数组：先比长度，再逐元素 strCompare；undefined 与 [] 视为相等 */
export function arrayCompare(
  a?: readonly string[] | null,
  b?: readonly string[] | null,
): number {
  const x = a ?? []
  const y = b ?? []
  if (x.length !== y.length) return x.length < y.length ? -1 : 1
  for (let i = 0; i < x.length; i++) {
    const c = strCompare(x[i], y[i])
    if (c) return c
  }
  return 0
}

// ---------------------------------------------------------------------------
// yearCompare（§4.7.2 类型化分档）
// ---------------------------------------------------------------------------

const TIER_UNDEFINED = 0
const TIER_NULL = 1
const TIER_NAN = 2
const TIER_POS_INF = 3
const TIER_NEG_INF = 4
const TIER_NON_INTEGER = 5
const TIER_OUT_RANGE = 6
const TIER_NON_NUMBER = 7

const YEAR_MIN = 1900
const YEAR_MAX = 2200

function isValidYearValue(y: unknown): y is number {
  return (
    typeof y === 'number' &&
    Number.isFinite(y) &&
    Number.isInteger(y) &&
    y >= YEAR_MIN &&
    y <= YEAR_MAX
  )
}

function invalidTier(y: unknown): number {
  if (y === undefined) return TIER_UNDEFINED
  if (y === null) return TIER_NULL
  if (typeof y === 'number') {
    if (Number.isNaN(y)) return TIER_NAN
    if (y === Infinity) return TIER_POS_INF
    if (y === -Infinity) return TIER_NEG_INF
    if (!Number.isInteger(y)) return TIER_NON_INTEGER
    return TIER_OUT_RANGE
  }
  return TIER_NON_NUMBER
}

/** year 入参白名单校验：不支持的类型抛错，绝不静默返回 0 */
export function assertSupportedYear(y: unknown): void {
  if (typeof y === 'number' || y === undefined || y === null) return
  if (typeof y === 'string' || typeof y === 'bigint') return
  const kind = typeof y === 'object' && y !== null ? 'object' : typeof y
  const e = new Error(`yearCompare: unsupported year input type "${kind}"`) as Error & {
    _tag?: string
    kind?: string
  }
  e._tag = 'YEAR_UNSUPPORTED_INPUT'
  e.kind = kind
  throw e
}

const SUPPORTED_NON_NUMBER_TAG: Readonly<Record<string, number>> = Object.freeze({
  string: 0,
  bigint: 1,
})

function tagOfNonNumber(v: unknown): number {
  if (typeof v === 'string') return SUPPORTED_NON_NUMBER_TAG.string
  if (typeof v === 'bigint') return SUPPORTED_NON_NUMBER_TAG.bigint
  assertSupportedYear(v)
  throw new Error('unreachable')
}

function cmpSameTier(a: unknown, b: unknown, tier: number): number {
  switch (tier) {
    case TIER_UNDEFINED:
    case TIER_NULL:
    case TIER_NAN:
    case TIER_POS_INF:
    case TIER_NEG_INF:
      return 0 // 档内取值唯一，原始值必然相同
    case TIER_NON_INTEGER:
    case TIER_OUT_RANGE:
      return cmpNum(a as number, b as number) // 按真实数值，与区间无关
    case TIER_NON_NUMBER: {
      const ta = tagOfNonNumber(a)
      const tb = tagOfNonNumber(b)
      if (ta !== tb) return ta < tb ? -1 : 1
      if (typeof a === 'string') return strCompare(a, b as string)
      return (a as bigint) < (b as bigint) ? -1 : (a as bigint) > (b as bigint) ? 1 : 0
    }
    default:
      return 0
  }
}

/**
 * 年份比较：三段式（有效/无效 → 档位 → 同档原始值）。
 * ★ assertSupportedYear 前置：即使另一侧是有效年份也不跳过校验。
 */
export function yearCompare(a: unknown, b: unknown): number {
  assertSupportedYear(a)
  assertSupportedYear(b)
  const va = isValidYearValue(a)
  const vb = isValidYearValue(b)
  if (va && vb) return cmpNum(a as number, b as number)
  if (va && !vb) return 1 // 有效年份整体排在无效之后
  if (!va && vb) return -1
  const ta = invalidTier(a)
  const tb = invalidTier(b)
  if (ta !== tb) return ta < tb ? -1 : 1
  return cmpSameTier(a, b, ta)
}

// ---------------------------------------------------------------------------
// 字段类型映射（静态，绝不按值判断）
// ---------------------------------------------------------------------------

type FieldKind = 'string' | 'number' | 'string[]' | 'year' | 'kind'

const FIELD_KIND: Readonly<Record<keyof WorkItem, FieldKind>> = Object.freeze({
  sourceId: 'string',
  workId: 'string',
  kind: 'kind',
  title: 'string',
  titleNative: 'string',
  cover: 'string',
  coverColor: 'string',
  description: 'string',
  score: 'number',
  year: 'year',
  genres: 'string[]',
  statusCn: 'string',
  formatCn: 'string',
  titleLang: 'string',
  descLang: 'string',
  episodes: 'number',
  chapters: 'number',
  favorites: 'number',
})

export function kindRank(k: WorkItem['kind']): number {
  return k === 'anime' ? 0 : 1
}

/** 单字段比较：选择器由**字段名**决定 */
export function cmpField<K extends keyof WorkItem>(a: WorkItem, b: WorkItem, f: K): number {
  switch (FIELD_KIND[f]) {
    case 'string':
      return strCompare(a[f] as string, b[f] as string)
    case 'number':
      return cmpNum(a[f] as number, b[f] as number)
    case 'string[]':
      return arrayCompare(a[f] as string[], b[f] as string[])
    case 'year':
      return yearCompare(a[f], b[f])
    case 'kind':
      return cmpNum(kindRank(a.kind), kindRank(b.kind))
    default:
      return 0
  }
}

/** compareRecord 中 year 之后的 13 个内容字段（顺序固定） */
export const RECORD_TAIL_FIELDS = Object.freeze([
  'titleNative',
  'cover',
  'coverColor',
  'description',
  'genres',
  'statusCn',
  'formatCn',
  'score',
  'episodes',
  'chapters',
  'favorites',
  'titleLang',
  'descLang',
] as const satisfies readonly (keyof WorkItem)[])

/**
 * ★ 唯一权威完整记录比较器：18 字段各出现一次。
 * 1 sourceId → 2 workId → 3 kind → 4 title → 5 year → 6..18 内容字段
 */
export function compareRecord(a: WorkItem, b: WorkItem): number {
  let c = strCompare(a.sourceId, b.sourceId)
  if (c) return c
  c = strCompare(a.workId, b.workId)
  if (c) return c
  c = cmpNum(kindRank(a.kind), kindRank(b.kind))
  if (c) return c
  c = strCompare(a.title, b.title)
  if (c) return c
  c = yearCompare(a.year, b.year)
  if (c) return c
  for (const f of RECORD_TAIL_FIELDS) {
    c = cmpField(a, b, f)
    if (c) return c
  }
  return 0
}

/**
 * 排序键：**唯一附加语义 = 动态 rank**，其余完全交给 compareRecord。
 * rank 相等时与 compareFullRecord 严格同号。
 */
export function byFixedKey(a: WorkItem, b: WorkItem): number {
  const d = rank(a.sourceId) - rank(b.sourceId)
  if (d) return Math.sign(d)
  return compareRecord(a, b)
}

/** 完整记录比较器：直接转发，无额外字段 */
export function compareFullRecord(a: WorkItem, b: WorkItem): number {
  return compareRecord(a, b)
}

// ---------------------------------------------------------------------------
// 搜索相关性比较器（独立搜索体验修复 · 方案 B）
//
// 设计约束：
//  - relevance() 是**纯函数**：相同 (item, kw) 恒返回相同分档，保证全序
//  - title / titleNative 取**较高**匹配等级，不叠加
//  - 空关键词、关键词长度 < 2 时不产生虚假相关分
//  - 规范化统一处理大小写、空白、全半角与常见标点
//  - 相关性相同 → 严格回退到 SOURCE_ORDER，再回退 compareRecord
// ---------------------------------------------------------------------------

/** 相关性分档：数值越大越相关 */
export const RELEVANCE = Object.freeze({
  EXACT: 4,
  PREFIX: 3,
  CONTAINS: 2,
  PARTIAL: 1,
  NONE: 0,
})

/** PARTIAL 档要求关键词至少这么长（避免单字符过度匹配） */
const PARTIAL_MIN_KW_LEN = 2
/** PARTIAL 档取关键词的前 N 个字符做片段匹配 */
const PARTIAL_PREFIX_LEN = 2

/**
 * 统一规范化：小写 + 全角转半角 + 去除空白与常见标点。
 * 只用于相关性匹配，**不修改** entry.ts 的 basicKey（它服务 matchKey）。
 */
export function normForRelevance(s?: string | null): string {
  if (!s) return ''
  return s
    .toLowerCase()
    // 全角 ASCII（！至 ～）转半角
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    // 全角空格
    .replace(/\u3000/g, '')
    // 空白 + 常见中英日标点/符号
    .replace(/[\s:：·・'’‘`\-—–_/\\|!?？?、，,。.「」『』【】\[\]()（）{}<>《》〈〉~～"“”*#@&+]+/g, '')
    .trim()
}

/** 单个标题对关键词的匹配等级 */
function matchLevel(title: string, kw: string): number {
  if (!title || !kw) return RELEVANCE.NONE
  if (title === kw) return RELEVANCE.EXACT
  if (title.startsWith(kw)) return RELEVANCE.PREFIX
  if (title.includes(kw)) return RELEVANCE.CONTAINS
  if (kw.length >= PARTIAL_MIN_KW_LEN) {
    const head = kw.slice(0, PARTIAL_PREFIX_LEN)
    if (head.length >= PARTIAL_MIN_KW_LEN && title.includes(head)) return RELEVANCE.PARTIAL
  }
  return RELEVANCE.NONE
}

/**
 * 计算单条记录对关键词的相关性分档（0..4）。
 * title 与 titleNative 取**较高**等级，不叠加。
 */
export function relevance(item: WorkItem, kw?: string | null): number {
  const k = normForRelevance(kw)
  if (!k) return RELEVANCE.NONE
  const a = matchLevel(normForRelevance(item.title), k)
  const b = matchLevel(normForRelevance(item.titleNative), k)
  return a > b ? a : b
}

/** 相关性比较器：分高者在前；相同返回 0，交给后续规则 */
export function cmpRelevance(a: WorkItem, b: WorkItem, kw?: string | null): number {
  const ra = relevance(a, kw)
  const rb = relevance(b, kw)
  return rb - ra
}

/**
 * 带相关性的排序键：相关性 → SOURCE_ORDER(rank) → compareRecord。
 *
 * 不传 kw（undefined/null/空串）时**逐字等价**于 byFixedKey，保持旧行为。
 * 全序性：relevance 为纯函数，平局严格回退到 byFixedKey 的全序，故整体仍是全序。
 */
export function byFixedKeyWithQuery(a: WorkItem, b: WorkItem, kw?: string | null): number {
  if (kw) {
    const d = cmpRelevance(a, b, kw)
    if (d) return Math.sign(d)
  }
  return byFixedKey(a, b)
}
