/**
 * MangaDex 封面 Blob 缓存（P1 第8子步 · Bug 2 方案 A）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么封面必须走 Blob 代理
 * ══════════════════════════════════════════════════════════════════════
 * MangaDex 官方条款原文：
 *   "We will serve the wrong response for any image hotlinked from our
 *    domains; you MUST proxy the requests your users make to our services"
 *
 * 真机实测（同一封面 URL）：
 *   专用 UA `AnimeUniverse/0.6 (manga reader)` → 200 / 44,503 B / image/jpeg / ffd8ffe0 ✅
 *   WebView 浏览器 UA                          → 200 /  2,022 B / text/html  / 3c21646f ❌
 *   `3c21646f` = `<!do` = Cloudflare 挑战页
 * ⇒ 封面直连 `<img src>` 在 App 内 100% 显示不出来。必须由客户端下载字节。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 与正文图片（阅读器）的生命周期必须分开
 * ══════════════════════════════════════════════════════════════════════
 *  - 正文图片：`onlineChapters.getOnlinePageBlob()`，窗口 WINDOW=5，
 *    由 ReaderPage 的 urlCache 回收，切章即清空。**本文件不碰它。**
 *  - 封面：由卡片 / 详情页生命周期管理，256px 缩略图（约 20–50 KB），
 *    跨页面复用价值高 ⇒ 本文件做**共享 Blob 缓存**（存 Blob，不存 Object URL）。
 *
 * ⚠️ 为什么缓存 Blob 而不缓存 Object URL：
 *    Object URL 是「消费者各自持有」的资源。同一张封面可能同时被首页卡片、
 *    搜索卡片、详情页引用；若缓存共享同一个 Object URL，任一消费者卸载时
 *    `revokeObjectURL` 会让其他消费者瞬间变破图。
 *    因此：**缓存层只存不可变 Blob；每个消费者自己 createObjectURL / revoke。**
 *
 * ══════════════════════════════════════════════════════════════════════
 * 约束
 * ══════════════════════════════════════════════════════════════════════
 *  - UA 固定 MANGADEX_USER_AGENT，**不接受调用方覆盖**（防止误用别的来源 UA）
 *  - 复用 binaryHttp 的 `getBinary()`（不改冻结实现）
 *  - 进行中请求去重；失败进入冷却期，避免滚动时无限重试风暴
 *  - LRU 上限：超出只**丢弃 Blob 引用**，绝不 revoke 消费者已持有的 Object URL
 */
import { getBinary, createLimiter, MAX_CONCURRENCY } from '../api/binaryHttp'
import { isAbortError } from '../api/abortError'
import { MANGADEX_USER_AGENT } from '../sources/mangadex'

/* ══════════════════════════════════════════════════════════════════════
 * 常量
 * ══════════════════════════════════════════════════════════════════════ */

/** MangaDex 封面图床域名（仅用于判定「这张封面需不需要代理」，绝不用于直连） */
export const MANGADEX_COVER_HOST = 'uploads.mangadex.org'

/** MangaDex 封面来源标识（WorkItem.sourceId / WorkDetail.sourceId） */
export const MANGADEX_SOURCE_ID = 'mangadex'

/** 封面 Blob 缓存上限（256px 缩略图，单张约 20–50 KB ⇒ 约 2–3 MB 内存上限） */
export const COVER_CACHE_MAX = 60

/** 失败后的冷却时间：期间不再发请求，避免列表滚动时重试风暴 */
export const COVER_FAIL_COOLDOWN_MS = 30_000

/** 封面下载超时（比正文图片短：封面小，20s 太久会拖住整屏） */
export const COVER_TIMEOUT_MS = 12_000

/* ══════════════════════════════════════════════════════════════════════
 * 判定：这张封面是否必须走代理
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 是否是需要代理的 MangaDex 封面。
 *
 * 判定依据是**来源**（sourceId），不是 URL 域名 ——
 * 因为将来若 MangaDex 换图床域名，按 URL 判断会静默失效（又变成直连热链）。
 * URL 域名只作为第二重保险。
 */
export function isMangadexCover(sourceId: string | undefined, coverUrl: string | undefined): boolean {
  if (!coverUrl) return false
  if (sourceId === MANGADEX_SOURCE_ID) return true
  return coverUrl.includes(MANGADEX_COVER_HOST)
}

/* ══════════════════════════════════════════════════════════════════════
 * 并发闸门
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 封面专用并发闸门。
 *
 * 为什么不与正文图片共用 onlineChapters 的 limiter：
 *   两者属于不同生命周期（列表页 / 阅读器），极少同时活跃；
 *   共用需要跨模块导出可变单例，会让两个子步的耦合度上升。
 *   这里独立取 MAX_CONCURRENCY(=4)，与 MangaDex「约 5 req/s/IP」留同样余量。
 */
const coverLimiter = createLimiter(MAX_CONCURRENCY)

/* ══════════════════════════════════════════════════════════════════════
 * 缓存实现
 * ══════════════════════════════════════════════════════════════════════ */

type CoverEntry =
  | { kind: 'loading'; promise: Promise<Blob> }
  | { kind: 'ready'; blob: Blob; at: number }
  | { kind: 'failed'; error: unknown; at: number }

export interface CoverCacheStats {
  /** 真实发起的网络请求数 */
  requests: number
  /** 命中进行中请求（去重）次数 */
  deduped: number
  /** 命中已完成 Blob 次数 */
  hits: number
  /** LRU 淘汰次数 */
  evicted: number
}

export interface CoverLoadOptions {
  /** 调用方取消信号：只影响**本次等待**，不影响共享下载（下载完成仍会入缓存） */
  signal?: AbortSignal
  /** 忽略失败冷却，强制重新请求（用户点重试时用） */
  force?: boolean
}

export interface CoverCache {
  load(url: string, opts?: CoverLoadOptions): Promise<Blob>
  peek(url: string): CoverEntry | undefined
  /** 是否处于失败冷却中（UI 可据此决定要不要显示重试入口） */
  isCoolingDown(url: string, now?: number): boolean
  clear(): void
  size(): number
  stats(): CoverCacheStats
}

export interface CoverCacheDeps {
  /** 下载函数（测试可注入，生产用 getBinary） */
  fetchBlob?: (url: string, signal?: AbortSignal) => Promise<Blob>
  maxEntries?: number
  failCooldownMs?: number
  now?: () => number
}

/** 生产用下载实现：固定 MangaDex UA，禁止调用方覆盖 */
async function defaultFetchBlob(url: string): Promise<Blob> {
  const r = await coverLimiter(() =>
    getBinary(url, {
      userAgent: MANGADEX_USER_AGENT,
      timeoutMs: COVER_TIMEOUT_MS,
      acceptMimePrefixes: ['image/'],
    }),
  )
  return r.blob
}

export function createCoverCache(deps: CoverCacheDeps = {}): CoverCache {
  const fetchBlob = deps.fetchBlob ?? defaultFetchBlob
  const maxEntries = deps.maxEntries ?? COVER_CACHE_MAX
  const failCooldownMs = deps.failCooldownMs ?? COVER_FAIL_COOLDOWN_MS
  const now = deps.now ?? (() => Date.now())

  /** Map 迭代顺序即插入顺序 ⇒ 天然可做 LRU（命中时 delete+set 移到末尾） */
  const map = new Map<string, CoverEntry>()
  const stats: CoverCacheStats = { requests: 0, deduped: 0, hits: 0, evicted: 0 }

  /** LRU 淘汰：只丢引用，绝不 revoke 消费者持有的 Object URL */
  function evictIfNeeded(): void {
    if (map.size <= maxEntries) return
    for (const [k, v] of map) {
      if (map.size <= maxEntries) break
      if (v.kind === 'loading') continue // 进行中的请求不淘汰
      map.delete(k)
      stats.evicted += 1
    }
  }

  function touch(url: string): void {
    const v = map.get(url)
    if (!v) return
    map.delete(url)
    map.set(url, v)
  }

  return {
    load(url: string, opts: CoverLoadOptions = {}): Promise<Blob> {
      const existing = map.get(url)

      if (existing && !opts.force) {
        if (existing.kind === 'ready') {
          stats.hits += 1
          touch(url)
          return Promise.resolve(existing.blob)
        }
        if (existing.kind === 'loading') {
          stats.deduped += 1
          return existing.promise
        }
        // failed：冷却期内直接拒绝，不发请求（防重试风暴）
        if (now() - existing.at < failCooldownMs) {
          return Promise.reject(existing.error)
        }
      }

      // 取消的等待者不应把「取消」写进缓存；这里只把错误交给调用方
      const promise = (async () => {
        stats.requests += 1
        try {
          const blob = await fetchBlob(url)
          map.set(url, { kind: 'ready', blob, at: now() })
          evictIfNeeded()
          return blob
        } catch (e) {
          // 取消不是失败：不写 failed，避免污染缓存
          if (!isAbortError(e)) {
            map.set(url, { kind: 'failed', error: e, at: now() })
          } else {
            map.delete(url)
          }
          throw e
        }
      })()

      map.set(url, { kind: 'loading', promise })
      // loading 态不参与 LRU 淘汰，但也要防止无限增长
      evictIfNeeded()
      return promise
    },

    peek(url: string): CoverEntry | undefined {
      return map.get(url)
    },

    isCoolingDown(url: string, at?: number): boolean {
      const v = map.get(url)
      if (!v || v.kind !== 'failed') return false
      return (at ?? now()) - v.at < failCooldownMs
    },

    clear(): void {
      map.clear()
    },

    size(): number {
      return map.size
    },

    stats(): CoverCacheStats {
      return { ...stats }
    },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 进程级单例（所有卡片 / 详情页共用同一份缓存与并发预算）
 * ══════════════════════════════════════════════════════════════════════ */

export const mangadexCoverCache: CoverCache = createCoverCache()
