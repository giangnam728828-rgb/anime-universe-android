/** 资讯服务：公开动漫 RSS，经 allorigins CORS 代理获取（0 预算方案）
 *  多源容错：Promise.allSettled，单源失败不影响整体；解析用 DOMParser
 */
import { cachedGet } from '../api/http'

export interface NewsItem {
  id: string
  title: string
  link: string
  source: string
  date?: string
  summary?: string
  image?: string
}

/** RSS 源注册（可扩展；id 用于失败提示） */
const FEEDS: { id: string; name: string; url: string }[] = [
  { id: 'ann', name: 'Anime News Network', url: 'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us' },
  { id: 'mal', name: 'MyAnimeList', url: 'https://myanimelist.net/rss/news.xml' },
  { id: 'cr', name: 'Crunchyroll News', url: 'https://www.crunchyroll.com/news.rss' },
  { id: 'ac', name: 'Anime Corner', url: 'https://animecorner.me/feed/' },
]

const PROXY = (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`

function firstImg(html: string): string | undefined {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m?.[1]
}

function parseFeed(xml: string, source: string): NewsItem[] {
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
    out.push({ id: `${source}-${i}-${link.slice(-40)}`, title, link, source, date, summary, image })
  })
  return out
}

/** 拉取全部源并合并（按时间新→旧），failed 返回失败源名 */
export async function fetchNews(): Promise<{ items: NewsItem[]; failed: string[] }> {
  const rs = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const xml = await cachedGet(PROXY(f.url), { timeout: 14000 })
      const items = parseFeed(xml, f.name)
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
  items.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
  const seen = new Set<string>()
  const deduped = items.filter((i) => {
    const k = i.title.toLowerCase().replace(/\s+/g, '')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { items: deduped, failed }
}
