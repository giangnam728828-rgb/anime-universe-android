/**
 * 播放专项阶段1 —— 统一播放数据结构
 *
 * 🔒 用户裁定（数据分层）：
 *  - 临时播放地址：内存 PlaybackSession，**绝不持久化**
 *  - 播放进度：可持久化（阶段4）
 *  - 播放状态：内存事件流，不持久化
 */

export type PlaybackProtocol = 'hls' | 'progressive'

export interface SubtitleTrack {
  language: string
  label: string
  url: string
}

export interface PlaybackEpisode {
  id: string
  title: string
  episodeNumber?: number
}

export interface PlaybackCandidate {
  sourceId: string
  sourceName: string
  /**
   * ★ 临时播放地址。
   *   仅在当前会话内有效，不得写入 localStorage / IndexedDB /
   *   SharedPreferences / 文件缓存 / 日志 / 路由。
   */
  url: string
  protocol: PlaybackProtocol
  /** ★ 同样的临时性约束；不得持久化 */
  headers?: Record<string, string>
  subtitles?: SubtitleTrack[]
}

export interface PlaybackSession {
  workId: string
  episodeId: string
  candidates: PlaybackCandidate[]
  selectedCandidateId: string
  /** 会话创建时间，用于判断临时地址是否可能已过期 */
  createdAt: number
}

/** 与原生侧错误码对齐（用户 A5 裁定） */
export type PlaybackErrorCode =
  | 'PLAYER_INIT_FAILED'
  | 'INVALID_MEDIA_URL'
  | 'MEDIA_LOAD_FAILED'
  | 'DECODER_FAILED'
  | 'PLAYER_RELEASE_FAILED'
  | 'ACTIVITY_LAUNCH_FAILED'
  | 'UNKNOWN'

export type PlaybackState =
  | 'idle'
  | 'buffering'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'
