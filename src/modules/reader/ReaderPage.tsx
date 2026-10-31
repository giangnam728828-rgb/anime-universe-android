import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Icon from '../../components/Icon'
import { Loading, EmptyState } from '../../components/ui'
import { getLocalManga, getLocalPages, dbPut } from '../../database/db'
import { useSettings, READER_BG_CSS, type ReaderMode, type ReaderBg } from '../../stores/settings'

const BG_LABEL: Record<ReaderBg, string> = { black: '黑', gray: '灰', white: '白', green: '护眼' }
const WINDOW = 5 // 当前页 ±N 预载（控制内存，规划书要求）

export default function ReaderPage() {
  const nav = useNavigate()
  const { mangaId = '', chapterId = '' } = useParams()
  const { readerMode, setReaderMode, readerBg, setReaderBg } = useSettings()

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

  /* 加载章节页面 + 恢复进度 */
  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const m = await getLocalManga(mangaId)
        if (!m) throw new Error('漫画不存在（可能已被删除）')
        const ch = m.chapters.find((c) => c.id === chapterId)
        if (!ch) throw new Error('章节不存在')
        const ps = await getLocalPages(mangaId, chapterId)
        if (!alive) return
        setMangaTitle(m.title)
        setPages(ps.map((p) => p.blob))
        setLoading(false)

        // 恢复：优先 URL ?p=，否则该章节的历史页码
        let target = 0
        const q = new URLSearchParams(window.location.hash.split('?')[1] || '')
        if (q.get('p')) target = Math.max(0, Number(q.get('p')) || 0)
        else {
          const hist = await (await import('../../database/db')).getReadingProgress(`local-${mangaId}`)
          if (hist && hist.chapterId === chapterId) target = Math.max(0, hist.pageIndex || 0)
        }
        requestAnimationFrame(() => setTimeout(() => {
          if (!alive || restoredRef.current) return
          restoredRef.current = true
          if (readerMode === 'horizontal') {
            scrollRef.current?.scrollTo({ left: target * (scrollRef.current?.clientWidth || 0) })
          } else {
            itemRefs.current[target]?.scrollIntoView()
          }
          setCur(Math.min(target, ps.length - 1))
        }, 60))
      } catch (e) {
        if (alive) { setError((e as Error).message); setLoading(false) }
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mangaId, chapterId])

  /* 卸载时回收 objectURL */
  useEffect(() => () => { urlCache.current.forEach((u) => URL.revokeObjectURL(u)); urlCache.current.clear() }, [])

  const urlFor = useCallback((i: number): string | undefined => {
    if (Math.abs(i - cur) > WINDOW) return undefined
    let u = urlCache.current.get(i)
    if (!u && pages[i]) { u = URL.createObjectURL(pages[i]); urlCache.current.set(i, u) }
    return u
  }, [cur, pages])

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
      const ch = getLocalManga(mangaId).then((m) => m?.chapters.find((c) => c.id === chapterId)?.title || '章节')
      void ch.then((chapter) =>
        dbPut('reading_history', {
          itemId: `local-${mangaId}`, title: mangaTitle, chapter, chapterId,
          position: pages.length ? (idx + 1) / pages.length : 0,
          pageIndex: idx, pageCount: pages.length, at: Date.now(),
        }),
      )
    }, 700)
  }, [mangaId, chapterId, mangaTitle, pages.length])

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
    setFailed((s) => { const n = new Set(s); n.delete(i); return n })
    const u = urlCache.current.get(i)
    if (u) { URL.revokeObjectURL(u); urlCache.current.delete(i) }
    setCur((c) => c) // 触发重渲染
  }

  const bg = READER_BG_CSS[readerBg]
  const imgs = useMemo(() => pages.map((_, i) => i), [pages])

  if (loading) return <div style={{ background: bg, minHeight: '100vh' }}><Loading text="打开章节…" /></div>
  if (error) {
    return <div style={{ background: bg, minHeight: '100vh', display: 'flex', alignItems: 'center' }}>
      <EmptyState icon="info" title="无法打开" desc={error} actionText="返回" onAction={() => nav(-1)} />
    </div>
  }

  return (
    <div className="reader" style={{ background: bg }}>
      {/* 顶栏/底栏 */}
      {bar && (
        <>
          <div className="rd-top">
            <button onClick={() => nav(-1)} className="rd-btn"><Icon name="chevron" size={18} /></button>
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
                failed.has(i) ? (
                  <div className="rd-retry" onClick={() => retryImg(i)}>加载失败 · 点按重试</div>
                ) : (
                  <img src={urlFor(i)} onError={() => setFailed((s) => new Set(s).add(i))} alt={`第${i + 1}页`} />
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
                failed.has(i) ? (
                  <div className="rd-retry" onClick={(e) => { e.stopPropagation(); retryImg(i) }}>加载失败 · 点按重试</div>
                ) : (
                  <img src={urlFor(i)} onError={() => setFailed((s) => new Set(s).add(i))} alt={`第${i + 1}页`} draggable={false} />
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
