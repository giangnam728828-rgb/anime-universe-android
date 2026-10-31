import { useNavigate } from 'react-router-dom'
import Icon, { type IconName } from '../../components/Icon'
import { Section, EmptyState, Loading } from '../../components/ui'
import WorkCard from '../../components/WorkCard'
import { useAsync } from '../../hooks/useAsync'
import { getSource, dedup, type WorkItem } from '../../services/sources'

const quicks: { icon: IconName; label: string; to?: string; wip?: boolean }[] = [
  { icon: 'search', label: '搜索', to: '/search' },
  { icon: 'compass', label: '发现', to: '/discovery' },
  { icon: 'sparkle', label: 'AI 助手', wip: true },
  { icon: 'tool', label: '工具箱', wip: true },
]

export default function HomePage() {
  const nav = useNavigate()
  const open = (w: WorkItem) => nav(`/detail/${w.sourceId}/${w.kind}/${w.workId}`)

  const { loading, data, error, retry } = useAsync(async () => {
    const src = getSource('anilist')
    const [trending, popManga] = await Promise.all([
      src.search({ kind: 'anime', sort: 'trending' }),
      src.search({ kind: 'manga', sort: '热门' }),
    ])
    return { anime: dedup(trending.items).slice(0, 10), manga: dedup(popManga.items).slice(0, 10) }
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

      {loading ? (
        <Loading />
      ) : error ? (
        <EmptyState icon="info" title="内容加载失败" desc={error}
          actionText="重试" onAction={retry} />
      ) : data ? (
        <>
          <Section title="热门动漫" extra="AniList · Trending">
            {data.anime.length === 0 ? <EmptyState title="暂无数据" /> : (
              <div className="h-scroll">
                {data.anime.map((w) => <WorkCard key={w.workId} w={w} onClick={() => open(w)} />)}
              </div>
            )}
          </Section>

          <Section title="热门漫画" extra="AniList · Popular">
            {data.manga.length === 0 ? <EmptyState title="暂无数据" /> : (
              <div className="h-scroll">
                {data.manga.map((w) => <WorkCard key={w.workId} w={w} onClick={() => open(w)} />)}
              </div>
            )}
          </Section>
        </>
      ) : null}

      <Section title="最新资讯" extra="阶段 5 接入">
        <EmptyState icon="news" title="数据源待接入" desc="资讯将通过公开 RSS 接入（阶段 5）。" />
      </Section>
    </>
  )
}
