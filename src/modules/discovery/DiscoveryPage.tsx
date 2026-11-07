import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chip, EmptyState, Section, Loading } from '../../components/ui'
import WorkCard from '../../components/WorkCard'
import type { WorkItem, Kind } from '../../services/sources'
import { GENRE_MAP } from '../../services/sources/anilist'
import { useDiscoverFeed } from './useDiscoverFeed'

const SORTS = ['热门', '最新', '评分'] as const

export default function DiscoveryPage() {
  const nav = useNavigate()
  const [type, setType] = useState<Kind>('anime')
  const [genreEn, setGenreEn] = useState<string | null>(null)
  const [sort, setSort] = useState<(typeof SORTS)[number]>('热门')

  // 阶段3第6步：渐进渲染 + 来源开关 + 健康记忆 + 发现页专用请求策略
  // 方案丙 v3：hook 直接给出 view / status（快照与生命周期已解耦）
  const { items, error, failed, blocked, view, status, retry } = useDiscoverFeed(type, genreEn, sort)

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
        {view === 'blocked' && blocked ? (
          <EmptyState icon="info" title={blocked.title} desc={blocked.message} />
        ) : view === 'loading' ? (
          <Loading />
        ) : view === 'error' ? (
          <EmptyState icon="info" title="加载失败" desc={error ?? ''} actionText="重试" onAction={retry} />
        ) : view === 'no-result' ? (
          <EmptyState
            icon="info"
            title="暂无可展示结果"
            desc={
              failed.length > 0
                ? `部分来源加载失败：${failed.join('、')}`
                : '请稍后重试。'
            }
            actionText="重试"
            onAction={retry}
          />
        ) : view === 'unconfirmed' ? (
          <EmptyState
            icon="compass"
            title="本次未获得可展示结果"
            desc="暂时无法确认该条件下是否有内容，可稍后重试。"
            actionText="重试"
            onAction={retry}
          />
        ) : (
          <>
            <div className="work-grid">
              {items.map((w) => <WorkCard key={w.sourceId + w.workId} w={w} onClick={() => open(w)} />)}
            </div>
            {status.kind !== 'none' && (
              <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginTop: 8 }}>
                {status.text}
              </div>
            )}
            {/* 失败来源明细：partial-failure 也要展示，否则只剩数量、无法定位 */}
            {status.kind !== 'none' && failed.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginTop: 4 }}>
                {failed.join('、')} 未返回
              </div>
            )}
          </>
        )}
      </Section>
    </>
  )
}
