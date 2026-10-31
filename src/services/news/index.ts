/** 资讯服务：动漫 RSS 聚合（中文源优先），经 allorigins CORS 代理（0 预算）
 *  多源容错：Promise.allSettled，单源失败不影响整体
 *  图片：referrerPolicy no-referrer + 失败走代理兜底（防盗链）
 */
import { cachedGet } from '../api/http'
import { PROXY } from '../../utils/proxy'

export interface NewsItem {
  id: string
  title: string
  link: string
  source: string
  date?: string
  summary?: string
  image?: string
  cn?: boolean
}

/** RSS 源注册：巴哈姆特 GNN 为繁中主源，英文源兜底 */
const FEEDS: { id: string; name: string; url: string; cn?: boolean }[] = [
  { id: 'gnn', name: '巴哈姆特GNN', url: 'https://gnn.gamer.com.tw/rss.xml', cn: true },
  { id: 'ann', name: 'ANN', url: 'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us' },
  { id: 'mal', name: 'MyAnimeList', url: 'https://myanimelist.net/rss/news.xml' },
  { id: 'ac', name: 'Anime Corner', url: 'https://animecorner.me/feed/' },
]

function firstImg(html: string): string | undefined {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m?.[1]
}

function parseFeed(xml: string, source: string, cn?: boolean): NewsItem[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  if (doc.querySelector('parsererror')) return []
  const nodes = Array.from(doc.querySelectorAll('item, entry')).slice(0, 12)
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
    const summary = decoded
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90)
    const image =
      n.querySelector('enclosure')?.getAttribute('url') ||
      n.querySelector('media\\:thumbnail, thumbnail')?.getAttribute('url') ||
      firstImg(decoded)
    out.push({ id: `${source}-${i}-${link.slice(-40)}`, title, link, source, date, summary, image, cn })
  })
  return out
}

export interface NewsResult { items: NewsItem[]; failed: string[] }

/** 拉取全部源：中文源条目排前，组内按时间新→旧；跨源标题去重 */
export async function fetchNews(): Promise<NewsResult> {
  const rs = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const xml = await cachedGet(PROXY(f.url), { timeout: 12000 })
      const items = parseFeed(xml, f.name, f.cn)
      if (items.length === 0) throw new Error(`${f.name} 解析为空`)
      return items
    }),
  )
  const items: NewsItem[] = []
  const failed: string[] = []
  rs.forEach((r, idx) => {
    if (r.status === 'fulfilled') items.push(...r.value)
    else failed.push(FEEDS[idx].name)
  })
  const cnItems = items.filter((i) => i.cn)
  const enItems = items.filter((i) => !i.cn)
  const byTime = (a: NewsItem, b: NewsItem) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
  cnItems.sort(byTime)
  enItems.sort(byTime)
  const merged = [...cnItems, ...enItems]
  const seen = new Set<string>()
  const deduped = merged.filter((i) => {
    const k = i.title.toLowerCase().replace(/\s+/g, '')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { items: deduped, failed }
}

/* ---------- 内置阅读：正文提取（readability 简版） ---------- */

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

/** 抓原文并提取正文段落（失败抛错 → 页面给"系统浏览器打开"兜底） */
export async function fetchArticle(link: string): Promise<Article> {
  const html = await cachedGet(PROXY(link), { timeout: 15000 })
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,nav,header,footer,aside,form,iframe,button').forEach((el) => el.remove())

  const title = doc.querySelector('h1')?.textContent?.trim() || doc.title?.trim() || link
  const time = doc.querySelector('time')?.getAttribute('datetime') || doc.querySelector('time')?.textContent?.trim() || undefined

  // 找正文容器：选择器命中且有足够文本
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
  if (blocks.filter((b) => b.type === 'p').length === 0 && blocks.length === 0) {
    throw new Error('该站不支持内嵌阅读')
  }
  return { title, source: new URL(link).hostname.replace('www.', ''), date: time, blocks }
}
