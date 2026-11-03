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
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { toSourceEntry, dedupWithinSource, aggregate, type SourceEntry } from '../../services/sources/aggregate'
import { createUiKeyMapper, type KeyedGroup } from './uiKeyMap'
import { fetchNews, type NewsItem } from '../../services/news'

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
}

export function useSearchController(): SearchController {
  const [q, setQState] = useState('')
  const [scope, setScopeState] = useState<Scope>('all')
  const [searched, setSearched] = useState('')

  const [workGroups, setWorkGroups] = useState<KeyedGroup[]>([])
  const [workLoading, setWorkLoading] = useState(false)
  const [workDone, setWorkDone] = useState(0)
  const [workTotal, setWorkTotal] = useState(0)
  const [workFailed, setWorkFailed] = useState<Record<string, string>>({})
  const workTotalRef = useRef(0)

  const [newsResults, setNewsResults] = useState<NewsItem[]>([])
  const [newsLoading, setNewsLoading] = useState(false)
  const [newsError, setNewsError] = useState<string>()

  const [pipelineError, setPipelineError] = useState<string>()
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(readEnabledMap)

  const workSeqRef = useRef(0)
  const newsSeqRef = useRef(0)
  const ctrlRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 会话级累积与身份映射（跨批次、跨渲染保持）
  const entriesRef = useRef<SourceEntry[]>([])
  const keyMapperRef = useRef(createUiKeyMapper())

  const clearDebounce = useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [])

  /** 开始新搜索会话：作废上一会话（逻辑取消，不停止底层 HTTP） */
  const startSession = useCallback(() => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    workSeqRef.current += 1
    entriesRef.current = []
    keyMapperRef.current.reset()
    setWorkGroups([])
    setWorkDone(0)
    setWorkFailed({})
    setWorkLoading(true)
    return { mySeq: workSeqRef.current, ctrl }
  }, [])

  const runNow = useCallback(
    (kwArg?: string, scArg?: Scope) => {
      const kw = (kwArg ?? q).trim()
      const sc = scArg ?? scope
      clearDebounce()

      if (!kw) {
        // 空关键词：作废会话 + 清空作品，资讯保留但终结 loading
        ctrlRef.current?.abort()
        workSeqRef.current += 1
        entriesRef.current = []
        keyMapperRef.current.reset()
        setWorkGroups([])
        setWorkDone(0)
        setWorkTotal(0)
        workTotalRef.current = 0
        setWorkFailed({})
        setWorkLoading(false)
        setSearched('')
        newsSeqRef.current += 1
        setNewsLoading(false)
        setNewsError(undefined)
        return
      }

      const { mySeq, ctrl } = startSession()
      setSearched(kw)

      // 每次真正执行搜索前重读来源设置（跨页面同步方案 i）
      const freshEnabled = readEnabledMap()
      setEnabledMap(freshEnabled)
      const enabledSources = SOURCES.filter((s) => freshEnabled[s.id])

      const isAlive = () => mySeq === workSeqRef.current && !ctrl.signal.aborted
      const commit = (fn: () => void) => {
        if (isAlive()) fn()
      }

      // 会话级结算守卫（闭包隔离，旧会话无法污染新会话）
      const guard = createSessionGuard(isAlive)

      const handleSettle = (sourceId: string, reason: SettleReason) => {
        // 来源层在逻辑取消时根本不调用 onSettle，因此 reason 不会为 cancelled
        if (!guard.trySettle(sourceId)) return
        commit(() => {
          setWorkDone((d) => Math.min(d + 1, workTotalRef.current))
          if (reason !== 'ok') setWorkFailed((p) => ({ ...p, [sourceId]: reason }))
        })
      }

      const handlePipelineError: PipelineErrorReporter = (stage, sourceId, err) => {
        console.error(`[pipeline:${stage}] ${sourceId}`, err)
        commit(() =>
          setPipelineError(
            stage === 'onBatch'
              ? `结果聚合异常（${sourceId}）：${(err as Error)?.message ?? '未知'}`
              : `进度回调异常（${sourceId}）`,
          ),
        )
      }

      const kinds: Kind[] = sc === 'all' ? ['anime', 'manga'] : sc === 'news' ? [] : [sc as Kind]

      // —— 作品搜索 ——
      if (kinds.length > 0) {
        const total = enabledSources.length * kinds.length
        setWorkTotal(total)
        workTotalRef.current = total

        const onBatch = (batch: WorkItem[]) => {
          if (!isAlive()) return
          for (const w of batch) {
            const e = toSourceEntry(w, undefined, () => {})
            if (e) entriesRef.current.push(e)
          }
          // 全量重算：同源去重 → 跨源聚合 → UI key
          const deduped = dedupWithinSource(entriesRef.current)
          const groups = aggregate(deduped.map((e) => e.item))
          const keyed = keyMapperRef.current.assign(groups)
          if (!isAlive()) return // 计算期间可能已过期
          commit(() => setWorkGroups(keyed))
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
          commit(() => setWorkLoading(false))
        })
      } else {
        setWorkTotal(0)
        workTotalRef.current = 0
        setWorkLoading(false)
      }

      // —— 资讯搜索（独立 seq，不参与 abort；请求/解析/过滤逻辑不变） ——
      if (sc === 'all' || sc === 'news') {
        const myNewsSeq = ++newsSeqRef.current
        setNewsLoading(true)
        fetchNews()
          .then((r) => {
            if (myNewsSeq !== newsSeqRef.current) return
            const k = kw.toLowerCase()
            const hits = r.items.filter((n) => n.title.toLowerCase().includes(k))
            setNewsResults(hits.slice(0, 10))
            setNewsLoading(false)
          })
          .catch(() => {
            if (myNewsSeq !== newsSeqRef.current) return
            setNewsError('资讯加载失败')
            setNewsLoading(false)
          })
      }
    },
    [q, scope, clearDebounce, startSession],
  )

  const setQ = useCallback(
    (v: string) => {
      setQState(v)
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
        setScopeState,
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

  // 卸载：清除定时器并作废会话
  useEffect(() => {
    return () => {
      clearDebounce()
      ctrlRef.current?.abort()
    }
  }, [clearDebounce])

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
    clearPipelineError: () => setPipelineError(undefined),
    enabledMap,
    toggleSource,
    runNow,
  }
}
