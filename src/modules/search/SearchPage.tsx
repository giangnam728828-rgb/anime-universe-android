import { useCallback, useEffect, useState } from 'react'
import { Chip, EmptyState, Section } from '../../components/ui'
import { getSearchHistory, addSearchHistory, dbClear, type SearchHistoryItem } from '../../database/db'

type Scope = '动漫' | '漫画' | '资讯'
const ALL_SCOPES: Scope[] = ['动漫', '漫画', '资讯']

export default function SearchPage() {
  const [q, setQ] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(['动漫', '漫画'])
  const [done, setDone] = useState<{ q: string; scopes: Scope[] } | null>(null)
  const [history, setHistory] = useState<SearchHistoryItem[]>([])

  const load = useCallback(() => { getSearchHistory().then(setHistory) }, [])
  useEffect(() => { load() }, [load])

  const toggleScope = (s: Scope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))

  const doSearch = async (text?: string) => {
    const kw = (text ?? q).trim()
    if (!kw) return
    setQ(kw)
    await addSearchHistory(kw)
    load()
    setDone({ q: kw, scopes })
  }

  return (
    <>
      <header className="page-head">
        <h1>搜索</h1>
        <p>全局搜索：动漫 / 漫画 / 资讯 / 资源</p>
      </header>

      <div className="search-bar">
        <input placeholder="输入关键词…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
        <button className="go" onClick={() => doSearch()}>搜索</button>
      </div>

      <Section title="搜索范围">
        <div className="chips">{ALL_SCOPES.map((s) => <Chip key={s} on={scopes.includes(s)} onClick={() => toggleScope(s)}>{s}</Chip>)}</div>
      </Section>

      {history.length > 0 && (
        <Section title="搜索历史" extra={
          <button onClick={() => { dbClear('search_history'); setHistory([]); setDone(null) }}
            style={{ color: 'var(--muted)', fontSize: 11.5 }}>清空</button>
        }>
          <div className="chips">{history.map((h) => <Chip key={h.kw} onClick={() => doSearch(h.kw)}>{h.kw}</Chip>)}</div>
        </Section>
      )}

      <Section title="结果">
        {done ? (
          <EmptyState icon="search" title={`已搜索「${done.q}」`}
            desc={`范围：${done.scopes.length ? done.scopes.join('、') : '未选择'}\n搜索适配器将在阶段 3 接入真实数据源，届时支持多来源与去重。`} />
        ) : (
          <EmptyState icon="search" title="输入关键词开始搜索"
            desc="支持动漫、漫画、资讯等多范围检索；多来源聚合搜索在阶段 3/5 实现。" />
        )}
      </Section>
    </>
  )
}
