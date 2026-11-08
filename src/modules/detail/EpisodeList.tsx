/**
 * 详情页剧集列表 → 真实播放入口（阶段3·第2步·批次③后续）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个组件
 * ══════════════════════════════════════════════════════════════════════
 * 批次③ 把「解析 → 会话 → 原生播放」贯通了，但真机验收发现：
 * `DetailPage` 的「观看 / 阅读」区对动漫仍是 `EmptyState`（「正片播放待开发」），
 * 全应用**唯一**指向 `/player/...` 的链接是 `ProfilePage` 里硬编码的
 * `/player/selftest/selftest/1`（自检入口）。
 *
 * ⇒ 用户无法带着真实作品参数进入播放页 ⇒ 批次③ 的成果不可见，
 *   且 D4（真实模式失败不回退自检）**无法验证**。
 *   这是功能断点，不是 UI 优化。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 数据来源核实（本步前置）
 * ══════════════════════════════════════════════════════════════════════
 *  `WorkDetail`（sources/types.ts:28-34）**只有** `episodes?: number`（集数总量），
 *  **没有剧集列表、没有每集稳定 id**。
 *
 *  ⇒ 绝不可用「集数总量」或硬编码 `1` 拼出 `/player/.../1`。
 *    那样能进播放页，但路由标识并不对应真实剧集，属伪造标识。
 *    真实剧集只能来自 `PlaybackSourceResolver.getEpisodes(workId)`。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 不可违反的规则
 * ══════════════════════════════════════════════════════════════════════
 *  1. 剧集**必须**来自 `getEpisodes()`，不得从 `episodes?: number` 伪造
 *  2. 无已登记解析器 ⇒ 显示「暂无可用播放源」，**不显示任何播放按钮**
 *  3. 有解析器但无剧集 ⇒ 显示「暂无可用剧集」，**不伪造第一集**
 *  4. 某来源失败不影响其他来源（`allSettled`，单源失败只记该源）
 *  5. 路由的 `sourceId` **必须**是播放源 id，不是内容来源 id
 *  6. 不预取播放候选（`getCandidates` 只在真正点击播放时调用）
 *  7. 不缓存剧集到持久化存储
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Loading, EmptyState } from '../../components/ui'
import { enabledResolvers } from '../../services/playback/registry'
import type { PlaybackEpisode } from '../../services/playback/types'

interface Props {
  /** 内容来源 id（仅用于展示与调试，**不是**播放源 id） */
  contentSourceId: string
  workId: string
  /** 当前详情页路径，用于 state.from */
  fromPath: string
}

/** 单个播放源加载后的状态 */
interface ResolverGroup {
  sourceId: string
  sourceName: string
  episodes: PlaybackEpisode[]
  error?: string
}

export default function EpisodeList({ contentSourceId, workId, fromPath }: Props) {
  const nav = useNavigate()
  const location = useLocation()

  const [groups, setGroups] = useState<ResolverGroup[]>([])
  const [loading, setLoading] = useState(true)

  /** 已登记且启用的解析器（空表是正常状态） */
  const resolvers = useMemo(() => {
    try {
      return enabledResolvers()
    } catch {
      return []
    }
  }, [])

  const load = useCallback(async () => {
    if (resolvers.length === 0) {
      setGroups([])
      setLoading(false)
      return
    }
    setLoading(true)
    // 🔴 allSettled：单源失败不影响其他来源
    const results = await Promise.allSettled(
      resolvers.map(async (r) => {
        const eps = await r.getEpisodes(workId)
        return { sourceId: r.sourceId, sourceName: r.sourceName, episodes: eps ?? [] }
      }),
    )
    const next: ResolverGroup[] = results.map((res, i) => {
      const r = resolvers[i]
      if (res.status === 'fulfilled') return res.value
      return {
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        episodes: [],
        // 不展示原始错误消息（可能含临时地址）
        error: '剧集加载失败',
      }
    })
    setGroups(next)
    setLoading(false)
  }, [resolvers, workId])

  useEffect(() => {
    void load()
  }, [load])

  /** 所有来源的剧集总数 */
  const total = useMemo(
    () => groups.reduce((n, g) => n + g.episodes.length, 0),
    [groups],
  )

  /** 进入播放页：sourceId 必须是**播放源** id */
  const open = (sourceId: string, ep: PlaybackEpisode) => {
    nav(`/player/${sourceId}/${workId}/${ep.id}`, {
      state: { from: fromPath || location.pathname },
    })
  }

  /* ── 空状态 ─────────────────────────────────────────────────────── */

  if (loading) {
    return <Loading text="正在加载剧集…" />
  }

  // 🔴 无已登记解析器：这是首版正常状态，不显示任何播放按钮
  if (resolvers.length === 0) {
    return (
      <EmptyState
        icon="film"
        title="暂无可用播放源"
        desc={
          '当前没有已通过准入的播放来源，因此无法获取剧集列表。\n' +
          '资料来源（AniList 等）只提供作品信息，不提供正片播放。\n' +
          '播放功能只使用经审核的合法来源。'
        }
      />
    )
  }

  // 有解析器但没有任何剧集：不伪造第一集
  if (total === 0) {
    return (
      <EmptyState
        icon="film"
        title="暂无可用剧集"
        desc={'已登记播放来源未返回剧集列表。\n不会用集数总量或默认编号伪造剧集。'}
      />
    )
  }

  /* ── 剧集列表 ───────────────────────────────────────────────────── */

  return (
    <div>
      {groups.map((g) =>
        g.episodes.length === 0 ? null : (
          <div key={g.sourceId} style={{ marginBottom: 16 }}>
            {/* 多来源时显示来源名，单来源时省略以省空间 */}
            {groups.filter((x) => x.episodes.length > 0).length > 1 && (
              <div
                style={{
                  fontSize: 12,
                  color: '#8A8A99',
                  margin: '8px 0',
                }}
              >
                {g.sourceName}
              </div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {g.episodes.map((ep) => (
                <button
                  key={`${g.sourceId}#${ep.id}`}
                  onClick={() => open(g.sourceId, ep)}
                  title={ep.title}
                  style={btnStyle}
                >
                  {ep.episodeNumber != null ? `第 ${ep.episodeNumber} 集` : ep.title}
                </button>
              ))}
            </div>
          </div>
        ),
      )}

      {/* 失败来源单独提示，不隐藏、不伪装成功 */}
      {groups.some((g) => g.error) && (
        <div style={{ fontSize: 12, color: '#FF6B6B', marginTop: 8 }}>
          {groups
            .filter((g) => g.error)
            .map((g) => `${g.sourceName}：${g.error}`)
            .join('　')}
        </div>
      )}

      {/* 内容来源与播放来源不同，明确说明避免误解 */}
      {contentSourceId && contentSourceId !== groups[0]?.sourceId && (
        <div style={{ fontSize: 11, color: '#5A5A68', marginTop: 12, lineHeight: 1.7 }}>
          资料来自 {contentSourceId}，播放来自 {groups.map((g) => g.sourceId).join(' / ')}。
          资料来源 ≠ 播放来源。
        </div>
      )}
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: '#1E1E28',
  border: '1px solid #2E2E3A',
  color: '#C8C8D8',
  borderRadius: 8,
  padding: '8px 14px',
  fontSize: 13,
  cursor: 'pointer',
  minWidth: 72,
  textAlign: 'center',
}
