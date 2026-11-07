/**
 * MangaBaka 漫画适配器（总方案·阶段3第2步·第7/8项）
 *
 * 归属：**独立来源工作线 · 漫画专用**。不属阶段3既有编号。
 * 准入依据：备忘录 §34（接口实测 N2）+ §36（vivo 浏览器大陆可达实测）
 *          + 第8项裁定（`source` 由「不读」改为「不透明保留」）。
 *
 * 能力边界（★ 必须遵守，不得谎报）：
 *  - ✅ 搜索 / 详情（漫画类）
 *  - ❌ **不提供动漫**：`type` 枚举实测为 manga|novel|manhwa|manhua|oel|other，**无 anime**。
 *       因此 kind='anime' 必须在**发起网络请求之前**返回空结果。
 *  - ❌ 不提供章节阅读（MangaBaka 是元数据站）
 *
 * 许可：
 *  - 数据 CC BY-NC-SA 4.0；**必须显示 MangaBaka 署名**（见设计 §4⑦，署名落地待批准）
 *  - `source` 根字段下是 Third-Party Data（上游各自条款），`source` 以外是 MangaBaka Data。
 *    按许可要求：`source.*` **不解释、不展示、不参与评分，但原样保留、不删除、不改写**。
 */
import { httpGetText } from '../api/nativeHttp'
import { normalizeCover } from '../../utils/cover'
import { GENRE_MAP, stripHtml } from './anilist'
import type { SourceAdapter, WorkItem, WorkDetail, SearchOptions, SearchResult, Kind, StaffRole } from './types'

const BASE = 'https://api.mangabaka.org'
const PAGE = 20
const REQ_TIMEOUT_MS = 10000

/** 内存缓存：(path,query) → 响应。TTL 5 分钟，与 MangaDex 适配器同级 */
const memCache = new Map<string, { t: number; v: unknown }>()
const TTL = 5 * 60 * 1000

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// 排序映射
// ---------------------------------------------------------------------------

/**
 * 发现页排序 → MangaBaka `sort_by`。
 *
 * ★★ 关键（反直觉，改错必看）：
 *   MangaBaka 的 `popularity` 是**排名，1 = 最热门**（数值越小越热）。
 *   因此「热门」必须用 **popularity_asc**；
 *   用 popularity_desc 会返回 rank 305761 起步的**最冷门**作品。
 *
 * ★ 参数名是 `sort_by`，不是 `sort`；传 `sort` 会得到 400 Unrecognized key。
 */
export const SORT_MAP: Record<string, string> = {
  热门: 'popularity_asc',
  最新: 'latest',
  评分: 'score_desc',
}

/** 有关键词时统一用相关性排序（覆盖上面的浏览排序） */
const SORT_RELEVANCE = 'relevance_desc'

// ---------------------------------------------------------------------------
// 分类映射：发现页的英文分类名（AniList 口径）→ MangaBaka tag id
// ---------------------------------------------------------------------------

/**
 * 16/16 已用 /v1/tags 逐个核对 id 与 name（2026-11-07）。
 * 注意：Mecha(11) / Music(27) / Sports(30) 是 level-2 标签，`is_genre=false`，
 *       **但 id 与语义正确**，过滤时可直接使用。
 */
export const GENRE_TAG: Record<string, number> = {
  Action: 39,
  Adventure: 37,
  Comedy: 6,
  Drama: 31,
  Fantasy: 36,
  Horror: 44,
  Mystery: 32,
  Psychological: 18,
  Romance: 9,
  'Sci-Fi': 1,
  'Slice of Life': 7,
  Sports: 30,
  Supernatural: 22,
  Thriller: 19,
  Music: 27,
  Mecha: 11,
}

// ---------------------------------------------------------------------------
// 状态 / 类型 / 分级
// ---------------------------------------------------------------------------

const STATUS_CN: Record<string, string> = {
  releasing: '连载中',
  completed: '已完结',
  cancelled: '已取消',
  hiatus: '休载/停更',
  upcoming: '未开始',
  unknown: '未知',
}

/** ★ 不得谎称漫画：novel 明确标为小说 */
const FORMAT_CN: Record<string, string> = {
  manga: '漫画（MangaBaka）',
  manhwa: '韩漫（MangaBaka）',
  manhua: '国漫（MangaBaka）',
  oel: '欧美漫画（MangaBaka）',
  novel: '小说（MangaBaka）',
  other: '其他（MangaBaka）',
}

/**
 * 成人向默认排除。
 *
 * ⚠️ `content_rating` 只衡量**性内容**（safe/suggestive/erotica/pornographic），
 *    **不代表暴力、血腥等内容安全**。不要把它当"全年龄"保证。
 *
 * 用 not_content_rating（黑名单外排除）而非 content_rating=safe,suggestive：
 * 前者对未知/未来新增枚举更稳。
 */
const EXCLUDE_RATING = ['erotica', 'pornographic']

/** 类型过滤：排除 novel（小说不是漫画），其余保留并由 formatCn 诚实标注 */
const INCLUDE_TYPES = ['manga', 'manhwa', 'manhua', 'oel', 'other']

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

function qs(params: Record<string, string | number | string[] | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) for (const x of v) sp.append(k, String(x))
    else sp.set(k, String(v))
  }
  return sp.toString()
}

async function mbGet(path: string): Promise<any> {
  const hit = memCache.get(path)
  if (hit && Date.now() - hit.t < TTL) return hit.v
  let lastErr: unknown
  for (let i = 0; i < 2; i++) {
    try {
      const r = await httpGetText(`${BASE}${path}`, REQ_TIMEOUT_MS)
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      const json = JSON.parse(r.text)
      memCache.set(path, { t: Date.now(), v: json })
      return json
    } catch (e) {
      lastErr = e
      if (i === 0) await new Promise((res) => setTimeout(res, 900))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('MangaBaka 请求失败')
}

// ---------------------------------------------------------------------------
// 字段映射
// ---------------------------------------------------------------------------

/** 中文标题语言 → 对外的 titleLang 标注 */
const LANG_OUT: Record<string, string> = {
  zh: 'zh-hans',
  'zh-hant': 'zh-hant',
  en: 'en',
  ja: 'ja',
}

/** 标题语言优先级（每档内再按 is_primary > official > 首个 回退） */
const TITLE_LANG_ORDER = ['zh', 'zh-hant', 'en', 'ja']

interface PickedTitle { title: string; lang?: string; native?: string }

/**
 * 从 `titles[]` 选展示标题。
 *
 * ★ /v2 的**顶层 `title` 字段恒为 null**，绝不能拿它当主标题。
 *   实测：进击的巨人 / 鬼灭之刃 / 葬送的芙莉莲 / 海贼王 的 titles 都有 zh 项。
 */
export function pickTitle(titles: unknown): PickedTitle {
  const arr = Array.isArray(titles) ? (titles as any[]) : []
  const norm = (l: unknown) => String(l ?? '').toLowerCase()

  const nativeRaw = arr.find((t) => norm(t?.language) === 'ja' && t?.title)

  for (const want of TITLE_LANG_ORDER) {
    const pool = arr.filter((t) => norm(t?.language) === want && t?.title)
    if (!pool.length) continue
    const p =
      pool.find((t) => t.is_primary) ||
      pool.find((t) => (t.traits || []).includes('official')) ||
      pool[0]
    return {
      title: String(p.title),
      lang: LANG_OUT[want],
      native: nativeRaw ? String(nativeRaw.title) : undefined,
    }
  }

  const first = arr.find((t) => t?.title)
  if (first) {
    return { title: String(first.title), lang: undefined, native: nativeRaw ? String(nativeRaw.title) : undefined }
  }
  return { title: '', lang: undefined, native: nativeRaw ? String(nativeRaw.title) : undefined }
}

/** 只展示分类级标签；映射得到中文则用中文，否则保留英文原名（与 anilist 口径一致） */
export function mapGenres(tags: unknown): string[] {
  const arr = Array.isArray(tags) ? (tags as any[]) : []
  const known = new Set(Object.keys(GENRE_TAG))
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of arr) {
    const name = t?.name
    if (!name) continue
    const isKnownGenre = known.has(name)
    const isGenreFlag = t?.is_genre === true
    // 收录：16 个已映射分类（含非 is_genre 的 Mecha/Music/Sports），或官方标记为 genre 的标签
    if (!isKnownGenre && !isGenreFlag) continue
    const cn = isKnownGenre ? GENRE_MAP[name] || name : name
    if (!seen.has(cn)) {
      seen.add(cn)
      out.push(cn)
    }
  }
  return out
}

/** 年度：从 published.start_date 取前 4 位 */
function pickYear(v: unknown): number | undefined {
  const s = typeof v === 'string' ? v : ''
  if (s.length < 4) return undefined
  const y = Number(s.slice(0, 4))
  return Number.isFinite(y) && y > 0 ? y : undefined
}

function mapSeries(s: any): WorkItem {
  const picked = pickTitle(s.titles)

  // ★ 评分隔离：只读顶层 rating；rating 为空 → score 必须 undefined，
  //   不得回退到 source.*（source 是 Third-Party Data，不参与评分）。
  const score = typeof s.rating === 'number' && Number.isFinite(s.rating)
    ? Math.round(s.rating)
    : undefined

  return {
    sourceId: 'mangabaka',
    workId: String(s.id),
    kind: 'manga' as Kind,
    title: picked.title || `MangaBaka#${s.id}`,
    titleNative: picked.native,
    cover: normalizeCover(s.cover?.x250 || s.cover?.x350 || s.cover?.raw || undefined),
    description: stripHtml(s.description),
    score,
    year: pickYear(s.published?.start_date),
    genres: mapGenres(s.tags),
    statusCn: STATUS_CN[s.status] ?? s.status ?? undefined,
    formatCn: FORMAT_CN[s.type] ?? s.type ?? undefined,
    // ★ description 恒为英文（大陆侧 vivo 未翻译实测确认），不得标成中文
    titleLang: picked.lang,
    descLang: s.description ? 'en' : undefined,
    chapters: typeof s.total_chapters === 'number' ? s.total_chapters : undefined,
    // favorites 不映射：popularity.global.current 是**排名**，不是收藏/订阅数
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

const mangabaka: SourceAdapter = {
  id: 'mangabaka',
  name: 'MangaBaka',

  async search(opts: SearchOptions): Promise<SearchResult> {
    // ★ 动漫零请求：type 枚举无 anime，必须在任何网络请求之前返回空。
    //   发现页默认 type='anime'，若在此处放行会每轮白发一次请求并浪费配额。
    if (opts.kind !== 'manga') return { items: [], hasNext: false }

    const page = opts.page ?? 1
    const kw = opts.kw?.trim()

    const sortBy = kw
      ? SORT_RELEVANCE
      : SORT_MAP[opts.sort ?? ''] ?? SORT_MAP['热门']

    const tagId = opts.genre ? GENRE_TAG[opts.genre] : undefined

    const path =
      '/v2/series/search?' +
      qs({
        q: kw || undefined,
        // schema=full 必带：默认响应不含 tags，没有分类数据
        schema: 'full',
        page,
        limit: PAGE,
        sort_by: sortBy,
        type: INCLUDE_TYPES,
        not_content_rating: EXCLUDE_RATING,
        // 未知分类不发送 tag（宁可不筛，也不要筛错）
        tag: tagId,
      })

    const json = await mbGet(path)
    const items = ((json?.data || []) as any[]).map(mapSeries)
    const count = typeof json?.pagination?.count === 'number' ? json.pagination.count : items.length
    return { items, hasNext: page * PAGE < count }
  },

  async getDetail(_kind: Kind, workId: string): Promise<WorkDetail> {
    const json = await mbGet(`/v2/series/${encodeURIComponent(workId)}?schema=full`)
    const s = json?.data
    if (!s?.id) throw new Error('作品不存在')
    const base = mapSeries(s)

    const staff: StaffRole[] = []
    const authors = Array.isArray(s.authors) ? s.authors : []
    const artists = Array.isArray(s.artists) ? s.artists : []
    for (const a of authors) if (a) staff.push({ role: '原作/作者', name: String(a) })
    for (const a of artists) if (a) staff.push({ role: '作画', name: String(a) })

    return {
      ...base,
      studios: Array.isArray(s.publishers)
        ? s.publishers.map((p: any) => p?.name).filter(Boolean).map(String)
        : [],
      staff,
      volumes: typeof s.final_volume === 'number' ? s.final_volume : undefined,
      siteUrl: typeof s.canonical_url === 'string' ? s.canonical_url : undefined,
    }
  },
}

export default mangabaka
