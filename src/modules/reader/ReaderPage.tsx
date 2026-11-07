import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import Icon from '../../components/Icon'
import { Loading, EmptyState } from '../../components/ui'
import { getLocalManga, getLocalPages, dbPut } from '../../database/db'
import { useSettings, READER_BG_CSS, type ReaderMode, type ReaderBg } from '../../stores/settings'
import { LOCAL_SOURCE_ID, resolveBackTarget } from './readerRoute'
import { getOnlinePages, type OnlinePagesResult } from '../../services/reader/onlineChapters'
import { useOnlineWindow } from './useOnlineWindow'

const BG_LABEL: Record<ReaderBg, string> = { black: '黑', gray: '灰', white: '白', green: '护眼' }
const WINDOW = 5 // 当前页 ±N 预载（控制内存，规划书要求）

export default function ReaderPage() {
  const nav = useNavigate()
  const location = useLocation()
  // P1 第4子步：四段式路由，显式携带来源。旧路由经 ReaderRedirect 后一定带 sourceId
  const { sourceId = LOCAL_SOURCE_ID, mangaId = '', chapterId = '' } = useParams()
  const { readerMode, setReaderMode, readerBg, setReaderBg } = useSettings()

  /**
   * 统一的返回逻辑（错误态与顶栏必须走同一套）。
   *
   * 用户裁定：返回目标由入口通过 state.from 明确提供，
   * 不依据浏览器历史长度猜测。无法校验时 fallback 到 /library。
   */
  const goBack = useCallback(() => {
    const t = resolveBackTarget(location.state)
    nav(t.path, { replace: false })
  }, [nav, location.state])

  const isLocal = sourceId === LOCAL_SOURCE_ID
  /** 在线分支的图片清单（本地分支恒为 null） */
  const [online, setOnline] = useState<OnlinePagesResult | null>(null)
  const [pages, setPages] = useState<Blob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [mangaTitle, setMangaTitle] = useState('')
  const [failed, setFailed] = useState<Set<number>>(new Set())
  const [cur, setCur] = useState(0)
  const [bar, setBar] = useState(true)

  const scrollRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const urlCache = useRef(new Map<number, string>())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoredRef = useRef(false)
  const barTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 恢复阅读位置：优先 URL ?p=，否则该章节的历史页码。
   * 本地与在线分支共用（页码语义一致，itemId 由 sourceId 区分）。
   */
  const restoreProgress = useCallback(async (total: number) => {
    let target = 0
    const q = new URLSearchParams(window.location.hash.split('?')[1] || '')
    if (q.get('p')) target = Math.max(0, Number(q.get('p')) || 0)
    else {
      // 与写入侧保持同一 itemId 格式：local 来源时等价于原 local-${mangaId}，
      // 在线来源时读取 mangadex-${mangaId}（不改变本地既有记录格式）
      const hist = await (await import('../../database/db')).getReadingProgress(`${sourceId}-${mangaId}`)
      if (hist && hist.chapterId === chapterId) target = Math.max(0, hist.pageIndex || 0)
    }
    requestAnimationFrame(() => setTimeout(() => {
      if (restoredRef.current) return
      restoredRef.current = true
      if (readerMode === 'horizontal') {
        scrollRef.current?.scrollTo({ left: target * (scrollRef.current?.clientWidth || 0) })
      } else {
        itemRefs.current[target]?.scrollIntoView()
      }
      setCur(Math.min(target, Math.max(0, total - 1)))
    }, 60))
  }, [sourceId, mangaId, chapterId, readerMode])

  /* 加载章节页面 + 恢复进度 */
  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        /* ── 分支 A：本地阅读（行为保持不变）── */
        if (isLocal) {
          const m = await getLocalManga(mangaId)
          if (!m) throw new Error('漫画不存在（可能已被删除）')
          const ch = m.chapters.find((c) => c.id === chapterId)
          if (!ch) throw new Error('章节不存在')
          const ps = await getLocalPages(mangaId, chapterId)
          if (!alive) return
          setMangaTitle(m.title)
          setPages(ps.map((p) => p.blob))
          setOnline(null)
          setLoading(false)
          await restoreProgress(ps.length)
          return
        }

        /* ── 分支 B：在线阅读（MangaDex）── */
        // 只取图片清单，不下载字节；字节由 useOnlineWindow 按窗口拉取
        const { getSource } = await import('../../services/sources/registry')
        const adapter = getSource(sourceId)
        // getSource 找不到时会回退 SOURCES[0]，必须显式校验，防止串源
        if (adapter.id !== sourceId) throw new Error(`未知阅读来源：${sourceId}`)
        if (typeof adapter.getPages !== 'function') {
          throw new Error(`来源 ${sourceId} 不支持在线阅读`)
        }

        const [detail, list] = await Promise.all([
          adapter.getDetail('manga', mangaId).catch(() => null),
          getOnlinePages(adapter, sourceId, mangaId, chapterId),
        ])
        if (!alive) return
        if (list.total === 0) throw new Error('本章节没有可阅读的图片')

        setMangaTitle(detail?.title || '在线章节')
        setOnline(list)
        // pages 只用于计数与进度（在线分支不存 Blob）
        setPages(new Array(list.total).fill(null).map(() => new Blob()))
        setLoading(false)
        await restoreProgress(list.total)

      } catch (e) {
        if (alive) { setError((e as Error).message); setLoading(false) }
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mangaId, chapterId])

  /* 卸载时回收 objectURL */
  useEffect(() => () => { urlCache.current.forEach((u) => URL.revokeObjectURL(u)); urlCache.current.clear() }, [])

  /* 在线分支：按窗口拉取 Blob（本地分支 enabled=false，完全惰性） */
  const onlineWin = useOnlineWindow({
    enabled: !isLocal && !!online,
    pages: online,
    cur,
    window: WINDOW,
    chapterKey: `${sourceId}:${mangaId}:${chapterId}`,
  })

  /**
   * 取某页的 Blob：
   *  - 本地分支：来自 IndexedDB 的 pages[i]
   *  - 在线分支：来自 useOnlineWindow 的窗口缓存
   */
  const blobFor = useCallback((i: number): Blob | undefined => {
    if (isLocal) return pages[i]
    return onlineWin.blobs.get(i)
  }, [isLocal, pages, onlineWin.blobs])

  const urlFor = useCallback((i: number): string | undefined => {
    if (Math.abs(i - cur) > WINDOW) return undefined
    let u = urlCache.current.get(i)
    if (!u) {
      const b = blobFor(i)
      if (b) { u = URL.createObjectURL(b); urlCache.current.set(i, u) }
    }
    return u
  }, [cur, blobFor])

  /* 只在 cur 变化时清理远处 URL，防内存膨胀 */
  useEffect(() => {
    for (const [i, u] of urlCache.current) {
      if (Math.abs(i - cur) > WINDOW + 3) { URL.revokeObjectURL(u); urlCache.current.delete(i) }
    }
  }, [cur])

  /* 进度保存（防抖） */
  const save = useCallback((idx: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      // 本地分支查本地章节标题；在线分支用章节号（不查本地库，避免串源）
      const ch = isLocal
        ? getLocalManga(mangaId).then((m) => m?.chapters.find((c) => c.id === chapterId)?.title || '章节')
        : Promise.resolve(chapterId)
      void ch.then((chapter) =>
        dbPut('reading_history', {
          itemId: `${sourceId}-${mangaId}`, title: mangaTitle, chapter, chapterId,
          // P1 第4子步：明确写入来源，供 FavoritesPage 判断（旧记录该字段为 undefined）
          sourceId,
          position: pages.length ? (idx + 1) / pages.length : 0,
          pageIndex: idx, pageCount: pages.length, at: Date.now(),
        }),
      )
    }, 700)
  }, [isLocal, sourceId, mangaId, chapterId, mangaTitle, pages.length])

  const flashBar = useCallback(() => {
    setBar(true)
    if (barTimer.current) clearTimeout(barTimer.current)
    barTimer.current = setTimeout(() => setBar(false), 2600)
  }, [])

  const onScrollV = () => {
    const el = scrollRef.current
    if (!el) return
    const mid = el.scrollTop + el.clientHeight * 0.4
    let idx = 0
    for (let i = 0; i < itemRefs.current.length; i++) {
      const t = itemRefs.current[i]
      if (t && t.offsetTop <= mid) idx = i
    }
    setCur(idx); save(idx)
  }

  const onScrollH = () => {
    const el = scrollRef.current
    if (!el || !el.clientWidth) return
    const idx = Math.min(pages.length - 1, Math.max(0, Math.round(el.scrollLeft / el.clientWidth)))
    setCur(idx); save(idx)
  }

  const goPage = (i: number) => {
    const el = scrollRef.current
    if (!el) return
    const t = Math.max(0, Math.min(pages.length - 1, i))
    if (readerMode === 'horizontal') el.scrollTo({ left: t * el.clientWidth, behavior: 'smooth' })
    else itemRefs.current[t]?.scrollIntoView({ behavior: 'smooth' })
  }

  const onTapH = (e: React.MouseEvent) => {
    const el = scrollRef.current
    if (!el) return
    const x = e.clientX - el.getBoundingClientRect().left
    const w = el.clientWidth
    if (x < w * 0.3) goPage(cur - 1)
    else if (x > w * 0.7) goPage(cur + 1)
    else flashBar()
  }

  const retryImg = (i: number) => {
    // 回收该页旧的 Object URL（本地与在线共用）
    const u = urlCache.current.get(i)
    if (u) { URL.revokeObjectURL(u); urlCache.current.delete(i) }

    if (!isLocal) {
      // 在线分支：交由 useOnlineWindow 重新下载
      onlineWin.retry(i)
      return
    }
    setFailed((s) => { const n = new Set(s); n.delete(i); return n })
    setCur((c) => c) // 触发重渲染
  }

  /** 该页是否应显示"加载失败"（本地用 failed state，在线用 onlineWin.failed） */
  const isFailed = (i: number): boolean => (isLocal ? failed.has(i) : onlineWin.failed.has(i))

  const bg = READER_BG_CSS[readerBg]
  const imgs = useMemo(() => pages.map((_, i) => i), [pages])

  if (loading) return <div style={{ background: bg, minHeight: '100vh' }}><Loading text="打开章节…" /></div>
  if (error) {
    return <div style={{ background: bg, minHeight: '100vh', display: 'flex', alignItems: 'center' }}>
      <EmptyState icon="info" title="无法打开" desc={error} actionText="返回" onAction={goBack} />
    </div>
  }

  return (
    <div className="reader" style={{ background: bg }}>
      {/* 顶栏/底栏 */}
      {bar && (
        <>
          <div className="rd-top">
            <button onClick={goBack} className="rd-btn"><Icon name="chevron" size={18} /></button>
            <div className="rd-title">{mangaTitle}</div>
            <div className="rd-count">{cur + 1} / {pages.length}</div>
          </div>
          <div className="rd-bottom">
            <div className="rd-group">
              <span className="rd-label">模式</span>
              {(['vertical', 'horizontal'] as ReaderMode[]).map((m) => (
                <button key={m} className={'rd-pill' + (readerMode === m ? ' on' : '')}
                  onClick={() => { setReaderMode(m); restoredRef.current = false; setTimeout(() => goPage(cur), 50) }}>
                  {m === 'vertical' ? '上下滚' : '左右翻'}
                </button>
              ))}
            </div>
            <div className="rd-group">
              <span className="rd-label">背景</span>
              {(Object.keys(BG_LABEL) as ReaderBg[]).map((b) => (
                <button key={b} className={'rd-dot' + (readerBg === b ? ' on' : '')}
                  style={{ background: READER_BG_CSS[b] }} title={BG_LABEL[b]}
                  onClick={() => setReaderBg(b)} />
              ))}
            </div>
          </div>
        </>
      )}

      {/* 内容 */}
      {readerMode === 'vertical' ? (
        <div className="rd-scroll" ref={scrollRef} onScroll={onScrollV} onClick={flashBar}
          style={{ background: bg }}>
          {imgs.map((i) => (
            <div key={i} ref={(el) => { itemRefs.current[i] = el }} className="rd-page">
              {urlFor(i) ? (
                isFailed(i) ? (
                  <div className="rd-retry" onClick={() => retryImg(i)}>加载失败 · 点按重试</div>
                ) : (
                  <img src={urlFor(i)} onError={() => { if (isLocal) setFailed((s) => new Set(s).add(i)); else onlineWin.retry(i) }} alt={`第${i + 1}页`} />
                )
              ) : (
                <div className="rd-hold">{i + 1}</div>
              )}
            </div>
          ))}
          <div className="rd-end">本章节完 · 共 {pages.length} 页</div>
        </div>
      ) : (
        <div className="rd-hscroll" ref={scrollRef} onScroll={onScrollH} onClick={onTapH}
          style={{ background: bg }}>
          {imgs.map((i) => (
            <div key={i} className="rd-slide">
              {urlFor(i) ? (
                isFailed(i) ? (
                  <div className="rd-retry" onClick={(e) => { e.stopPropagation(); retryImg(i) }}>加载失败 · 点按重试</div>
                ) : (
                  <img src={urlFor(i)} onError={() => { if (isLocal) setFailed((s) => new Set(s).add(i)); else onlineWin.retry(i) }} alt={`第${i + 1}页`} draggable={false} />
                )
              ) : (
                <div className="rd-hold">{i + 1}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 双指缩放：WebView 手势限制，明确标注（规划书要求不装假功能） */}
      <div className="rd-note">双指缩放待开发 · 点两侧翻页 / 中间呼出菜单</div>
    </div>
  )
}
