/**
 * 统一作品卡片（P0+P1 修复 2026-11-01）
 * 布局约定（P1）：纵向 Flex —— 封面 → 标题(固定2行高,超出省略) → 元信息(固定区域) → 来源标签(底部固定)
 * 不同来源/标题长度下卡片布局一致；来源标签用统一 SourceBadge 组件。
 * 图片用 SmartImage：懒加载、no-referrer(B站防盗链修复)、占位、有限重试、失败兜底图标。
 */
import { useEffect, useRef, useState } from 'react'
import SourceBadge from './SourceBadge'
import SmartImage from './SmartImage'
import { getSource, type WorkItem } from '../services/sources'

/** 点击即预取详情（fire-and-forget），详情页 useAsync 命中内存缓存秒开 */
function prefetch(w: WorkItem) {
  void getSource(w.sourceId).getDetail(w.kind, w.workId).catch(() => {})
}

export default function WorkCard({ w, onClick }: { w: WorkItem; onClick: () => void }) {
  // O4 图片懒加载：进入可视范围(rootMargin 200px 预载带)前不发图片请求；首屏仅可见卡片主动加载
  const cardRef = useRef<HTMLButtonElement>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    if (inView || !cardRef.current) return
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        setInView(true)
        io.disconnect()
      }
    }, { rootMargin: '200px' })
    io.observe(cardRef.current)
    return () => io.disconnect()
  }, [inView])

  return (
    <button ref={cardRef} className="work-card" onClick={() => { prefetch(w); onClick() }}>
      <div className="wc-cover" style={w.coverColor ? { background: w.coverColor } : undefined}>
        <SmartImage src={w.cover} fallbackIcon={w.kind === 'manga' ? 'book' : 'film'} hold={!inView} />
      </div>
      <div className="wc-title">{w.title}</div>
      <div className="wc-meta">
        {w.score != null && <span className="wc-score">★ {w.score}</span>}
        {w.year && <span>{w.year}</span>}
      </div>
      <div className="wc-foot">
        <SourceBadge sourceId={w.sourceId} />
      </div>
    </button>
  )
}
