/**
 * 统一图片组件（P0 修复 2026-11-01 v2——频闪修复版）
 * 根因链（真机实测+静态证据闭环）：
 *  1) WebView 子资源自动带 Referer: https://localhost/ → B站图床防盗链 403
 *     → img referrerPolicy="no-referrer" + index.html 全局 meta（保留，勿动）
 *  2) v0.6.30 频闪：shimmer 占位层 `position:absolute; inset:0` 从 .wc-cover 一路逃逸
 *     （.wc-cover/.work-card/.h-scroll/.page/.app-shell/body 均无 position）→ 铺满视口，
 *     24 张卡片 24 层全屏 shimmer 动画 → 整屏闪白/闪黑，图片加载完占位卸载后"自行停止"。
 * 修复：SmartImage 渲染自带 `.smart-img-wrap { position:relative }` 包裹层，
 *     占位/图片/兜底全部收在 wrap 内——无论父级是否有定位上下文都不会逃逸（结构性根治）。
 * 同时提供：懒加载、加载占位、失败有限重试(1次)、最终失败显示占位图标（永不显示破图）。
 */
import { useState, useEffect, useRef } from 'react'
import Icon, { type IconName } from './Icon'
import { perf } from '../services/perf'

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
  const t0 = useRef(Date.now()) // 阶段2计时：图片开始→完成

  // src 变化时重置状态（卡片复用/详情切换）
  useEffect(() => {
    setAttempt(0)
    setLoaded(false)
    setFailed(false)
    t0.current = Date.now()
  }, [src])

  return (
    <div className="smart-img-wrap">
      {!src || failed || attempt >= 2 ? (
        <div className="smart-img-fallback">
          <Icon name={fallbackIcon} size={26} />
        </div>
      ) : (
        <>
          {!loaded && <div className="smart-img-ph" />}
          <img
            key={attempt}
            src={src}
            alt={alt}
            className={`${className || ''} ${loaded ? 'is-loaded' : 'is-loading'}`}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => {
              setLoaded(true)
              perf({ phase: 'img-load', status: 'ok', ms: Date.now() - t0.current, detail: attempt ? `重试${attempt}成功` : undefined })
            }}
            onError={() => {
              if (attempt < 1) {
                setAttempt((a) => a + 1) // 有限重试 1 次（瞬时网络抖动）
                t0.current = Date.now()
              } else {
                setFailed(true)
                perf({ phase: 'img-load', status: 'fail', ms: Date.now() - t0.current, detail: '重试后仍失败' })
              }
            }}
          />
        </>
      )}
    </div>
  )
}
