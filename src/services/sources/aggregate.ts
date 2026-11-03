/**
 * 聚合层（阶段 3 · 第 2 步）
 *
 * 实现设计文档 v1.8 的：
 *  - §4.3 dedupWithinSource（同源去重，确定性择优，不保留"输入首条"）
 *  - §4.2 三级匹配判定 + 年份佐证 + 排除条件
 *  - §4.2.2 pairwise 全检（禁止传递性误合并）
 *  - §3.2 入口全序排序 + 多组歧义独立成组
 *  - §3.1 结构化 descKey + createAggIdAllocator 唯一签发
 *
 * 纪律：不触碰适配器、不改 classifyError、不复用旧 dedup()、不改 IndexedDB。
 */
import type { Kind, WorkItem } from './types'
import {
  type SourceEntry,
  toSourceEntry,
  isValidYear,
  makeDescKey,
} from './entry'
import { byFixedKey } from './compare'

// ---------------------------------------------------------------------------
// §3.1 aggId 唯一分配器（★ v1.9：私有作用域，不对外导出）
// ---------------------------------------------------------------------------

/** 内部接口：外部模块无法 import 此类型（未导出） */
interface AggIdAllocator {
  issue(descKey: string): string
  size(): number
  snapshot(): string[]
}

/**
 * 创建会话内 aggId 分配器。
 *
 * 核心规则：
 *  - 占用表全量唯一，**循环 while** 直到找到未占用候选，而不是简单追加一次
 *  - 防止「某组原始 descKey 恰好形如 `["manga","X",null]#2`」与「`["manga","X",null]` 第 2 份」撞车
 *  - ★ 唯一签发口：本函数**不导出**，只有 aggregate() 能创建与调用；
 *    外部无法拿到独立签发器，因此不存在第二个 ID 命名空间
 */
function createAggIdAllocator(): AggIdAllocator {
  const occupied = new Set<string>()
  return Object.freeze({
    issue(descKey: string): string {
      if (!occupied.has(descKey)) {
        occupied.add(descKey)
        return descKey
      }
      let n = 2
      while (occupied.has(`${descKey}#${n}`)) n += 1
      const id = `${descKey}#${n}`
      occupied.add(id)
      return id
    },
    size: () => occupied.size,
    snapshot: () => [...occupied],
  })
}

// ---------------------------------------------------------------------------
// §4.3 同源去重
// ---------------------------------------------------------------------------

/** 同源去重键：sourceId + kind + workId（★ 必须含 kind —— Jikan 的 anime/manga 可共享数值 id） */
export function dedupKey(e: SourceEntry): string {
  return `${e.sourceId}\u0000${e.kind}\u0000${e.workId}`
}

/**
 * 信息完备度：用于在重复条目中确定性择优（分数越高越"完整"）。
 * 纯函数、与输入顺序无关。
 */
function richnessScore(e: SourceEntry): number {
  let s = 0
  const str = (v?: string) => (typeof v === 'string' && v.length > 0 ? 1 : 0)
  const num = (v?: number) => (typeof v === 'number' && Number.isFinite(v) ? 1 : 0)
  s += str(e.description) * 3
  s += str(e.titleNative) * 2
  s += str(e.cover) * 2
  s += str(e.coverColor)
  s += str(e.statusCn)
  s += str(e.formatCn)
  s += str(e.titleLang)
  s += str(e.descLang)
  s += num(e.score) * 2
  s += isValidYear(e.year) ? 2 : 0
  s += (e.genres?.length ?? 0) > 0 ? 2 : 0
  s += (e.genres?.length ?? 0)
  s += num(e.episodes)
  s += num(e.chapters)
  s += num(e.favorites)
  return s
}

/**
 * 择优比较：信息更完备者胜；完备度相同 → compareFullRecord 定序（绝不依赖输入顺序）。
 */
function pickBetter(a: SourceEntry, b: SourceEntry): SourceEntry {
  const ra = richnessScore(a)
  const rb = richnessScore(b)
  if (ra !== rb) return ra > rb ? a : b
  // ★ v1.9 修复：平局改用 byFixedKey（规格指定），不再用 compareFullRecord
  const c = byFixedKey(a.item, b.item)
  return c <= 0 ? a : b
}

/**
 * 同源去重：确定性择优，不保留"输入首条"。
 * 不跨源删除（不同 sourceId 的同 workId 条目全部保留）。
 */
export function dedupWithinSource(entries: SourceEntry[]): SourceEntry[] {
  // ★ v1.9 修复：先按 byFixedKey 全序排序，再分桶去重（规格指定顺序）
  const ordered = [...entries].sort((x, y) => byFixedKey(x.item, y.item))
  const buckets = new Map<string, SourceEntry>()
  for (const e of ordered) {
    const k = dedupKey(e)
    const cur = buckets.get(k)
    buckets.set(k, cur ? pickBetter(cur, e) : e)
  }
  // 输出保持 byFixedKey 全序（分桶后重排，确保 Map 插入序不影响结果）
  return [...buckets.values()].sort((a, b) => byFixedKey(a.item, b.item))
}

// ---------------------------------------------------------------------------
// §4.2 三级匹配判定 + 佐证 + 排除
// ---------------------------------------------------------------------------

/**
 * 季度/季数标记提取（v1.9 修复：设计文档明确要求的排除条件）。
 *
 * 识别：第N季 / 第N期 / 第N部 / Season N / S{N} / 第Nクール
 * 归一化为统一的季数序号字符串；无标记返回 null。
 * 典型场景：同标题的「鬼灭之刃 第一季」与「鬼灭之刃 第二季」必须拒绝合并。
 */
export function seasonMarker(title: string): string | null {
  const t = (title || '').toLowerCase()
  // 中文数字 → 阿拉伯数字
  const cn: Record<string, string> = {
    一: '1', 二: '2', 三: '3', 四: '4', 五: '5',
    六: '6', 七: '7', 八: '8', 九: '9', 十: '10',
  }
  const toNum = (raw: string): string => {
    if (/^\d+$/.test(raw)) return String(Number(raw))
    if (cn[raw] !== undefined) return cn[raw] // ★ 修复：单个中文数字（一/二/三…十）
    if (raw === '十') return '10'
    if (/^十[一二三四五六七八九]$/.test(raw)) return String(10 + Number(cn[raw[1]]))
    if (/^[一二三四五六七八九]十$/.test(raw)) return String(Number(cn[raw[0]]) * 10)
    if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(raw))
      return String(Number(cn[raw[0]]) * 10 + Number(cn[raw[2]]))
    return raw
  }
  const patterns: RegExp[] = [
    // ★ v1.10 修复：[季期部クール] 是字符集合（只匹配单字），
    // 会让「第2ク」这种残缺串误命中；改用非捕获分组匹配完整「クール」
    /第\s*([0-9一二三四五六七八九十]+)\s*(?:季|期|部|クール)/, // 第N季/期/部/クール
    /season\s*([0-9]+)/,
    /\bs([0-9]+)\b/,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (m) return toNum(m[1])
  }
  return null
}

/**
 * 排除条件：命中即**绝不合并**（即使标题/年份都相符）。
 * 返回 true 表示"存在明确冲突，禁止合并"。
 */
export function isExcluded(a: SourceEntry, b: SourceEntry): boolean {
  // 1) kind 不同：动漫 vs 漫画 → 不合并
  if (a.kind !== b.kind) return true

  // 2) 季度标记冲突：同一部作品的不同季**不可合并**
  const sa = seasonMarker(a.title) || ''
  const sb = seasonMarker(b.title) || ''
  if (sa && sb && sa !== sb) return true // 双方都有季度标记且不同 → 冲突
  if ((sa && !sb) || (!sa && sb)) return true // 一方有、一方无 → 视为不同作品，拒绝

  // 3) formatCn 明确冲突（TV vs 剧场版 等）
  const fa = (a.formatCn || '').trim()
  const fb = (b.formatCn || '').trim()
  if (fa && fb && fa !== fb) {
    const isMovie = (s: string) => /剧场版|電影版|电影版|movie/i.test(s)
    const isTV = (s: string) => /^tv$|^TV$|电视/i.test(s)
    if ((isMovie(fa) && isTV(fb)) || (isTV(fa) && isMovie(fb))) return true
  }

  // 4) genres 两者都非空且交集为空 → 视为不同类型作品
  if (a.genres.length > 0 && b.genres.length > 0) {
    const sa = new Set(a.genres.map((g) => g.toLowerCase()))
    const hit = b.genres.some((g) => sa.has(g.toLowerCase()))
    if (!hit) return true
  }

  return false
}

/**
 * 年份佐证：
 *  - 两侧都必须有**有效年份**且 yearMeaning ≠ 'unknown'
 *  - 年份相等才算"佐证通过"
 *  - 任一侧无效/unknown → 不构成佐证，也**不因此拒绝**（降级为标题匹配）
 */
export function yearCorroborates(a: SourceEntry, b: SourceEntry): boolean | 'na' {
  const oka = isValidYear(a.year) && a.yearMeaning !== 'unknown'
  const okb = isValidYear(b.year) && b.yearMeaning !== 'unknown'
  if (!oka || !okb) return 'na' // 无法佐证，交给标题判定
  // ★ v1.9 修复：语义必须一致才可比较年份（'start' vs 'finished' 等不可互证）
  if (a.yearMeaning !== b.yearMeaning) return 'na'
  return a.year === b.year
}

/**
 * 三级匹配判定（pairMatch）：
 *  一级 —— 规范化标题键（matchKey）必须完全相等
 *  二级 —— 排除条件不得命中
 *  三级 —— 年份佐证：相等则强通过；明确不等则**拒绝**；无法佐证则放行
 */
export function pairMatch(a: SourceEntry, b: SourceEntry): boolean {
  if (a.matchKey !== b.matchKey) return false
  if (isExcluded(a, b)) return false
  const yc = yearCorroborates(a, b)
  if (yc === 'na') return true
  return yc
}

// ---------------------------------------------------------------------------
// §3.2 分组 + §4.2.2 pairwise 全检
// ---------------------------------------------------------------------------

export interface AggregatedWork {
  /** 会话内唯一 ID（不持久化） */
  aggId: string
  kind: Kind
  /** 展示标题（取组内 SOURCE_ORDER 最靠前的条目原文） */
  title: string
  entries: SourceEntry[]
  /** 展示用合并字段 */
  cover?: string
  coverColor?: string
  description?: string
  score?: number
  year?: number
  genres: string[]
  statusCn?: string
  formatCn?: string
  episodes?: number
  chapters?: number
  favorites?: number
}

/** 从组内条目合成展示字段（按 SOURCE_ORDER 优先取首个非空） */
function mergeDisplay(entries: SourceEntry[]): Omit<AggregatedWork, 'aggId' | 'entries'> {
  const pick = <T>(get: (e: SourceEntry) => T | undefined): T | undefined => {
    for (const e of entries) {
      const v = get(e)
      if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 0)) return v
    }
    return undefined
  }
  const genreSet: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    for (const g of e.genres) {
      const k = g.toLowerCase()
      if (!seen.has(k)) {
        seen.add(k)
        genreSet.push(g)
      }
    }
  }
  const scores = entries.map((e) => e.score).filter((s): s is number => typeof s === 'number')
  const kind = entries[0].kind
  return {
    kind,
    title: entries[0].title,
    cover: pick((e) => e.cover),
    coverColor: pick((e) => e.coverColor),
    description: pick((e) => e.description),
    score: scores.length ? Math.max(...scores) : undefined,
    year: pick((e) => (isValidYear(e.year) ? e.year : undefined)),
    genres: genreSet,
    statusCn: pick((e) => e.statusCn),
    formatCn: pick((e) => e.formatCn),
    episodes: pick((e) => e.episodes),
    chapters: pick((e) => e.chapters),
    favorites: pick((e) => e.favorites),
  }
}

/**
 * 聚合主函数。
 *
 * 流程（严格按设计文档）：
 *  0) 入口按 byFixedKey 全序排序（与请求返回顺序解耦）
 *  1) 逐条尝试并入已有组：必须与组内**每一个**成员 pairMatch 通过（pairwise 全检）
 *  2) 可并入 ≥2 个组 → 归属歧义 → **保守独立成组**（不随机归）
 *  3) 每组计算 descKey，由 allocator 唯一签发 aggId
 *  4) 组列表按首次出现序；组内 entries 恒为 byFixedKey 序
 */
export function aggregate(items: WorkItem[], onReject?: (sourceId: string, reason: string) => void): AggregatedWork[] {
  // 第 0 步：统一转换 + 校验（非法条目在此被拒，绝不进入比较器）
  const entries: SourceEntry[] = []
  for (const it of items) {
    const e = toSourceEntry(it, onReject)
    if (e) entries.push(e)
  }

  // 入口全序排序：与输入顺序无关
  const sorted = [...entries].sort((a, b) => byFixedKey(a.item, b.item))

  // 贪心分组，但每步做 pairwise 全检
  const groups: SourceEntry[][] = []
  for (const e of sorted) {
    const candidates: number[] = []
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]
      // ★ pairwise 全检：必须与组内每个成员都通过，禁止只看代表条目
      if (g.every((m) => pairMatch(m, e))) candidates.push(gi)
    }
    if (candidates.length === 1) {
      groups[candidates[0]].push(e)
    } else if (candidates.length === 0) {
      groups.push([e])
    } else {
      // 多组可容纳 = 归属歧义 → 保守独立成组
      groups.push([e])
    }
  }

  // 组内排序（byFixedKey 恒序）+ 组列表按首元素序
  for (const g of groups) g.sort((a, b) => byFixedKey(a.item, b.item))
  groups.sort((a, b) => byFixedKey(a[0].item, b[0].item))

  // descKey + 唯一 ID 签发
  const alloc = createAggIdAllocator()
  return groups.map((g) => {
    const meta = mergeDisplay(g)
    // descKey 的年份位：组内年份一致且有效才写入，否则 null
    const years = new Set(g.map((e) => (isValidYear(e.year) ? e.year : null)))
    const yearForKey = years.size === 1 ? [...years][0] : null
    const descKey = makeDescKey(g[0].kind, g[0].matchKey, yearForKey)
    return Object.freeze({
      aggId: alloc.issue(descKey),
      entries: Object.freeze([...g]) as SourceEntry[],
      ...meta,
    })
  })
}

// ---------------------------------------------------------------------------
// 导出：供后续步骤与测试使用
// ---------------------------------------------------------------------------

export {
  byFixedKey,
  compareRecord,
  compareFullRecord,
  strCompare,
  cmpNum,
  arrayCompare,
  yearCompare,
  cmpField,
  kindRank,
  RECORD_TAIL_FIELDS,
} from './compare'
export {
  basicKey,
  makeDescKey,
  isValidYear,
  toSourceEntry,
  validateWorkItem,
  freezeWorkItem,
  normalizeWorkItem,
  yearMeaningOf,
  WORK_ITEM_RULES,
  WORK_ITEM_FIELD_LIST,
} from './entry'
export { rank, UNKNOWN_RANK, SOURCE_ORDER } from './registry'
export type { SourceEntry, YearMeaning } from './entry'

/** 测试辅助：richnessScore 供断言使用 */
export const __richnessScore = richnessScore
