/**
 * 图片请求共享调度器（第9子步 · 批次①）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════════
 * 第8子步之后，MangaDex 图片有两个独立入口：
 *   - 正文图片：`onlineChapters.ts` 的 `createLimiter(4)`
 *   - 封面图片：`mangadexCover.ts` 的 `createLimiter(MAX_CONCURRENCY)`
 * 两者各开一个闸门 ⇒ 理论并发 8，且**封面可能抢占正文名额**。
 *
 * 本模块提供**单一并发预算 + 优先级隔离**：
 *   - 全 App 图片请求共享 `maxConcurrent`（默认 6）
 *   - `reader`（正文）优先于 `cover`（封面）
 *   - 封面等待过久可「老化提升」越过正文，但**最多 1 个名额**，避免永久饿死
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三条不可让步的语义（方案 §3.4.1 / §4.2）
 * ══════════════════════════════════════════════════════════════════════
 * 1. **物理名额只在 Promise settle 后释放**
 *    一旦 `fn()` 被调用，名额锁定到 settle。即使 `signal` abort 也不提前释放。
 *    原因：CapacitorHttp 没有真正的网络中断能力（`getBinary` 的原生分支
 *    不支持 signal），所谓取消只是「响应回来时丢弃」，底层 HTTP 仍在跑。
 *    若此时归还名额，物理并发会翻倍甚至累积。
 *
 * 2. **排队期间 abort 可以立即出队**
 *    尚未调用 `fn()` ⇒ 未占物理资源，出队零成本。
 *
 * 3. **不做速率限制**
 *    实测（备忘录 §73.1）：图片 CDN 并发 8 零 429，api 30 并发 34.2 req/s 零 429，
 *    且响应头没有 `X-RateLimit-*` 可供自适应退避。
 *    ⇒ 本调度器**只承诺并发受控与正文优先，不承诺消除 429**。
 *    也不实现未经证据支持的速率限制（那只会让加载更慢）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 与冻结区的关系
 * ══════════════════════════════════════════════════════════════════════
 * `binaryHttp.ts` **零改动**。已核实 `getBinary()` 内部本来就没有任何并发控制
 * （`MAX_CONCURRENCY` 只是常量、`createLimiter` 只是导出给调用方的工具），
 * 并发控制 100% 在调用方。因此这里替换的是两个调用方的闸门，不是叠加。
 */

/** 图片优先级：正文 > 封面 */
export type ImagePriority = 'reader' | 'cover'

/** 封面等待超过此时长，允许老化提升（不是硬等待上限，只是触发阈值） */
export const COVER_AGING_MS = 3000

/** 默认并发上限。实测并发 6 ≈ 1.99s，接近并发 8 的 1.70s，同时留余量 */
export const DEFAULT_MAX_CONCURRENT = 6

interface Task<T = unknown> {
  fn: () => Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
  signal?: AbortSignal
  /** 入队时刻，用于封面老化判定 */
  enqueuedAt: number
  /** 排队期间的 abort 监听器，出队时要摘掉 */
  onAbort?: () => void
  settled: boolean
  /** 是否通过「老化提升」越过正文启动，settle 时要归还老化配额 */
  promotedAged?: boolean
}

export interface SchedulerStats {
  /** 🔴 物理占用：已调用 fn 且 Promise 未 settle 的数量，决定能否启动新任务 */
  physicalActive: number
  queued: { reader: number; cover: number }
  maxConcurrent: number
}

export interface ImageScheduler {
  run<T>(priority: ImagePriority, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>
  stats(): SchedulerStats
  /** 仅测试用 */
  setMaxConcurrent(n: number): void
  /** 仅测试用：可注入时钟，用于老化判定 */
  __setNow(fn: () => number): void
}

function makeAbortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

export function createImageScheduler(initialMax: number = DEFAULT_MAX_CONCURRENT): ImageScheduler {
  let maxConcurrent = initialMax
  let now: () => number = () => Date.now()

  /**
   * 物理占用计数。
   * 🔴 只在 fn 真正被调用时 +1、在 Promise settle 时 -1。
   * 绝不因 abort / stale / 出队而提前减少。
   */
  let physicalActive = 0

  const queues: Record<ImagePriority, Task[]> = { reader: [], cover: [] }

  /** 出队并清理 abort 监听 */
  function dequeue(priority: ImagePriority, task: Task): void {
    const q = queues[priority]
    const i = q.indexOf(task)
    if (i >= 0) q.splice(i, 1)
    if (task.signal && task.onAbort) {
      task.signal.removeEventListener('abort', task.onAbort)
      task.onAbort = undefined
    }
  }

  function start(priority: ImagePriority, task: Task): void {
    dequeue(priority, task)
    if (task.settled) return

    // 排队期间已被 abort ⇒ 不启动，不占名额
    if (task.signal?.aborted) {
      task.settled = true
      task.reject(makeAbortError())
      return
    }

    // 🔴 名额在此锁定，直到 settle
    physicalActive++
    let p: Promise<unknown>
    try {
      p = task.fn()
    } catch (e) {
      // 同步抛错也要归还名额
      physicalActive--
      releaseAged(task)
      task.settled = true
      task.reject(e)
      pump()
      return
    }

    Promise.resolve(p).then(
      (v) => {
        physicalActive--
        releaseAged(task)
        if (!task.settled) {
          task.settled = true
          task.resolve(v)
        }
        pump()
      },
      (e) => {
        physicalActive--
        releaseAged(task)
        if (!task.settled) {
          task.settled = true
          task.reject(e)
        }
        pump()
      },
    )
  }

  function releaseAged(task: Task): void {
    if (task.promotedAged) {
      task.promotedAged = false
      agedInFlight = Math.max(0, agedInFlight - 1)
    }
  }

  /** 封面是否有等待超过阈值、可越过正文的候选（队列按入队时间 FIFO，故只需看队首） */
  function agingCoverReady(): Task | undefined {
    const t = queues.cover[0]
    if (!t) return undefined
    return now() - t.enqueuedAt >= COVER_AGING_MS ? t : undefined
  }

  /**
   * 同时最多 1 个「老化提升」的封面在跑（方案 §4.2.1 / §8.3.2）。
   * 老化只改变**队列取用顺序**，不改变 `physicalActive` 判定 ——
   * 无空闲名额时照样启动不了，也绝不抢占**已启动**的正文请求。
   */
  let agedInFlight = 0

  function pump(): void {
    while (physicalActive < maxConcurrent) {
      // ① 老化封面可越过正文，但全局最多 1 个
      if (agedInFlight < 1) {
        const aged = agingCoverReady()
        if (aged) {
          agedInFlight++
          aged.promotedAged = true
          start('cover', aged)
          continue
        }
      }

      // ② 正文优先
      const r = queues.reader.shift()
      if (r) { start('reader', r); continue }

      // ③ 正文队列空 ⇒ 取封面
      const c = queues.cover.shift()
      if (c) { start('cover', c); continue }

      return
    }
  }

  function run<T>(priority: ImagePriority, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = {
        fn,
        resolve: resolve as (v: unknown) => void,
        reject,
        signal,
        enqueuedAt: now(),
        settled: false,
      }

      // 已经 abort：直接拒绝，不入队、不占名额
      if (signal?.aborted) {
        reject(makeAbortError())
        return
      }

      if (signal) {
        task.onAbort = () => {
          // 只有仍在排队才需要处理；已启动的任务名额锁定到 settle
          const q = queues[priority]
          if (q.indexOf(task as Task) >= 0) {
            dequeue(priority, task as Task)
            task.settled = true
            reject(makeAbortError())
          }
        }
        signal.addEventListener('abort', task.onAbort, { once: true })
      }

      queues[priority].push(task as Task)
      pump()
    })
  }

  return {
    run,
    stats: () => ({
      physicalActive,
      queued: { reader: queues.reader.length, cover: queues.cover.length },
      maxConcurrent,
    }),
    setMaxConcurrent: (n: number) => {
      maxConcurrent = n
      pump()
    },
    __setNow: (fn: () => number) => {
      now = fn
    },
  }
}

/**
 * 进程级单例。
 *
 * 正文（`onlineChapters`）与封面（`mangadexCover`）共用同一个实例，
 * 这是「单一并发预算 + 优先级隔离」的实现基础。
 */
export const imageScheduler: ImageScheduler = createImageScheduler()
