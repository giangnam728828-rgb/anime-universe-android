/**
 * 播放专项阶段1 —— Media3 原生播放器插件 TypeScript 接口
 *
 * 设计约束（用户裁定）：
 *  - 临时播放地址只在会话内有效，**绝不持久化**
 *  - 路由只承载稳定 ID，不承载 URL / Token / 签名参数
 *  - 原生 Activity 只负责播放，不关心视频来自哪个来源
 */

import type { PluginListenerHandle } from '@capacitor/core'

// ---------------------------------------------------------------------------
// 播放状态
// ---------------------------------------------------------------------------

export type PlaybackState =
  | 'idle'
  | 'buffering'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'

// ---------------------------------------------------------------------------
// 错误码（用户 A5 裁定：首版稳定、可扩展）
// ---------------------------------------------------------------------------

export type PlaybackErrorCode =
  | 'PLAYER_INIT_FAILED'
  /** URI 格式错误，或 scheme 不被允许（含 uriKind 与 scheme 不匹配） */
  | 'INVALID_MEDIA_URL'
  /** 本地资源读取 IO 失败（非「不存在」的 IO 错误） */
  | 'MEDIA_LOAD_FAILED'
  /** ★ v2 新增：APK 内置素材不存在（对应 Media3 ERROR_CODE_IO_FILE_NOT_FOUND） */
  | 'MEDIA_RESOURCE_NOT_FOUND'
  /** ★ v2 新增：容器损坏或格式无法解析（对应 Media3 ERROR_CODE_PARSING_*） */
  | 'MEDIA_FORMAT_INVALID'
  | 'DECODER_FAILED'
  | 'PLAYER_RELEASE_FAILED'
  | 'ACTIVITY_LAUNCH_FAILED'
  /** 兜底：原生侧未能归类的异常 */
  | 'UNKNOWN'

// ---------------------------------------------------------------------------
// URI 类型（v2 裁定：显式声明，不依赖 URL 猜测；不设 auto）
// ---------------------------------------------------------------------------

/**
 * 资源类型标识。
 *
 * - `asset`   ：APK 内置资源，URI 形如 `asset:///test.mp4`
 * - `network` ：网络资源，URI 形如 `https://...`
 *
 * ★ 不提供 `auto`：避免同一 URI 因隐式判断产生不同结果。
 *   未传时按 `network` 处理（兼容旧调用）。
 */
export type UriKind = 'asset' | 'network'

// ---------------------------------------------------------------------------
// open() 参数
// ---------------------------------------------------------------------------

export interface Media3PlayerOpenOptions {
  sourceId: string
  workId: string
  episodeId: string
  /**
   * 临时播放地址。
   * ★ 仅在本次播放会话内有效，调用方不得持久化、不得写入路由或日志。
   */
  url: string
  /**
   * 资源类型（v2 新增，可选）。
   *
   * ★ 原生侧会再次校验 `uriKind` 与 URI scheme 是否一致，
   *   不单纯依赖前端传入值（前端字段仅作声明，不作授权依据）。
   * ★ 不传时按 `network` 处理，兼容旧调用。
   */
  uriKind?: UriKind
  /**
   * 可选请求头（如 Referer）。
   * ★ 同样只在会话内有效，不得持久化。
   */
  headers?: Record<string, string>
  /** 标题，仅用于原生侧展示 */
  title?: string
}

export interface Media3PlayerOpenResult {
  opened: boolean
}

// ---------------------------------------------------------------------------
// 事件负载
// ---------------------------------------------------------------------------

export interface PlaybackEventPayload {
  state?: PlaybackState
  errorCode?: PlaybackErrorCode
  /** 可诊断信息；★ 不含 Cookie / Token / 签名 URL 等敏感数据 */
  errorMessage?: string
  positionMs?: number
  durationMs?: number
}

// ---------------------------------------------------------------------------
// 插件接口
// ---------------------------------------------------------------------------

export interface Media3PlayerPlugin {
  /** 打开原生全屏播放 Activity */
  open(options: Media3PlayerOpenOptions): Promise<Media3PlayerOpenResult>

  /** 请求停止并关闭播放器 */
  stop(): Promise<void>

  /** 查询插件是否可用（用于降级判断） */
  isAvailable(): Promise<{ available: boolean }>

  addListener(
    eventName: 'playbackState',
    listener: (data: PlaybackEventPayload) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'playbackError',
    listener: (data: PlaybackEventPayload) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'playbackClosed',
    listener: (data: PlaybackEventPayload) => void,
  ): Promise<PluginListenerHandle>
}
