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
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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

/** 发现页结果区视图状态（纯函数判定，便于单测） */
export type DiscoverView = 'blocked' | 'loading' | 'error' | 'all-failed' | 'grid' | 'empty'

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

/** 纯决策：结果区该显示哪种视图（顺序即优先级） */
export function pickViewState(p: {
  blocked: DiscoverBlocked | null
  loading: boolean
  error: string | null
  failedCount: number
  itemCount: number
}): DiscoverView {
  if (p.blocked) return 'blocked'
  if (p.loading && p.itemCount === 0) return 'loading'
  if (p.error && p.itemCount === 0) return 'error'
  if (p.itemCount === 0 && p.failedCount > 0) return 'all-failed'
  if (p.itemCount > 0) return 'grid'
  return 'empty'
}

export interface DiscoverFeed {
  items: WorkItem[]
  loading: boolean
  /** 抛出型错误（非来源级失败） */
  error: string | null
  /** 来源级失败的中文名列表 */
  failed: string[]
  /** 前置阻断（不发请求） */
  blocked: DiscoverBlocked | null
  retry: () => void
}

export function useDiscoverFeed(
  type: Kind,
  genreEn: string | null,
  sort: string,
): DiscoverFeed {
  const [items, setItems] = useState<WorkItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState<string[]>([])
  const [blocked, setBlocked] = useState<DiscoverBlocked | null>(null)
  const seqRef = useRef(0)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const my = ++seqRef.current
    /** 会话闸：切类型/分类/排序、点重试、组件卸载都会让它失效 */
    const alive = () => seqRef.current === my
    const cleanup = () => {
      if (seqRef.current === my) seqRef.current++
    }

    setItems([])
    setError(null)
    setFailed([])
    setBlocked(null)
    setLoading(true)

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
      return cleanup
    }

    // ---------------- 分类模式：单源（AniList） ----------------
    if (genreEn) {
      getSource('anilist')
        .search({ kind: type, genre: genreEn, sort, reqPolicy: DISCOVER_POLICY })
        .then((r) => {
          if (!alive()) return
          setItems(dedup(r.items)) // ★ 保留旧分类模式语义：只 dedup，不加 normalizeCover
          setLoading(false)
        })
        .catch((e) => {
          if (!alive()) return
          setError(String((e as Error)?.message ?? e))
          setLoading(false)
        })
      return cleanup
    }

    // ---------------- 全部模式：多源渐进 ----------------
    searchAll(
      { kind: type, sort },
      (partial) => {
        if (!alive()) return
        setItems(partial) // 渐进：已有内容立即显示，loading 仍为 true
      },
      {
        respectEnabled: true,
        skipUnhealthy: true,
        sourceReqPolicy: { jikan: DISCOVER_POLICY },
      },
    )
      .then((res) => {
        if (!alive()) return
        setItems(res.items)
        setFailed(res.failed)
        setLoading(false)
      })
      .catch((e) => {
        if (!alive()) return
        setError(String((e as Error)?.message ?? e))
        setLoading(false)
      })

    return cleanup
  }, [type, genreEn, sort, tick])

  const retry = useCallback(() => setTick((t) => t + 1), [])

  return { items, loading, error, failed, blocked, retry }
}
