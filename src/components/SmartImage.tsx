/**
 * 统一图片组件（P0 修复 2026-11-01）
 * 根因链（真机实测确认）：
 *  1) Capacitor WebView `androidScheme:'https'` + 默认 mixed-content NEVER_ALLOW → 拦截 http:// 图片
 *     （已由 normalizeCover 在数据层统一升级 https 解决）
 *  2) **WebView 对子资源请求自动带 `Referer: https://localhost/`，B站图床 i0.hdslb.com 防盗链
 *     对非 B 站 Referer 返回 403**（实测：无 Referer 200 / localhost Referer 403 / B站官网 200）
 *     → 这就是 v0.6.29 后鬼灭之刃仍破图的真正原因。
 * 修复：img 加 `referrerPolicy="no-referrer"` + index.html 全局 `<meta name="referrer" content="no-referrer">`
 *     （AniList/MangaDex 实测不受 Referer 影响，均 200，无副作用；不关闭 mixed-content 安全限制）
 * 同时提供：懒加载、加载占位、失败有限重试(1次)、最终失败显示占位图标（永不显示破图）
 */
import { useState, useEffect } from 'react'
import Icon, { type IconName } from './Icon'

interface Props {
  src?: string
  alt?: string
  /** 占位/失败时显示的图标名 */
  fallbackIcon?: IconName
  className?: string
}

export default function SmartImage({ src, alt = '', fallbackIcon = 'film', className }: Props) {
  const [attempt, setAttempt] = useState(0) // 0=首次, 1=重试1次, 2=放弃
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  // src 变化时重置状态（卡片复用/详情切换）
  useEffect(() => {
    setAttempt(0)
    setLoaded(false)
    setFailed(false)
  }, [src])

  if (!src || failed || attempt >= 2) {
    return (
      <div className={`smart-img-fallback ${className || ''}`}>
        <Icon name={fallbackIcon} size={26} />
      </div>
    )
  }

  return (
    <>
      {!loaded && <div className={`smart-img-ph ${className || ''}`} />}
      <img
        key={attempt}
        src={src}
        alt={alt}
        className={`${className || ''} ${loaded ? 'is-loaded' : 'is-loading'}`}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (attempt < 1) setAttempt((a) => a + 1) // 有限重试 1 次（瞬时网络抖动）
          else setFailed(true)
        }}
      />
    </>
  )
}
