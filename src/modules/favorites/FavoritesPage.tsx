import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { historyReaderPath, resolveHistorySource } from '../reader/readerRoute'
import Icon from '../../components/Icon'
import { EmptyState, Section } from '../../components/ui'
import { dbGetAll, dbDelete, dbClear, type FavoriteItem, type ReadingHistoryItem } from '../../database/db'

type Tab = 'fav' | 'history'

export default function FavoritesPage() {
  const nav = useNavigate()
  const location = useLocation()
  const [tab, setTab] = useState<Tab>('fav')
  const [favs, setFavs] = useState<FavoriteItem[]>([])
  const [history, setHistory] = useState<ReadingHistoryItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [f, h] = await Promise.all([
      dbGetAll<FavoriteItem>('favorites').then((l) => l.sort((a, b) => b.addedAt - a.addedAt)),
      dbGetAll<ReadingHistoryItem>('reading_history').then((l) => l.sort((a, b) => b.at - a.at)),
    ])
    setFavs(f)
    setHistory(h)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const remove = async (id: string) => { await dbDelete('favorites', id); load() }
  const clearAll = async () => { await dbClear('favorites'); load() }
  const fmt = (ts: number) => new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <>
      <header className="page-head">
        <h1>收藏</h1>
        <p>收藏 · 历史 · 进度 —— 全部保存在本机数据库，重启不丢</p>
      </header>

      <div className="seg" style={{ marginBottom: 16 }}>
        <button className={tab === 'fav' ? 'on' : ''} onClick={() => setTab('fav')}>收藏 ({favs.length})</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>阅读历史</button>
      </div>

      {loading ? (
        <EmptyState icon="heart" title="加载中…" />
      ) : tab === 'fav' ? (
        favs.length === 0 ? (
          <Section title="我的收藏">
            <EmptyState icon="heart" title="暂无收藏"
              desc="去「发现」页把喜欢的作品加入收藏，数据保存在本机 IndexedDB。"
              actionText="去发现页看看" onAction={() => nav('/discovery')} />
          </Section>
        ) : (
          <Section title="我的收藏" extra={<button onClick={clearAll} style={{ color: 'var(--muted)', fontSize: 11.5 }}>清空</button>}>
            <div className="rows">
              {favs.map((f) => (
                <div key={f.id} className="row-item" onClick={() => { if (f.id.startsWith('anilist-')) nav(f.id.replace('-', '/').replace('-', '/')) }}>
                  <span className="ric"><Icon name={f.kind === 'anime' ? 'film' : 'book'} size={20} /></span>
                  <span className="rmain">
                    <div className="rtitle">{f.title}</div>
                    <div className="rdesc">{f.kind === 'anime' ? '动漫' : '漫画'} · 收藏于 {fmt(f.addedAt)}{f.id.startsWith('anilist-') ? ' · 点击查看详情' : ''}</div>
                  </span>
                  <span onClick={(e) => { e.stopPropagation(); remove(f.id) }} aria-label="取消收藏" style={{ color: 'var(--muted)', display: 'flex', padding: 6 }}>
                    <Icon name="x" size={16} />
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )
      ) : (
        <Section title="阅读历史">
          {history.length === 0 ? (
            <EmptyState icon="book" title="暂无阅读记录"
              desc="阅读器将在阶段 4 实现，届时记录章节与进度，支持继续阅读。" />
          ) : (
            <div className="rows">
              {history.map((h) => {
                /**
                 * P1 第4子步：来源判定改造
                 *  - 新记录：优先用 h.sourceId 字段
                 *  - 旧记录（sourceId 为 undefined）：回退到 itemId 前缀判断
                 * 不再用 `startsWith('local-')` 单一条件，也不再手拼 replace。
                 */
                const src = resolveHistorySource(h)
                const canContinue = src.kind !== 'unknown' && !!h.chapterId
                return (
                <div key={h.itemId} className="row-item">
                  <span className="ric"><Icon name="book" size={19} /></span>
                  <span className="rmain">
                    <div className="rtitle">{h.title}</div>
                    <div className="rdesc">
                      {h.chapter} · 进度 {Math.round(h.position * 100)}%
                      {src.kind === 'online' && ' · 在线'}
                    </div>
                  </span>
                  {canContinue && (
                    <button className="badge" style={{ padding: '5px 12px', fontSize: 11.5 }}
                      onClick={() => { const p = historyReaderPath(h); if (p) nav(p, { state: { from: location.pathname } }) }}>
                      继续
                    </button>
                  )}
                </div>
                )
              })}
            </div>
          )}
        </Section>
      )}
    </>
  )
}
