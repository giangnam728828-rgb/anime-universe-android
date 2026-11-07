/**
 * 多源播放候选聚合（阶段3·第2步·播放源适配层 · 批次①）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 职责
 * ══════════════════════════════════════════════════════════════════════
 * 把「多个播放源解析同一集」变成「一份排好序、带诊断的候选列表」。
 *
 * 本模块是**纯异步函数 + 注入依赖**，不碰任何全局状态，
 * 因此可以完整测试失败隔离、超时、并发预算与迟到结果。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 三条不可让步的语义
 * ══════════════════════════════════════════════════════════════════════
 *
 * 【1】逻辑超时 ≠ 底层结束（用户 Q2 裁定）
 *   `Promise.race()` 超时只让**调用方不再等待**，不会停止底层 HTTP 请求。
 *   因此：
 *     - 迟到结果必须**隔离**（不得写回聚合结果）
 *     - 超时**不归还**并发名额，名额只在底层 Promise 真正 settle 时 -1
 *   若底层请求长期不结束，名额会被长期占用，表现为「新解析变慢」——
 *   这是**正确行为**，诚实反映资源受限，不能用无限并发掩盖。
 *
 * 【2】并发预算按真实 Promise 生命周期管理（检查点 B）
 *   同一个底层 Promise 只能归还一次名额；同步抛错 / resolve / reject
 *   都必须归还；超时后底层 settle 仍必须完成清理。
 *
 * 【3】部分成功即成功（检查点 C）
 *   只要有**一个**来源产出有效候选，聚合就成功。
 *   `ALL_SOURCES_FAILED` 只在**一个候选都没有**时返回，
 *   不能因为某几个源失败就丢弃成功候选。
 *
 * ══════════════════════════════════════════════════════════════════════
 * candidateId 三条身份约束（C1–C3）
 * ══════════════════════════════════════════════════════════════════════
 *   C1  index 用**单源原始列表**的零基索引，不用聚合后全局索引
 *   C2  聚合不得重新生成或覆盖已有 candidateId
 *   C3  排序 / 去重只移动数组元素，绝不改 id 字段
 */
import type {
  PlaybackCandidate,
  PlaybackProtocol,
  PlaybackResolveErrorCode,
} from './types'
import type { PlaybackSourceResolver } from './PlaybackService'
import { playbackRank } from './registry'

/** 单源解析等待上限（用户 Q1 裁定：8000ms 统一常量，不做按源配置） */
export const RESOLVE_TIMEOUT_MS = 8000

/**
 * 解析阶段物理并发上限。
 *
 * 为什么需要它：超时只是「不再等待」，底层请求仍在跑。
 * 若无上限，反复解析会不断堆积后台请求。
 */
export const MAX_RESOLVE_CONCURRENT = 4

/** 单源失败明细（诊断用，**不得含完整 URL**） */
export interface ResolveFailure {
  sourceId: string
  code: PlaybackResolveErrorCode
  /** 可诊断信息；🔴 不得包含 url / headers */
  message: string
}

export interface AggregateResult {
  candidates: PlaybackCandidate[]
  /** 成功产出候选的来源 id */
  succeeded: string[]
  /** 失败来源明细 */
  failed: ResolveFailure[]
  /**
   * 聚合层错误码。
   * 仅在 `candidates` 为空时有值；部分成功时为 `undefined`。
   */
  error?: PlaybackResolveErrorCode
}

export interface ResolveOptions {
  /** 用户偏好来源：其候选置顶 */
  preferredSourceId?: string
  /** 单源等待上限，默认 RESOLVE_TIMEOUT_MS */
  timeoutMs?: number
  /** 可注入时钟（测试用） */
  now?: () => number
  /** 诊断回调（测试用；生产可不传） */
  onEvent?: (e: ResolveEvent) => void
}

/**
 * 诊断事件。
 *
 * 🔴 `resolve.timeout` 与 `resolve.settled` 是**两个不同事件**，
 *    不得混写（禁止把逻辑超时记录成「请求已取消」）。
 */
export type ResolveEvent =
  | { type: 'resolve.timeout'; sourceId: string; waitedMs: number }
  | { type: 'resolve.settled'; sourceId: string; afterTimeout: boolean }

/* ══════════════════════════════════════════════════════════════════════
 * 并发预算（物理名额）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 物理占用计数：只在**底层 Promise settle** 时 -1。
 * 与第9子步 `imageScheduler.physicalActive` 同构。
 */
let physicalActive = 0
const waiters: Array<() => void> = []

function acquire(): Promise<void> {
  if (physicalActive < MAX_RESOLVE_CONCURRENT) {
    physicalActive++
    return Promise.resolve()
  }
  // 名额已满 ⇒ 排队（不通过增加并发掩盖问题）
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      physicalActive++
      resolve()
    })
  })
}

function release(): void {
  physicalActive = Math.max(0, physicalActive - 1)
  const next = waiters.shift()
  if (next) next()
}

/** 仅测试用：读取当前物理占用 */
export function __physicalActive(): number {
  return physicalActive
}

/** 仅测试用：重置并发预算（避免测试间串扰） */
export function __resetResolveBudget(): void {
  physicalActive = 0
  waiters.length = 0
}

/* ══════════════════════════════════════════════════════════════════════
 * 候选校验
 * ══════════════════════════════════════════════════════════════════════ */

/** 合法协议集合 */
const VALID_PROTOCOLS: ReadonlySet<string> = new Set<PlaybackProtocol>(['hls', 'progressive'])

/**
 * 校验单个候选。返回 `null` 表示合法，否则返回原因（不含 URL）。
 */
function invalidReason(c: Partial<PlaybackCandidate> | null | undefined): string | null {
  if (!c || typeof c !== 'object') return '候选不是对象'
  if (typeof c.url !== 'string' || c.url.length === 0) return '缺少播放地址'
  if (!/^https?:\/\//i.test(c.url)) return '播放地址非 http(s)'
  if (!c.protocol || !VALID_PROTOCOLS.has(c.protocol)) return '协议缺失或不受支持'
  return null
}

/* ══════════════════════════════════════════════════════════════════════
 * 聚合主流程
 * ══════════════════════════════════════════════════════════════════════ */

/** 单源解析结果（内部） */
type OneResult =
  | { ok: true; sourceId: string; candidates: PlaybackCandidate[] }
  | { ok: false; sourceId: string; code: PlaybackResolveErrorCode; message: string }

/**
 * 解析单个来源，带逻辑超时。
 *
 * 🔴 关键：`release()` 挂在**底层 Promise 自己的 finally** 上，
 *    不挂在 race 的结算上。超时分支不归还名额。
 */
async function resolveOne(
  resolver: PlaybackSourceResolver,
  workId: string,
  episodeId: string,
  timeoutMs: number,
  onEvent?: (e: ResolveEvent) => void,
): Promise<OneResult> {
  await acquire()

  let timedOut = false
  let settledOnce = false

  /** 幂等清理：同一个 Promise 只归还一次名额（检查点 B） */
  const cleanup = () => {
    if (settledOnce) return
    settledOnce = true
    release()
    onEvent?.({ type: 'resolve.settled', sourceId: resolver.sourceId, afterTimeout: timedOut })
  }

  // 底层请求：无论成功/失败/同步抛错，都必须在自己的生命周期末尾清理
  let underlying: Promise<PlaybackCandidate[]>
  try {
    underlying = Promise.resolve(resolver.getCandidates(workId, episodeId))
  } catch (e) {
    // 同步抛错：立刻清理并返回失败
    cleanup()
    return {
      ok: false,
      sourceId: resolver.sourceId,
      code: 'RESOLVE_FAILED',
      message: e instanceof Error ? e.message : String(e),
    }
  }

  // 底层 settle 时清理（可能远晚于超时）
  const underlyingTracked = underlying.then(
    (v) => { cleanup(); return v },
    (e) => { cleanup(); throw e },
  )

  // 逻辑超时：只是不再等待，**不**清理名额
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      onEvent?.({ type: 'resolve.timeout', sourceId: resolver.sourceId, waitedMs: timeoutMs })
      reject(new Error('__RESOLVE_TIMEOUT__'))
    }, timeoutMs)
  })

  try {
    const raw = await Promise.race([underlyingTracked, timeout])
    if (timer) clearTimeout(timer)

    // 🔴 迟到结果隔离：若此刻已超时，即使 race 先返回也不得采纳
    if (timedOut) {
      return {
        ok: false,
        sourceId: resolver.sourceId,
        code: 'RESOLVE_TIMEOUT',
        message: `等待超过 ${timeoutMs}ms`,
      }
    }

    // 空候选
    if (!Array.isArray(raw) || raw.length === 0) {
      return {
        ok: false,
        sourceId: resolver.sourceId,
        code: 'EMPTY_CANDIDATES',
        message: '来源未返回任何候选',
      }
    }

    // 逐条校验；全部非法 ⇒ INVALID_CANDIDATES
    const valid: PlaybackCandidate[] = []
    let invalidCount = 0
    raw.forEach((c, index) => {
      const reason = invalidReason(c)
      if (reason) {
        invalidCount++
        return
      }
      // 🔴 C1/C2：candidateId 用**单源原始索引**，此处一次性生成后不再改动
      valid.push({
        ...c,
        candidateId: `${resolver.sourceId}#${index}`,
        sourceId: resolver.sourceId,
        sourceName: c.sourceName || resolver.sourceName,
      })
    })

    if (valid.length === 0) {
      return {
        ok: false,
        sourceId: resolver.sourceId,
        code: 'INVALID_CANDIDATES',
        message: `${invalidCount} 条候选全部非法`,
      }
    }

    return { ok: true, sourceId: resolver.sourceId, candidates: valid }
  } catch (e) {
    if (timer) clearTimeout(timer)

    if (e instanceof Error && e.message === '__RESOLVE_TIMEOUT__') {
      return {
        ok: false,
        sourceId: resolver.sourceId,
        code: 'RESOLVE_TIMEOUT',
        message: `等待超过 ${timeoutMs}ms`,
      }
    }
    return {
      ok: false,
      sourceId: resolver.sourceId,
      code: 'RESOLVE_FAILED',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 聚合多个来源的播放候选。
 *
 * 排序（用户裁定 §2）：
 *   1. `preferredSourceId` 的候选置顶
 *   2. `playbackRank(sourceId)` 升序
 *   3. 解析器返回的原始顺序（稳定）
 *
 * 🔴 部分成功即成功：只要有一个源产出有效候选，`error` 为 `undefined`。
 */
export async function resolveCandidates(
  workId: string,
  episodeId: string,
  resolvers: PlaybackSourceResolver[],
  opts: ResolveOptions = {},
): Promise<AggregateResult> {
  const timeoutMs = opts.timeoutMs ?? RESOLVE_TIMEOUT_MS

  // 空 Registry 是正常状态，不是异常（§1.3.1）
  if (resolvers.length === 0) {
    return { candidates: [], succeeded: [], failed: [], error: 'NO_RESOLVER_ENABLED' }
  }

  /**
   * 🔴 检查点 A：candidateId 的作用域防御。
   *
   * `candidateId` 形如 `${sourceId}#${index}`，只有在**单源结果内**才唯一。
   * 若同一轮聚合对同一个 sourceId 出现两次，会产生重复 id（`dup#0` 出现两次），
   * 导致选择时无法区分。
   *
   * registry 的构建期断言已禁止重复注册，但 `resolveCandidates` 是公开函数，
   * 调用方可能传入任意数组 ⇒ 此处按 sourceId 去重，保留首个。
   * 静默去重优于产出损坏的 id 空间。
   */
  const seenSource = new Set<string>()
  const uniqueResolvers = resolvers.filter((r) => {
    if (seenSource.has(r.sourceId)) return false
    seenSource.add(r.sourceId)
    return true
  })

  // 并行解析；单源失败不影响其他源
  const results = await Promise.all(
    uniqueResolvers.map((r) => resolveOne(r, workId, episodeId, timeoutMs, opts.onEvent)),
  )

  const succeeded: string[] = []
  const failed: ResolveFailure[] = []
  const collected: PlaybackCandidate[] = []

  // 按 resolvers 顺序收集，保证「同 rank 保持解析器顺序」
  for (const r of results) {
    if (r.ok) {
      succeeded.push(r.sourceId)
      collected.push(...r.candidates)
    } else {
      failed.push({ sourceId: r.sourceId, code: r.code, message: r.message })
    }
  }

  // URL 去重（保留排序靠前者）；只比较 url，不比较 headers
  const seenUrl = new Set<string>()
  const deduped = collected.filter((c) => {
    if (seenUrl.has(c.url)) return false
    seenUrl.add(c.url)
    return true
  })

  // 排序：偏好源 → rank → 原始顺序（稳定）
  const preferred = opts.preferredSourceId
  const indexed = deduped.map((c, i) => ({ c, i }))
  indexed.sort((a, b) => {
    if (preferred) {
      const ap = a.c.sourceId === preferred ? 0 : 1
      const bp = b.c.sourceId === preferred ? 0 : 1
      if (ap !== bp) return ap - bp
    }
    const ar = playbackRank(a.c.sourceId)
    const br = playbackRank(b.c.sourceId)
    if (ar !== br) return ar - br
    return a.i - b.i        // 稳定：保持收集顺序
  })

  // 🔴 C2/C3：排序只移动元素，不碰 candidateId
  const candidates = indexed.map((x) => x.c)

  // 部分成功即成功；一个都没有才算 ALL_SOURCES_FAILED
  const error: PlaybackResolveErrorCode | undefined =
    candidates.length === 0 ? 'ALL_SOURCES_FAILED' : undefined

  return { candidates, succeeded, failed, error }
}
