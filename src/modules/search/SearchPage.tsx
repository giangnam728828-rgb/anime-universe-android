import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chip, EmptyState, Section, Loading } from '../../components/ui'
import WorkCard from '../../components/WorkCard'
import { getSearchHistory, addSearchHistory, dbClear, type SearchHistoryItem } from '../../database/db'
import { SOURCES, dedup, type WorkItem, type Kind } from '../../services/sources'
import { fetchNews, type NewsItem } from '../../services/news'
import { NewsRow } from '../news/NewsPage'

type Scope = 'all' | 'anime' | 'manga' | 'news'
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'anime', label: '动漫' },
  { id: 'manga', label: '漫画' },
  { id: 'news', label: '资讯' },
]

export default function SearchPage() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [results, setResults] = useState<WorkItem[]>([])
  const [newsResults, setNewsResults] = useState<NewsItem[]>([])
  const [sourcesDone, setSourcesDone] = useState(0) // 已返回的源数（流式渲染）
  const [sourcesTotal, setSourcesTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [searched, setSearched] = useState('')
  const [history, setHistory] = useState<SearchHistoryItem[]>([])

  const load = useCallback(() => { getSearchHistory().then(setHistory) }, [])
  useEffect(() => { load() }, [load])

  /** 流式渲染：每个源独立返回先到先显示，组内跨源去重 */
  const run = async (kw: string, sc: Scope) => {
    const key = kw.trim()
    if (!key) return
    setLoading(true)
    setError(undefined)
    setResults([])
    setNewsResults([])
    setSourcesDone(0)
    setSearched(key)

    const merge = (items: WorkItem[]) =>
      setResults((prev) => dedup([...prev, ...items]))
    const jobs: Promise<void>[] = []

    const kinds: Kind[] = sc === 'all' ? ['anime', 'manga'] : [sc as Kind]
    if (sc === 'all' || sc === 'anime' || sc === 'manga') {
      setSourcesTotal(SOURCES.length * kinds.length)
      SOURCES.forEach((src) => {
        kinds.forEach((k) => {
          jobs.push(
            src.search({ kw: key, kind: k, page: 1 })
              .then((r) => { merge(r.items); setSourcesDone((d) => d + 1) })
              .catch(() => { setSourcesDone((d) => d + 1) }),
          )
        })
      })
    }
    if (sc === 'all' || sc === 'news') {
      jobs.push(
        fetchNews()
          .then((r) => {
            const k = key.toLowerCase()
            const hits = r.items.filter((n) => n.title.toLowerCase().includes(k))
            setNewsResults(hits.slice(0, 10))
            setSourcesDone((d) => d + 1)
          })
          .catch(() => { setSourcesDone((d) => d + 1) }),
      )
      if (sc === 'news') setSourcesTotal(1)
      else setSourcesTotal((t) => t + 1)
    }

    await Promise.allSettled(jobs)
    setLoading(false)
    await addSearchHistory(key)
    load()
  }

  const doSearch = (text?: string, kind?: Scope) => {
    const kw = (text ?? q).trim()
    if (!kw) return
    setQ(kw)
    if (kind) setScope(kind)
    run(kw, kind ?? scope)
  }

  const openDetail = (w: WorkItem) => nav(`/detail/${w.sourceId}/${w.kind}/${w.workId}`)

  const groups: { label: string; items: WorkItem[] }[] = [
    { label: '动漫', items: results.filter((r) => r.kind === 'anime') },
    { label: '漫画', items: results.filter((r) => r.kind === 'manga') },
  ]
  const shownGroups = scope === 'all' ? groups : scope === 'news' ? [] : groups

  return (
    <>
      <header className="page-head">
        <h1>搜索</h1>
        <p>一次搜索：动漫 · 漫画 · 资讯（AniList + MyAnimeList）</p>
      </header>

      <div className="search-bar">
        <input placeholder="输入作品或资讯关键词…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
        <button className="go" onClick={() => doSearch()}>搜索</button>
      </div>

      <Section title="搜索范围">
        <div className="chips">
          {SCOPES.map((s) => <Chip key={s.id} on={scope === s.id} onClick={() => setScope(s.id)}>{s.label}</Chip>)}
        </div>
      </Section>

      {history.length > 0 && (
        <Section title="搜索历史" extra={
          <button onClick={() => { dbClear('search_history'); setHistory([]) }}
            style={{ color: 'var(--muted)', fontSize: 11.5 }}>清空</button>
        }>
          <div className="chips">{history.map((h) => <Chip key={h.kw} onClick={() => doSearch(h.kw)}>{h.kw}</Chip>)}</div>
        </Section>
      )}

      {loading && results.length === 0 && newsResults.length === 0 && (
        <Loading text={sourcesTotal > 0 ? `正在搜索（${sourcesDone}/${sourcesTotal} 个来源完成）…` : '正在搜索…'} />
      )}

      {error && (
        <EmptyState icon="info" title="搜索失败" desc={error} actionText="重试" onAction={() => doSearch(searched || q)} />
      )}

      {/* 动漫 / 漫画分组结果 */}
      {shownGroups.map((g) => g.items.length > 0 && (
        <Section key={g.label} title={`${g.label}（${g.items.length}）`} extra="点击查看详情">
          <div className="work-grid">
            {g.items.map((w) => <WorkCard key={w.sourceId + w.kind + w.workId} w={w} onClick={() => openDetail(w)} />)}
          </div>
          {scope === 'all' && g.items.length >= 12 && (
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>仅显示匹配前部结果 · 切到「{g.label}」范围看更多</div>
          )}
        </Section>
      ))}

      {/* 资讯分组结果 */}
      {(scope === 'all' || scope === 'news') && newsResults.length > 0 && (
        <Section title={`资讯（${newsResults.length}）`} extra="近期新闻标题匹配">
          <div className="news-list">
            {newsResults.map((n) => <NewsRow key={n.id} n={n} nav={nav} />)}
          </div>
        </Section>
      )}

      {!loading && searched && results.length === 0 && newsResults.length === 0 && (
        <EmptyState icon="search" title={`没有找到「${searched}」`} desc="换个关键词、或切换搜索范围试试。" />
      )}

      {!loading && !searched && (
        <EmptyState icon="search" title="输入关键词开始搜索"
          desc={'默认搜索全部：动漫 + 漫画 + 资讯\n支持英文、罗马音、日文原名\n结果多来源聚合去重（AniList / MyAnimeList）'} />
      )}
    </>
  )
}
