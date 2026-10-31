import Icon from '../../components/Icon'
import { EmptyState, Loading } from '../../components/ui'
import { useAsync } from '../../hooks/useAsync'
import { fetchNews, type NewsItem } from '../../services/news'
import { useNavigate } from 'react-router-dom'
import { imgFallback } from '../../utils/proxy'

export default function NewsPage() {
  const nav = useNavigate()
  const { loading, data, error, retry } = useAsync(() => fetchNews(), [])

  return (
    <div className="page">
      <header className="page-head">
        <h1>资讯</h1>
        <p>公开动漫新闻 RSS 聚合 · 点击阅读原文</p>
      </header>

      {loading ? <Loading text="拉取资讯…" /> : error || !data ? (
        <EmptyState icon="info" title="资讯加载失败" desc={error || '未知错误'}
          actionText="重试" onAction={retry} />
      ) : data.items.length === 0 ? (
        <EmptyState icon="news" title="暂无资讯" desc="所有来源都没有返回内容，稍后再试。"
          actionText="重试" onAction={retry} />
      ) : (
        <>
          {data.failed.length > 0 && (
            <div className="news-warn">部分来源暂时不可用：{data.failed.join('、')}（其余正常）</div>
          )}
          <div className="news-list">
            {data.items.map((n) => <NewsRow key={n.id} n={n} nav={nav} />)}
          </div>
          <div className="news-foot">内容来自公开 RSS，版权属原作者 · 阶段 5</div>
        </>
      )}
    </div>
  )
}

export function NewsRow({ n, nav }: { n: NewsItem; nav: (to: string) => void }) {
  return (
    <button className="news-row" onClick={() => nav(`/newsview/${encodeURIComponent(n.link)}`)}>
      {n.image && (
        <div className="news-thumb">
          <img src={n.image} referrerPolicy="no-referrer" loading="lazy" alt="" onError={imgFallback} />
        </div>
      )}
      <div className="news-main">
        <div className="news-title">{n.title}</div>
        {n.summary && <div className="news-desc">{n.summary}</div>}
        <div className="news-meta">
          <span className="news-src">{n.source}</span>
          {n.date && <span>{fmtDate(n.date)}</span>}
          <span style={{ marginLeft: 'auto', display: 'flex', color: 'var(--muted)' }}><Icon name="chevron" size={13} /></span>
        </div>
      </div>
    </button>
  )
}

function fmtDate(d: string): string {
  const t = new Date(d).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const day = Math.floor(h / 24)
  if (day < 7) return `${day} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}
