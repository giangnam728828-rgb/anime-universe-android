/**
 * 封面 Object URL 生命周期 hook（P1 第8子步 · Bug 2 方案 A）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 职责边界（用户 2026-11-08 明确要求）
 * ══════════════════════════════════════════════════════════════════════
 * 本 hook 只负责「一个封面」的：
 *   1. 请求状态（idle / loading / ready / failed）
 *   2. Blob 获取（走 mangadexCoverCache，共享缓存 + 并发闸门 + 失败冷却）
 *   3. 加载失败与重试
 *   4. Object URL 创建
 *   5. 组件卸载 / 封面切换时回收旧 URL
 *   6. 防止旧请求覆盖新封面（序号校验）
 *
 * 它**不**负责渲染，也**不**负责正文图片（阅读器窗口有自己的一套）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 与阅读器的 Object URL 严格分离
 * ══════════════════════════════════════════════════════════════════════
 * 阅读器：`ReaderPage.urlCache` + `WINDOW=5`，切章清空，urlFor(i) 惰性创建。
 * 封面  ：本 hook 一对一持有，卸载即 revoke。
 * 两者**不共享**任何 Object URL，也不共享缓存 Map。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 为什么不在渲染期 createObjectURL
 * ══════════════════════════════════════════════════════════════════════
 * 渲染期创建会在每次重渲染时产生新 URL 并泄漏（React 可能多次渲染同一组件）。
 * 必须放在 effect 里，且只在「Blob 真正就绪」时创建一次。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { mangadexCoverCache } from '../../services/covers/mangadexCover'
import { isAbortError } from '../../services/api/abortError'

export type CoverStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface UseCoverObjectUrlOptions {
  /** 封面原始地址 */
  src?: string
  /** true = 走 MangaDex Blob 代理；false = 直接用原始 URL（其他来源，行为完全不变） */
  proxy: boolean
  /** 懒加载持有：true 时不发请求（卡片未进入可视范围） */
  hold?: boolean
}

export interface UseCoverObjectUrlResult {
  /** 最终用于 <img src> 的地址 */
  url?: string
  status: CoverStatus
  /** 用户主动重试（忽略失败冷却） */
  retry: () => void
}

export function useCoverObjectUrl(opts: UseCoverObjectUrlOptions): UseCoverObjectUrlResult {
  const { src, proxy, hold } = opts

  const [url, setUrl] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<CoverStatus>('idle')
  /** 重试令牌：变化时重新执行加载 effect */
  const [retryToken, setRetryToken] = useState(0)

  /** 当前持有的 Object URL（用于替换/回收） */
  const urlRef = useRef<string | undefined>(undefined)
  /** 请求序号：只有最新序号的响应才允许写入状态（C9 防旧封面覆盖新封面） */
  const seqRef = useRef(0)

  /* ── 加载 effect：src / proxy / hold / 重试变化时重跑 ── */
  useEffect(() => {
    // 序号自增：本次之前的所有在途请求一律作废
    const mySeq = ++seqRef.current

    // 立即回收上一次的 Object URL（切换封面 / 进入 hold / 关闭代理）
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = undefined
    }
    setUrl(undefined)

    // 非代理来源：直接用原始 URL，不发任何请求（其他来源行为不变）
    if (!proxy) {
      setStatus(src ? 'ready' : 'idle')
      return
    }

    if (!src || hold) {
      setStatus('idle')
      return
    }

    setStatus('loading')

    mangadexCoverCache
      .load(src, retryToken > 0 ? { force: true } : undefined)
      .then((blob) => {
        // 🔴 旧请求迟到：直接丢弃，绝不能覆盖新封面
        if (mySeq !== seqRef.current) return
        const u = URL.createObjectURL(blob)
        urlRef.current = u
        setUrl(u)
        setStatus('ready')
      })
      .catch((e: unknown) => {
        if (mySeq !== seqRef.current) return
        // 取消（切章/卸载/主动 abort）属正常流程，不显示失败
        if (isAbortError(e)) return
        setStatus('failed')
      })
  }, [src, proxy, hold, retryToken])

  /* ── 卸载：作废在途请求 + 回收 Object URL（C7）── */
  useEffect(
    () => () => {
      seqRef.current++
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = undefined
      }
    },
    [],
  )

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1)
  }, [])

  return { url, status, retry }
}
