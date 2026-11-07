/**
 * 在线阅读的窗口化图片加载（第9子步 · 批次② 重写）
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
 * 🔴 第9子步重写了内部实现（对外签名零变化）
 * ══════════════════════════════════════════════════════════════════════
 * 旧实现用 `requested: Set<number>`（曾经请求过）+ `blobs: Map`（手上有字节）
 * 两个结构共同决定「要不要发请求」。二者清理时机不同：
 *   - `requested` 只在切章 / 单页 retry 时清
 *   - `blobs` 在 |i-cur| > win+3 时淘汰
 * ⇒ 出现 `requested.has(i) === true` 但无 blob、无 failed 的页，
 *   永远不再下载 ⇒ 翻回前面时该页**永久空白**（Bug A）。
 *
 * 新实现把逻辑状态收进纯模块 `readerWindowState.ts`：
 *   - 淘汰把状态**回退到 idle**（而不是留一条"请求过"的墓碑），该页可被重新调度
 *   - `PageRecord`（逻辑状态）与 `InflightRequest`（物理请求身份）分离
 *   - settle 走固定四阶段 S1→S2→S3→S4，S2→S3 同步连续执行
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 并发归属（不要在本层再自建并发闸门）
 * ══════════════════════════════════════════════════════════════════════
 * 本层只负责「按优先级把窗口内的页**派发**给调度器」。
 * 真正的物理并发由 `imageScheduler`（第9子步批次①）统一控制：
 *   - 全 App 图片并发 ≤ 6
 *   - 正文 `reader` 优先于封面 `cover`
 *
 * 因此本层 `inflight` 的语义是**已派发未 settle**（含仍在调度器里排队的），
 * 是物理并发的**超集**，不是等号。物理名额只在 Promise settle 后释放。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 关键约束（继承自第5/8子步，未放宽）
 * ══════════════════════════════════════════════════════════════════════
 *  1. 只下载 [cur-WINDOW, cur+WINDOW] 内的页，绝不整章预下载
 *  2. 同页进行中的请求由 inflight 去重
 *  3. 单页失败只标记该页，不影响其他页、不崩溃阅读器
 *  4. 切章 / 卸载时 abort 所有进行中请求，并清空已下载 Blob
 *  5. **不做 LRU 常驻缓存** —— 内存由 ReaderPage 的 urlCache 窗口管理
 *  6. `markFailed` 只记录失败、**绝不**发起请求（第8子步 T6 根因修复）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getOnlinePageBlob, type OnlinePagesResult } from '../../services/reader/onlineChapters'
import { isAbortError } from '../../services/api/abortError'
import {
  applyWindow,
  createWindowState,
  deriveBlobs,
  deriveFailed,
  derivePending,
  markPageFailed,
  markRetry,
  pagesToRequest,
  resetForChapter,
  settleRequest,
  startRequest,
  type InflightRequest,
  type WindowState,
} from './readerWindowState'

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

  /** 纯逻辑状态机（不进 React state，避免 Map/Set 频繁拷贝） */
  const st = useRef<WindowState>(createWindowState())

  /** 当前章节的 AbortController，切章/卸载时统一 abort */
  const abortRef = useRef<AbortController | null>(null)
  /** 防止已卸载后 setState */
  const aliveRef = useRef(true)
  /** 当前页快照，供 settle 时判定「是否仍在窗口内」 */
  const curRef = useRef(cur)
  curRef.current = cur
  /** pump 的间接引用，避免 dispatch 与 pump 循环依赖 */
  const pumpRef = useRef<(() => void) | null>(null)
  /** 派生视图版本，用于 useMemo 失效 */
  const [viewVer, setViewVer] = useState(0)

  const rerenderAll = useCallback(() => setViewVer((v) => v + 1), [])

  /**
   * 派发一页请求（S1）。
   *
   * ⚠️ 必须在发请求前同步把状态推到 loading 并注册 inflight，
   *    这样同一 tick 内再次进入本函数会被 `pagesToRequest` 过滤掉（去重）。
   */
  const dispatch = useCallback((index: number, url: string, timeoutMs?: number) => {
    const inf: InflightRequest = startRequest(st.current, index)
    const signal = abortRef.current?.signal

    // 先把「已派发」这个事实反映到 UI（loading），再发请求
    setViewVer((v) => v + 1)

    void getOnlinePageBlob(url, { signal, timeoutMs })
      .then((r) => {
        // 🔴 S2 → S3 必须在同一同步调用栈内连续执行，中间不得让出。
        //    settleRequest 内部完成 S2（按 reqId 删 inflight）与 S3（reconcile），
        //    此处不得插入 await / 用户回调 / 事件派发。
        settleRequest(st.current, index, inf, { ok: true, blob: r.blob })
        // S4：状态已 reconcile，才通知外部并继续调度
        if (aliveRef.current) setViewVer((v) => v + 1)
        pumpRef.current?.()
      })
      .catch((e: unknown) => {
        // abort 属正常流程（切章/卸载/窗口移动），不记为失败
        const aborted = isAbortError(e)
        settleRequest(st.current, index, inf, { ok: false, error: e })
        // AbortError 不把页面标成 failed —— 回到 idle 等重新调度
        if (aborted) {
          const rec = st.current.records.get(index)
          if (rec && rec.status === 'failed') {
            rec.status = 'idle'
            rec.error = undefined
          }
        }
        if (aliveRef.current) setViewVer((v) => v + 1)
        pumpRef.current?.()
      })
  }, [])

  /**
   * S4 调度：把窗口内应当请求的页按优先级派发出去。
   *
   * 并发不在这里限制 —— 交给 `imageScheduler`（正文优先级）。
   */
  const pump = useCallback(() => {
    if (!enabled || !pages || pages.total === 0) return

    const todo = pagesToRequest(st.current, curRef.current, pages.total, win)
    if (todo.length === 0) return

    for (const i of todo) {
      const ref = pages.pages.find((p) => p.index === i)
      if (!ref) continue
      dispatch(i, ref.url)
    }
  }, [enabled, pages, win, dispatch])

  pumpRef.current = pump

  /* ── 切章：清空一切并换新的 AbortController ── */
  useEffect(() => {
    aliveRef.current = true
    resetForChapter(st.current)

    abortRef.current?.abort()
    abortRef.current = new AbortController()

    rerenderAll()
    // 新章节的窗口需求由下面的窗口 effect 触发

    return () => {
      aliveRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
      resetForChapter(st.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterKey])

  /* ── 窗口变化：更新 inWindow / stale / 淘汰，然后调度 ── */
  useEffect(() => {
    if (!enabled || !pages || pages.total === 0) return

    applyWindow(st.current, cur, pages.total, win)
    rerenderAll()
    pump()
  }, [enabled, pages, cur, win, pump, rerenderAll])

  /* ── 派生视图（对外结构与旧版一致）── */
  const blobs = useMemo(() => deriveBlobs(st.current), [viewVer]) // eslint-disable-line react-hooks/exhaustive-deps
  const pending = useMemo(() => derivePending(st.current), [viewVer]) // eslint-disable-line react-hooks/exhaustive-deps
  const failed = useMemo(() => deriveFailed(st.current), [viewVer]) // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useCallback((index: number) => {
    if (!pages) return
    const ref = pages.pages.find((p) => p.index === index)
    if (!ref) return

    // T13/T14：retry 不绕过调度器，只是产生一个新 epoch 的需求
    markRetry(st.current, index)
    setViewVer((v) => v + 1)
    dispatch(index, ref.url, 20000)
  }, [pages, dispatch])

  /**
   * 只记录失败，不发起任何请求。
   *
   * 用途：`<img src={ObjectURL}>` 的 onError。
   * 走到 onError 说明「Blob 已经拿到了，但渲染失败」（解码失败 / URL 被回收）。
   * 此时绝不能自动重新下载 —— 重下多半还是同一份坏数据，只会变成请求风暴。
   */
  const markFailed = useCallback((index: number) => {
    markPageFailed(st.current, index)
    if (aliveRef.current) setViewVer((v) => v + 1)
  }, [])

  return { blobs, pending, failed, retry, markFailed }
}
