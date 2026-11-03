import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chip, EmptyState, Section, Loading } from '../../components/ui'
import WorkCard from '../../components/WorkCard'
import { getSearchHistory, addSearchHistory, dbClear, type SearchHistoryItem } from '../../database/db'
import { SOURCES, SOURCE_NAMES, type WorkItem } from '../../services/sources'
import type { SourceEntry } from '../../services/sources/aggregate'
import { NewsRow } from '../news/NewsPage'
import { useSearchController, type Scope } from './useSearchController'
import { createToken } from '../detail/searchSession'

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'anime', label: '动漫' },
  { id: 'manga', label: '漫画' },
  { id: 'news', label: '资讯' },
]

/**
 * 修复3：all 范围两档文案。
 * ★ 集合相等时才能说"所有来源均至少出现过一次请求失败"；
 *   否则只能说"有 N 个来源"，不能夸大。
 */
function allFailedCopy(failedCount: number, enabledCount: number): string {
  if (enabledCount > 0 && failedCount === enabledCount) {
    return '所有来源均至少出现过一次请求失败，但部分搜索流可能成功并返回空结果。建议重新搜索。'
  }
  return `有 ${failedCount} 个来源至少出现过一次请求失败，其他来源可能正常返回但没有匹配结果。搜索结果可能不完整。`
}

export default function SearchPage() {
  const nav = useNavigate()
  const c = useSearchController()
  const [history, setHistory] = useState<SearchHistoryItem[]>([])

  const load = useCallback(() => { getSearchHistory().then(setHistory) }, [])
  useEffect(() => { load() }, [load])

  // ── UX-1：搜索键盘自动收起 ──
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * 唯一收键盘出口。
   * ★ 无 DOM 句柄（已卸载）时静默忽略，绝不抛错。
   * ★ 必须是同步调用，且发生在可能触发重渲染的 doSearch 之前。
   */
  const dismissKeyboard = () => {
    inputRef.current?.blur()
  }

  const doSearch = (text?: string, sc?: Scope) => {
    const kw = (text ?? c.q).trim()
    if (!kw) return
    if (sc) c.setScope(sc)
    c.runNow(kw, sc ?? c.scope)
    void addSearchHistory(kw).then(load)
  }

  /** 按钮路径：先收键盘，再搜索（顺序固定，不可调换） */
  const handleSearchClick = () => {
    dismissKeyboard()
    doSearch()
  }

  /**
   * 键盘路径：先处理输入法组合态，再收键盘，最后搜索。
   * ★ isComposing：中文输入法中 Enter 用于"确认候选词"，此时不得提交搜索。
   * ★ 非 Enter 直接返回，不干扰其他按键。
   * ★ preventDefault 放在组合态判断之后，避免吞掉输入法的候选确认。
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    if (e.nativeEvent.isComposing) return

    e.preventDefault()
    dismissKeyboard()
    doSearch()
  }

  /** 点击聚合组：进入首来源的现有详情页（aggId 不是作品 ID） */
  const openDetail = (g: { entries: SourceEntry[] }) => {
    const first = g.entries[0]
    if (!first) return
    // ★ 不变量：route 与下方 URL 必须来自同一个 first，禁止分别取值
    const route = { sourceId: first.sourceId, kind: first.kind, workId: first.workId }
    const token = createToken(g.entries, route)
    nav(`/detail/${first.sourceId}/${first.kind}/${first.workId}`, { state: { ctx: token } })
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
          ref={inputRef}
          placeholder="输入作品或资讯关键词…"
          value={c.q}
          enterKeyHint="search"
          onChange={(e) => c.setQ(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="go" onClick={handleSearchClick}>搜索</button>
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

      {c.isIncomplete && (
        <div
          style={{
            margin: '8px 0', padding: '8px 12px', borderRadius: 8,
            background: 'var(--surface-2, #22262e)', color: 'var(--info, #6aa9e0)', fontSize: 12,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          }}
        >
          <span>上次搜索未完成，当前显示的是已获取的部分结果。</span>
          <button onClick={c.onResearch} style={{ color: 'var(--muted)', flexShrink: 0 }}>重新搜索</button>
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

      {/* 修复3：S1 时提示条隐藏，原因并入空态；其余情况保留 */}
      {Object.keys(c.workFailed).length > 0 && c.emptyStateType !== 'all-failed' && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0' }}>
          部分来源未返回：{Object.entries(c.workFailed).map(([id, r]) => `${SOURCE_NAMES[id] ?? id}（${r}）`).join('、')}
        </div>
      )}

      {/* 修复3：资讯错误提示，仅在范围确实包含资讯时显示 */}
      {(c.scope === 'all' || c.scope === 'news') && c.newsError && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0' }}>{c.newsError}</div>
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

      {c.emptyStateType === 'all-failed' && (
        <EmptyState
          icon="info"
          title="所有来源都未能返回结果"
          desc={`本次搜索的所有来源均请求失败，请检查网络或重新搜索。失败来源：${Object.entries(c.workFailed).map(([id, r]) => `${SOURCE_NAMES[id] ?? id}（${r}）`).join('、')}`}
          actionText="重新搜索"
          onAction={c.onResearch}
        />
      )}

      {c.emptyStateType === 'news-empty' && (
        <EmptyState icon="search" title={`没有找到「${c.searched}」的资讯`} desc="换个关键词、或切换搜索范围试试。" />
      )}

      {c.emptyStateType === 'partial-failure' && (
        <EmptyState
          icon="search"
          title={`没有找到「${c.searched}」`}
          desc={allFailedCopy(Object.keys(c.workFailed).length, Object.values(c.enabledMap).filter(Boolean).length)}
        />
      )}

      {c.emptyStateType === 'no-results' && (
        <EmptyState icon="search" title={`没有找到「${c.searched}」`} desc="换个关键词、或切换搜索范围试试。" />
      )}

      {!c.workLoading && !c.searched && (
        <EmptyState icon="search" title="输入关键词开始搜索"
          desc={'默认搜索全部：动漫 + 漫画 + 资讯\n支持英文、罗马音、日文原名\n结果多来源聚合（同源去重 + 跨源合并）'} />
      )}
    </>
  )
}
