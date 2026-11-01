/** 无底部导航的子页布局（性能日志等调试页用） */
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'

export function NavBarlessLayout({ title, children }: { title: string; children: ReactNode }) {
  const nav = useNavigate()
  return (
    <div className="app-shell">
      <main className="page">
        <header className="page-head" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="back-btn" onClick={() => nav(-1)}>‹ 返回</button>
          <h1 style={{ margin: 0 }}>{title}</h1>
        </header>
        {children}
      </main>
    </div>
  )
}
