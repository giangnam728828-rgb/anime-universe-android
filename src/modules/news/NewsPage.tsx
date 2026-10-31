import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../../components/Icon'
import { EmptyState, Loading } from '../../components/ui'
import NewsImage from '../../components/NewsImage'
import { useAsync } from '../../hooks/useAsync'
import { fetchNews, type NewsItem } from '../../services/news'
import { transEvents } from '../../services/translate'

const CATS = ['全部', '动漫', '漫画', '游戏', '二次元', '英文资讯'] as const
type Cat = (typeof CATS)[number]
const PAGE = 20

export default function NewsPage() {
  const nav = useNavigate()
  const [cat, setCat] = useState<Cat>('全部')
  const [shown, setShown] = useState(PAGE)
  const { loading, data, error, retry } = useAsync(() => fetchNews(), [])

  // 后台翻译每完成一批 → 防抖刷新（原文先出，中文几秒后自动跟上）
  useEffect(() => {
    let timer: number | undefined
    const onBatch = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => retry(), 1200)
    }
    transEvents.addEventListener('batch', onBatch)
    return () => {
      transEvents.removeEventListener('batch', onBatch)
      window.clearTimeout(timer)
    }
  }, [retry])

  const all = data?.items || []
  // 分类数量统计（chips 徽标）
  const isZh = (n: NewsItem) => n.lang === 'zh' || (n.lang === 'ja' && n.translated === true)
  const countOf = (c: Cat) => {
    if (c === '全部') return all.filter(isZh).length
    if (c === '英文资讯') return all.filter((n) => n.lang === 'en').length
    return all.filter((n) => isZh(n) && n.category === c).length
  }
  const zh = all.filter((n) => isZh(n) && (cat === '全部' || n.category === cat)).slice(0, shown)
  const zhTotal = all.filter((n) => isZh(n) && (cat === '全部' || n.category === cat)).length
  const jaRaw = all.filter((n) => n.lang === 'ja' && n.translated !== true)
  const en = cat === '全部' || cat === '英文资讯'
    ? all.filter((n) => n.lang === 'en')
    : []

  return (
    <div className="page">
      <header className="page-head">
        <h1>资讯</h1>
        <p>中文优先 · 官方公开来源 · 点击站内阅读
          <button onClick={() => nav('/news-sources')} style={{ color: 'var(--accent)', marginLeft: 8, fontSize: 11.5 }}>来源管理 ›</button>
        </p>
      </header>

      <div className="chips" style={{ marginBottom: 14 }}>
        {CATS.map((c) => (
          <button key={c} className={'chip' + (cat === c ? ' on' : '')} onClick={() => { setCat(c); setShown(PAGE) }}>
            {c}·{countOf(c)}
          </button>
        ))}
      </div>

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
          {data.fromCache.length > 0 && (
            <div className="news-warn">以下来源本次请求失败，展示的是 6 小时内缓存：{data.fromCache.join('、')}</div>
          )}

          {zh.length > 0 && (
            <>
              <div className="news-group">中文来源{cat !== '全部' ? ` · ${cat}` : ''}（含机器翻译日文）</div>
              <div className="news-list">{zh.map((n) => <NewsRow key={n.id} n={n} nav={nav} />)}</div>
              {zhTotal > shown && (
                <button className="load-more" onClick={() => setShown((n) => n + PAGE)}>
                  加载更多（已显示 {zh.length} / {zhTotal}）
                </button>
              )}
              {zhTotal <= shown && zhTotal > PAGE && (
                <div className="news-foot">已加载全部 {zhTotal} 条（来源缓存 3 分钟，下拉更新见来源管理）</div>
              )}
            </>
          )}
          {zh.length === 0 && cat !== '英文资讯' && (
            <div className="news-warn">
              {all.some((n) => n.lang === 'zh' || n.translated)
                ? `暂无「${cat}」分类的中文内容（其他分类可能有）`
                : '中文来源当前不可用（如巴哈姆特GNN网络不可达），已保留并在来源管理中显示原因。'}
            </div>
          )}
          {jaRaw.length > 0 && (
            <>
              <div className="news-group">日文来源（原文，未开启翻译）</div>
              <div className="news-warn">以下为日文原文。在「来源管理 → 翻译设置」开启自动翻译后，将显示中文并标注「机器翻译」。</div>
              <div className="news-list">{jaRaw.map((n) => <NewsRow key={n.id} n={n} nav={nav} />)}</div>
            </>
          )}
          {en.length > 0 && (
            <>
              <div className="news-group">英文备用来源（不与中文内容混排）</div>
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
          {n.lang === 'ja' && n.translated && <span className="mtag">机器翻译</span>}
          {n.lang === 'ja' && !n.translated && <span className="mtag ja">日文</span>}
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
