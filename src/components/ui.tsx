import type { ReactNode } from 'react'
import Icon, { type IconName } from './Icon'

/* 区块标题 */
export function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head"><h2>{title}</h2>{extra && <span>{extra}</span>}</div>
      {children}
    </section>
  )
}

/* 空状态 / 待开发占位 */
export function EmptyState({ icon = 'info', title, desc, actionText, onAction }: {
  icon?: IconName; title: string; desc?: string; actionText?: string; onAction?: () => void
}) {
  return (
    <div className="empty">
      <span style={{ color: 'var(--hl)', display: 'flex' }}><Icon name={icon} size={30} /></span>
      <div className="etitle">{title}</div>
      {desc && <div className="edesc">{desc}</div>}
      {actionText && onAction && <button className="btn" onClick={onAction}>{actionText}</button>}
    </div>
  )
}

/* 筛选 Chip */
export function Chip({ on, onClick, children }: { on?: boolean; onClick?: () => void; children: ReactNode }) {
  return <button className={'chip' + (on ? ' on' : '')} onClick={onClick}>{children}</button>
}

/* 待开发徽章 */
export function WipBadge() {
  return <span className="badge">待开发</span>
}

/* 设置行 */
export function Row({ icon, title, desc, wip, onClick, right }: {
  icon: IconName; title: string; desc?: string; wip?: boolean; onClick?: () => void; right?: ReactNode
}) {
  const cls = 'row-item' + (wip || !onClick ? ' disabled' : '')
  return (
    <button className={cls} onClick={wip ? undefined : onClick}>
      <span className="ric"><Icon name={icon} size={20} /></span>
      <span className="rmain">
        <div className="rtitle">{title} {wip && <WipBadge />}</div>
        {desc && <div className="rdesc">{desc}</div>}
      </span>
      {right ?? (!wip && <span className="rarr"><Icon name="chevron" size={16} /></span>)}
    </button>
  )
}

/* 居中弹窗 */
export function Modal({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode
}) {
  if (!open) return null
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="mtext">{children}</div>
        <button className="mclose" onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}
