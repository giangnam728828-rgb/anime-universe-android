/**
 * 播放专项阶段1 —— 播放调度层
 *
 * 职责隔离（用户架构裁定）：
 *  - 统一管理播放会话
 *  - 来源适配器只负责提供 PlaybackCandidate，不直接控制播放器
 *  - 新增播放源不需要修改播放器核心
 *
 * 🔒 数据分层：
 *  - 临时播放地址：仅存在于内存 session
 *  - 播放进度：可持久化（阶段4 实现）
 *  - 播放状态：内存事件流
 */

import type {
  PlaybackCandidate,
  PlaybackEpisode,
  PlaybackSession,
  PlaybackState,
} from './types'

/** 会话有效期：临时签名地址可能过期，超过则视为需重新解析 */
export const SESSION_TTL_MS = 30 * 60 * 1000

/** 播放器装配契约：每个播放来源实现此接口，不接触播放器 */
export interface PlaybackSourceResolver {
  /** 来源标识，需与 SourceAdapter.id 对应 */
  readonly sourceId: string
  /** 展示名 */
  readonly sourceName: string
  /** 拉取剧集列表 */
  getEpisodes(workId: string): Promise<PlaybackEpisode[]>
  /**
   * 解析播放候选。
   * ★ 返回的 url 为临时地址，调用方不得持久化。
   */
  getCandidates(workId: string, episodeId: string): Promise<PlaybackCandidate[]>
}

// ---------------------------------------------------------------------------
// 会话状态（内存，不持久化）
// ---------------------------------------------------------------------------

let currentSession: PlaybackSession | null = null

export function getCurrentSession(): PlaybackSession | null {
  if (!currentSession) return null
  // 过期则不返回（临时地址可能失效）
  if (Date.now() - currentSession.createdAt > SESSION_TTL_MS) {
    currentSession = null
    return null
  }
  return currentSession
}

/** 清空当前会话（丢弃所有临时播放地址） */
export function clearSession(): void {
  currentSession = null
}

/** 建立会话 */
export function createSession(
  workId: string,
  episodeId: string,
  candidates: PlaybackCandidate[],
): PlaybackSession {
  if (candidates.length === 0) {
    throw new Error('INVALID_MEDIA_URL: 没有可用的播放候选')
  }
  const session: PlaybackSession = {
    workId,
    episodeId,
    candidates,
    selectedCandidateId: candidates[0].sourceId,
    createdAt: Date.now(),
  }
  currentSession = session
  return session
}

/** 切换线路（多线路留待阶段4；此处仅切换选中候选） */
export function selectCandidate(sourceId: string): PlaybackCandidate | null {
  const s = getCurrentSession()
  if (!s) return null
  const c = s.candidates.find((x) => x.sourceId === sourceId)
  if (!c) return null
  s.selectedCandidateId = sourceId
  return c
}

/** 取当前选中候选 */
export function getSelectedCandidate(): PlaybackCandidate | null {
  const s = getCurrentSession()
  if (!s) return null
  return s.candidates.find((x) => x.sourceId === s.selectedCandidateId) ?? s.candidates[0] ?? null
}

// ---------------------------------------------------------------------------
// 播放状态（内存事件流，不持久化）
// ---------------------------------------------------------------------------

let currentState: PlaybackState = 'idle'
const stateListeners = new Set<(s: PlaybackState) => void>()

export function getPlaybackState(): PlaybackState {
  return currentState
}

export function setPlaybackState(s: PlaybackState): void {
  currentState = s
  stateListeners.forEach((fn) => {
    try {
      fn(s)
    } catch {
      /* 监听器异常不影响其他监听器 */
    }
  })
}

export function subscribePlaybackState(fn: (s: PlaybackState) => void): () => void {
  stateListeners.add(fn)
  return () => stateListeners.delete(fn)
}

// ---------------------------------------------------------------------------
// 🔒 明确不做的事
// ---------------------------------------------------------------------------
// 本模块**不得**把 PlaybackCandidate.url / headers 写入：
//   - localStorage
//   - IndexedDB
//   - 任何数据库
//   - 任何日志
// 路由只承载 sourceId / workId / episodeId 等稳定 ID。
