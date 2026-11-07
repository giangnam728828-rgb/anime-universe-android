/**
 * 详情页章节列表（P1 第7子步）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个组件
 * ══════════════════════════════════════════════════════════════════════
 * 第6子步真机验收发现：在线章节服务层与 ReaderPage 在线分支都已就绪，
 * 但 `DetailPage` 的「观看/阅读」区写死为 EmptyState（「漫画阅读待开发」），
 * `getChapters` 在整个 UI 层**零调用者** ⇒ 用户无法进入阅读器。
 * 这是功能断点，不是 UI 优化。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 数据来源核实（本步前置，已确认无缺口）
 * ══════════════════════════════════════════════════════════════════════
 * `ChapterItem`（types.ts:61-73）已包含：
 *   id / chapter / volume / pages / translatedLanguage / group / externalUrl
 *
 * MangaDex 的 `getChapters` 从 `/feed` 一次性返回这些字段：
 *   - `pages`      ← feed 自带，**不需要额外 at-home 请求**
 *   - `group`      ← `includes[]=scanlation_group` 展开
 *   - `translatedLanguage` ← feed 自带
 *
 * ⇒ **不产生 N+1 请求**。这是本组件能显示页数与扫描组的前提。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 不可违反的规则
 * ══════════════════════════════════════════════════════════════════════
 *  1. 同章节号的不同 UUID **全部保留**，不按章节号去重
 *  2. 不同语言 / 扫描组的版本**不合并**
 *  3. 章节号为空时**不伪造编号**（显示「无编号」而非编造数字）
 *  4. 语言**必须显示**（用户明确要求）
 *  5. 扫描组/页数**有数据才显示**，不伪造
 *  6. 不为章节列表预下载图片
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import Icon from '../../components/Icon'
import { Loading, EmptyState } from '../../components/ui'
import { getSource, type Kind } from '../../services/sources'
import type { ChapterItem } from '../../services/sources/types'
import {
  languageLabel,
  isChineseLanguage,
  sortChapters,
  normalizeChapter,
  type OnlineChapter,
} from '../../services/reader/onlineChapters'
import { readerPath } from '../reader/readerRoute'

/** 每次加载的章节数（与服务端 PAGE 一致） */
const PAGE_SIZE = 20

interface Props {
  sourceId: string
  kind: Kind
  workId: string
  /** 当前详情页路径，用于 state.from */
  fromPath: string
}

export default function ChapterList({ sourceId, workId, fromPath }: Props) {
  const nav = useNavigate()
  const location = useLocation()

  const [chapters, setChapters] = useState<OnlineChapter[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [cursor, setCursor] = useState<string | undefined>()
  const [hasNext, setHasNext] = useState(false)

  /** 来源适配器是否具备章节能力（决定是否渲染本组件） */
  const adapter = useMemo(() => {
    try { return getSource(sourceId) } catch { return null }
  }, [sourceId])

  const supported = !!adapter && typeof adapter.getChapters === 'function'

  const load = useCallback(async (append: boolean, cur?: string) => {
    if (!supported || !adapter?.getChapters) return
    if (append) setLoadingMore(true)
    else { setLoading(true); setError(undefined) }

    try {
      const r = await adapter.getChapters(workId, { limit: PAGE_SIZE, cursor: cur })
      // 规范化：保留 UUID、语言、扫描组、页数；不丢弃、不去重
      const list = (r.chapters || []).map((c: ChapterItem) => normalizeChapter(c, workId, sourceId))
      setChapters((prev) => (append ? [...prev, ...list] : list))
      setCursor(r.nextCursor)
      setHasNext(!!r.hasNext)
    } catch (e) {
      if (!append) setError((e as Error).message || '章节加载失败')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [supported, adapter, workId, sourceId])

  useEffect(() => {
    if (!supported) { setLoading(false); return }
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, workId, sourceId])

  /** 排序：复用统一规则（章节号数值升序 → 语言 → 发布时间），**绝不去重** */
  const sorted = useMemo(() => sortChapters(chapters), [chapters])

  const stats = useMemo(() => {
    let zh = 0
    for (const c of chapters) if (isChineseLanguage(c.language)) zh++
    return { total: chapters.length, zh }
  }, [chapters])

  /** 点击：四段式路由 + state.from（不手写路径） */
  const open = (c: OnlineChapter) => {
    nav(
      readerPath({ sourceId, mangaId: workId, chapterId: c.id, page: 0 }),
      { state: { from: fromPath || location.pathname } },
    )
  }

  /* ── 状态：不支持章节能力 ── */
  if (!supported) {
    return (
      <EmptyState icon="film" title="此来源不提供章节"
        desc={'该来源只提供作品资料，不提供漫画章节。\n阅读功能只会使用合法开放来源或本地导入内容。'} />
    )
  }

  /* ── 状态：加载中 ── */
  if (loading) return <Loading text="加载章节…" />

  /* ── 状态：失败 ── */
  if (error) {
    return (
      <EmptyState icon="info" title="章节加载失败" desc={error}
        actionText="重试" onAction={() => void load(false)} />
    )
  }

  /* ── 状态：空 ── */
  if (sorted.length === 0) {
    return (
      <EmptyState icon="book" title="暂无章节"
        desc="该作品在当前来源下没有可阅读的章节。" />
    )
  }

  return (
    <div>
      {/* 统计行：让用户一眼看到语言分布（中文优先提示） */}
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.7 }}>
        已加载 {stats.total} 章
        {hasNext && '（可继续加载）'}
        {stats.zh > 0
          ? ` · 其中中文 ${stats.zh} 章`
          : ' · 当前列表无中文章节'}
      </div>

      <div className="rows">
        {sorted.map((c) => (
          <button key={c.id} className="row-item" onClick={() => open(c)}
            style={{ textAlign: 'left', width: '100%' }}>
            <span className="ric"><Icon name="book" size={19} /></span>
            <span className="rmain">
              <div className="rtitle">
                {c.chapter ? `第 ${c.chapter} 话` : '无编号章节'}
                {c.volume ? ` · 卷 ${c.volume}` : ''}
                {c.title ? ` · ${c.title}` : ''}
              </div>
              <div className="rdesc">
                {/* 语言必须显示 */}
                <span style={{
                  display: 'inline-block', padding: '1px 6px', borderRadius: 4,
                  background: isChineseLanguage(c.language) ? 'var(--accent, #4a7)' : 'transparent',
                  border: '1px solid var(--line, #ddd)',
                  color: isChineseLanguage(c.language) ? '#fff' : 'inherit',
                  fontSize: 10.5, marginRight: 6,
                }}>{c.languageLabel}</span>
                {/* 扫描组：有数据才显示，不伪造 */}
                {c.group && <span style={{ marginRight: 6 }}>{c.group}</span>}
                {/* 页数：feed 自带，无额外请求 */}
                {c.pages > 0 && <span>{c.pages} 页</span>}
                {c.external && <span style={{ marginLeft: 6 }}>· 外部链接</span>}
              </div>
            </span>
          </button>
        ))}
      </div>

      {hasNext && (
        <button
          onClick={() => void load(true, cursor)}
          disabled={loadingMore}
          style={{
            width: '100%', marginTop: 10, padding: '11px 0',
            background: 'transparent', border: '1px solid var(--line, #ddd)',
            borderRadius: 10, color: 'var(--muted)', fontSize: 12.5,
          }}>
          {loadingMore ? '加载中…' : '加载更多章节'}
        </button>
      )}
    </div>
  )
}

/** 供 DetailPage 判断是否渲染章节区（避免在不支持的来源上显示空壳） */
export function sourceSupportsChapters(sourceId: string): boolean {
  try {
    const a = getSource(sourceId)
    return typeof a.getChapters === 'function'
  } catch {
    return false
  }
}

/** 语言标签再导出，便于测试直接引用 */
export { languageLabel }
