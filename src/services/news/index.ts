/** 资讯服务：官方公开 RSS/API 直连（CapacitorHttp 原生请求，无第三方代理）
 *  中文来源优先；英文源为独立备用分类
 *  来源状态持久化 + 失败冷却（10min 内跳过，不阻塞其他源）
 *
 *  来源调查（2026-10-31 手机网络实测）：
 *  - 机核 GCORES  官方RSS https://www.gcores.com/rss         简中 200OK 20条 117图 无防盗链
 *  - CnGal        官方API https://api.cngal.org (swagger已验证) 简中 200OK 18条 带图(302跟随)
 *  - 巴哈姆特 GNN  官方RSS https://gnn.gamer.com.tw          繁中 当前网络不可达，保留+冷却
 *  - MyAnimeList  官方RSS https://myanimelist.net/rss/news.xml 英文 200OK（英文备用）
 *  - Anime Corner 官方RSS https://animecorner.me/feed/       英文 200OK（英文备用）
 *  - 已验证并拒绝：ACG17(RSS空壳0条) / IT之家(动漫占比低噪音大) / Animen(不可达) / 动漫之家(接口全失效) / RSSHub公共实例(不可达)
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
  url: string
  lang: 'zh' | 'en'
  category: NewsCategory
  kind: 'rss' | 'cngal'
  /** 来源主页（CnGal 等无独立原文页时跳主站） */
  home?: string
  note?: string
}

/** 来源注册（全部为官方公开 RSS/API，保留来源标记与原文链接，不转载全文） */
export const FEEDS: FeedMeta[] = [
  { id: 'gcores', name: '机核 GCORES', url: 'https://www.gcores.com/rss', lang: 'zh', category: '综合', kind: 'rss' },
  { id: 'cngal', name: 'CnGal资料站', url: 'https://api.cngal.org/api/home/GetHomeNewsView', lang: 'zh', category: '游戏', kind: 'cngal', home: 'https://www.cngal.org' },
  { id: 'gnn', name: '巴哈姆特GNN', url: 'https://gnn.gamer.com.tw/rss_utf8.xml', lang: 'zh', category: '综合', kind: 'rss', note: '当前网络不可达，保留备用' },
  { id: 'mal', name: 'MyAnimeList', url: 'https://myanimelist.net/rss/news.xml', lang: 'en', category: '英文', kind: 'rss' },
  { id: 'ac', name: 'Anime Corner', url: 'https://animecorner.me/feed/', lang: 'en', category: '英文', kind: 'rss' },
]

/** 分类自动识别（关键词 → 分类；无法判断归「综合」） */
export function classify(text: string): NewsCategory {
  const t = text.toLowerCase()
  if (/漫画|manga|comic/.test(t)) return '漫画'
  if (/动漫|动画|anime|动画|番剧|新番|剧场版|放送/.test(t)) return '动漫'
  if (/游戏|新作|发售|steam|主机|switch|playstation|galgame|视觉小说|独立游戏|rpg/.test(t)) return '游戏'
  if (/声优|周边|cos|漫展|手办|谷子|同人|展台|二次元/.test(t)) return '二次元'
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

/** 清除冷却并立即单测（来源管理页按钮） */
export async function testSource(id: string): Promise<SourceStatus> {
  const feed = FEEDS.find((f) => f.id === id)
  if (!feed) throw new Error('未知来源')
  const t0 = Date.now()
  try {
    const r = await httpGetText(feed.url, 12000)
    const items = await parseSource(feed, r.text)
    const ok = r.status === 200 && items.length > 0
    const st: SourceStatus = {
      enabled: getSourceStatuses()[id]?.enabled ?? true,
      lastTestAt: Date.now(), lastStatus: r.status, lastMs: Date.now() - t0,
      ok, lastError: ok ? undefined : `HTTP ${r.status}，解析到 ${items.length} 条`,
      cooldownUntil: ok ? undefined : Date.now() + COOLDOWN_MS,
    }
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

/* ---------- 解析 ---------- */

function firstImg(html: string): string | undefined {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m?.[1]
}

function stripHtml2(raw: string): string {
  const decoded = raw.includes('&lt;') ? raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : raw
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseRss(xml: string, feed: FeedMeta): NewsItem[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  if (doc.querySelector('parsererror')) return []
  const nodes = Array.from(doc.querySelectorAll('item, entry')).slice(0, 15)
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
      lang: feed.lang, category: feed.lang === 'en' ? '英文' : classify(full),
      date, summary, image,
    })
  })
  return out
}

interface CngalEntry { articleId: number; title?: string; text?: string; type?: string; image?: string; groupId?: number }

function parseCngal(text: string, feed: FeedMeta): NewsItem[] {
  const arr = JSON.parse(text) as CngalEntry[]
  if (!Array.isArray(arr)) return []
  return arr.slice(0, 15).map((e) => {
    const title = (e.title || e.text || 'CnGal 动态').trim().slice(0, 80)
    const link = `https://www.cngal.org/news/index/${e.articleId}`
    return {
      id: `cngal-${e.articleId}`,
      title,
      link,
      source: feed.name,
      lang: 'zh' as const,
      category: classify(title + ' ' + (e.text || '')) || '游戏',
      summary: (e.text || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      image: e.image || undefined,
    }
  }).filter((n) => n.title)
}

async function parseSource(feed: FeedMeta, text: string): Promise<NewsItem[]> {
  if (feed.kind === 'cngal') return parseCngal(text, feed)
  return parseRss(text, feed)
}

/* ---------- 聚合拉取 ---------- */
let lastFetchAt = 0
let lastResult: NewsResult | null = null

export interface NewsResult { items: NewsItem[]; failed: { name: string; reason: string }[] }

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
        const r = await httpGetText(f.url, 12000)
        const items = await parseSource(f, r.text)
        const ok = r.status === 200 && items.length > 0
        updateStatus(f.id, {
          lastTestAt: Date.now(), lastStatus: r.status, lastMs: Date.now() - t0, ok,
          lastError: ok ? undefined : `HTTP ${r.status}，解析 ${items.length} 条`,
          cooldownUntil: ok ? undefined : Date.now() + COOLDOWN_MS,
        })
        if (!ok) throw new Error(`HTTP ${r.status}`)
        return items
      } catch (e) {
        const msg = (e as Error)?.message || String(e)
        updateStatus(f.id, {
          lastTestAt: Date.now(), lastStatus: 0, lastMs: Date.now() - t0, ok: false,
          lastError: /abort|timeout/i.test(msg) ? '连接超时（当前网络不可达）' : msg,
          cooldownUntil: Date.now() + COOLDOWN_MS,
        })
        throw e
      }
    }),
  )

  const items: NewsItem[] = []
  const failed: { name: string; reason: string }[] = []
  results.forEach((r, idx) => {
    const feed = active[idx]
    if (r.status === 'fulfilled') items.push(...r.value)
    else {
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
  const merged = [...zh, ...en]
  const seen = new Set<string>()
  const deduped = merged.filter((i) => {
    const k = i.title.toLowerCase().replace(/\s+/g, '')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  lastFetchAt = Date.now()
  lastResult = { items: deduped, failed }
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
