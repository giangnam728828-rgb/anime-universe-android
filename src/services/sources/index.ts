/** 内容来源注册表：每来源独立适配器，单源故障不影响其他来源 */
import type { WorkItem } from './types'
import { normalizeCover } from '../../utils/cover'
import { perf } from '../perf'
import { isHomeSkipped, recordHomeSuccess, recordHomeFailure } from './health'
import { SOURCE_ORDER, SOURCES, SOURCE_NAMES, getSource } from './registry'
import { isSourceEnabled } from './settings'

// 来源注册表已迁至 registry.ts（阶段 3 第 1 步）；此处转出保持既有 import 不变
export { SOURCE_ORDER, SOURCES, SOURCE_NAMES, getSource }
export { rank, UNKNOWN_RANK, enabledSources, isEnabled } from './registry'
export {
  isSourceEnabled,
  setSourceEnabled,
  setAllSourcesEnabled,
  getDisabledSources,
  resetSourceSettings,
} from './settings'

/** 多来源去重：同源按 sourceId:workId；跨源按 归一化标题+类型 合并（保留优先来源） */
export function dedup(items: WorkItem[]): WorkItem[] {
  const seenKey = new Set<string>()
  const seenTitle = new Set<string>()
  const sorted = [...items].sort((a, b) => (SOURCE_ORDER[a.sourceId] ?? 9) - (SOURCE_ORDER[b.sourceId] ?? 9))
  return sorted.filter((i) => {
    const k = `${i.sourceId}:${i.workId}`
    if (seenKey.has(k)) return false
    seenKey.add(k)
    const t = (i.title || '').toLowerCase().replace(/[\s:：·・'\-]+/g, '')
    const tk = `${i.kind}:${t}`
    if (t && seenTitle.has(tk)) return false
    seenTitle.add(tk)
    return true
  })
}

/** 单源超时：源卡住时快速放弃（Kazumi 式体验——快源先出，慢源不拖整页） */

// ---------------------------------------------------------------------------
// 阶段3第3步：失败原因类型 + 三方竞速（仅搜索路径使用；首页路径不受影响）
// ---------------------------------------------------------------------------

/** 仅在 withTimeout 的超时分支抛出（搜索路径） */
class SourceTimeoutError extends Error {
  readonly _tag = 'SOURCE_TIMEOUT'
  constructor(public readonly sourceId: string, public readonly ms: number) {
    super(`源超时 ${ms}ms: ${sourceId}`)
    this.name = 'SourceTimeoutError'
  }
}

/** 仅在 withTimeout 的取消分支抛出 */
class SourceCancelledError extends Error {
  readonly _tag = 'SOURCE_CANCELLED'
  constructor() {
    super('搜索会话已取消')
    this.name = 'SourceCancelledError'
  }
}

export type FailureReason = 'timeout' | 'cancelled' | 'source_error'

/**
 * ★ 只依据**错误类型**分类，不做 signal.aborted 检查。
 * 第一个终结事件已在 withTimeout 内部决定结果类型，此处不得二次干预，
 * 否则「来源先报错、随后用户取消」会被错误改写为 cancelled。
 */
function classifyFailure(e: unknown): FailureReason {
  if (e instanceof SourceCancelledError) return 'cancelled'
  if (e instanceof SourceTimeoutError) return 'timeout'
  return 'source_error'
}

/**
 * 三方竞速：来源 Promise / 超时定时器 / 逻辑取消信号。
 * ★ 第一个终结事件决定结果（settled 守卫），终结后清理定时器与监听器。
 * ★ 底层网络请求无法被此信号停止（适配器 SearchOptions 无 signal），
 *   取消只丢弃结果，**不代表 HTTP 请求已终止**。
 * ★ onTimeout 省略时保留原有 '源超时' 错误消息（首页路径）。
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout?: () => Error,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onAbort = () => settle(() => reject(new SourceCancelledError()))

    // ★ 先安装处理器：即使下面立刻走"预先取消"分支，也不产生未处理的 rejection
    p.then(
      (v) => settle(() => resolve(v)),
      (e) => settle(() => reject(e)), // 原样透传，绝不包装
    )

    if (signal?.aborted) {
      // 预先已取消：立即终结；p 的处理器已就位，其后续 settle 被 settled 拦截
      settled = true
      reject(new SourceCancelledError())
      return
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    timer = setTimeout(
      () => settle(() => reject(onTimeout ? onTimeout() : new Error('源超时'))),
      ms,
    )
  })
}

/** 错误分类（P0：失败原因可观测，不笼统报"失败"） */
export function classifyError(e: unknown): 'timeout' | 'network_error' | 'http_error' | 'parse_error' | 'unavailable' {
  const msg = ((e as Error)?.message || String(e) || '').toLowerCase()
  if (msg.includes('源超时') || msg.includes('timeout') || msg.includes('abort')) return 'timeout'
  if (msg.includes('http 4') || msg.includes('http 5') || msg.includes('403') || msg.includes('429')) return 'http_error'
  if (msg.includes('json') || msg.includes('parse') || msg.includes('unexpected')) return 'parse_error'
  if (msg.includes('network') || msg.includes('ssl') || msg.includes('unreachable') || msg.includes('failed to fetch')) return 'network_error'
  return 'unavailable'
}

/** 统一出口规范化：封面 https 升级 + 去重（流式/聚合共用） */
function finish(items: WorkItem[]): WorkItem[] {
  return dedup(items.map((i) => (i.cover ? { ...i, cover: normalizeCover(i.cover) } : i)))
}

/**
 * 流式多来源聚合（P0 新增）：每源独立 8s 超时，**某源完成即回调 onBatch**，
 * 首页快源（AniList/B站 1~2s）先渲染，慢源（MangaDex）后到渐进补入，互不阻塞。
 * 返回各源失败原因（sourceId → 分类）。
 */
export type SettleReason = 'ok' | 'timeout' | 'source_error'
export type PipelineStage = 'onBatch' | 'settle-callback'
export type PipelineErrorReporter = (stage: PipelineStage, sourceId: string, error: unknown) => void

export interface StreamOptions {
  skipUnhealthy?: boolean
  /** 是否按用户开关过滤来源（首页路径传 true）；false/省略 = 不过滤（保持旧行为） */
  respectEnabled?: boolean
  /**
   * ★ 逻辑取消信号（搜索路径）。
   * 只让结果被丢弃并作废结算，**不会停止底层 fetch**——适配器 SearchOptions 无 signal 字段。
   */
  signal?: AbortSignal
  /** ★ 每源超时（毫秒）。省略 = 8000（首页行为完全不变） */
  requestTimeoutMs?: number
  /** ★ 每源结算回调（搜索路径）。同一 sourceId 至多调用一次 */
  onSettle?: (sourceId: string, reason: SettleReason) => void
  /** ★ 管线错误通道：聚合/结算回调异常，**不计入来源失败** */
  onPipelineError?: PipelineErrorReporter
}

/**
 * ★ 安全调用管线错误报告器：报告器自身异常在此完全吞掉，
 * 绝不进入来源错误处理路径、不污染 failed、不影响其他来源。
 */
function reportPipelineErrorSafely(
  reporter: PipelineErrorReporter | undefined,
  stage: PipelineStage,
  sourceId: string,
  error: unknown,
): void {
  if (!reporter) return
  try {
    reporter(stage, sourceId, error)
  } catch {
    // 诊断通道故障不得影响来源结算与统计，此处刻意不做任何再抛出或次级上报
  }
}

export async function searchAllStream(
  opts: { kw?: string; kind: WorkItem['kind']; genre?: string; sort?: string; page?: number },
  onBatch: (batch: WorkItem[], sourceId: string) => void,
  streamOpts?: StreamOptions,
): Promise<{ failed: Record<string, string> }> {
  const failed: Record<string, string> = {}
  // 开关过滤：被禁用的来源**完全不发起请求**（不进入 Promise.allSettled 的 map）
  const list = streamOpts?.respectEnabled ? SOURCES.filter((s) => isSourceEnabled(s.id)) : SOURCES

  // ★ 搜索路径判定：任一新增参数出现即走新逻辑；首页（三者皆无）走原逻辑，行为一字不改
  const isSearchPath =
    streamOpts?.signal !== undefined ||
    streamOpts?.requestTimeoutMs !== undefined ||
    streamOpts?.onSettle !== undefined

  const timeoutMs = streamOpts?.requestTimeoutMs ?? 8000

  await Promise.allSettled(
    list.map(async (s) => {
      // ★ 逻辑取消：尚未启动的来源不再发起请求（已运行的网络请求无法停止）
      if (streamOpts?.signal?.aborted) return

      // O1 健康记忆：仅首页路径（skipUnhealthy）生效——冷却中的来源直接跳过，不拖累首屏
      if (streamOpts?.skipUnhealthy && isHomeSkipped(s.id)) {
        perf({ phase: 'source-skip', sourceId: s.id, status: 'cache-hit', detail: '健康记忆跳过' })
        return
      }

      // 结算幂等：同一来源至多结算一次
      let settled = false
      const settleOnce = (reason: SettleReason) => {
        if (settled) return
        settled = true // ★ 先置位：回调异常也不回滚、不重试
        try {
          streamOpts?.onSettle?.(s.id, reason)
        } catch (err) {
          reportPipelineErrorSafely(streamOpts?.onPipelineError, 'settle-callback', s.id, err)
        }
      }

      const t0 = Date.now() // 阶段2性能计时：每源独立（开始/结束/耗时/成败）
      try {
        const r = isSearchPath
          ? await withTimeout(s.search(opts), timeoutMs, () => new SourceTimeoutError(s.id, timeoutMs), streamOpts?.signal)
          : await withTimeout(s.search(opts), 8000)
        perf({ phase: 'source-request', sourceId: s.id, status: 'ok', ms: Date.now() - t0, detail: `${r.items.length}条` })
        if (streamOpts?.skipUnhealthy) recordHomeSuccess(s.id) // O1: 成功立即清零
        if (r.items.length) {
          try {
            onBatch(finish(r.items), s.id)
          } catch (pipelineErr) {
            // ★ 聚合/UI key 管线异常：不计入来源失败，来源本身仍按成功结算
            reportPipelineErrorSafely(streamOpts?.onPipelineError, 'onBatch', s.id, pipelineErr)
          }
        }
        if (isSearchPath) settleOnce('ok')
      } catch (e) {
        if (!isSearchPath) {
          // ★ 首页路径：原分类与统计逻辑一字不改
          const kind = classifyError(e)
          perf({ phase: 'source-request', sourceId: s.id, status: 'fail', ms: Date.now() - t0, detail: kind })
          if (streamOpts?.skipUnhealthy) recordHomeFailure(s.id, kind)
          failed[s.id] = kind
          return
        }
        // ★ 搜索路径：首事件类型决定结果（取消不结算、不计失败）
        const reason = classifyFailure(e)
        if (reason === 'cancelled') return
        perf({ phase: 'source-request', sourceId: s.id, status: 'fail', ms: Date.now() - t0, detail: reason })
        failed[s.id] = reason
        settleOnce(reason)
      }
    }),
  )
  return { failed }
}

/** 多来源聚合搜索（一次性）：基于流式实现，兼容搜索页现有用法 */
export async function searchAll(opts: { kw?: string; kind: WorkItem['kind']; genre?: string; sort?: string; page?: number }): Promise<{ items: WorkItem[]; failed: string[] }> {
  const items: WorkItem[] = []
  const { failed } = await searchAllStream(opts, (batch) => items.push(...batch))
  return { items: finish(items), failed: Object.keys(failed).map((id) => SOURCE_NAMES[id] || id) }
}

export type { WorkItem, WorkDetail, SearchOptions, SearchResult, Kind } from './types'
