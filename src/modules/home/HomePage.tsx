import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon, { type IconName } from '../../components/Icon'
import { Section, EmptyState, Loading } from '../../components/ui'
import WorkCard from '../../components/WorkCard'
import NewsSection from '../news/NewsSection'
import { useHomeStore, type BlockState } from './homeStore'
import { SOURCE_NAMES } from '../../services/sources'
import type { WorkItem } from '../../services/sources'

const quicks: { icon: IconName; label: string; to?: string; wip?: boolean }[] = [
  { icon: 'search', label: '搜索', to: '/search' },
  { icon: 'compass', label: '发现', to: '/discovery' },
  { icon: 'book', label: '书架', to: '/library' },
  { icon: 'sparkle', label: 'AI 助手', wip: true },
  { icon: 'tool', label: '工具箱', wip: true },
]

const BLOCK_NAME: Record<string, string> = { anime: 'anime', manga: 'manga' }

/** 首页区块：独立 loading/error/数据，渐进渲染（快源先画），失败可单独重试 */
function HomeRow({ title, extra, block, data, onOpen }: {
  title: string
  extra?: string
  block: 'anime' | 'manga'
  data: BlockState
  onOpen: (w: WorkItem) => void
}) {
  const retryBlock = useHomeStore((s) => s.retryBlock)
  const items = data.items
  const failedNames = Object.keys(data.failed || {})
    .map((id) => SOURCE_NAMES[id] || id)
    .join('、')

  return (
    <Section
      title={title}
      extra={extra}
    >
      {data.loading && !items.length ? (
        <Loading />
      ) : !items.length ? (
        <EmptyState
          icon="info"
          title="内容加载失败"
          desc={failedNames ? `${failedNames} 不可用（${Object.values(data.failed)[0]}）` : '暂无数据'}
          actionText="重试"
          onAction={() => retryBlock(BLOCK_NAME[block] as 'anime' | 'manga')}
        />
      ) : (
        <>
          <div className="h-scroll">
            {items.map((w) => <WorkCard key={`${w.sourceId}-${w.workId}`} w={w} onClick={() => onOpen(w)} />)}
          </div>
          {data.loading && <div className="block-partial">部分来源加载中…（已显示快源内容）</div>}
          {!data.loading && failedNames && (
            <div className="block-partial">
              {failedNames} 加载失败（{Object.values(data.failed)[0]}）
              <button className="link-btn" onClick={() => retryBlock(block)}>重试</button>
            </div>
          )}
        </>
      )}
    </Section>
  )
}

export default function HomePage() {
  const nav = useNavigate()
  const open = (w: WorkItem) => nav(`/detail/${w.sourceId}/${w.kind}/${w.workId}`)
  const anime = useHomeStore((s) => s.anime)
  const manga = useHomeStore((s) => s.manga)
  const setScrollY = useHomeStore((s) => s.setScrollY)
  const hydrate = useHomeStore((s) => s.hydrate)
  const scrollY = useHomeStore((s) => s.scrollY)

  // 挂载即 hydrate（缓存有效立即显示、不重复请求；过期后台刷新）；卸载时记录滚动位置
  useEffect(() => {
    hydrate()
    const main = document.querySelector<HTMLElement>('main.page')
    if (main && scrollY > 0) main.scrollTop = scrollY
    return () => {
      const m = document.querySelector<HTMLElement>('main.page')
      if (m) setScrollY(m.scrollTop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

      <HomeRow title="热门动漫" extra="多来源聚合" block="anime" data={anime} onOpen={open} />
      <HomeRow title="热门漫画" extra="多来源聚合" block="manga" data={manga} onOpen={open} />

      <Section title="最新资讯" extra={
        <button onClick={() => nav('/news')} style={{ color: 'var(--accent)', fontSize: 11.5 }}>更多 ›</button>
      }>
        <NewsSection />
      </Section>
    </>
  )
}
