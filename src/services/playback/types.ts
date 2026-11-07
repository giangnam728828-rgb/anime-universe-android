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
  /**
   * ★ 候选唯一标识（播放源适配层 · 批次①，修复 D-1）。
   *
   * 为什么不能只用 sourceId 定位：
   *   同一来源可返回**多条线路**（`getCandidates` 返回数组正是为此设计），
   *   用 `sourceId` 查找永远只能取到该来源的第一个候选 ⇒ 同源多线路切换失效。
   *
   * 🔴 三条身份约束（用户审查追加，不可违反）：
   *   C1  `index` 必须是**单个 Resolver 原始候选列表**的零基索引，
   *       不得使用聚合后的全局索引（排序一变身份就变）
   *   C2  聚合过程不得重新生成或覆盖已有 candidateId
   *   C3  所有选择 / 查找 / 切换 / 会话状态更新必须用 candidateId；
   *       sourceId 只负责标识来源
   *
   * 格式：`${sourceId}#${index}`
   */
  candidateId: string
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

/** 与原生侧错误码对齐（用户 A5 裁定 + v2 修订） */
export type PlaybackErrorCode =
  | 'PLAYER_INIT_FAILED'
  /** URI 格式错误，或 scheme 不被允许（含 uriKind 与 scheme 不匹配） */
  | 'INVALID_MEDIA_URL'
  /** 本地资源读取 IO 失败（非「不存在」的 IO 错误） */
  | 'MEDIA_LOAD_FAILED'
  /** ★ v2 新增：APK 内置素材不存在 */
  | 'MEDIA_RESOURCE_NOT_FOUND'
  /** ★ v2 新增：容器损坏或格式无法解析 */
  | 'MEDIA_FORMAT_INVALID'
  | 'DECODER_FAILED'
  | 'PLAYER_RELEASE_FAILED'
  | 'ACTIVITY_LAUNCH_FAILED'
  | 'UNKNOWN'

/* ══════════════════════════════════════════════════════════════════════
 * 解析阶段错误码（与 PlaybackErrorCode 严格分层）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 为什么单独建一个类型，而不是加进 `PlaybackErrorCode`：
 *   - `PlaybackErrorCode` 与原生侧 `definitions.ts` **严格对齐**，
 *     加 TS-only 的码会破坏对齐（原生不认识，事件回传时会退化为 UNKNOWN）
 *   - 解析阶段错误**永远不会传到原生**（没候选就不会 openNativePlayer）
 *   - 两类错误的消费方不同：解析错误给 PlayerPage 展示，播放错误来自原生事件
 *
 * 五种情形必须可区分（用户审查明确要求）：
 *   没有注册任何播放源   → NO_RESOLVER_ENABLED   （聚合层）
 *   所有来源解析失败     → ALL_SOURCES_FAILED    （聚合层）
 *   单个来源超时         → RESOLVE_TIMEOUT       （单源明细）
 *   单个来源返回空候选   → EMPTY_CANDIDATES      （单源明细）
 *   单个来源返回无效候选 → INVALID_CANDIDATES    （单源明细）
 */
export type PlaybackResolveErrorCode =
  /** 聚合层：所有来源都没有产出可用候选（**不是**单源失败即返回） */
  | 'ALL_SOURCES_FAILED'
  /** 聚合层：没有任何注册/启用的播放源（首版常态，不是异常） */
  | 'NO_RESOLVER_ENABLED'
  /** 单源：等待超过 RESOLVE_TIMEOUT_MS（逻辑超时，非底层取消） */
  | 'RESOLVE_TIMEOUT'
  /** 单源：解析过程抛错（网络 / 解析 / 格式） */
  | 'RESOLVE_FAILED'
  /** 单源：解析成功但返回空候选数组 */
  | 'EMPTY_CANDIDATES'
  /** 单源：返回候选但字段非法（无 url / 非 http(s) / 缺 protocol） */
  | 'INVALID_CANDIDATES'

export type PlaybackState =
  | 'idle'
  | 'buffering'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'
