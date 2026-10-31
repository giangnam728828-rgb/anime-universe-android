import { useNavigate } from 'react-router-dom'
import Icon from '../../components/Icon'
import { EmptyState, Loading } from '../../components/ui'
import NewsImage from '../../components/NewsImage'
import { useAsync } from '../../hooks/useAsync'
import { fetchNews, type NewsItem } from '../../services/news'

export default function NewsPage() {
  const nav = useNavigate()
  const { loading, data, error, retry } = useAsync(() => fetchNews(), [])

  const zh = (data?.items || []).filter((n) => n.lang === 'zh')
  const en = (data?.items || []).filter((n) => n.lang === 'en')

  return (
    <div className="page">
      <header className="page-head">
        <h1>资讯</h1>
        <p>公开 RSS 聚合 · 原生直连 · 点击站内阅读
          <button onClick={() => nav('/news-sources')} style={{ color: 'var(--accent)', marginLeft: 8, fontSize: 11.5 }}>来源管理 ›</button>
        </p>
      </header>

      {loading ? <Loading text="正在请求来源…" /> : error || !data ? (
        <EmptyState icon="info" title="资讯加载失败" desc={error || '未知错误'}
          actionText="重试" onAction={retry} />
      ) : data.items.length === 0 ? (
        <EmptyState icon="news" title="所有来源都不可用"
          desc={'可到「来源管理」查看每个来源的真实请求状态与失败原因。'}
          actionText="打开来源管理" onAction={() => nav('/news-sources')} />
      ) : (
        <>
          {data.failed.length > 0 && (
            <div className="news-warn">
              {data.failed.map((f) => `${f.name}：${f.reason}`).join('；')}
            </div>
          )}

          {zh.length > 0 && (
            <>
              <div className="news-group">中文来源</div>
              <div className="news-list">{zh.map((n) => <NewsRow key={n.id} n={n} nav={nav} />)}</div>
            </>
          )}
          {zh.length === 0 && (
            <div className="news-warn">中文来源当前网络不可达（如巴哈姆特GNN），已保留并在来源管理中显示原因。</div>
          )}
          {en.length > 0 && (
            <>
              <div className="news-group">英文备用来源</div>
              <div className="news-list">{en.map((n) => <NewsRow key={n.id} n={n} nav={nav} />)}</div>
            </>
          )}
          <div className="news-foot">内容来自公开 RSS，仅展示摘要，版权归原作者 · 点按站内阅读</div>
        </>
      )}
    </div>
  )
}

export function NewsRow({ n, nav }: { n: NewsItem; nav: (to: string) => void }) {
  return (
    <button className="news-row" onClick={() => nav(`/newsview/${encodeURIComponent(n.link)}`)}>
      {/* 图片独立组件：失败/无图不影响文字 */}
      {n.image ? <NewsImage src={n.image} className="news-thumb" /> : null}
      <div className="news-main" style={n.image ? undefined : { paddingLeft: 4 }}>
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
