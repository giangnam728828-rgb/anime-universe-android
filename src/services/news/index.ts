/** 资讯服务：官方公开 RSS 直连（CapacitorHttp 原生请求，无第三方代理）
 *  文字/图片完全分离；来源状态持久化 + 失败冷却（10min 内跳过，不阻塞其他源）
 */
import { httpGetText } from '../api/nativeHttp'

export interface NewsItem {
  id: string
  title: string
  link: string
  source: string
  lang: 'zh' | 'en'
  date?: string
  summary?: string
  image?: string
}

export type NewsCategory = '综合' | '动漫' | '漫画' | '游戏' | '二次元'

export interface FeedMeta {
  id: string
  name: string
  url: string
  lang: 'zh' | 'en'
  category: NewsCategory
  /** 备注（如"当前网络不可达，保留待恢复"） */
  note?: string
}

/** 来源注册：GNN 保留（当前网络不可达，靠冷却机制不阻塞其他源） */
export const FEEDS: FeedMeta[] = [
  { id: 'gnn', name: '巴哈姆特GNN', url: 'https://gnn.gamer.com.tw/rss_utf8.xml', lang: 'zh', category: '综合', note: '当前网络环境不可达，保留备用' },
  { id: 'mal', name: 'MyAnimeList', url: 'https://myanimelist.net/rss/news.xml', lang: 'en', category: '动漫' },
  { id: 'ac', name: 'Anime Corner', url: 'https://animecorner.me/feed/', lang: 'en', category: '综合' },
]

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
  // 补默认
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
    const items = parseFeed(r.text, feed)
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
      ok: false, lastError: msg.includes('abort') || msg.includes('timeout') ? '连接超时（当前网络不可达）' : msg,
      cooldownUntil: Date.now() + COOLDOWN_MS,
    }
    updateStatus(id, st)
    return st
  }
}

/* ---------- RSS 解析 ---------- */

function firstImg(html: string): string | undefined {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m?.[1]
}

function parseFeed(xml: string, feed: FeedMeta): NewsItem[] {
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
    const decoded = rawDesc.includes('&lt;') ? rawDesc.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : rawDesc
    const summary = decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)
    const image =
      n.querySelector('enclosure')?.getAttribute('url') ||
      n.querySelector('media\\:thumbnail, thumbnail')?.getAttribute('url') ||
      firstImg(decoded)
    out.push({ id: `${feed.id}-${i}-${link.slice(-40)}`, title, link, source: feed.name, lang: feed.lang, date, summary, image })
  })
  return out
}

/* ---------- 聚合拉取 ---------- */
let lastFetchAt = 0
let lastResult: NewsResult | null = null

export interface NewsResult { items: NewsItem[]; failed: { name: string; reason: string }[] }

export async function fetchNews(force = false): Promise<NewsResult> {
  // 3 分钟结果缓存，防重复拉取
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
        const items = parseFeed(r.text, f)
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

  // 被冷却跳过的源也纳入 failed 提示（仅启用但冷却中的）
  FEEDS.forEach((f) => {
    const s = statuses[f.id]
    if (s?.enabled !== false && s?.cooldownUntil && s.cooldownUntil >= now && !active.includes(f)) {
      failed.push({ name: f.name, reason: `冷却中（${s.lastError || '上次失败'}）` })
    }
  })

  // 中文源优先，组内按时间新→旧
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
