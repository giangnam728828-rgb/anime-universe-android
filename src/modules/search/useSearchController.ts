/**
 * 搜索控制器（阶段 3 · 第 3 步）
 *
 * 职责：
 *  - 会话控制：seq + AbortController + commit 三道闸
 *  - 逻辑取消：只丢弃结果，**不停止底层 HTTP**（适配器无 signal 通道）
 *  - 每源 6000ms 超时（搜索路径）
 *  - 作品 / 资讯双 seq 独立
 *  - debounce 去重（Enter/按钮/来源切换先清除待执行定时器）
 *  - 来源开关同步（读 au_source_settings）
 *  - 空关键词处理
 *  - 每批次全量聚合：dedupWithinSource → aggregate → uiKey 分配
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  searchAllStream,
  SOURCES,
  isSourceEnabled,
  setSourceEnabled,
  type WorkItem,
  type Kind,
  type SettleReason,
  type PipelineErrorReporter,
} from '../../services/sources'
import type { KeyedGroup } from './uiKeyMap'
import { fetchNews, type NewsItem } from '../../services/news'
import {
  subscribe,
  getSnapshot,
  currentWorkSeq,
  currentNewsSeq,
  beginWorkSession,
  beginNewsSession,
  finishNewsSuccess,
  finishNewsFailure,
  invalidateAllSessions,
  clearEmptySearch,
  commitWorkBatch,
  patchSnapshot,
} from './searchStore'

export type Scope = 'all' | 'anime' | 'manga' | 'news'

const DEBOUNCE_MS = 300
const SEARCH_TIMEOUT_MS = 6000

/**
 * 会话级结算守卫（导出以便单元测试；与 React 无关）。
 *
 * 关键设计：
 *  - 集合由每次 runNow 通过工厂**新建**，旧会话的回调持有旧集合，无法污染新会话。
 *  - ★ 先判存活、再判幂等：过期回调绝不会写入任何集合。
 *  - 返回 true 表示本次调用应当提交进度。
 */
export function createSessionGuard(isAlive: () => boolean) {
  const settled = new Set<string>()
  return {
    trySettle(sourceId: string): boolean {
      if (!isAlive()) return false // ★ 先判存活
      if (settled.has(sourceId)) return false // ★ 再判幂等
      settled.add(sourceId)
      return true
    },
    size(): number {
      return settled.size
    },
  }
}

/**
 * 切换搜索范围的纯决策逻辑（导出以便单元测试；与 React 无关）。
 *
 * 规则（阶段3第4步，与 toggleSource 同构）：
 *  - 重复点击当前范围 → no-op，不发请求
 *  - 真正切换 + 有关键词 → 清防抖后立即按新范围重搜（runNow 内部负责逻辑取消旧会话）
 *  - 真正切换 + 无关键词 → 只更新界面状态，不发请求
 *
 * 通过依赖注入（setScopeState/clearDebounce/runNow）便于测试，调用顺序固定为
 * 「先置状态 → 清防抖 → 视关键词决定是否重搜」。
 */
export function applyScopeChange(args: {
  prev: Scope
  next: Scope
  keyword: string
  setScopeState: (s: Scope) => void
  clearDebounce: () => void
  runNow: (kw: string, sc: Scope) => void
}): void {
  const { prev, next, keyword, setScopeState, clearDebounce, runNow } = args
  if (next === prev) return // 重复点击当前范围：no-op
  setScopeState(next)
  clearDebounce()
  if (keyword.trim()) runNow(keyword, next)
  // 无关键词：只更新界面，不发空请求
}

function readEnabledMap(): Record<string, boolean> {
  const m: Record<string, boolean> = {}
  for (const s of SOURCES) m[s.id] = isSourceEnabled(s.id)
  return m
}

export interface SearchController {
  // 输入与范围
  q: string
  setQ: (v: string) => void
  scope: Scope
  setScope: (s: Scope) => void
  searched: string
  // 作品结果
  workGroups: KeyedGroup[]
  workLoading: boolean
  workDone: number
  workTotal: number
  workFailed: Record<string, string>
  // 资讯结果
  newsResults: NewsItem[]
  newsLoading: boolean
  newsError?: string
  // 通用
  pipelineError?: string
  clearPipelineError: () => void
  // 来源开关
  enabledMap: Record<string, boolean>
  toggleSource: (id: string) => void
  // 操作
  runNow: (kw?: string, sc?: Scope) => void
  // ★ 阶段3第7步：中断会话提示与「重新搜索」
  /** 上次搜索未完成（页面离开导致中断），当前显示的是部分结果 */
  isIncomplete: boolean
  /** 按当前关键词 + 当前范围 + 最新来源开关重新发起搜索（不承诺断点续跑） */
  onResearch: () => void
}

export function useSearchController(): SearchController {
  // ★ 阶段3第7步：除 q 的输入框草稿与来源开关外，全部可见状态来自模块级快照
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const q = snap.q
  const scope = snap.scope
  const searched = snap.searched
  const workGroups = snap.workGroups as KeyedGroup[]
  const workLoading = snap.workLoading
  const workDone = snap.workDone
  const workTotal = snap.workTotal
  const workFailed = snap.workFailed as Record<string, string>
  const newsResults = snap.newsResults as NewsItem[]
  const newsLoading = snap.newsLoading
  const newsError = snap.newsError
  const pipelineError = snap.pipelineError

  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(readEnabledMap)

  const ctrlRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearDebounce = useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [])

  /**
   * 开始新搜索会话：作废上一会话（逻辑取消，不停止底层 HTTP）。
   * store 侧一次性完成：推进序号 → 重置作品运行时 → 清 pipelineError → emit。
   */
  const startSession = useCallback(() => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    const mySeq = beginWorkSession({ loading: true })
    return { mySeq, ctrl }
  }, [])

  const runNow = useCallback(
    (kwArg?: string, scArg?: Scope) => {
      const kw = (kwArg ?? q).trim()
      const sc = scArg ?? scope
      clearDebounce()

      if (!kw) {
        // 空关键词：作废双会话 + 清空作品运行时；资讯结果保留（store 内一次 emit）
        ctrlRef.current?.abort()
        ctrlRef.current = null
        clearEmptySearch()
        return
      }

      const { mySeq, ctrl } = startSession()
      patchSnapshot({ searched: kw, q: kw })

      // 每次真正执行搜索前重读来源设置（跨页面同步方案 i）
      const freshEnabled = readEnabledMap()
      setEnabledMap(freshEnabled)
      const enabledSources = SOURCES.filter((s) => freshEnabled[s.id])

      const isAlive = () => mySeq === currentWorkSeq() && !ctrl.signal.aborted
      const commit = (fn: () => void) => {
        if (isAlive()) fn()
      }

      // 会话级结算守卫（闭包隔离，旧会话无法污染新会话）
      const guard = createSessionGuard(isAlive)

      const handleSettle = (sourceId: string, reason: SettleReason) => {
        // 来源层在逻辑取消时根本不调用 onSettle，因此 reason 不会为 cancelled
        if (!guard.trySettle(sourceId)) return
        commit(() => {
          const cur = getSnapshot()
          patchSnapshot({
            workDone: Math.min(cur.workDone + 1, cur.workTotal),
            workFailed: reason === 'ok' ? cur.workFailed : { ...cur.workFailed, [sourceId]: reason },
          })
        })
      }

      const handlePipelineError: PipelineErrorReporter = (stage, sourceId, err) => {
        console.error(`[pipeline:${stage}] ${sourceId}`, err)
        commit(() =>
          patchSnapshot({
            pipelineError:
              stage === 'onBatch'
                ? `结果聚合异常（${sourceId}）：${(err as Error)?.message ?? '未知'}`
                : `进度回调异常（${sourceId}）`,
          }),
        )
      }

      const kinds: Kind[] = sc === 'all' ? ['anime', 'manga'] : sc === 'news' ? [] : [sc as Kind]

      // —— 作品搜索 ——
      if (kinds.length > 0) {
        const total = enabledSources.length * kinds.length
        patchSnapshot({ workTotal: total })

        /**
         * 批次提交：外层 isAlive（含 abort 判定）+ store 内层序号校验，双层守卫。
         * 实际的累积 / 去重 / 聚合 / uiKey 分配全部收敛到 store 的单一写入口。
         */
        const onBatch = (batch: WorkItem[]) => {
          if (!isAlive()) return
          const r = commitWorkBatch(mySeq, batch)
          if (!r.ok && r.reason === 'failed') {
            // store 已写入 pipelineError 并重建 mapper + 推进 epoch，此处不重复上报
          }
        }

        void Promise.allSettled(
          kinds.map((k) =>
            searchAllStream({ kw, kind: k, page: 1 }, (batch) => onBatch(batch), {
              respectEnabled: true,
              signal: ctrl.signal,
              requestTimeoutMs: SEARCH_TIMEOUT_MS,
              onSettle: handleSettle,
              onPipelineError: handlePipelineError,
            }),
          ),
        ).then(() => {
          commit(() => patchSnapshot({ workLoading: false }))
        })
      } else {
        patchSnapshot({ workTotal: 0, workLoading: false })
      }

      // —— 资讯搜索（独立 seq，不参与 abort；请求/解析/过滤逻辑不变） ——
      if (sc === 'all' || sc === 'news') {
        const myNewsSeq = beginNewsSession()
        fetchNews()
          .then((r) => {
            if (myNewsSeq !== currentNewsSeq()) return
            const k = kw.toLowerCase()
            const hits = r.items.filter((n) => n.title.toLowerCase().includes(k))
            // 阶段3第7步行为变更：成功时同时清除旧 newsError
            finishNewsSuccess(hits.slice(0, 10))
          })
          .catch(() => {
            if (myNewsSeq !== currentNewsSeq()) return
            finishNewsFailure('资讯加载失败')
          })
      }
    },
    [q, scope, clearDebounce, startSession],
  )

  const setQ = useCallback(
    (v: string) => {
      patchSnapshot({ q: v })
      clearDebounce()
      if (!v.trim()) {
        // 空关键词：立即走空处理路径（作废旧结果提交）
        runNow('')
        return
      }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        runNow(v)
      }, DEBOUNCE_MS)
    },
    [clearDebounce, runNow],
  )

  // ★ 阶段3第4步：切换搜索范围 = 改变搜索条件，行为与切换来源同构（有词立即重搜，无词只改界面）
  //   不涉及来源设置持久化；资讯请求/解析/过滤规则不变，切到 news 仅改变范围
  const setScope = useCallback(
    (s: Scope) =>
      applyScopeChange({
        prev: scope,
        next: s,
        keyword: q,
        setScopeState: (ns) => patchSnapshot({ scope: ns }),
        clearDebounce,
        runNow,
      }),
    [scope, q, runNow, clearDebounce],
  )

  const toggleSource = useCallback(
    (id: string) => {
      const next = !enabledMap[id]
      setSourceEnabled(id, next) // 落盘 au_source_settings v1
      setEnabledMap((prev) => ({ ...prev, [id]: next }))
      clearDebounce() // ★ 切换来源先清除待执行 debounce
      if (q.trim()) runNow(q)
      // 无关键词：只更新设置与界面，不发空请求
    },
    [enabledMap, q, runNow, clearDebounce],
  )

  // 页面重新可见时重读来源设置（跨页面同步方案 iii）
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) setEnabledMap(readEnabledMap())
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  /**
   * 卸载（阶段3第7步）：清除定时器、作废双会话、两个 loading 归 false。
   * ★ 保留结果 / 关键词 / 范围 / 错误，返回时直接恢复，不自动重发请求。
   * ★ 两个序号同时前进：恢复模式下不重发，若序号不前进，
   *   离开期间仍在执行的旧请求返回时会被误判为"当前会话"而污染恢复后的快照。
   */
  useEffect(() => {
    return () => {
      clearDebounce()
      ctrlRef.current?.abort()
      ctrlRef.current = null
      invalidateAllSessions()
    }
  }, [clearDebounce])

  /**
   * 未完成判定（阶段3第7步）：
   *  - workTotal === 0：没有可搜索的源，不显示（边界①）
   *  - workDone === workTotal 但 workFailed 非空：属"全部完成但有来源失败"，走既有来源错误提示（边界②）
   */
  const isIncomplete =
    workLoading === false &&
    workTotal > 0 &&
    workDone < workTotal &&
    searched.trim() !== ''

  /** 重新搜索：当前关键词 + 当前范围；runNow 内部会重读来源开关并新建双会话 */
  const onResearch = useCallback(() => {
    if (!searched.trim()) return
    runNow(searched, scope)
  }, [runNow, searched, scope])

  return {
    q,
    setQ,
    scope,
    setScope,
    searched,
    workGroups,
    workLoading,
    workDone,
    workTotal,
    workFailed,
    newsResults,
    newsLoading,
    newsError,
    pipelineError,
    clearPipelineError: () => patchSnapshot({ pipelineError: undefined }),
    enabledMap,
    toggleSource,
    runNow,
    isIncomplete,
    onResearch,
  }
}
