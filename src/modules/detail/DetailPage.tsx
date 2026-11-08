import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import Icon from '../../components/Icon'
import { Section, EmptyState, Loading, Modal } from '../../components/ui'
import { useAsync } from '../../hooks/useAsync'
import { getSource, SOURCE_NAMES, type Kind, type WorkDetail } from '../../services/sources'
import SourceBadge from '../../components/SourceBadge'
import ProxyCover from '../covers/ProxyCover'
import { isFavorited, toggleFavorite } from '../../database/db'
import { createToken, peek, type EntrySnapshot, type RouteIdentity } from './searchSession'
import ChapterList, { sourceSupportsChapters } from './ChapterList'
import EpisodeList from './EpisodeList'

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

  // ---- 阶段3-5a：会话上下文（只读，不发起任何反查） ----
  // 读取路径是纯计算（peek 不修改模块状态），因此不受 StrictMode 双调用影响
  const location = useLocation()
  const ctxRoute = useMemo<RouteIdentity>(
    () => ({ sourceId, kind: kind as Kind, workId }),
    [sourceId, kind, workId],
  )
  const ctxToken = (location.state as { ctx?: string } | null)?.ctx
  const ctxEntries = useMemo(() => peek(ctxToken, ctxRoute), [ctxToken, ctxRoute])
  /** 排除当前页自身：必须用三元组比对（同一来源可能有 anime/manga 两条） */
  const otherEntries = useMemo(
    () =>
      ctxEntries?.filter(
        (e) => !(e.sourceId === sourceId && e.kind === kind && e.workId === workId),
      ) ?? [],
    [ctxEntries, sourceId, kind, workId],
  )

  /**
   * 阶段3-5b：点击「其他来源」跳转到该来源的详情页。
   * ★ 必须把**完整 ctxEntries**（含当前页自身）作为新上下文传下去，
   *   否则目标页的「其他来源」里会看不到刚刚离开的那一个来源。
   * ★ 令牌重新颁发（绑定目标 route）；由于存储是有界多令牌，
   *   本页令牌不会被覆盖，返回本页时上下文仍在。
   */
  const onPickOther = (target: EntrySnapshot) => {
    if (!ctxEntries) return
    const route = { sourceId: target.sourceId, kind: target.kind, workId: target.workId }
    const token = createToken(ctxEntries, route)
    nav(`/detail/${target.sourceId}/${target.kind}/${target.workId}`, { state: { ctx: token } })
  }

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
          <ProxyCover src={d.cover} sourceId={d.sourceId} eager fallbackIcon={d.kind === 'manga' ? 'book' : 'film'} />
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
        <div className="info-item"><div className="il">数据来源</div><div className="iv"><SourceBadge sourceId={d.sourceId} /></div></div>
      </div>

      {/* 阶段3-5a 展示 / 阶段3-5b 可点击跳转；仍不发起任何反查（留给 3-5c） */}
      <Section title="其他来源">
        {otherEntries.length > 0 ? (
          <div className="rows">
            {otherEntries.map((e) => (
              <button
                key={`${e.sourceId}\u0000${e.kind}\u0000${e.workId}`}
                className="row-item"
                style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }}
                onClick={() => onPickOther(e)}
              >
                <span className="rmain">
                  {/* 标题缺失时退回来源名称，绝不借用其他来源的标题 */}
                  <div className="rtitle">{e.title.trim() || (SOURCE_NAMES[e.sourceId] ?? e.sourceId)}</div>
                  <div className="rdesc"><SourceBadge sourceId={e.sourceId} /></div>
                </span>
                <span style={{ display: 'flex', transform: 'rotate(180deg)', color: 'var(--muted)' }}>
                  <Icon name="chevron" size={15} />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {ctxEntries ? '该作品暂无其他来源' : '暂无其他来源信息'}
          </div>
        )}
      </Section>

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
        {/*
          P1 第7子步：漫画且有章节能力时，渲染真实章节列表。
          条件严格限定：kind === 'manga' && 适配器实现 getChapters && 有 workId。
          其他情况保持原有说明，不误显示章节。
        */}
        {d.kind === 'manga' && !!d.workId && sourceSupportsChapters(d.sourceId) ? (
          <ChapterList
            sourceId={d.sourceId}
            kind={d.kind}
            workId={d.workId}
            fromPath={location.pathname}
          />
        ) : d.kind === 'anime' && !!d.workId ? (
          /*
            批次③后续：动漫真实剧集入口。
            🔴 剧集**只能**来自 PlaybackSourceResolver.getEpisodes()。
               WorkDetail 只有 episodes?: number（集数总量），
               绝不用它或硬编码 1 伪造 episodeId。
            🔴 无已登记解析器时 EpisodeList 内部显示「暂无可用播放源」，
               不渲染任何播放按钮。
          */
          <EpisodeList
            contentSourceId={d.sourceId}
            workId={d.workId}
            fromPath={location.pathname}
          />
        ) : (
          <EmptyState icon="film"
            title={d.kind === 'anime' ? '正片播放待开发' : '漫画阅读待开发'}
            desc={'资料源不提供正片播放或漫画阅读。\n正片播放与漫画阅读器将按规划在阶段 4/后续实现。\n阅读功能只会使用合法开放来源或本地导入内容。'} />
        )}
      </Section>

      <Modal open={note} onClose={() => setNote(false)} title="关于数据来源">
        本页资料来自 <b>AniList</b> 公开 API，仅用于作品信息展示。<br />
        资料来源 ≠ 播放来源 ≠ 漫画章节来源。
      </Modal>
    </div>
  )
}
