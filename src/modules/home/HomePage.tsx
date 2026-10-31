import { useNavigate } from 'react-router-dom'
import Icon, { type IconName } from '../../components/Icon'
import { Section, EmptyState } from '../../components/ui'

const quicks: { icon: IconName; label: string; to?: string; wip?: boolean }[] = [
  { icon: 'search', label: '搜索', to: '/search' },
  { icon: 'compass', label: '发现', to: '/discovery' },
  { icon: 'sparkle', label: 'AI 助手', wip: true },
  { icon: 'tool', label: '工具箱', wip: true },
]

export default function HomePage() {
  const nav = useNavigate()
  return (
    <>
      <header className="page-head">
        <h1>动漫宇宙</h1>
        <p>动漫 · 漫画 · 资讯 · AI —— 一站式内容平台</p>
      </header>

      <Section title="快捷入口">
        <div className="quick-grid">
          {quicks.map((q) =>
            q.wip ? (
              <div key={q.label} className="quick-item disabled">
                <span className="qicon"><Icon name={q.icon} size={21} /></span>
                <span>{q.label}</span>
                <span className="badge">待开发</span>
              </div>
            ) : (
              <button key={q.label} className="quick-item isOn" onClick={() => q.to && nav(q.to)}>
                <span className="qicon"><Icon name={q.icon} size={21} /></span>
                <span>{q.label}</span>
              </button>
            ),
          )}
        </div>
      </Section>

      <Section title="热门动漫" extra="阶段 3 接入">
        <EmptyState icon="film" title="数据源待接入"
          desc="将接入 AniList / Jikan 等公开动漫资料 API（阶段 3），接入前此处不展示任何虚构数据。" />
      </Section>

      <Section title="热门漫画" extra="阶段 3 接入">
        <EmptyState icon="book" title="数据源待接入"
          desc="漫画资料与阅读功能将在阶段 3/4 实现，仅使用合法开放来源或本地导入。" />
      </Section>

      <Section title="最新资讯" extra="阶段 5 接入">
        <EmptyState icon="news" title="数据源待接入"
          desc="资讯将通过公开 RSS 接入（阶段 5）。" />
      </Section>
    </>
  )
}
