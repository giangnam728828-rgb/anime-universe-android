/**
 * 发现页数据源 Hook（总方案·阶段3·第6步）
 *
 * 目标：把发现页从「等全部来源结算才渲染」改成「先到先渲染」，同时让发现页
 * 遵守来源开关与来源健康记忆，并给发现页专用底层请求策略。
 *
 * 边界（用户裁定）：
 *  - 只做**逻辑取消**（会话闸）。不中止底层 HTTP——真正取消属于 总方案·阶段3·第7步。
 *  - 不修改 aggregate.ts / entry.ts / compare.ts / homeStore.ts / health.ts / http.ts。
 *  - 健康记忆在分类模式**只读检查**，不写入记录（避免分类维度偶发失败波及首页）。
 *
 * 结果处理语义（对照旧 DiscoveryPage，必须保留）：
 *  - 旧代码渲染时两种模式都执行过 `dedup(data.items)`。
 *  - 全部模式：searchAll 返回的已是 `finish()` 结果（normalizeCover + dedup），
 *    再 dedup 一次是幂等操作 → 与旧行为等价。
 *  - 分类模式：旧代码是 `dedup(anilist.search().items)`，**没有** normalizeCover。
 *    因此这里分类模式只调 `dedup`，绝不额外加 normalizeCover。
 *
 * ── 方案丙 v3（用户 2026-11-07 批准）────────────────────────────────
 *  1. progress 与正式快照彻底分离：onUpdate 只写 progress，绝不碰 snapshot。
 *  2. `.then` 是唯一正式提交点；`onUpdate` / `.catch` 一律不调 shouldCommit。
 *  3. complete（请求是否结束）与 shouldCommit（是否替换快照）**解耦**：
 *     不提交也必须结束 loading，否则会永远停在 loading。
 *  4. 快照**只允许非空提交**；空结果不创建、不替换、不清除旧快照。
 *     代价（已接受）：真实成功空不会清除旧结果。
 *  5. 归属由 `requestId` + `key` 共同判定：同 key 不代表同一次请求。
 *  6. 不传 onSettle / signal / requestTimeoutMs —— 保持 isSearchPath === false，
 *     不改变首页健康记忆路径。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  SOURCES,
  dedup,
  getSource,
  isEnabled,
  searchAll,
  type Kind,
  type WorkItem,
} from '../../services/sources'
import { isHomeSkipped } from '../../services/sources/health'

/** 发现页专用底层请求策略：单次 8s、不重试（对齐管道层 8000ms，避免 20.6s 长占槽） */
export const DISCOVER_POLICY = { timeoutMs: 8000, retries: 0 } as const

export type DiscoverBlockedReason =
  | 'no-sources'
  | 'anilist-disabled'
  | 'anilist-unhealthy'
  | 'all-unhealthy'

export interface DiscoverBlocked {
  reason: DiscoverBlockedReason
  title: string
  message: string
}

/**
 * 发现页结果区视图状态（纯函数判定，便于单测）
 *
 * ⚠️ 与旧版差异（方案丙 v3）：
 *  - 删除 `all-failed`：`expected` 在请求期间会漂移（isHomeSkipped 逐源副作用读），
 *    `failed >= expected` 无法可靠成立，故不再宣称「全部失败」。
 *  - 删除 `empty`：零参与来源与真实成功空的返回值完全相同
 *    （均为 `{items:[], failed:[]}`），无法证明「查询成功且无内容」，
 *    改用中性的 `unconfirmed`。
 */
export type DiscoverView =
  | 'blocked'
  | 'loading'
  | 'error'
  | 'no-result'
  | 'unconfirmed'
  | 'grid'

/** 已提交快照：唯一权威数据源。方案丙下**永不为空** */
export interface Snapshot {
  /** 请求条件 kind|genreEn|sort */
  key: string
  /** 请求代次（复用 seqRef） */
  requestId: number
  items: WorkItem[]
}

/**
 * 渐进缓冲（**不是**权威数据）。必须携带请求归属，否则跨请求会串数据。
 *
 * 🔴 为什么需要 `attempt`：真实 React 中「setState 触发 render」早于「effect 执行」。
 *    切 key 时 `key` 已变，可识别；但**同键重试**时只有 `tick` 变了，
 *    `seqRef.current` 尚未递增 ⇒ 仅靠 requestId 无法识别，必须再加 attempt。
 */
export interface ProgressState {
  key: string
  requestId: number
  /** 请求尝试序号（= tick），用于 effect 执行前的 render 识别旧 progress */
  attempt: number
  items: WorkItem[]
}

/** 数据归属：由 requestId + key 共同判定，不能只看 key */
export type DataOrigin =
  | { kind: 'none' }
  | { kind: 'current' }
  | { kind: 'stale'; sameKey: boolean; fromKey: string }

export type StatusKind =
  | 'none'
  | 'partial-failure'
  | 'pipeline-error'
  | 'retry-error'
  | 'retry-failed'
  | 'retrying'
  | 'stale'
  | 'stale-error'
  | 'stale-failed'
  | 'no-new-result'

export interface StatusBar {
  kind: StatusKind
  text: string
}

/**
 * 纯决策：是否需要前置阻断（阻断即**不发请求**）。
 * 顺序：分类模式看 AniList；全部模式看「是否一个都没启用」→「是否全部在冷却」。
 */
export function decideBlocked(
  genreEn: string | null,
  isEnabledFn: (id: string) => boolean,
  isSkippedFn: (id: string) => boolean,
  allSourceIds: readonly string[],
): DiscoverBlocked | null {
  if (genreEn) {
    if (!isEnabledFn('anilist')) {
      return {
        reason: 'anilist-disabled',
        title: '分类浏览不可用',
        message: '该分类浏览需要启用 AniList 来源',
      }
    }
    if (isSkippedFn('anilist')) {
      return {
        reason: 'anilist-unhealthy',
        title: '分类浏览不可用',
        message: 'AniList 暂时不可用，请稍后重试',
      }
    }
    return null
  }

  const enabled = allSourceIds.filter((id) => isEnabledFn(id))
  if (enabled.length === 0) {
    return { reason: 'no-sources', title: '没有启用的来源', message: '请先启用至少一个来源' }
  }
  if (enabled.every((id) => isSkippedFn(id))) {
    return {
      reason: 'all-unhealthy',
      title: '来源暂不可用',
      message: '已启用的来源暂时都不可用，请稍后重试',
    }
  }
  return null
}

/** 请求键：用于判断旧快照是否属于同一组查询条件 */
export function makeRequestKey(kind: string, genreEn: string | null, sort: string): string {
  return `${kind}|${genreEn ?? ''}|${sort}`
}

/** 数据归属判定：requestId 必须与 key 同时匹配才算 current */
export function evalOrigin(
  snapshot: Snapshot | null,
  currentRequestId: number,
  currentKey: string,
): DataOrigin {
  if (!snapshot) return { kind: 'none' }
  if (snapshot.requestId === currentRequestId && snapshot.key === currentKey) {
    return { kind: 'current' }
  }
  return { kind: 'stale', sameKey: snapshot.key === currentKey, fromKey: snapshot.key }
}

/**
 * 策略 C：有快照 → 请求期间始终展示快照（防 20→3 缩水）；
 *         无快照 → **仅当 progress 属于当前请求**时展示，否则展示空。
 *
 * 🔴 progress 必须校验归属（key + requestId + attempt），否则切条件/重试时
 *    会短暂把上一个请求的渐进数据当作当前请求的 `current` 展示。
 *
 * @returns progressMismatch 存在「不属于当前请求」的 progress 遗留（用于强制 loading）
 */
export function resolveItems(
  snapshot: Snapshot | null,
  progress: ProgressState | null,
  currentRequestId: number,
  currentKey: string,
  currentAttempt: number,
): { items: WorkItem[]; origin: DataOrigin; progressMismatch: boolean } {
  if (snapshot) {
    return {
      items: snapshot.items,
      origin: evalOrigin(snapshot, currentRequestId, currentKey),
      progressMismatch: false,
    }
  }
  if (
    progress &&
    progress.requestId === currentRequestId &&
    progress.key === currentKey &&
    progress.attempt === currentAttempt
  ) {
    return { items: progress.items, origin: { kind: 'current' }, progressMismatch: false }
  }
  // 无快照且没有「属于当前请求」的 progress：不得展示、不得标记 current
  return { items: [], origin: { kind: 'none' }, progressMismatch: progress !== null }
}

/**
 * 是否允许提交快照。
 *
 * 🔴 **只允许在最终 Promise resolve 路径调用**（方式一）。
 *    `onUpdate`（progress）与 `.catch` 一律不得调用本函数。
 *    因此这里**不需要**再加 complete 判断。
 *
 * 规则（方案丙）：
 *  - 取消 / 管道异常 → 不提交
 *  - 有非空结果 → 提交
 *  - 无结果（含成功空、零参与）→ 不提交（二者返回值不可区分）
 */
export function shouldCommit(p: {
  cancelled: boolean
  pipelineError: string | null
  failed: number
  itemCount: number
}): boolean {
  if (p.cancelled) return false
  if (p.pipelineError) return false
  return p.itemCount > 0
}

/** 纯决策：结果区该显示哪种视图（顺序即优先级） */
export function pickViewState(p: {
  blocked: DiscoverBlocked | null
  loading: boolean
  /** 请求是否已结束 —— 与是否提交快照**解耦** */
  complete: boolean
  error: string | null
  origin: DataOrigin
  failedCount: number
  itemCount: number
}): DiscoverView {
  if (p.blocked) return 'blocked'
  // 有可展示数据（本次或旧快照）→ 直接展示，不回到骨架屏
  if (p.origin.kind !== 'none' && p.itemCount > 0) return 'grid'
  // 请求未结束 → 绝不下结论（用 complete，不用 shouldCommit）
  if (!p.complete || p.loading) return 'loading'
  if (p.error) return 'error'
  if (p.failedCount > 0) return 'no-result'
  return 'unconfirmed'
}

/** 纯决策：状态条（区分「来源级部分失败」与「管道级异常」） */
export function deriveStatusBar(p: {
  origin: DataOrigin
  loading: boolean
  error: string | null
  failedCount: number
}): StatusBar {
  const o = p.origin
  if (o.kind === 'none') return { kind: 'none', text: '' }

  if (o.kind === 'current') {
    if (p.error) return { kind: 'pipeline-error', text: '加载异常，以下结果可能不完整' }
    if (p.failedCount > 0) {
      return { kind: 'partial-failure', text: `${p.failedCount} 个来源失败，已显示其余结果` }
    }
    return { kind: 'none', text: '' }
  }

  // stale：旧快照
  if (p.error) {
    return o.sameKey
      ? { kind: 'retry-error', text: '重新加载异常，显示的是上次结果' }
      : { kind: 'stale-error', text: '加载异常，显示的是上次结果' }
  }
  if (!p.loading && p.failedCount > 0) {
    return o.sameKey
      ? { kind: 'retry-failed', text: '本次未获得新结果，显示的是上次结果' }
      : { kind: 'stale-failed', text: '当前条件未能加载结果，显示的是上次结果' }
  }
  if (!p.loading) return { kind: 'no-new-result', text: '本次未获得可展示结果' }
  return o.sameKey
    ? { kind: 'retrying', text: '正在重新加载…' }
    : { kind: 'stale', text: '显示的是上次条件的结果' }
}

export interface DiscoverFeed {
  /** 当前可展示条目（有快照=快照；无快照=progress） */
  items: WorkItem[]
  loading: boolean
  /** 抛出型错误（非来源级失败） */
  error: string | null
  /** 来源级失败的中文名列表 */
  failed: string[]
  /** 前置阻断（不发请求） */
  blocked: DiscoverBlocked | null
  /** 已判定的视图状态 */
  view: DiscoverView
  /** 已判定的状态条 */
  status: StatusBar
  retry: () => void
}

export function useDiscoverFeed(
  type: Kind,
  genreEn: string | null,
  sort: string,
): DiscoverFeed {
  /** 已提交快照（唯一权威数据源；永不为空） */
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  /** 本次请求的渐进缓冲（带归属；**不是**权威数据） */
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [loading, setLoading] = useState(true)
  /** 请求是否已结束 —— 与 shouldCommit 解耦 */
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState<string[]>([])
  const [blocked, setBlocked] = useState<DiscoverBlocked | null>(null)
  const seqRef = useRef(0)
  const [tick, setTick] = useState(0)

  const requestKey = makeRequestKey(type, genreEn, sort)

  /** 请求身份 = 查询键 + 尝试序号（切条件改 key、点重试改 tick） */
  const requestSig = `${requestKey}#${tick}`
  const sigRef = useRef(requestSig)

  /**
   * 🔴 在 **提交期**（useLayoutEffect）让在途请求失效。
   *
   * 为什么需要：真实时序是「setState → render → commit → passive effect」，
   * 而主 effect 里的 `seqRef.current++` 要到最后一刻才发生。若不提前失效，
   * 旧请求的 then / catch / onUpdate 会在「新 render 之后、新 effect 之前」
   * 通过 `alive()`，把 snapshot / failed / error / loading / complete
   * 写进新条件的视图（会显示旧条件的条目、旧条件的失败来源甚至旧条件的错误）。
   *
   * 为什么必须选提交期而不是 render 期：
   *  - render 期会被**放弃**（并发渲染中中断 / 优先级变化 / StrictMode 丢弃）。
   *    一次没有提交的 render 若已递增 seqRef，就会把仍然有效的当前请求
   *    永久判死 ⇒ 结果丢失、永久 loading、或被吞掉错误。
   *  - layout effect 只在**真正提交**后同步执行，且早于任何 passive effect
   *    与后续微任务，因此既不会误杀、也不会漏挡「commit → passive」这段间隙。
   */
  useLayoutEffect(() => {
    if (sigRef.current !== requestSig) {
      sigRef.current = requestSig
      seqRef.current++
    }
  }, [requestSig])

  useEffect(() => {
    const my = ++seqRef.current
    /** 会话闸：切类型/分类/排序、点重试、组件卸载都会让它失效 */
    const alive = () => seqRef.current === my
    const cleanup = () => {
      if (seqRef.current === my) seqRef.current++
    }

    // 只重置「本次请求」的临时状态；**快照绝不清空**
    setProgress(null)
    setError(null)
    setFailed([])
    setBlocked(null)
    setLoading(true)
    setComplete(false)

    // 前置阻断判定（不发请求）
    const gate = decideBlocked(
      genreEn,
      isEnabled,
      isHomeSkipped,
      SOURCES.map((s) => s.id),
    )
    if (gate) {
      setBlocked(gate)
      setLoading(false)
      setComplete(true)
      return cleanup
    }

    // ---------------- 分类模式：单源（AniList） ----------------
    if (genreEn) {
      getSource('anilist')
        .search({ kind: type, genre: genreEn, sort, reqPolicy: DISCOVER_POLICY })
        .then((r) => {
          if (!alive()) return
          // ★ 保留旧分类模式语义：只 dedup，不加 normalizeCover
          const items = dedup(r.items)
          // 唯一提交点
          if (shouldCommit({ cancelled: false, pipelineError: null, failed: 0, itemCount: items.length })) {
            setSnapshot({ key: requestKey, requestId: my, items })
          }
          setFailed([])
          setLoading(false)
          setComplete(true)
        })
        .catch((e) => {
          if (!alive()) return
          setError(String((e as Error)?.message ?? e))
          setLoading(false)
          setComplete(true)
        })
      return cleanup
    }

    // ---------------- 全部模式：多源渐进 ----------------
    searchAll(
      { kind: type, sort },
      (partial) => {
        if (!alive()) return
        // ★ 只写 progress 缓冲（带归属），绝不触碰 snapshot（策略 C）
        setProgress({ key: requestKey, requestId: my, attempt: tick, items: partial })
      },
      {
        respectEnabled: true,
        skipUnhealthy: true,
        sourceReqPolicy: { jikan: DISCOVER_POLICY },
      },
    )
      .then((res) => {
        if (!alive()) return
        // 唯一提交点
        if (
          shouldCommit({
            cancelled: false,
            pipelineError: null,
            failed: res.failed.length,
            itemCount: res.items.length,
          })
        ) {
          setSnapshot({ key: requestKey, requestId: my, items: res.items })
        }
        setFailed(res.failed)
        setLoading(false)
        setComplete(true)
      })
      .catch((e) => {
        if (!alive()) return
        // ★ 管道异常：丢弃本次渐进缓冲，绝不用中间结果冒充结果（验收项 A8）
        setProgress(null)
        setError(String((e as Error)?.message ?? e))
        setLoading(false)
        setComplete(true)
      })

    return cleanup
  }, [type, genreEn, sort, tick, requestKey])

  const retry = useCallback(() => setTick((t) => t + 1), [])

  const resolved = resolveItems(snapshot, progress, seqRef.current, requestKey, tick)
  // 存在「不属于当前请求」的 progress 遗留 ⇒ 当前请求尚未产出，按加载中处理
  // （避免闪出一帧「本次未获得可展示结果」的错误结论）
  const loadingForView = loading || resolved.progressMismatch
  const status = deriveStatusBar({
    origin: resolved.origin,
    loading: loadingForView,
    error,
    failedCount: failed.length,
  })
  const view = pickViewState({
    blocked,
    loading: loadingForView,
    complete,
    error,
    origin: resolved.origin,
    failedCount: failed.length,
    itemCount: resolved.items.length,
  })

  return { items: resolved.items, loading, error, failed, blocked, view, status, retry }
}
