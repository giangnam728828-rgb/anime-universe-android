import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chip, EmptyState, Section, Loading } from '../../components/ui'
import WorkCard from '../../components/WorkCard'
import { getSearchHistory, addSearchHistory, dbClear, type SearchHistoryItem } from '../../database/db'
import { SOURCES, SOURCE_NAMES, type WorkItem } from '../../services/sources'
import { NewsRow } from '../news/NewsPage'
import { useSearchController, type Scope } from './useSearchController'

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'anime', label: '动漫' },
  { id: 'manga', label: '漫画' },
  { id: 'news', label: '资讯' },
]

export default function SearchPage() {
  const nav = useNavigate()
  const c = useSearchController()
  const [history, setHistory] = useState<SearchHistoryItem[]>([])

  const load = useCallback(() => { getSearchHistory().then(setHistory) }, [])
  useEffect(() => { load() }, [load])

  const doSearch = (text?: string, sc?: Scope) => {
    const kw = (text ?? c.q).trim()
    if (!kw) return
    if (sc) c.setScope(sc)
    c.runNow(kw, sc ?? c.scope)
    void addSearchHistory(kw).then(load)
  }

  /** 点击聚合组：进入首来源的现有详情页（aggId 不是作品 ID） */
  const openDetail = (g: { entries: { sourceId: string; kind: string; workId: string }[] }) => {
    const first = g.entries[0]
    if (!first) return
    nav(`/detail/${first.sourceId}/${first.kind}/${first.workId}`)
  }

  /** 多来源展示：按 SOURCE_ORDER 前两个 + 剩余数 */
  const sourceLabel = (g: { entries: { sourceId: string }[] }) => {
    const names = g.entries.map((e) => SOURCE_NAMES[e.sourceId] ?? e.sourceId)
    if (names.length <= 2) return names.join('、')
    return `${names.slice(0, 2).join('、')} +${names.length - 2}`
  }

  const animeGroups = c.workGroups.filter((k) => k.group.kind === 'anime')
  const mangaGroups = c.workGroups.filter((k) => k.group.kind === 'manga')
  const shownGroups =
    c.scope === 'news'
      ? []
      : c.scope === 'all'
        ? [{ label: '动漫', items: animeGroups }, { label: '漫画', items: mangaGroups }]
        : c.scope === 'anime'
          ? [{ label: '动漫', items: animeGroups }]
          : [{ label: '漫画', items: mangaGroups }]

  const enabledCount = SOURCES.filter((s) => c.enabledMap[s.id]).length

  return (
    <>
      <header className="page-head">
        <h1>搜索</h1>
        <p>一次搜索：动漫 · 漫画 · 资讯 · 多来源聚合</p>
      </header>

      <div className="search-bar">
        <input
          placeholder="输入作品或资讯关键词…"
          value={c.q}
          onChange={(e) => c.setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
        />
        <button className="go" onClick={() => doSearch()}>搜索</button>
      </div>

      <Section title="搜索范围">
        <div className="chips">
          {SCOPES.map((s) => (
            <Chip key={s.id} on={c.scope === s.id} onClick={() => c.setScope(s.id)}>{s.label}</Chip>
          ))}
        </div>
      </Section>

      <Section title={`来源（${enabledCount}/${SOURCES.length}）`} extra="点击切换，立即生效">
        <div className="chips">
          {SOURCES.map((s) => (
            <Chip key={s.id} on={!!c.enabledMap[s.id]} onClick={() => c.toggleSource(s.id)}>
              {SOURCE_NAMES[s.id] ?? s.id}
            </Chip>
          ))}
        </div>
      </Section>

      {c.pipelineError && (
        <div
          style={{
            margin: '8px 0', padding: '8px 12px', borderRadius: 8,
            background: 'var(--surface-2, #22262e)', color: 'var(--warn, #e0a040)', fontSize: 12,
            display: 'flex', justifyContent: 'space-between', gap: 8,
          }}
        >
          <span>{c.pipelineError}</span>
          <button onClick={c.clearPipelineError} style={{ color: 'var(--muted)' }}>关闭</button>
        </div>
      )}

      {history.length > 0 && (
        <Section title="搜索历史" extra={
          <button onClick={() => { dbClear('search_history'); setHistory([]) }}
            style={{ color: 'var(--muted)', fontSize: 11.5 }}>清空</button>
        }>
          <div className="chips">{history.map((h) => <Chip key={h.kw} onClick={() => doSearch(h.kw)}>{h.kw}</Chip>)}</div>
        </Section>
      )}

      {c.workLoading && c.workGroups.length === 0 && c.newsResults.length === 0 && (
        <Loading text={c.workTotal > 0 ? `正在搜索（${c.workDone}/${c.workTotal} 个来源完成）…` : '正在搜索…'} />
      )}

      {Object.keys(c.workFailed).length > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0' }}>
          部分来源未返回：{Object.entries(c.workFailed).map(([id, r]) => `${SOURCE_NAMES[id] ?? id}（${r}）`).join('、')}
        </div>
      )}

      {shownGroups.map((g) => g.items.length > 0 && (
        <Section key={g.label} title={`${g.label}（${g.items.length}）`} extra="点击查看详情">
          <div className="work-grid">
            {g.items.map((k) => (
              <div key={k.uiKey}>
                <WorkCard w={k.group.entries[0].item as WorkItem} onClick={() => openDetail(k.group)} />
                <div style={{ fontSize: 10.5, color: 'var(--muted)', textAlign: 'center', marginTop: 2 }}>
                  {sourceLabel(k.group)}
                </div>
              </div>
            ))}
          </div>
        </Section>
      ))}

      {(c.scope === 'all' || c.scope === 'news') && c.newsResults.length > 0 && (
        <Section title={`资讯（${c.newsResults.length}）`} extra="近期新闻标题匹配">
          <div className="news-list">
            {c.newsResults.map((n) => <NewsRow key={n.id} n={n} nav={nav} />)}
          </div>
        </Section>
      )}

      {!c.workLoading && c.searched && c.workGroups.length === 0 && c.newsResults.length === 0 && (
        <EmptyState icon="search" title={`没有找到「${c.searched}」`} desc="换个关键词、或切换搜索范围试试。" />
      )}

      {!c.workLoading && !c.searched && (
        <EmptyState icon="search" title="输入关键词开始搜索"
          desc={'默认搜索全部：动漫 + 漫画 + 资讯\n支持英文、罗马音、日文原名\n结果多来源聚合（同源去重 + 跨源合并）'} />
      )}
    </>
  )
}
