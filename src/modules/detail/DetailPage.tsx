import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Icon from '../../components/Icon'
import { Section, EmptyState, Loading, Modal } from '../../components/ui'
import { useAsync } from '../../hooks/useAsync'
import { getSource, type Kind, type WorkDetail } from '../../services/sources'
import { isFavorited, toggleFavorite } from '../../database/db'

export const favKeyOf = (sourceId: string, kind: string, workId: string) => `${sourceId}-${kind}-${workId}`

export default function DetailPage() {
  const nav = useNavigate()
  // 有历史则回上一级；无历史(如直接落到详情页)兜底回首页
  const goBack = () => {
    if (window.history.length > 1) nav(-1)
    else nav('/')
  }
  const { sourceId = '', kind = 'anime', workId = '' } = useParams()
  const { loading, data, error, retry } = useAsync<WorkDetail>(
    () => getSource(sourceId).getDetail(kind as Kind, workId),
    [sourceId, kind, workId],
  )
  const [fav, setFav] = useState(false)
  const [note, setNote] = useState(false)

  useEffect(() => {
    isFavorited(favKeyOf(sourceId, kind, workId)).then(setFav)
  }, [sourceId, kind, workId])

  if (loading && !data) return <Loading text="加载详情…" />
  if (error || !data) {
    return (
      <div style={{ paddingTop: 30 }}>
        <EmptyState icon="info" title="加载失败" desc={error || '未知错误'}
          actionText="重试" onAction={retry} />
      </div>
    )
  }

  const d = data
  const onFav = async () => {
    const next = await toggleFavorite({
      id: favKeyOf(d.sourceId, d.kind, d.workId),
      kind: d.kind,
      title: d.title,
      cover: d.cover,
      note: d.sourceId,
    })
    setFav(next)
  }

  return (
    <div style={{ paddingBottom: 90 }}>
      <button onClick={goBack} style={{ display: 'flex', alignItems: 'center', gap: 2, color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
        <span style={{ display: 'flex', transform: 'rotate(180deg)' }}><Icon name="chevron" size={15} /></span>
        返回
      </button>

      <div className="detail-hero">
        <div className="dh-cover">
          {d.cover ? <img src={d.cover} alt="" /> : null}
        </div>
        <div className="dh-info">
          <div className="dh-title">{d.title}</div>
          {d.titleNative && d.titleNative !== d.title && <div className="dh-native">{d.titleNative}</div>}
          {d.score != null && <span className="score-pill">★ {d.score} <span style={{ fontSize: 10, color: 'var(--muted)' }}>/100</span></span>}
          <div className="dh-tags">
            <span className="dh-tag">{d.kind === 'anime' ? '动漫' : '漫画'}</span>
            {d.year && <span className="dh-tag">{d.year}</span>}
            {d.formatCn && <span className="dh-tag">{d.formatCn}</span>}
            {d.statusCn && <span className="dh-tag">{d.statusCn}</span>}
          </div>
          <button className={'fav-btn' + (fav ? ' on' : '')} onClick={onFav}>
            <Icon name="heart" size={16} /> {fav ? '已收藏' : '收藏'}
          </button>
        </div>
      </div>

      <div className="info-table">
        {d.episodes != null && <div className="info-item"><div className="il">集数</div><div className="iv">{d.episodes}</div></div>}
        {d.chapters != null && <div className="info-item"><div className="il">话数</div><div className="iv">{d.chapters}</div></div>}
        {d.volumes != null && <div className="info-item"><div className="il">卷数</div><div className="iv">{d.volumes}</div></div>}
        {d.duration != null && <div className="info-item"><div className="il">单集时长</div><div className="iv">{d.duration} 分钟</div></div>}
        {d.favorites != null && <div className="info-item"><div className="il">收藏人数</div><div className="iv">{d.favorites.toLocaleString()}</div></div>}
        <div className="info-item"><div className="il">数据来源</div><div className="iv" style={{ color: 'var(--accent)' }}>AniList</div></div>
      </div>

      {d.genres.length > 0 && (
        <Section title="分类">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {d.genres.map((g) => <span key={g} className="chip-mini">{g}</span>)}
          </div>
        </Section>
      )}

      {d.studios.length > 0 && (
        <Section title="制作公司">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {d.studios.map((s) => <span key={s} className="chip-mini">{s}</span>)}
          </div>
        </Section>
      )}

      {d.staff.length > 0 && (
        <Section title="主要制作人员">
          <div className="rows">
            {d.staff.map((s, i) => (
              <div key={i} className="row-item" style={{ width: '100%' }}>
                <span className="rmain">
                  <div className="rtitle">{s.name}</div>
                  <div className="rdesc">{s.role}</div>
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {d.description && (
        <Section title="简介">
          <div className="dh-desc">{d.description}</div>
        </Section>
      )}

      <Section title="观看 / 阅读">
        <EmptyState icon="film"
          title={d.kind === 'anime' ? '正片播放待开发' : '漫画阅读待开发'}
          desc={'资料源不提供正片播放或漫画阅读。\n正片播放与漫画阅读器将按规划在阶段 4/后续实现。\n阅读功能只会使用合法开放来源或本地导入内容。'} />
      </Section>

      <Modal open={note} onClose={() => setNote(false)} title="关于数据来源">
        本页资料来自 <b>AniList</b> 公开 API，仅用于作品信息展示。<br />
        资料来源 ≠ 播放来源 ≠ 漫画章节来源。
      </Modal>
    </div>
  )
}
