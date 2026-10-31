import { useState } from 'react'
import { Chip, EmptyState, Section } from '../../components/ui'

type Scope = '动漫' | '漫画' | '资讯'
const ALL_SCOPES: Scope[] = ['动漫', '漫画', '资讯']
const HKEY = 'au_search_history'

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HKEY) || '[]') } catch { return [] }
}

export default function SearchPage() {
  const [q, setQ] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(['动漫', '漫画'])
  const [done, setDone] = useState<{ q: string; scopes: Scope[] } | null>(null)
  const [history, setHistory] = useState<string[]>(loadHistory)

  const toggleScope = (s: Scope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))

  const doSearch = (text?: string) => {
    const kw = (text ?? q).trim()
    if (!kw) return
    setQ(kw)
    const next = [kw, ...history.filter((h) => h !== kw)].slice(0, 8)
    setHistory(next)
    localStorage.setItem(HKEY, JSON.stringify(next))
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
        <Section title="搜索历史" extra={<button onClick={() => { setHistory([]); localStorage.removeItem(HKEY); setDone(null) }} style={{ color: 'var(--muted)', fontSize: 11.5 }}>清空</button>}>
          <div className="chips">{history.map((h) => <Chip key={h} onClick={() => doSearch(h)}>{h}</Chip>)}</div>
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
