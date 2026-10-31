import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { imgFallback } from '../../utils/proxy'
import { useAsync } from '../../hooks/useAsync'
import { fetchNews } from '../../services/news'

/** 首页资讯横滑区块（复用 fetchNews 的 5min 缓存，与 /news 页共享） */
export default function NewsSection() {
  const nav = useNavigate()
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setIdle(true), 800) // 首屏内容先行，资讯延迟拉取
    return () => clearTimeout(t)
  }, [])
  const { loading, data } = useAsync(async () => {
    if (!idle) return undefined as never
    return fetchNews()
  }, [idle])
  const items = (data?.items || []).slice(0, 10)
  if (!idle) return null

  if (loading) return <div className="loading" style={{ padding: '18px 0' }}><span className="spinner" /></div>
  if (items.length === 0) return null

  return (
    <div className="h-scroll">
      {items.map((n) => (
        <button key={n.id} className="news-card" onClick={() => nav(`/newsview/${encodeURIComponent(n.link)}`)}>
          <div className="nc-thumb">
            {n.image && <img src={n.image} referrerPolicy="no-referrer" loading="lazy" alt="" onError={imgFallback} />}
          </div>
          <div className="nc-title">{n.title}</div>
          <div className="nc-src">{n.source}</div>
        </button>
      ))}
      <button className="news-card news-more" onClick={() => nav('/news')}>
        <div className="nc-more-txt">查看全部</div>
      </button>
    </div>
  )
}
