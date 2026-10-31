import { useState } from 'react'
import { Chip, EmptyState, Section } from '../../components/ui'

const GENRES = ['热血', '恋爱', '科幻', '悬疑', '日常', '奇幻', '搞笑', '治愈']
const SORTS = ['热门', '最新', '评分'] as const

export default function DiscoveryPage() {
  const [type, setType] = useState<'anime' | 'manga'>('anime')
  const [genres, setGenres] = useState<string[]>([])
  const [sort, setSort] = useState<(typeof SORTS)[number]>('热门')

  const toggleGenre = (g: string) =>
    setGenres((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]))

  const summary = `类型：${type === 'anime' ? '动漫' : '漫画'} · 分类：${genres.length ? genres.join('、') : '全部'} · 排序：${sort}`

  return (
    <>
      <header className="page-head">
        <h1>发现</h1>
        <p>按类型、年份、评分探索动漫与漫画</p>
      </header>

      <Section title="内容类型">
        <div className="chips">
          <Chip on={type === 'anime'} onClick={() => setType('anime')}>动漫</Chip>
          <Chip on={type === 'manga'} onClick={() => setType('manga')}>漫画</Chip>
        </div>
      </Section>

      <Section title="分类筛选">
        <div className="chips">{GENRES.map((g) => <Chip key={g} on={genres.includes(g)} onClick={() => toggleGenre(g)}>{g}</Chip>)}</div>
        <div className="filter-label">排序方式</div>
        <div className="chips">{SORTS.map((s) => <Chip key={s} on={sort === s} onClick={() => setSort(s)}>{s}</Chip>)}</div>
      </Section>

      <Section title="结果">
        <EmptyState icon="compass" title="筛选条件已就绪"
          desc={`${summary}\n数据源待接入（阶段 3），接入后此处展示真实结果。`} />
      </Section>
    </>
  )
}
