import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import NewsImage from '../../components/NewsImage'
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
  const zhAll = (data?.items || []).filter((n) => n.lang === 'zh')
  const items = zhAll.slice(0, 10) // 首页只出中文，英文不占位
  if (!idle) return null
  // 分类数量统计条（阶段6扩充）
  const stat = (re: RegExp) => zhAll.filter((n) => re.test(n.category)).length

  if (loading) return <div className="loading" style={{ padding: '18px 0' }}><span className="spinner" /></div>
  if (items.length === 0) return null

  return (
    <>
    <div className="news-stat">
      动漫 {stat(/动漫/)} · 漫画 {stat(/漫画/)} · 游戏 {stat(/游戏/)} · 二次元 {stat(/二次元/)}
    </div>
    <div className="h-scroll">
      {items.map((n) => (
        <button key={n.id} className="news-card" onClick={() => nav(`/newsview/${encodeURIComponent(n.link)}`)}>
          <div className="nc-thumb">
            {n.image && <NewsImage src={n.image} className="nc-thumb" />}
          </div>
          <div className="nc-title">{n.title}</div>
          <div className="nc-src">{n.source}</div>
        </button>
      ))}
      <button className="news-card news-more" onClick={() => nav('/news')}>
        <div className="nc-more-txt">查看全部</div>
      </button>
    </div>
    </>
  )
}
