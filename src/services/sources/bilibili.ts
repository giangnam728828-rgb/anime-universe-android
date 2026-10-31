/** Bilibili 番剧/国创适配器（阶段 6.4.2 / 6.4.2.2）
 *  接口（6.4.1 实测，公开网页端接口，无需登录/Token）：
 *  - 列表: GET api.bilibili.com/pgc/season/index/result?season_type=1|2&page=1&pagesize=10&type=1&year=YYYY
 *  - 详情: GET api.bilibili.com/pgc/view/web/season?season_id=ID
 *  仅获取作品元数据与页面入口（siteUrl 指向 B 站页面），不请求/解析任何视频流。
 *  请求头只用正常允许的 UA + Referer + 固定通用头；有限重试 + 内存缓存。
 *  合规约定（6.4.2.1 验收通过）：不使用任何动态设备指纹(如 x/frontend/finger/spi → buvid)
 *  也不规避验证；接口要求额外验证(风控/登录)时如实报错，由多来源聚合降级，不伪造指纹。
 *  B漫搜索复用静态通用头尽力而为，失败则报告来源不可用（不绕过访问控制）。
 */
import { httpGetText, httpPostJson } from '../api/nativeHttp'
import type { SourceAdapter, WorkItem, WorkDetail, SearchOptions, SearchResult, Kind, StaffRole } from './types'

const BASE = 'https://api.bilibili.com'
const UA_BILI = 'Mozilla/5.0 (Linux; Android 14) AnimeUniverse/0.6'
/** 固定普通请求头（非动态指纹；B站网页端常规头） */
const HEADERS = { Referer: 'https://www.bilibili.com/', Accept: 'application/json' }

/* ── B站漫画（mc 搜索，公开网页端接口；仅用静态头尽力调用，风控则报错降级）── */
const MANGA_API = 'https://manga.bilibili.com/twirp/comic.v1.Comic/Search?device=pc&platform=web'

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
  // 仅用静态普通头，不携带/获取设备指纹；B漫 Search 若被风控(code!=0)或401/403，如实抛错由聚合降级
  const r = await httpPostJson(
    MANGA_API,
    { 'User-Agent': UA_BILI, Referer: 'https://manga.bilibili.com/', Accept: 'application/json' },
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
