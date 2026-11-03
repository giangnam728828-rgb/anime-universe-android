/** Jikan (MyAnimeList) 适配器：免费无 Key，限流 3 req/s → 内部节流 400ms */
import { cachedGet } from '../api/http'
import { GENRE_MAP, STATUS_MAP, FORMAT_MAP, stripHtml } from './anilist'
import type { SourceAdapter, WorkItem, WorkDetail, SearchOptions, SearchResult, Kind, StaffRole, SourceRequestPolicy } from './types'

const BASE = 'https://api.jikan.moe/v4'

let lastReq = 0
async function throttle() {
  const wait = 400 - (Date.now() - lastReq)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastReq = Date.now()
}

async function jikanGet(path: string, reqPolicy?: SourceRequestPolicy): Promise<any> {
  await throttle()
  const text = await cachedGet(
    BASE + path,
    // 只有显式传入策略才覆盖 HTTP 层默认值；不传 → 传空对象 = 原默认行为
    reqPolicy
      ? { timeout: reqPolicy.timeoutMs ?? 10000, retries: reqPolicy.retries ?? 1 }
      : {},
  )
  return JSON.parse(text)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapEntry(e: any): WorkItem {
  const images = e.images?.webp || e.images?.jpg || {}
  return {
    sourceId: 'jikan',
    workId: String(e.mal_id),
    kind: e.type?.toLowerCase() === 'manga' ? 'manga' : 'anime',
    title: e.title || e.title_english || e.title_japanese || '未命名',
    titleNative: e.title_japanese || undefined,
    cover: images.large_image_url || images.image_url || undefined,
    description: stripHtml(e.synopsis),
    score: e.score ?? undefined,
    year: e.year ?? e.aired?.prop?.from?.year ?? e.published?.prop?.from?.year ?? undefined,
    genres: (e.genres || []).map((g: any) => GENRE_MAP[g.name] || g.name),
    statusCn: STATUS_MAP[e.status] || e.status,
    formatCn: FORMAT_MAP[e.type] || e.type,
    episodes: e.episodes ?? undefined,
    chapters: e.chapters ?? undefined,
    favorites: e.favorites ?? undefined,
  }
}

const jikan: SourceAdapter = {
  id: 'jikan',
  name: 'MyAnimeList',

  async search(opts: SearchOptions): Promise<SearchResult> {
    const p = new URLSearchParams()
    if (opts.kw?.trim()) p.set('q', opts.kw.trim())
    p.set('page', String(opts.page ?? 1))
    p.set('limit', '18')
    p.set('sfw', 'true') // 过滤成人内容
    const path = opts.kind === 'manga' ? `/manga?${p}` : `/anime?${p}`
    // ★ 阶段3第6步：仅 search 接收策略；下方 getDetail 刻意不传，保持原行为
    const json = await jikanGet(path, opts.reqPolicy)
    if (json?.error) throw new Error(json.error)
    const items: WorkItem[] = (json?.data || []).map(mapEntry)
    // 跨源统一：Jikan 的分页字段 has_next_page
    return { items, hasNext: !!json?.pagination?.has_next_page }
  },

  async getDetail(kind: Kind, workId: string): Promise<WorkDetail> {
    const json = await jikanGet(`/${kind}/${workId}/full`)
    const e = json?.data
    if (!e) throw new Error('作品不存在')
    const base = mapEntry(e)
    const staff: StaffRole[] = []
    return {
      ...base,
      studios: (e.studios || []).map((s: any) => s.name).filter(Boolean),
      staff,
      volumes: e.volumes ?? undefined,
      duration: e.duration ? Number(String(e.duration).replace(/\D/g, '')) || undefined : undefined,
      siteUrl: e.url || undefined,
    }
  },
}

export default jikan
