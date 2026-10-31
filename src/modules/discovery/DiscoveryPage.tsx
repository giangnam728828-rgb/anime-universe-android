import { useEffect, useState } from 'react'
import Icon from '../../components/Icon'
import { Chip, EmptyState, Section } from '../../components/ui'
import { dbGetAll, dbPut, dbDelete, type FavoriteItem } from '../../database/db'

const GENRES = ['热血', '恋爱', '科幻', '悬疑', '日常', '奇幻', '搞笑', '治愈']
const SORTS = ['热门', '最新', '评分'] as const

/** 测试数据：仅用于验证收藏持久化，阶段 3 接入真实数据源后移除 */
const TEST_ITEMS: Omit<FavoriteItem, 'addedAt'>[] = [
  { id: 'test-anime-1', kind: 'anime', title: '测试作品 A（动漫）' },
  { id: 'test-manga-1', kind: 'manga', title: '测试作品 B（漫画）' },
  { id: 'test-anime-2', kind: 'anime', title: '测试作品 C（动漫）' },
]

export default function DiscoveryPage() {
  const [type, setType] = useState<'anime' | 'manga'>('anime')
  const [genres, setGenres] = useState<string[]>([])
  const [sort, setSort] = useState<(typeof SORTS)[number]>('热门')
  const [favIds, setFavIds] = useState<Set<string>>(new Set())

  const loadFavs = () => dbGetAll<FavoriteItem>('favorites').then((l) => setFavIds(new Set(l.map((x) => x.id))))
  useEffect(() => { loadFavs() }, [])

  const toggleGenre = (g: string) =>
    setGenres((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]))

  const toggleFav = async (item: Omit<FavoriteItem, 'addedAt'>) => {
    if (favIds.has(item.id)) await dbDelete('favorites', item.id)
    else await dbPut('favorites', { ...item, addedAt: Date.now() })
    loadFavs()
  }

  const summary = `类型：${type === 'anime' ? '动漫' : '漫画'} · 分类：${genres.length ? genres.join('、') : '全部'} · 排序：${sort}`

  return (
    <>
      <header className="page-head">
        <h1>发现</h1>
        <p>按类型、评分探索动漫与漫画</p>
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

      <Section title="本地测试数据" extra="验证收藏用 · 阶段3移除">
        <div className="rows">
          {TEST_ITEMS.map((t) => (
            <button key={t.id} className="row-item" onClick={() => toggleFav(t)}>
              <span className="ric"><Icon name={t.kind === 'anime' ? 'film' : 'book'} size={20} /></span>
              <span className="rmain">
                <div className="rtitle">{t.title}</div>
                <div className="rdesc">点按收藏 / 取消收藏 → 到「收藏」页查看（重启后仍在）</div>
              </span>
              <span style={{ color: favIds.has(t.id) ? 'var(--primary)' : 'var(--muted)', display: 'flex' }}>
                <Icon name="heart" size={18} />
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="结果">
        <EmptyState icon="compass" title="筛选条件已就绪"
          desc={`${summary}\n数据源待接入（阶段 3），接入后此处展示真实结果。`} />
      </Section>
    </>
  )
}
