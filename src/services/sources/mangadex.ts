/** MangaDex 漫画适配器（阶段 6.4.2.2）
 *  官方开放 API（api.mangadex.org），免 Token，支持分页（limit/offset）。
 *
 *  标题规则：中文主标题 > altTitles 中文别名(简>繁) > 原文标语言。
 *  简介规则：中文优先 > 原文标语言。
 *  阅读链路：feed (章节列表) -> at-home/server (图片服务器) -> 图片直链。
 *  失效恢复：图片 403/404 时重新请求 at-home 服务器地址并重试。
 */
import { httpGetText } from '../api/nativeHttp'
import { finalizeInternal, markParsing, markParsed } from '../diagnostics'
import type { DiagContext } from '../diagnostics'
import type { SourceAdapter, WorkItem, WorkDetail, SearchOptions, SearchResult, Kind, StaffRole, ChapterItem, PageItem } from './types'

const BASE = 'https://api.mangadex.org'

/* ══════════════════════════════════════════════════════════════
 * 2c 诊断接入：尝试台账（文件内私有，不进入 diagnostics、不新增诊断 API）
 *  - helper 只【登记】每次尝试，绝不终结
 *  - 终结权集中在适配器 finally（成功/失败两路径都执行）
 * ══════════════════════════════════════════════════════════════ */
type AttemptSlot = { attemptId: string; ok: boolean; err?: unknown; done?: boolean }
type AttemptPlan = { requestId: string; ledger: AttemptSlot[] }

let reqSeq = 0
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

/** 逻辑请求的关联 ID（诊断关联用，非安全令牌；同实例内同步自增保证不重复） */
function nextRequestId(tag: 'manga_search'): string {
  reqSeq += 1
  return `mangadex:${tag}:${RUN_ID}:${reqSeq.toString(36)}`
}

/** 适配器侧统一终结：双层隔离，诊断异常绝不覆盖业务返回值或原始异常 */
function settleLedger(ledger: AttemptSlot[]): void {
  try {
    for (const s of ledger) {
      if (s.done) continue
      s.done = true
      try {
        if (s.ok) finalizeInternal(s.attemptId, 'success')
        else finalizeInternal(s.attemptId, 'failure', s.err)
      } catch { /* 内层：单个 slot 失败不影响其余 */ }
    }
  } catch { /* 外层：遍历本身异常同样不外泄 */ }
}
const COVER = 'https://uploads.mangadex.org/covers'

/* eslint-disable @typescript-eslint/no-explicit-any */
const memCache = new Map<string, { t: number; v: any }>()
const TTL = 5 * 60 * 1000

// at-home 服务器信息缓存（短期，方便失效刷新）
const serverCache = new Map<string, { t: number; v: any }>()
const SERVER_TTL = 10 * 60 * 1000

async function mdGet(path: string, plan?: AttemptPlan): Promise<any> {
  const hit = memCache.get(path)
  if (hit && Date.now() - hit.t < TTL) return hit.v // ★ 缓存命中：不建 ctx、不登记
  let lastErr: unknown
  for (let i = 0; i < 2; i++) {
    const attempt = i + 1
    const slot: AttemptSlot | undefined = plan ? { attemptId: `${plan.requestId}:${attempt}`, ok: false } : undefined
    if (slot && plan) plan.ledger.push(slot) // ★ 先入账、后发请求
    try {
      const ctx: DiagContext | undefined = slot && plan
        ? { sourceId: 'mangadex', requestType: 'manga_search', attempt, requestId: plan.requestId, attemptId: slot.attemptId, path: path.split('?')[0] }
        : undefined
      const r = await httpGetText(`${BASE}${path}`, 10000, undefined, ctx)
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      if (ctx) markParsing(ctx.attemptId)
      const json = JSON.parse(r.text)
      if (ctx && slot) { markParsed(ctx.attemptId); slot.ok = true } // ★ 只记 ok，不终结
      memCache.set(path, { t: Date.now(), v: json })
      return json
    } catch (e) {
      if (slot) slot.err = e // ★ 只记错，不终结
      lastErr = e
      await new Promise((res) => setTimeout(res, 900 * (i + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('MangaDex 请求失败')
}

const ZH_SIMP = ['zh-hans', 'zh', 'zh-cn']
const ZH_TRAD = ['zh-hant', 'zh-tw']
const zhKey = (obj: Record<string, string>): string | undefined => {
  for (const k of [...ZH_SIMP, ...ZH_TRAD]) {
    const v = obj[k]
    if (v && v.trim()) return k
  }
  return undefined
}

function pickTitle(title: Record<string, string>, altTitles: Record<string, string>[]): { text: string; lang: string; original: boolean } {
  const zhMain = zhKey(title)
  if (zhMain) return { text: title[zhMain], lang: zhMain.toLowerCase(), original: true }
  for (const pref of [...ZH_SIMP, ...ZH_TRAD]) {
    for (const alt of altTitles) {
      const v = alt[pref]
      if (v && v.trim()) return { text: v, lang: pref, original: false }
    }
  }
  for (const alt of altTitles) {
    const k = Object.keys(alt).find((x) => x.toLowerCase().startsWith('zh'))
    if (k && alt[k]?.trim()) return { text: alt[k], lang: k, original: false }
  }
  const fallbackKey = title.en ? 'en' : (Object.keys(title)[0] ?? '')
  return { text: title[fallbackKey] || Object.values(title)[0] || '未命名', lang: fallbackKey, original: true }
}

function pickDesc(desc: Record<string, string>): { text?: string; lang?: string } {
  const zh = zhKey(desc)
  if (zh) return { text: desc[zh], lang: zh.toLowerCase() }
  for (const k of ['en', 'ja', 'ja-ro']) {
    if (desc[k]?.trim()) return { text: desc[k], lang: k }
  }
  const keys = Object.keys(desc)
  if (keys.length) return { text: desc[keys[0]], lang: keys[0] }
  return {}
}

const STATUS_CN: Record<string, string> = {
  ongoing: '连载中', completed: '已完结', hiatus: '休载', cancelled: '已取消',
}

const TAG_CN: Record<string, string> = {
  Action: '热血', Adventure: '冒险', Comedy: '搞笑', Drama: '剧情', Fantasy: '奇幻',
  Horror: '恐怖', Mystery: '悬疑', Psychological: '心理', Romance: '恋爱', 'Sci-Fi': '科幻',
  'Slice of Life': '日常', Sports: '运动', Supernatural: '超自然', Thriller: '惊悚',
  Tragedy: '悲剧', Mecha: '机甲', Isekai: '异世界', 'School Life': '校园',
  Historical: '历史', 'Martial Arts': '武侠', Music: '音乐', Award: '获奖作品',
  'Award Winning': '获奖作品', 'Boys Love': 'BL', 'Girls Love': 'GL', Ecchi: '福利',
}

function mapManga(m: any): WorkItem {
  const a = m.attributes
  const altTitles: Record<string, string>[] = a.altTitles || []
  const t = pickTitle(a.title || {}, altTitles)
  const d = pickDesc(a.description || {})
  const coverRel = (m.relationships || []).find((r: any) => r.type === 'cover_art')
  const cover = coverRel ? `${COVER}/${m.id}/${coverRel.attributes.fileName}.256.jpg` : undefined
  return {
    sourceId: 'mangadex',
    workId: m.id,
    kind: 'manga',
    title: t.text,
    titleNative: a.title?.['ja-ro'] || a.title?.ja || a.title?.['ko-ro'] || Object.values(a.title || {})[0] || undefined,
    cover,
    description: d.text,
    score: a.rating?.average ? Math.round(a.rating.average * 10) : undefined,
    year: a.year ?? undefined,
    genres: (a.tags || []).map((x: any) => TAG_CN[x.attributes?.name?.en] || x.attributes?.name?.en).filter(Boolean),
    statusCn: STATUS_CN[a.status] || a.status,
    formatCn: a.originalLanguage === 'ko' ? '韩漫（MangaDex）' : a.originalLanguage === 'zh' ? '国漫（MangaDex）' : '漫画（MangaDex）',
    chapters: a.lastChapter ? Number(a.lastChapter) : undefined,
    titleLang: t.lang,
    descLang: d.lang,
  }
}

const PAGE = 20

const mangadex: SourceAdapter = {
  id: 'mangadex',
  name: 'MangaDex',

  async search(opts: SearchOptions): Promise<SearchResult> {
    const requestId = nextRequestId('manga_search') // ★ 每个 search 各一
    const ledger: AttemptSlot[] = []
    const page = opts.page ?? 1
    const offset = (page - 1) * PAGE
    const q = new URLSearchParams()
    q.set('limit', String(PAGE))
    q.set('offset', String(offset))
    q.set('includes[]', 'cover_art')
    q.set('contentRating[]', 'safe')
    q.set('contentRating[]', 'suggestive')
    if (opts.kw?.trim()) q.set('title', opts.kw.trim())
    else {
      const order = opts.sort === '评分' ? 'rating' : opts.sort === '最新' ? 'latestUploadedChapter' : 'followedCount'
      q.set(`order[${order}]`, 'desc')
      if (order === 'latestUploadedChapter') q.set('hasAvailableChapters', 'true')
    }
    try {
      const json = await mdGet(`/manga?${q.toString()}`, { requestId, ledger })
      const items = (json.data || []).map(mapManga)
      const total = json.total ?? 0
      return { items, hasNext: offset + items.length < total }
    } finally {
      settleLedger(ledger) // ★ 唯一终结点：错误照常上抛（无 catch）
    }
  },

  async getDetail(_kind: Kind, workId: string): Promise<WorkDetail> {
    const json = await mdGet(`/manga/${encodeURIComponent(workId)}?includes[]=cover_art&includes[]=author&includes[]=artist`)
    const m = json.data
    if (!m?.attributes) throw new Error('作品不存在')
    const base = mapManga(m)
    const staff: StaffRole[] = (m.relationships || [])
      .filter((r: any) => r.type === 'author' || r.type === 'artist')
      .map((r: any) => ({ role: r.type === 'author' ? '原作/作者' : '作画', name: r.attributes?.name || '' }))
      .filter((s: StaffRole) => s.name)
    return {
      ...base,
      studios: [],
      staff,
      chapters: base.chapters,
      siteUrl: `https://mangadex.org/title/${workId}`,
    }
  },

  async getChapters(workId: string, options?: { limit?: number; cursor?: string }): Promise<{ chapters: ChapterItem[]; nextCursor?: string; hasNext: boolean }> {
    const limit = options?.limit ?? PAGE
    const offset = options?.cursor ? parseInt(options.cursor) : 0
    const q = new URLSearchParams()
    q.set('limit', String(limit))
    q.set('offset', String(offset))
    q.set('order[chapter]', 'desc')
    q.set('includes[]', 'scanlation_group')
    q.set('contentRating[]', 'safe')
    q.set('contentRating[]', 'suggestive')
    // 说明：本网络下服务端对 translatedLanguage[]=zh-hans/zh-hant 返回 400（BCP47 正则限制），
    // 故不过滤语言，拉取全语言章节后由 UI 用 translatedLanguage 徽标区分/筛选（见 6.4.2.2 实测记录）。
    const json = await mdGet(`/manga/${encodeURIComponent(workId)}/feed?${q.toString()}`)
    const items = (json.data || []).map((c: any): ChapterItem => {
      const a = c.attributes
      const grp = (c.relationships || []).find((r: any) => r.type === 'scanlation_group')
      return {
        id: c.id,
        sourceId: 'mangadex',
        workId,
        title: a.title || '(无标题)',
        chapter: a.chapter || '-',
        volume: a.volume,
        pages: a.pages,
        translatedLanguage: a.translatedLanguage,
        group: grp?.attributes?.name,
        externalUrl: a.externalUrl,
      }
    })
    const total = json.total ?? 0
    return {
      chapters: items,
      nextCursor: offset + items.length < total ? String(offset + items.length) : undefined,
      hasNext: offset + items.length < total,
    }
  },

  async getPages(chapterId: string, options?: { refresh?: boolean }): Promise<PageItem[]> {
    // at-home 服务器地址做短期内存缓存；refresh=true（图片 403/404 后由调用方触发）强制重新获取一次
    const getServer = async () => {
      const hit = serverCache.get(chapterId)
      if (!options?.refresh && hit && Date.now() - hit.t < SERVER_TTL) return hit.v
      const json = await mdGet(`/at-home/server/${chapterId}`)
      const res = { baseUrl: json.baseUrl, hash: json.chapter.hash, data: json.chapter.data }
      serverCache.set(chapterId, { t: Date.now(), v: res })
      return res
    }

    const { baseUrl, hash, data } = await getServer()
    return (data || []).map((fileName: string, index: number) => ({
      index,
      url: `${baseUrl}/data/${hash}/${fileName}`,
    }))
  },

  async status(): Promise<{ ok: boolean; message?: string }> {
    try {
      const r = await mdGet('/ping')
      return { ok: r === 'pong' }
    } catch (e: any) {
      return { ok: false, message: e.message }
    }
  }
}

export default mangadex
