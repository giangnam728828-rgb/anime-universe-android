/** 资讯服务：官方公开 RSS/API 直连（CapacitorHttp 原生，无第三方代理）
 *  中文来源优先；英文独立备用；来源状态持久化 + 失败冷却 + 每源独立缓存兜底
 *
 *  来源调查存档（2026-10-31 手机网络实测，详见备忘录）：
 *  ✅可用简中：机核GCORES(RSS 20条) / CnGal(API 18条) / 爱奇漫(WP分类RSS×4 各10条)
 *  ⚠️保留不可达：巴哈姆特GNN(整域TCP超时, 冷却机制)
 *  🇬🇧英文备用：MyAnimeList / Anime Corner
 *  ❌实测拒绝：AnimesData(Cloudflare盾403) ACG17(空feed) IT之家(占比低) Animen(超时)
 *    动漫之家(失效) RSSHub(不可达) Anitama(514) AcFun API(404) a9vg(404) animate.cn(超时)
 *    CCC追漫台(纯SPA无接口) 腾讯动漫新闻(已下线) 东立(无RSS,ASPX页) acgdoge(站点异常)
 */
import { httpGetText } from '../api/nativeHttp'

export type NewsCategory = '综合' | '动漫' | '漫画' | '游戏' | '二次元' | '英文'

export interface NewsItem {
  id: string
  title: string
  link: string
  source: string
  lang: 'zh' | 'en'
  category: NewsCategory
  date?: string
  summary?: string
  image?: string
}

export interface FeedMeta {
  id: string
  name: string
  /** 单 feed URL；爱奇漫为多分类 feed（kind=multi-rss 时使用 subFeeds） */
  url?: string
  subFeeds?: { url: string; category: NewsCategory; label: string }[]
  lang: 'zh' | 'en'
  category: NewsCategory
  kind: 'rss' | 'cngal' | 'multi-rss'
  note?: string
}

/** 来源注册（全部官方公开接口；保留来源标记与原文链接，不转载全文） */
export const FEEDS: FeedMeta[] = [
  { id: 'gcores', name: '机核 GCORES', url: 'https://www.gcores.com/rss', lang: 'zh', category: '综合', kind: 'rss' },
  {
    id: 'iqiok', name: '爱奇漫', lang: 'zh', category: '综合', kind: 'multi-rss',
    subFeeds: [
      { url: 'https://www.iqiok.net/acgnews/acgfilm/feed', category: '动漫', label: '动漫影视' },
      { url: 'https://www.iqiok.net/acgnews/information/feed', category: '动漫', label: '动画情报' },
      { url: 'https://www.iqiok.net/acgnews/manhua/feed', category: '漫画', label: '漫画情报' },
      { url: 'https://www.iqiok.net/acgnews/zhoubian/feed', category: '二次元', label: '动漫周边' },
    ],
  },
  { id: 'cngal', name: 'CnGal资料站', url: 'https://api.cngal.org/api/home/GetHomeNewsView', lang: 'zh', category: '游戏', kind: 'cngal' },
  { id: 'gnn', name: '巴哈姆特GNN', url: 'https://gnn.gamer.com.tw/rss_utf8.xml', lang: 'zh', category: '综合', kind: 'rss', note: '当前网络不可达，保留备用' },
  { id: 'mal', name: 'MyAnimeList', url: 'https://myanimelist.net/rss/news.xml', lang: 'en', category: '英文', kind: 'rss' },
  { id: 'ac', name: 'Anime Corner', url: 'https://animecorner.me/feed/', lang: 'en', category: '英文', kind: 'rss' },
]

/** 分类自动识别（关键词 → 分类；无法判断归「综合」） */
export function classify(text: string): NewsCategory {
  const t = text.toLowerCase()
  if (/漫画|manga|comic|连载|单行本|新刊/.test(t)) return '漫画'
  if (/动漫|动画|anime|新番|剧场版|放送|声优|番剧/.test(t)) return '动漫'
  if (/游戏|新作|发售|steam|主机|switch|playstation|galgame|视觉小说|独立游戏|rpg|dlc/.test(t)) return '游戏'
  if (/周边|cos|漫展|手办|谷子|同人|展台|二次元|cosplay|插画|立牌/.test(t)) return '二次元'
  return '综合'
}

/* ---------- 来源状态（持久化 + 冷却） ---------- */
export interface SourceStatus {
  enabled: boolean
  lastTestAt?: number
  lastStatus?: number
  lastMs?: number
  lastError?: string
  cooldownUntil?: number
  ok?: boolean
  itemsCount?: number
}

const SKEY = 'au_news_src_status'
const COOLDOWN_MS = 10 * 60 * 1000

function loadStatus(): Record<string, SourceStatus> {
  try { return JSON.parse(localStorage.getItem(SKEY) || '{}') } catch { return {} }
}
function saveStatus(s: Record<string, SourceStatus>) {
  try { localStorage.setItem(SKEY, JSON.stringify(s)) } catch { /* ignore */ }
}

export function getSourceStatuses(): Record<string, SourceStatus> {
  const st = loadStatus()
  FEEDS.forEach((f) => { if (!st[f.id]) st[f.id] = { enabled: true } })
  return st
}

function updateStatus(id: string, patch: Partial<SourceStatus>) {
  const st = loadStatus()
  const prev = st[id] || { enabled: true }
  st[id] = { ...prev, ...patch, enabled: patch.enabled ?? prev.enabled ?? true }
  saveStatus(st)
}

export function setSourceEnabled(id: string, enabled: boolean) {
  const st = loadStatus()
  st[id] = { ...(st[id] || { enabled: true }), enabled }
  saveStatus(st)
}

/* ---------- 每源独立缓存（失败回退，标记"缓存"） ---------- */
interface SourceCache { at: number; items: NewsItem[] }
const CKEY = (id: string) => `au_news_cache_${id}`
const CACHE_TTL = 6 * 60 * 60 * 1000

function readCache(id: string): SourceCache | null {
  try {
    const c = JSON.parse(localStorage.getItem(CKEY(id)) || 'null') as SourceCache | null
    if (c && Date.now() - c.at < CACHE_TTL && c.items?.length) return c
  } catch { /* ignore */ }
  return null
}
function writeCache(id: string, items: NewsItem[]) {
  try { localStorage.setItem(CKEY(id), JSON.stringify({ at: Date.now(), items } satisfies SourceCache)) } catch { /* 容量忽略 */ }
}

/* ---------- 解析 ---------- */

function firstImg(html: string): string | undefined {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m?.[1]
}

function stripHtml2(raw: string): string {
  const decoded = raw.includes('&lt;') ? raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : raw
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** RSS 解析：不人为截断条目（WordPress feed 一般 10-25 条，机核 20，全保留） */
function parseRss(xml: string, feed: FeedMeta, forcedCategory?: NewsCategory): NewsItem[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  if (doc.querySelector('parsererror')) return []
  const nodes = Array.from(doc.querySelectorAll('item, entry')).slice(0, 30)
  const out: NewsItem[] = []
  nodes.forEach((n, i) => {
    const title = n.querySelector('title')?.textContent?.trim() || ''
    const link =
      n.querySelector('link')?.textContent?.trim() ||
      n.querySelector('link')?.getAttribute('href')?.trim() ||
      ''
    if (!title || !link) return
    const date = n.querySelector('pubDate, published, updated')?.textContent || undefined
    const rawDesc =
      n.querySelector('description')?.textContent ||
      n.querySelector('summary')?.textContent ||
      n.querySelector('content')?.textContent ||
      ''
    const summary = stripHtml2(rawDesc).slice(0, 90)
    const image =
      n.querySelector('enclosure')?.getAttribute('url') ||
      n.querySelector('media\\:thumbnail, thumbnail')?.getAttribute('url') ||
      firstImg(rawDesc)
    const full = title + ' ' + summary
    out.push({
      id: `${feed.id}-${i}-${link.slice(-40)}`, title, link, source: feed.name,
      lang: feed.lang,
      category: feed.lang === 'en' ? '英文' : forcedCategory ?? classify(full),
      date, summary, image,
    })
  })
  return out
}

interface CngalEntry { articleId: number; title?: string; text?: string; type?: string; image?: string }

function parseCngal(text: string, feed: FeedMeta): NewsItem[] {
  const arr = JSON.parse(text) as CngalEntry[]
  if (!Array.isArray(arr)) return []
  return arr.slice(0, 30).map((e) => {
    const title = (e.title || e.text || 'CnGal 动态').trim().slice(0, 80)
    const link = `https://www.cngal.org/news/index/${e.articleId}`
    return {
      id: `cngal-${e.articleId}`, title, link, source: feed.name,
      lang: 'zh' as const,
      category: classify(title + ' ' + (e.text || '')) || '游戏',
      summary: (e.text || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      image: e.image || undefined,
    }
  }).filter((n) => n.title)
}

async function fetchSub(url: string): Promise<string> {
  const r = await httpGetText(url, 12000)
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
  return r.text
}

/** 抓取并解析一个来源（多分类源并行，任一分类失败不影响其余） */
async function loadSource(feed: FeedMeta): Promise<NewsItem[]> {
  if (feed.kind === 'cngal' && feed.url) {
    return parseCngal(await fetchSub(feed.url), feed)
  }
  if (feed.kind === 'multi-rss' && feed.subFeeds) {
    const sfs = feed.subFeeds
    const rs = await Promise.allSettled(
      sfs.map(async (sf) => parseRss(await fetchSub(sf.url), feed, sf.category)),
    )
    const items: NewsItem[] = []
    const failedLabels: string[] = []
    rs.forEach((r, idx) => {
      if (r.status === 'fulfilled') items.push(...r.value)
      else failedLabels.push(sfs[idx].label)
    })
    if (items.length === 0) throw new Error(failedLabels.length ? `${failedLabels.join('、')}分类全部失败` : '全部分类失败')
    if (failedLabels.length) console.info(`[资讯] ${feed.name} 部分分类失败: ${failedLabels.join('、')}`)
    return items
  }
  if (feed.url) return parseRss(await fetchSub(feed.url), feed)
  throw new Error('来源配置错误')
}

/* ---------- 单源测试（来源管理页） ---------- */
export async function testSource(id: string): Promise<SourceStatus> {
  const feed = FEEDS.find((f) => f.id === id)
  if (!feed) throw new Error('未知来源')
  const t0 = Date.now()
  try {
    const items = await loadSource(feed)
    const st: SourceStatus = {
      enabled: getSourceStatuses()[id]?.enabled ?? true,
      lastTestAt: Date.now(), lastStatus: 200, lastMs: Date.now() - t0,
      ok: items.length > 0, itemsCount: items.length,
      lastError: items.length ? undefined : '解析到 0 条',
      cooldownUntil: items.length ? undefined : Date.now() + COOLDOWN_MS,
    }
    if (items.length) writeCache(id, items)
    updateStatus(id, st)
    return st
  } catch (e) {
    const msg = (e as Error)?.message || String(e)
    const st: SourceStatus = {
      enabled: getSourceStatuses()[id]?.enabled ?? true,
      lastTestAt: Date.now(), lastStatus: 0, lastMs: Date.now() - t0,
      ok: false, lastError: /abort|timeout/i.test(msg) ? '连接超时（当前网络不可达）' : msg,
      cooldownUntil: Date.now() + COOLDOWN_MS,
    }
    updateStatus(id, st)
    return st
  }
}

/* ---------- 聚合拉取 ---------- */
let lastFetchAt = 0
let lastResult: NewsResult | null = null

export interface NewsResult { items: NewsItem[]; failed: { name: string; reason: string }[]; fromCache: string[] }

export async function fetchNews(force = false): Promise<NewsResult> {
  if (!force && lastResult && Date.now() - lastFetchAt < 3 * 60 * 1000) return lastResult

  const statuses = getSourceStatuses()
  const now = Date.now()
  const active = FEEDS.filter((f) => {
    const s = statuses[f.id]
    return !s || (s.enabled !== false && (!s.cooldownUntil || s.cooldownUntil < now))
  })

  const results = await Promise.allSettled(
    active.map(async (f) => {
      const t0 = Date.now()
      try {
        const items = await loadSource(f)
        if (items.length === 0) throw new Error('解析到 0 条')
        writeCache(f.id, items)
        updateStatus(f.id, {
          lastTestAt: Date.now(), lastStatus: 200, lastMs: Date.now() - t0, ok: true,
          itemsCount: items.length, lastError: undefined, cooldownUntil: undefined,
        })
        return items
      } catch (e) {
        const msg = (e as Error)?.message || String(e)
        // 失败回退该源独立缓存（≤6h），标"缓存"供 UI 提示
        const cached = readCache(f.id)
        updateStatus(f.id, {
          lastTestAt: Date.now(), lastStatus: 0, lastMs: Date.now() - t0, ok: false,
          lastError: /abort|timeout/i.test(msg) ? '连接超时（当前网络不可达）' : msg,
          cooldownUntil: Date.now() + COOLDOWN_MS,
        })
        if (cached) return cached.items.map((it) => ({ ...it, source: `${it.source}（缓存）` }))
        throw e
      }
    }),
  )

  const items: NewsItem[] = []
  const failed: { name: string; reason: string }[] = []
  const fromCache: string[] = []
  results.forEach((r, idx) => {
    const feed = active[idx]
    if (r.status === 'fulfilled') {
      items.push(...r.value)
      if (r.value.some((i) => i.source.includes('（缓存）'))) fromCache.push(feed.name)
    } else {
      const s = getSourceStatuses()[feed.id]
      failed.push({ name: feed.name, reason: s?.lastError || '请求失败' })
    }
  })

  FEEDS.forEach((f) => {
    const s = statuses[f.id]
    if (s?.enabled !== false && s?.cooldownUntil && s.cooldownUntil >= now && !active.includes(f)) {
      failed.push({ name: f.name, reason: `冷却中（${s.lastError || '上次失败'}）` })
    }
  })

  const byTime = (a: NewsItem, b: NewsItem) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
  const zh = items.filter((i) => i.lang === 'zh').sort(byTime)
  const en = items.filter((i) => i.lang === 'en').sort(byTime)

  // 去重：原文 URL 优先，标题兜底
  const merged = [...zh, ...en]
  const seenLink = new Set<string>()
  const seenTitle = new Set<string>()
  const deduped = merged.filter((i) => {
    const lk = i.link.replace(/[?#].*$/, '')
    if (seenLink.has(lk)) return false
    seenLink.add(lk)
    const tk = i.title.toLowerCase().replace(/\s+/g, '')
    if (seenTitle.has(tk)) return false
    seenTitle.add(tk)
    return true
  })

  lastFetchAt = Date.now()
  lastResult = { items: deduped, failed, fromCache }
  return lastResult
}

/* ---------- 内置阅读：正文提取（直连，无代理） ---------- */

export interface Article {
  title: string
  source: string
  date?: string
  blocks: { type: 'p' | 'img'; text?: string; src?: string }[]
}

const CONTENT_SELECTORS = [
  'article', '.entry-content', '.post-content', '.article-content',
  '.news-content', '.article_body', '#newscontent', '.topic', 'main',
]

export async function fetchArticle(link: string): Promise<Article> {
  const r = await httpGetText(link, 15000)
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
  const doc = new DOMParser().parseFromString(r.text, 'text/html')
  doc.querySelectorAll('script,style,nav,header,footer,aside,form,iframe,button').forEach((el) => el.remove())

  const title = doc.querySelector('h1')?.textContent?.trim() || doc.title?.trim() || link
  const time = doc.querySelector('time')?.getAttribute('datetime') || doc.querySelector('time')?.textContent?.trim() || undefined

  let root: Element | null = null
  for (const sel of CONTENT_SELECTORS) {
    const el = doc.querySelector(sel)
    if (el && (el.textContent || '').trim().length > 200) { root = el; break }
  }
  if (!root) root = doc.body

  const blocks: Article['blocks'] = []
  const pushText = (t?: string | null) => {
    const s = (t || '').replace(/\s+/g, ' ').trim()
    if (s.length > 12) blocks.push({ type: 'p', text: s })
  }
  root.querySelectorAll('p, figcaption').forEach((p) => {
    const img = p.querySelector('img')
    if (img) {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src')
      if (src && !src.startsWith('data:')) blocks.push({ type: 'img', src })
    }
    pushText(p.textContent)
  })
  if (blocks.length === 0) {
    root.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src')
      if (src && !src.startsWith('data:')) blocks.push({ type: 'img', src })
    })
  }
  if (blocks.length === 0) throw new Error('该站不支持内嵌阅读')
  return { title, source: new URL(link).hostname.replace('www.', ''), date: time, blocks }
}
