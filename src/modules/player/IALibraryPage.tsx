/**
 * 公共领域动画浏览页（阶段3·第3步·A1）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要独立入口，而不是挂在详情页
 * ══════════════════════════════════════════════════════════════════════
 * 真机验收发现：从 AniList 详情页看不到任何 IA 剧集。
 *
 * 根因是**两个独立的作品 ID 空间**：
 *   AniList  workId = "21" / "5114"（纯数字）
 *   IA       workId = "ia-krazy-kat-1916"（带前缀）
 * 实测 getEpisodes("21") => 0 集，两者无交集，也不存在可信映射。
 *
 * ⇒ IA 是**独立内容集合**，必须有自己入口，不能挂靠在内容源作品下。
 *   这不是 Resolver 的解析能力问题，是入口语义问题。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 不可违反的规则
 * ══════════════════════════════════════════════════════════════════════
 *  1. 作品列表**只能**来自 `APPROVED_WORKS`（经权利核查的硬编码清单）
 *  2. 不扩大清单、不新增网络来源、不复制 MP4 生成多候选
 *  3. `episodeId` 含 `#`，导航时**必须** `encodeURIComponent`
 *     —— 否则 URL 会在 `#` 处截断，fileName 丢失，播放必然失败
 *  4. 不在本页重复解码（React Router 已自动 decodeURIComponent）
 *  5. 本页不发网络请求（getEpisodes 由清单直接生成）
 *  6. 无音轨作品必须明确标记，避免用户误以为音频故障
 *  7. 画质提示必须诚实（IA 仅提供约 240p 转码文件）
 */
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  APPROVED_WORKS,
  IA_SOURCE_ID,
  iaArchiveResolver,
} from '../../services/playback/iaArchive'

/**
 * 构造播放页路径。
 *
 * 🔴 单独抽成纯函数，供测试直接验证「完整路径 + 编码往返」，
 *    而不是只检查源码里出现了 `encodeURIComponent`。
 *
 * `episodeId` 形如 `identifier#fileName`，含 `#`。
 * 不编码时 URL 会在 `#` 处截断，fileName 丢失 ⇒ 播放必然失败。
 */
export function buildPlayerPath(workId: string, episodeId: string): string {
  return `/player/${IA_SOURCE_ID}/${workId}/${encodeURIComponent(episodeId)}`
}

/**
 * 从播放路径还原三个路由参数。
 *
 * 模拟 React Router 对每个 path 段的 decodeURIComponent 行为。
 * 🔴 用于验证编码往返；页面本身不调用此函数（Router 已自动解码），
 *    因此不存在「重复解码」问题。
 */
export function parsePlayerPath(path: string): {
  sourceId: string
  workId: string
  episodeId: string
} | null {
  const m = /^\/player\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path)
  if (!m) return null
  return {
    sourceId: decodeURIComponent(m[1]),
    workId: decodeURIComponent(m[2]),
    episodeId: decodeURIComponent(m[3]),
  }
}

export default function IALibraryPage() {
  const nav = useNavigate()
  /** 正在打开的作品（防止重复点击） */
  const [opening, setOpening] = useState<string | null>(null)
  /** 打开失败提示 */
  const [error, setError] = useState<string>('')

  /**
   * 进入播放页。
   *
   * 🔴 `episodeId` 含 `#`，必须编码。
   *    实测：不编码时 URL 在 `#` 处截断，pathname 只剩 identifier，
   *    getCandidates 的 fileName 校验必然失败。
   */
  const open = useCallback(
    async (workId: string) => {
      setError('')
      setOpening(workId)
      try {
        // getEpisodes 不发网络请求，直接由审核清单生成
        const eps = await iaArchiveResolver.getEpisodes(workId)
        if (eps.length === 0) {
          setError('该作品暂无可用剧集')
          return
        }
        const ep = eps[0]
        // 🔴 必须编码，否则 # 之后的 fileName 会丢失
        nav(buildPlayerPath(workId, ep.id))
      } catch {
        setError('打开失败，请稍后重试')
      } finally {
        setOpening(null)
      }
    },
    [nav],
  )

  return (
    <div style={{ padding: 24, color: '#E8E8F0', maxWidth: 720, margin: '0 auto' }}>
      <button
        onClick={() => nav(-1)}
        style={{
          background: 'transparent',
          border: '1px solid #333',
          color: '#E8E8F0',
          borderRadius: 8,
          padding: '8px 16px',
          marginBottom: 24,
          cursor: 'pointer',
        }}
      >
        ← 返回
      </button>

      <h2 style={{ margin: '0 0 8px' }}>公共领域动画</h2>
      <p style={{ color: '#8A8A99', fontSize: 13, margin: '0 0 20px' }}>
        来自 Internet Archive · 仅收录经权利核查的作品
      </p>

      {error && (
        <div
          style={{
            background: '#2A1A1A',
            border: '1px solid #4A2A2A',
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
            color: '#FF6B6B',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {APPROVED_WORKS.map((w) => (
          <div
            key={w.workId}
            style={{
              background: '#14141C',
              border: '1px solid #26262F',
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
              {w.title}
            </div>
            <div style={{ fontSize: 12, color: '#8A8A99', lineHeight: 1.8 }}>
              {w.year} · {w.creator}
              <br />
              {w.audioStatus === 'no-audio' ? (
                <span style={{ color: '#FFB86B' }}>⚠ 无音轨</span>
              ) : (
                <span>有音轨</span>
              )}
              {' · 约 240p（Internet Archive 转码文件）'}
            </div>
            <button
              onClick={() => open(w.workId)}
              disabled={opening === w.workId}
              style={{
                marginTop: 12,
                background: opening === w.workId ? '#2A2A35' : '#6C5CE7',
                border: 'none',
                color: opening === w.workId ? '#5A5A68' : '#fff',
                borderRadius: 8,
                padding: '8px 18px',
                fontSize: 13,
                cursor: opening === w.workId ? 'not-allowed' : 'pointer',
              }}
            >
              {opening === w.workId ? '打开中…' : '播放 →'}
            </button>
          </div>
        ))}
      </div>

      <p style={{ color: '#5A5A68', fontSize: 12, marginTop: 24, lineHeight: 1.9 }}>
        这些作品因版权保护期届满进入公有领域，仅收录已逐部核查的条目。
        <br />
        画质受 Internet Archive 提供的转码文件限制。
        <br />
        播放地址仅存在于内存会话，不写入任何持久化存储。
      </p>
    </div>
  )
}
