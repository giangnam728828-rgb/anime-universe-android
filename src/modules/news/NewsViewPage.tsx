import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Icon from '../../components/Icon'
import { Loading, EmptyState } from '../../components/ui'
import { fetchArticle, type Article } from '../../services/news'
import { openExternal } from '../../utils/openUrl'
import { imgFallback } from '../../utils/proxy'

/** 内置资讯阅读页：不跳转，APP 内直接看正文；提取失败兜底系统浏览器 */
export default function NewsViewPage() {
  const nav = useNavigate()
  const { eid = '' } = useParams()
  const [article, setArticle] = useState<Article | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [url, setUrl] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const link = decodeURIComponent(eid)
        if (!/^https?:\/\//.test(link)) throw new Error('链接无效')
        setUrl(link)
        const a = await fetchArticle(link)
        if (alive) { setArticle(a); setLoading(false) }
      } catch (e) {
        if (alive) { setError((e as Error).message); setLoading(false) }
      }
    })()
    return () => { alive = false }
  }, [eid])

  return (
    <div className="page newsview">
      <button onClick={() => nav(-1)} className="nv-back">
        <span style={{ display: 'flex', transform: 'rotate(180deg)' }}><Icon name="chevron" size={15} /></span>
        返回资讯
      </button>

      {loading && <Loading text="正在提取正文…" />}

      {!loading && (error || !article) && (
        <EmptyState icon="info" title="无法内嵌阅读" desc={'该网站不支持内嵌提取。\n可以用系统浏览器打开原文。'}
          actionText="系统浏览器打开" onAction={() => openExternal(url)} />
      )}

      {!loading && article && (
        <>
          <h1 className="nv-title">{article.title}</h1>
          <div className="nv-meta">
            <span className="news-src">{article.source}</span>
            {article.date && <span>{article.date.slice(0, 16)}</span>}
            <button className="nv-orig" onClick={() => openExternal(url)}>查看原文</button>
          </div>
          <div className="nv-body">
            {article.blocks.map((b, i) =>
              b.type === 'img' && b.src ? (
                <img key={i} src={b.src} referrerPolicy="no-referrer" loading="lazy"
                  onError={imgFallback} alt="" />
              ) : (
                <p key={i}>{b.text}</p>
              ),
            )}
          </div>
          <div className="news-foot">内容来自公开网络，版权归原作者与原网站所有</div>
        </>
      )}
    </div>
  )
}
