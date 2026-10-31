/** Bilibili 番剧/国创适配器（阶段 6.4.2）
 *  接口（6.4.1 实测，公开网页端接口，无需登录/Token）：
 *  - 列表: GET api.bilibili.com/pgc/season/index/result?season_type=1|2&page=1&pagesize=10&type=1&year=YYYY
 *  - 详情: GET api.bilibili.com/pgc/view/web/season?season_id=ID
 *  仅获取作品元数据与页面入口（siteUrl 指向 B 站页面），不请求/解析任何视频流。
 *  需要请求头 UA + Referer（网页端常规头）；实测约 1/3 概率网络波动 → 重试 2 次 + 内存缓存 5min。
 *  搜索接口依赖浏览器 cookie（实测假 cookie 返回空结果），故本适配器不提供关键词搜索，
 *  关键词搜索由 AniList/MangaDex 承担；B 站源用于浏览（首页/发现页的中文动漫内容）。
 */
import { httpGetText, httpPostJson } from '../api/nativeHttp'
import type { SourceAdapter, WorkItem, WorkDetail, SearchOptions, SearchResult, Kind, StaffRole } from './types'

const BASE = 'https://api.bilibili.com'
const UA_BILI = 'Mozilla/5.0 (Linux; Android 14) AnimeUniverse/0.6'
const HEADERS = { Referer: 'https://www.bilibili.com/', Accept: 'application/json', Cookie: 'buvid3=AF3B4C9E-8B21-4C6A-9D0E-3F5A7B8C9D1Einfoc; b_nut=1700000000' }

/* ── B站漫画（mc 搜索，公开网页端接口；6.4.2 实测 Search 可用，详情/分类接口被风控）── */
const MANGA_API = 'https://manga.bilibili.com/twirp/comic.v1.Comic/Search?device=pc&platform=web'

let buvidCk: string | null = null
/** spi 指纹接口拿真实 buvid（公开无登录）；失败用静态兜底 */
async function ensureBuvid(): Promise<string> {
  if (buvidCk) return buvidCk
  try {
    const r = await httpGetText(`${BASE}/x/frontend/finger/spi`, 8000)
    if (r.status === 200) {
      const d = JSON.parse(r.text)?.data
      if (d?.b_3) {
        buvidCk = `buvid3=${d.b_3}; buvid4=${d.b_4 || ''}`
        return buvidCk
      }
    }
  } catch { /* 忽略，走兜底 */ }
  return HEADERS.Cookie!
}

const mangaDetailMap = new Map<string, WorkItem>()
const mangaAuthors = new Map<string, string[]>()

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapMangaComic(it: any): WorkItem | null {
  const id = it.id ?? it.comic_id
  const title = String(it.org_title || it.real_title || it.title || '').replace(/<[^>]*>/g, '').trim()
  if (!id || !title) return null
  const wid = String(id)
  if (Array.isArray(it.author_name) && it.author_name.length) mangaAuthors.set(wid, it.author_name.filter(Boolean))
  return {
    sourceId: 'bilibili',
    workId: wid,
    kind: 'manga',
    title,
    cover: it.vertical_cover || it.square_cover || it.horizontal_cover || undefined,
    genres: (it.styles || []).filter(Boolean),
    statusCn: it.is_finish === 1 ? '已完结' : it.is_finish === 0 ? '连载中' : undefined,
    formatCn: '漫画（B漫）',
    titleLang: 'zh',
    descLang: 'zh',
  }
}

async function mangaSearch(kw: string): Promise<SearchResult> {
  const ck = await ensureBuvid()
  const r = await httpPostJson(
    MANGA_API,
    { 'User-Agent': UA_BILI, Referer: 'https://manga.bilibili.com/', Accept: 'application/json', Cookie: ck },
    { keyWord: kw, pageNum: 1, pageSize: 20 },
    10000,
  )
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
  const json = JSON.parse(r.text)
  if (json.code !== 0) throw new Error(json.msg || `code ${json.code}`)
  const items = (json?.data?.list || []).map(mapMangaComic).filter(Boolean) as WorkItem[]
  for (const it of items) {
    mangaDetailMap.set(it.workId, it)
    if (mangaDetailMap.size > 300) {
      const first = mangaDetailMap.keys().next().value
      if (first !== undefined) mangaDetailMap.delete(first)
    }
  }
  return { items, hasNext: false }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const memCache = new Map<string, { t: number; v: any }>()
const TTL = 5 * 60 * 1000

async function biliGet(path: string): Promise<any> {
  const key = path
  const hit = memCache.get(key)
  if (hit && Date.now() - hit.t < TTL) return hit.v
  let lastErr: unknown
  for (let i = 0; i < 2; i++) {
    try {
      const r = await httpGetText(`${BASE}${path}`, 8000, HEADERS)
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      const json = JSON.parse(r.text)
      if (json.code !== 0) throw new Error(json.message || `code ${json.code}`)
      memCache.set(key, { t: Date.now(), v: json })
      return json
    } catch (e) {
      lastErr = e
      await new Promise((res) => setTimeout(res, 800 * (i + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Bilibili 请求失败')
}

function mapItem(it: any, kind: '番剧' | '国创', year: number): WorkItem | null {
  const seasonId = it.season_id ?? it.seasonId
  const title: string = (it.title || '').replace(/<[^>]*>/g, '').trim()
  if (!seasonId || !title) return null
  const desc = (it.desc || it.evaluate || '').replace(/<[^>]*>/g, '').trim() || undefined
  const score = it.media_score?.score ?? (it.score ? Number(it.score) : undefined)
  return {
    sourceId: 'bilibili',
    workId: String(seasonId),
    kind: 'anime',
    title,
    titleNative: it.origin_name || undefined,
    cover: it.cover || undefined,
    description: desc,
    score: score && score > 0 ? score : undefined,
    year,
    genres: (it.styles || []).map((s: any) => s.name || s).filter(Boolean),
    statusCn: it.badge === '会员完结' || it.badge === '完结' ? '已完结' : it.badge === '连载中' ? '放送/连载中' : undefined,
    formatCn: kind === '番剧' ? '番剧（B站）' : '国创（B站）',
    episodes: it.total ?? undefined,
  }
}

/** 页码 → 年份：第1页当年（番剧+国创各10），往后逐年回溯 */
function yearOfPage(page: number): number {
  return new Date().getFullYear() - (Math.max(1, page) - 1)
}

async function listSeason(seasonType: 1 | 2, year: number): Promise<{ list: any[]; hasNext: boolean }> {
  try {
    const json = await biliGet(`/pgc/season/index/result?season_type=${seasonType}&page=1&pagesize=10&type=1&year=${year}`)
    const list = json?.data?.list || []
    return { list, hasNext: !!json?.data?.has_next }
  } catch {
    return { list: [], hasNext: false } // 单类失败不阻塞另一类
  }
}

const bilibili: SourceAdapter = {
  id: 'bilibili',
  name: '哔哩哔哩',

  async search(opts: SearchOptions): Promise<SearchResult> {
    // 关键词搜索：漫画走 B漫 Search（实测可用）；动漫 B站搜索需登录 cookie，不参与
    if (opts.kw?.trim()) {
      if (opts.kind === 'manga') return mangaSearch(opts.kw.trim())
      return { items: [], hasNext: false }
    }
    if (opts.kind !== 'anime') return { items: [], hasNext: false }
    const year = yearOfPage(opts.page ?? 1)
    const [fan, guochuang] = await Promise.all([listSeason(1, year), listSeason(2, year)])
    const items = [
      ...fan.list.map((it) => mapItem(it, '番剧', year)),
      ...guochuang.list.map((it) => mapItem(it, '国创', year)),
    ].filter(Boolean) as WorkItem[]
    return { items, hasNext: fan.hasNext || guochuang.hasNext }
  },

  async getDetail(_kind: Kind, workId: string): Promise<WorkDetail> {
    // B漫条目：详情接口被风控，用搜索时缓存的条目数据（无简介，详情页显示基础信息+B漫跳转）
    const cached = mangaDetailMap.get(workId)
    if (cached && cached.kind === 'manga') {
      const staff: StaffRole[] = (mangaAuthors.get(workId) || []).slice(0, 6).map((n) => ({ role: '作者', name: n }))
      return {
        ...cached,
        studios: [],
        staff,
        siteUrl: `https://manga.bilibili.com/detail/mc${workId}`,
      }
    }
    const json = await biliGet(`/pgc/view/web/season?season_id=${encodeURIComponent(workId)}`)
    const r = json?.result
    if (!r?.title) throw new Error('作品不存在')
    const score = r.media_score?.score
    const staff: StaffRole[] = [
      ...(r.actors || '').split(/[、，,]/).filter(Boolean).slice(0, 8).map((n: string) => ({ role: '主要配音', name: n.trim() })),
      ...(r.staff || '').split(/[、，,]/).filter(Boolean).slice(0, 6).map((n: string) => ({ role: '制作人员', name: n.trim() })),
    ]
    return {
      sourceId: 'bilibili',
      workId: String(r.season_id ?? workId),
      kind: 'anime',
      title: (r.title || '').replace(/<[^>]*>/g, '').trim(),
      titleNative: r.origin_name || undefined,
      cover: r.cover || undefined,
      description: (r.evaluate || '').replace(/<[^>]*>/g, '').trim() || undefined,
      score: score && score > 0 ? score : undefined,
      year: r.publish?.pub_time ? Number(String(r.publish.pub_time).slice(0, 4)) : undefined,
      genres: (r.styles || []).map((s: any) => s.name || s).filter(Boolean),
      statusCn: r.status ? undefined : undefined, // B站状态字段不稳定，留空
      formatCn: r.type === 1 ? '番剧（B站）' : '国创（B站）',
      episodes: r.episodes?.length ?? undefined,
      titleLang: 'zh',
      descLang: 'zh',
      studios: (r.productions || r.producers || []).map((p: any) => p.name || p).filter(Boolean),
      staff,
      siteUrl: `https://www.bilibili.com/bangumi/media/md${r.season_id ?? workId}`,
    }
  },
}

export default bilibili
