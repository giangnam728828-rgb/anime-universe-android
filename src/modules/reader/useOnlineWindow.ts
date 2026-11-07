/**
 * 在线阅读的窗口化图片加载（P1 第5子步）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独抽成 hook
 * ══════════════════════════════════════════════════════════════════════
 * ReaderPage 的本地分支已有成熟的窗口/回收机制（WINDOW=5、urlCache、
 * 远处 URL 回收）。用户明确要求：
 *   「不要为了接入在线分支而重写 ReaderPage 的整体加载生命周期」
 *   「优先采用独立分支接入，复用现有窗口和资源管理机制」
 *
 * 因此本 hook 只负责**一件事**：把「当前窗口需要哪些页」变成
 * 「这些页的 Blob 已经就绪」。ReaderPage 仍用原来的 urlCache +
 * URL.createObjectURL 逻辑，只是 Blob 来源从 IndexedDB 换成网络。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 关键约束
 * ══════════════════════════════════════════════════════════════════════
 *  1. 只下载 [cur-WINDOW, cur+WINDOW] 内的页，绝不整章预下载
 *  2. 并发由 binaryHttp 的 limiter(4) 控制
 *  3. 同页进行中的请求由 inflight 去重
 *  4. 单页失败只标记该页，不影响其他页、不崩溃阅读器
 *  5. 切章 / 卸载时 abort 所有进行中请求，并清空已下载 Blob
 *  6. **不做 LRU 常驻缓存** —— 内存由 ReaderPage 的 urlCache 窗口管理，
 *     本 hook 只保留窗口内的 Blob，窗口外丢弃（与 WINDOW 语义一致）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getOnlinePageBlob, type OnlinePagesResult } from '../../services/reader/onlineChapters'
import { isAbortError } from '../../services/api/abortError'

export interface OnlineWindowState {
  /** 已就绪的 Blob（只有窗口内的页会有值） */
  blobs: Map<number, Blob>
  /** 正在下载中的页码 */
  pending: Set<number>
  /** 下载失败且需要用户重试的页码 */
  failed: Set<number>
  /** 触发某页重新下载（用户点「重试」） */
  retry: (index: number) => void
  /**
   * 标记某页失败（**不重新请求**）。
   *
   * 第8子步新增：`<img>` 的 onError 只能「记录失败」，
   * 绝不能再顺手 `retry()` —— 那会把失败状态立刻清掉，
   * 形成「失败 → 重试 → 又失败 → 再重试」的死循环，
   * 用户永远看不到失败提示（T6 真机现象的根因）。
   */
  markFailed: (index: number) => void
}

export interface UseOnlineWindowOptions {
  /** false 时本 hook 完全惰性（本地阅读分支） */
  enabled: boolean
  /** 图片清单；null 表示尚未加载 */
  pages: OnlinePagesResult | null
  /** 当前页 */
  cur: number
  /** 窗口半径（与 ReaderPage 的 WINDOW 一致） */
  window: number
  /** 章节标识，变化时清空全部状态（切章） */
  chapterKey: string
}

export function useOnlineWindow(opts: UseOnlineWindowOptions): OnlineWindowState {
  const { enabled, pages, cur, window: win, chapterKey } = opts

  const [blobs, setBlobs] = useState<Map<number, Blob>>(() => new Map())
  const [pending, setPending] = useState<Set<number>>(() => new Set())
  const [failed, setFailed] = useState<Set<number>>(() => new Set())

  /** 记录"已请求过"的页，避免重复发起（失败页由 retry 显式清除） */
  const requested = useRef<Set<number>>(new Set())
  /** 当前章节的 AbortController，切章/卸载时统一 abort */
  const abortRef = useRef<AbortController | null>(null)
  /** 防止已卸载后 setState */
  const aliveRef = useRef(true)

  /* ── 切章：清空一切并换新的 AbortController ── */
  useEffect(() => {
    aliveRef.current = true
    requested.current = new Set()
    setBlobs(new Map())
    setPending(new Set())
    setFailed(new Set())

    abortRef.current?.abort()
    abortRef.current = new AbortController()

    return () => {
      aliveRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
      requested.current = new Set()
    }
  }, [chapterKey])

  /* ── 窗口变化：只补齐窗口内缺失的页 ── */
  useEffect(() => {
    if (!enabled || !pages || pages.total === 0) return

    const lo = Math.max(0, cur - win)
    const hi = Math.min(pages.total - 1, cur + win)
    const signal = abortRef.current?.signal

    for (let i = lo; i <= hi; i++) {
      if (requested.current.has(i)) continue        // 已请求过（含失败，等用户重试）
      const ref = pages.pages.find((p) => p.index === i)
      if (!ref) continue

      requested.current.add(i)
      setPending((s) => { const n = new Set(s); n.add(i); return n })

      void getOnlinePageBlob(ref.url, { signal })
        .then((r) => {
          if (!aliveRef.current) return
          setBlobs((m) => { const n = new Map(m); n.set(i, r.blob); return n })
          setPending((s) => { const n = new Set(s); n.delete(i); return n })
        })
        .catch((e: unknown) => {
          if (!aliveRef.current) return
          // abort 属正常流程（切章/卸载），不记为失败
          if (isAbortError(e)) {
            setPending((s) => { const n = new Set(s); n.delete(i); return n })
            return
          }
          setPending((s) => { const n = new Set(s); n.delete(i); return n })
          setFailed((s) => { const n = new Set(s); n.add(i); return n })
        })
    }
  }, [enabled, pages, cur, win])

  /* ── 窗口外丢弃 Blob（与 ReaderPage 的 urlCache 回收阈值保持一致语义）── */
  useEffect(() => {
    if (!enabled) return
    setBlobs((m) => {
      let changed = false
      const n = new Map(m)
      for (const i of m.keys()) {
        if (Math.abs(i - cur) > win + 3) { n.delete(i); changed = true }
      }
      return changed ? n : m
    })
    setFailed((s) => {
      let changed = false
      const n = new Set(s)
      for (const i of s) {
        if (Math.abs(i - cur) > win + 3) { n.delete(i); changed = true }
      }
      return changed ? n : s
    })
  }, [enabled, cur, win])

  const retry = useCallback((index: number) => {
    requested.current.delete(index)
    setFailed((s) => { const n = new Set(s); n.delete(index); return n })
    // 触发窗口 effect 重新执行：清空 cur 后再设回不可行，
    // 这里直接用一个新的 AbortController 并立即发起该页请求
    const ref = pages?.pages.find((p) => p.index === index)
    if (!ref) return
    const signal = abortRef.current?.signal
    requested.current.add(index)
    setPending((s) => { const n = new Set(s); n.add(index); return n })
    void getOnlinePageBlob(ref.url, { signal, timeoutMs: 20000 })
      .then((r) => {
        if (!aliveRef.current) return
        setBlobs((m) => { const n = new Map(m); n.set(index, r.blob); return n })
        setPending((s) => { const n = new Set(s); n.delete(index); return n })
      })
      .catch((e: unknown) => {
        if (!aliveRef.current) return
        setPending((s) => { const n = new Set(s); n.delete(index); return n })
        if (!isAbortError(e)) {
          setFailed((s) => { const n = new Set(s); n.add(index); return n })
        }
      })
  }, [pages])

  /**
   * 只记录失败，不发起任何请求。
   *
   * 用途：`<img src={ObjectURL}>` 的 onError。
   * 走到 onError 说明「Blob 已经拿到了，但渲染失败」（解码失败 / URL 被回收）。
   * 此时绝不能自动重新下载 —— 重下多半还是同一份坏数据，只会变成请求风暴。
   */
  const markFailed = useCallback((index: number) => {
    setPending((s) => { const n = new Set(s); n.delete(index); return n })
    setFailed((s) => {
      if (s.has(index)) return s
      const n = new Set(s); n.add(index); return n
    })
  }, [])

  return { blobs, pending, failed, retry, markFailed }
}
