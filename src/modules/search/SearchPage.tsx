import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chip, EmptyState, Section, Loading } from '../../components/ui'
import WorkCard from '../../components/WorkCard'
import { getSearchHistory, addSearchHistory, dbClear, type SearchHistoryItem } from '../../database/db'
import { searchAll, type WorkItem } from '../../services/sources'

type Scope = 'anime' | 'manga'
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'anime', label: '动漫' },
  { id: 'manga', label: '漫画' },
]

export default function SearchPage() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<Scope>('anime')
  const [results, setResults] = useState<WorkItem[]>([])
  const [hasNext, setHasNext] = useState(false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [failed, setFailed] = useState<string[]>([])
  const [searched, setSearched] = useState('')
  const [history, setHistory] = useState<SearchHistoryItem[]>([])

  const load = useCallback(() => { getSearchHistory().then(setHistory) }, [])
  useEffect(() => { load() }, [load])

  const run = async (kw: string, kind: Scope, p: number, append: boolean) => {
    const key = kw.trim()
    if (!key) return
    setLoading(true)
    setError(undefined)
    try {
      if (!append) setResults([])
      const r = await searchAll({ kw: key, kind, page: p })
      setResults((prev) => (append ? [...prev, ...r.items] : r.items))
      setHasNext(r.items.length >= 18)
      setPage(p)
      setSearched(key)
      setFailed(r.failed)
      if (!append && p === 1) { await addSearchHistory(key); load() }
    } catch (e) {
      setError((e as Error)?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const doSearch = (text?: string, kind?: Scope) => {
    const kw = (text ?? q).trim()
    if (!kw) return
    setQ(kw)
    if (kind) setScope(kind)
    run(kw, kind ?? scope, 1, false)
  }

  return (
    <>
      <header className="page-head">
        <h1>搜索</h1>
        <p>全局搜索 · 数据来自 AniList</p>
      </header>

      <div className="search-bar">
        <input placeholder="输入作品名（支持英文/罗马音/日文）…" value={q} onChange={(e) => setQ(e.target.value)}
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

      {loading && results.length === 0 && <Loading text="正在搜索…" />}

      {error && (
        <EmptyState icon="info" title="搜索失败" desc={error}
          actionText="重试" onAction={() => doSearch(searched || q)} />
      )}

      {results.length > 0 && (
        <Section title={searched ? `「${searched}」的搜索结果` : '结果'}
          extra={`共 ${results.length} 条 · AniList`}>
          {failed.length > 0 && (
            <div className="news-warn">部分来源不可用：{failed.join('、')}（其余正常）</div>
          )}
          <div className="work-grid">
            {results.map((w) => (
              <WorkCard key={w.sourceId + w.workId} w={w}
                onClick={() => nav(`/detail/${w.sourceId}/${w.kind}/${w.workId}`)} />
            ))}
          </div>
          {hasNext && (
            <button className="load-more" onClick={() => run(searched, scope, page + 1, true)} disabled={loading}>
              {loading ? '加载中…' : '加载更多'}
            </button>
          )}
        </Section>
      )}

      {!loading && !error && results.length === 0 && searched && (
        <EmptyState icon="search" title={`没有找到「${searched}」`} desc="换个关键词或切换范围试试。" />
      )}

      {!loading && !searched && (
        <EmptyState icon="search" title="输入关键词开始搜索"
          desc="支持英文、罗马音、日文原名。\n多来源聚合搜索在阶段 5 实现（Jikan/Bangumi 等）。" />
      )}
    </>
  )
}
