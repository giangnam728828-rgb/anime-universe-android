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
 *
 * ══════════════════════════════════════════════════════════════════════
 * 批次②（播放源适配层）：会话贯通
 * ══════════════════════════════════════════════════════════════════════
 *  - `createSession` 正式接入聚合结果（`AggregateResult`）
 *  - 全部选择 / 查找 / 切换改用 `candidateId`（修复 D-1）
 *  - 当前候选失效时**自愈**（回落首个并修正 id），不留悬空选择
 *  - 区分「当前会话选择（candidateId）」与「来源偏好（sourceId）」
 *  - 可注入时钟（`__setNowForTest`），使 TTL 可测
 *
 * 🔴 明确不做：
 *  - 不持久化任何临时 URL / headers / 候选对象
 *  - 来源偏好仅内存，应用重启后不保证恢复
 */

import type {
  PlaybackCandidate,
  PlaybackEpisode,
  PlaybackSession,
  PlaybackState,
} from './types'
import type { AggregateResult } from './resolve'

/** 会话有效期：临时签名地址可能过期，超过则视为需重新解析 */
export const SESSION_TTL_MS = 30 * 60 * 1000

/**
 * 当前时钟。
 * 生产环境用 `Date.now()`；测试通过 `__setNowForTest` 注入，使 TTL 边界可测。
 */
let nowFn: () => number = () => Date.now()

/** 仅测试用：注入时钟（传 `null` 恢复真实时间） */
export function __setNowForTest(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now())
}

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

/**
 * 来源偏好（仅内存，绝不持久化）。
 *
 * 🔴 与「当前会话选择」是两个不同概念（用户 Q3 裁定）：
 *   - 当前会话选择：`PlaybackSession.selectedCandidateId`（`candidateId`）
 *   - 来源偏好：本变量（`sourceId`），跨会话保持，应用重启后丢失
 *
 * 不持久化的内容：候选 URL / headers / PlaybackCandidate 对象。
 */
let preferredSourceId: string | null = null

export function getCurrentSession(): PlaybackSession | null {
  if (!currentSession) return null
  // 过期则不返回（临时地址可能失效）
  if (nowFn() - currentSession.createdAt > SESSION_TTL_MS) {
    currentSession = null
    return null
  }
  return currentSession
}

/**
 * 清空当前会话（丢弃所有临时播放地址）。
 *
 * ⚠️ **保留** `preferredSourceId`：来源偏好跨会话有效（用户 Q3 裁定）。
 */
export function clearSession(): void {
  currentSession = null
}

/** 取来源偏好（仅内存；应用重启后为 null） */
export function getPreferredSourceId(): string | null {
  return preferredSourceId
}

/** 仅测试用：重置来源偏好 */
export function __resetPreferredSourceForTest(): void {
  preferredSourceId = null
}

/**
 * 建立会话。
 *
 * 输入是聚合结果（`AggregateResult`）而不是裸候选数组——
 * 这样 `createSession` 只处理「已有候选」的情况，聚合与失败语义留在
 * `resolveCandidates`，职责清晰（方案 §4.2）。
 *
 * 默认选中：
 *   1. 来源偏好对应的候选（若有）
 *   2. 否则 `candidates[0]`（聚合已排好序）
 *
 * 🔴 空候选 ⇒ 抛 `ALL_SOURCES_FAILED`，**不建立空会话**。
 */
export function createSession(
  workId: string,
  episodeId: string,
  agg: Pick<AggregateResult, 'candidates'>,
): PlaybackSession {
  const candidates = agg.candidates
  if (!candidates || candidates.length === 0) {
    throw new Error('ALL_SOURCES_FAILED: 没有可用的播放候选')
  }

  // 默认选中：偏好来源优先，否则首个（聚合已排序）
  let selected = candidates[0]
  if (preferredSourceId) {
    const hit = candidates.find((c) => c.sourceId === preferredSourceId)
    if (hit) selected = hit
  }

  const session: PlaybackSession = {
    workId,
    episodeId,
    candidates,
    selectedCandidateId: selected.candidateId,   // 🔴 candidateId，不是 sourceId
    createdAt: nowFn(),
  }
  currentSession = session
  return session
}

/**
 * 切换候选（按 `candidateId` 精确选择）。
 *
 * 🔴 C3：必须用 `candidateId`；`sourceId` 只标识来源。
 *    用 `sourceId` 查找永远只能取到该来源的第一条候选（D-1 缺陷）。
 *
 * 用户选择不存在的 id ⇒ 返回 `null`，**不改变**当前选择（无副作用）。
 */
export function selectCandidate(candidateId: string): PlaybackCandidate | null {
  const s = getCurrentSession()
  if (!s) return null
  const c = s.candidates.find((x) => x.candidateId === candidateId)
  if (!c) return null
  s.selectedCandidateId = candidateId
  // 记录来源偏好（仅内存）
  preferredSourceId = c.sourceId
  return c
}

/**
 * 取当前选中候选。
 *
 * 🔴 当前候选失效时**自愈**：
 *    若 `selectedCandidateId` 指向的候选已不存在（例如会话被替换/重新解析），
 *    回落到首个候选**并修正会话内的 id**，不留悬空选择。
 *
 *    这与「用户选择不存在的 id」不同：
 *      - 用户选错 ⇒ 无副作用（见 `selectCandidate`）
 *      - 状态不一致 ⇒ 必须自愈（本函数）
 */
export function getSelectedCandidate(): PlaybackCandidate | null {
  const s = getCurrentSession()
  if (!s) return null

  const found = s.candidates.find((x) => x.candidateId === s.selectedCandidateId)
  if (found) return found

  const fallback = s.candidates[0]
  if (fallback) {
    s.selectedCandidateId = fallback.candidateId   // 🔴 修正，不留悬空
    return fallback
  }
  return null
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
