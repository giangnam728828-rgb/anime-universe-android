/** MangaDex 漫画适配器（阶段 6.4.2）
 *  官方开放 API（api.mangadex.org），免 Token，官方允许第三方客户端使用，支持分页（limit/offset）。
 *  6.4.1 实测：total≈55k，偶发网络波动 → 重试 2 次 + 内存缓存。
 *
 *  标题规则（按需求实现）：
 *  1. 主标题(title)含中文（zh-hans/zh/zh-cn 简体、zh-hant/zh-tw 繁体）优先；
 *  2. 主标题无中文 → altTitles 里按 简体>繁体>任意zh* 提取；
 *  3. 简繁分开识别（titleLang 标注 zh-hans / zh-hant）；
 *  4. 无中文 → 保留原文（en/ja-ro/ja/原文首键），titleLang 标注实际语言。
 *  简介规则同理（descLang 标注），本阶段不使用 AI 翻译。
 */
import { httpGetText } from '../api/nativeHttp'
import type { SourceAdapter, WorkItem, WorkDetail, SearchOptions, SearchResult, Kind, StaffRole } from './types'

const BASE = 'https://api.mangadex.org'
const COVER = 'https://uploads.mangadex.org/covers'

/* eslint-disable @typescript-eslint/no-explicit-any */
const memCache = new Map<string, { t: number; v: any }>()
const TTL = 5 * 60 * 1000

async function mdGet(path: string): Promise<any> {
  const hit = memCache.get(path)
  if (hit && Date.now() - hit.t < TTL) return hit.v
  let lastErr: unknown
  for (let i = 0; i < 2; i++) {
    try {
      const r = await httpGetText(`${BASE}${path}`, 10000)
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      const json = JSON.parse(r.text)
      memCache.set(path, { t: Date.now(), v: json })
      return json
    } catch (e) {
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

/** 标题选择：中文主标题 > 中文别名(简>繁) > 原文主标题；返回 {text, lang, isOriginal} */
function pickTitle(title: Record<string, string>, altTitles: Record<string, string>[]): { text: string; lang: string; original: boolean } {
  const zhMain = zhKey(title)
  if (zhMain) return { text: title[zhMain], lang: zhMain.toLowerCase(), original: true }
  // 别名：先简体，再繁体，再任意 zh*
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
  // 无中文：原文主标题
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

/** 常用标签英→中（未收录标签保留英文原文） */
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
    const json = await mdGet(`/manga?${q.toString()}`)
    const items = (json.data || []).map(mapManga)
    const total = json.total ?? 0
    return { items, hasNext: offset + items.length < total }
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
}

export default mangadex
