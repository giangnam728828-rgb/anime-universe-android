import { useNavigate } from 'react-router-dom'
import { useAsync } from '../../hooks/useAsync'
import { fetchNews } from '../../services/news'
import { openExternal } from '../../utils/openUrl'

/** 首页资讯横滑区块（复用 fetchNews 的 5min 缓存，与 /news 页共享） */
export default function NewsSection() {
  const nav = useNavigate()
  const { loading, data } = useAsync(() => fetchNews(), [])
  const items = (data?.items || []).slice(0, 10)

  if (loading) return <div className="loading" style={{ padding: '18px 0' }}><span className="spinner" /></div>
  if (items.length === 0) return null

  return (
    <div className="h-scroll">
      {items.map((n) => (
        <button key={n.id} className="news-card" onClick={() => openExternal(n.link)}>
          <div className="nc-thumb">
            {n.image && <img src={n.image} loading="lazy" alt=""
              onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />}
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
