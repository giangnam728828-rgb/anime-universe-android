/**
 * 来源感知封面组件（P1 第8子步 · Bug 2 方案 A）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这一层，而不是直接改 SmartImage
 * ══════════════════════════════════════════════════════════════════════
 * `SmartImage` 服务**所有来源**（B站防盗链 no-referrer、懒加载、有限重试、
 * 失败兜底图标）。它的行为是全局契约，不能为了一个来源改成 Blob 代理，
 * 否则其他来源的图片策略会被动改变（用户明确禁止）。
 *
 * 因此本组件是**分流层**：
 *   - MangaDex 封面 → 走 Blob 代理（uploads.mangadex.org 绝不直连）
 *   - 其他来源封面 → 原样交给 SmartImage，一行行为都不变
 *
 * ══════════════════════════════════════════════════════════════════════
 * 渲染契约：与 SmartImage 视觉一致
 * ══════════════════════════════════════════════════════════════════════
 * 复用同一套 CSS 类（smart-img-wrap / smart-img-ph / smart-img-fallback），
 * 因此占位、淡入、兜底图标的观感与普通封面完全一致，
 * 不会出现「有的卡片占位是 shimmer、有的是色块」的割裂。
 */
import { useState } from 'react'
import Icon, { type IconName } from '../../components/Icon'
import SmartImage from '../../components/SmartImage'
import { isMangadexCover } from '../../services/covers/mangadexCover'
import { useCoverObjectUrl } from './useCoverObjectUrl'

export interface ProxyCoverProps {
  /** 封面原始地址 */
  src?: string
  /** 来源标识（WorkItem.sourceId / WorkDetail.sourceId） */
  sourceId?: string
  fallbackIcon?: IconName
  /** 懒加载持有：true 时不发请求 */
  hold?: boolean
  /** 首屏关键图：跳过 lazy 立即请求 */
  eager?: boolean
}

/**
 * 封面组件：自动判定是否需要走 MangaDex Blob 代理。
 *
 * ⚠️ 判定在**组件内部**完成，调用方只需传 sourceId + src，
 *    不需要自己写 if (sourceId === 'mangadex') 分支 —— 避免多处遗漏。
 */
export default function ProxyCover({ src, sourceId, fallbackIcon = 'film', hold, eager }: ProxyCoverProps) {
  const proxy = isMangadexCover(sourceId, src)

  // 非代理来源：完全走原路径，零行为变化
  if (!proxy) {
    return <SmartImage src={src} fallbackIcon={fallbackIcon} hold={hold} eager={eager} />
  }
  return <MangadexCover src={src} fallbackIcon={fallbackIcon} hold={hold} eager={eager} />
}

/* ══════════════════════════════════════════════════════════════════════
 * MangaDex 专用封面渲染
 * ══════════════════════════════════════════════════════════════════════ */

function MangadexCover({
  src, fallbackIcon, hold, eager,
}: {
  src?: string
  fallbackIcon: IconName
  hold?: boolean
  eager?: boolean
}) {
  const [loaded, setLoaded] = useState(false)
  const { url, status, retry } = useCoverObjectUrl({ src, proxy: true, hold })

  // 无封面地址：与 SmartImage 一致的兜底
  if (!src) {
    return (
      <div className="smart-img-wrap">
        <div className="smart-img-fallback"><Icon name={fallbackIcon} size={26} /></div>
      </div>
    )
  }

  // 懒加载持有中：静态色块，不发请求
  if (hold || status === 'idle') {
    return (
      <div className="smart-img-wrap">
        <div className="smart-img-hold" />
      </div>
    )
  }

  // 加载失败：显示兜底图标 + 可点重试（不自动重试，避免请求风暴）
  if (status === 'failed') {
    return (
      <div className="smart-img-wrap">
        <button
          type="button"
          className="smart-img-fallback cover-retry"
          onClick={(e) => {
            // 卡片本身是 <button>，必须阻止冒泡，否则点重试会跳详情页
            e.stopPropagation()
            e.preventDefault()
            setLoaded(false)
            retry()
          }}
          aria-label="封面加载失败，点按重试"
        >
          <Icon name={fallbackIcon} size={26} />
          <span className="cover-retry-text">重试</span>
        </button>
      </div>
    )
  }

  // 下载中：与 SmartImage 一致的 shimmer 占位（不发额外请求）
  if (status === 'loading' || !url) {
    return (
      <div className="smart-img-wrap">
        <div className="smart-img-ph" />
      </div>
    )
  }

  // 就绪：Object URL 渲染
  return (
    <div className="smart-img-wrap">
      {!loaded && <div className="smart-img-ph" />}
      <img
        src={url}
        alt=""
        className={loaded ? 'is-loaded' : 'is-loading'}
        loading={eager ? 'eager' : 'lazy'}
        fetchPriority={eager ? 'high' : undefined}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => {
          // Object URL 已生成却加载失败 = 极端异常（内存回收/解码失败）
          // 这里只标记未加载，不做自动重试（重试必须由用户触发）
          setLoaded(false)
        }}
      />
    </div>
  )
}
