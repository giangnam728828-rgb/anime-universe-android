import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chip, EmptyState, Section, Loading } from '../../components/ui'
import WorkCard from '../../components/WorkCard'
import { useAsync } from '../../hooks/useAsync'
import { getSource, dedup, type WorkItem, type Kind } from '../../services/sources'
import { GENRE_MAP } from '../../services/sources/anilist'

const SORTS = ['热门', '最新', '评分'] as const

export default function DiscoveryPage() {
  const nav = useNavigate()
  const [type, setType] = useState<Kind>('anime')
  const [genreEn, setGenreEn] = useState<string | null>(null)
  const [sort, setSort] = useState<(typeof SORTS)[number]>('热门')

  const { loading, data, error, retry } = useAsync(
    () => getSource('anilist').search({ kind: type, genre: genreEn ?? undefined, sort }),
    [type, genreEn, sort],
  )

  const open = (w: WorkItem) => nav(`/detail/${w.sourceId}/${w.kind}/${w.workId}`)

  return (
    <>
      <header className="page-head">
        <h1>发现</h1>
        <p>按分类、排序探索动漫与漫画 · 数据来自 AniList</p>
      </header>

      <Section title="内容类型">
        <div className="chips">
          <Chip on={type === 'anime'} onClick={() => setType('anime')}>动漫</Chip>
          <Chip on={type === 'manga'} onClick={() => setType('manga')}>漫画</Chip>
        </div>
      </Section>

      <Section title="分类筛选">
        <div className="chips">
          <Chip on={genreEn === null} onClick={() => setGenreEn(null)}>全部</Chip>
          {Object.entries(GENRE_MAP).map(([en, cn]) => (
            <Chip key={en} on={genreEn === en} onClick={() => setGenreEn(en)}>{cn}</Chip>
          ))}
        </div>
        <div className="filter-label">排序方式</div>
        <div className="chips">
          {SORTS.map((s) => <Chip key={s} on={sort === s} onClick={() => setSort(s)}>{s}</Chip>)}
        </div>
      </Section>

      <Section title="结果" extra="点击查看详情">
        {loading && !data ? <Loading /> : error ? (
          <EmptyState icon="info" title="加载失败" desc={error} actionText="重试" onAction={retry} />
        ) : data && data.items.length > 0 ? (
          <div className="work-grid">
            {dedup(data.items).map((w) => <WorkCard key={w.sourceId + w.workId} w={w} onClick={() => open(w)} />)}
          </div>
        ) : (
          <EmptyState icon="compass" title="没有找到作品" desc="换个分类或排序试试。" />
        )}
      </Section>
    </>
  )
}
