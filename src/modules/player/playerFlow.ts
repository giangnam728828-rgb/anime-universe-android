/**
 * 播放流程边界（阶段3·第2步·播放源适配层 · 批次③）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独一层
 * ══════════════════════════════════════════════════════════════════════
 * `PlayerPage` 是 React 组件，本项目**没有 jsdom**（`environment: 'node'`），
 * 组件无法直接单测。因此把「解析 → 会话 → 候选 → 原生参数」这段纯逻辑
 * 抽到本模块，用纯函数 + 注入依赖实现，可完整测试。
 *
 * `PlayerPage` 只负责：状态展示、按钮、调用本模块、把结果交给原生桥。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 三条硬约束（用户批次③ 授权时明确）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 【1】selftest 与 real 严格隔离
 *   - selftest：`asset:///test.mp4`，`uriKind: 'asset'`，不碰解析器
 *   - real：聚合候选 → 会话 → 当前候选 URL，`uriKind: 'network'`
 *   两种模式**不共用**任何地址来源。
 *
 * 【2】real 必须使用当前选中 `candidateId` 对应的 URL
 *   - 绝不使用路由里的 `sourceId`（那是**内容来源**，不是播放来源）
 *   - 播放来源取自 `PlaybackCandidate.sourceId`
 *
 * 【3】真实播放失败绝不回退自检素材
 *   - 本模块**不导出**任何「失败时用自检素材」的路径
 *   - 失败就是失败，交由调用方展示错误
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔒 安全约束
 * ══════════════════════════════════════════════════════════════════════
 *  - 不持久化任何 URL / headers / 候选对象
 *  - 不把解析器原始错误消息透出（可能含完整 URL）
 *  - 不在日志中打印 url
 */
import type { PlaybackSourceResolver } from '../../services/playback/PlaybackService'
import {
  createSession,
  getCurrentSession,
  getSelectedCandidate,
  selectCandidate,
} from '../../services/playback/PlaybackService'
import { resolveCandidates, type AggregateResult } from '../../services/playback/resolve'
import { enabledResolvers } from '../../services/playback/registry'
import type { PlaybackCandidate, PlaybackResolveErrorCode } from '../../services/playback/types'

/** 播放模式：自检 / 真实 */
export type PlayerMode = 'selftest' | 'real'

/** APK 内置自检素材（阶段1 遗留，不得删除） */
export const SELF_TEST_ASSET = 'test.mp4'

/**
 * 自检素材 URI。
 *
 * ★ 必须使用 `asset:///`（Media3 AssetDataSource）。
 * 禁止 `window.location.origin`：本项目 `androidScheme='https'`，
 * `window.location.origin === 'https://localhost'`，该地址只在 WebView 内可达，
 * **原生进程无法访问**（这是上一轮 MEDIA_LOAD_FAILED 的根因）。
 */
export const SELF_TEST_ASSET_URI = `asset:///${SELF_TEST_ASSET}`

/** 交给原生播放器的参数（与 `Media3PlayerOpenOptions` 对齐） */
export interface NativePlaybackParams {
  sourceId: string
  workId: string
  episodeId: string
  url: string
  uriKind: 'asset' | 'network'
  headers?: Record<string, string>
  title?: string
}

/** 真实解析结果 */
export type PrepareRealResult =
  | { ok: true; params: NativePlaybackParams; candidateCount: number }
  | {
      ok: false
      /** 解析阶段错误码；不透明，供 UI 展示 */
      code: PlaybackResolveErrorCode
      /** 面向用户的安全文案（不含 URL） */
      message: string
      /** 诊断用：失败来源 id 列表（不含 URL） */
      failedSources: string[]
    }

/** 可注入依赖（测试用） */
export interface PrepareRealDeps {
  resolvers?: PlaybackSourceResolver[]
  resolve?: typeof resolveCandidates
}

/** 错误码 → 安全文案（🔴 不含任何 URL） */
function safeMessage(code: PlaybackResolveErrorCode): string {
  switch (code) {
    case 'NO_RESOLVER_ENABLED':
      return '暂无可用播放源'
    case 'ALL_SOURCES_FAILED':
      return '所有播放源均未返回可用地址'
    case 'RESOLVE_TIMEOUT':
      return '播放源响应超时'
    case 'EMPTY_CANDIDATES':
      return '播放源未返回任何线路'
    case 'INVALID_CANDIDATES':
      return '播放源返回的地址无效'
    case 'RESOLVE_FAILED':
      return '播放源解析失败'
    default:
      return '播放失败'
  }
}

/**
 * 校验候选是否可用于原生播放。
 *
 * 原生侧 `PlaybackUriValidator` 会再校验一次（不信任前端），
 * 这里先挡掉明显非法的，避免无意义的 Activity 启动。
 */
export function isPlayableCandidate(
  c: PlaybackCandidate | null | undefined,
): c is PlaybackCandidate {
  if (!c) return false
  if (!c.url || typeof c.url !== 'string') return false
  if (!/^https?:\/\//i.test(c.url)) return false
  if (c.protocol !== 'hls' && c.protocol !== 'progressive') return false
  return true
}

/**
 * 真实模式：解析 → 建会话 → 取当前候选 → 转原生参数。
 *
 * 🔴 失败时**绝不**回退自检素材（用户批次③ 硬约束）。
 * 🔴 播放来源取自 `candidate.sourceId`，不是路由的内容来源 `sourceId`。
 */
export async function prepareRealPlayback(
  workId: string,
  episodeId: string,
  deps: PrepareRealDeps = {},
): Promise<PrepareRealResult> {
  const resolvers = deps.resolvers ?? enabledResolvers()
  const doResolve = deps.resolve ?? resolveCandidates

  const agg: AggregateResult = await doResolve(workId, episodeId, resolvers)

  // 聚合失败：不建会话，不回退自检
  if (agg.candidates.length === 0) {
    const code: PlaybackResolveErrorCode = agg.error ?? 'ALL_SOURCES_FAILED'
    return {
      ok: false,
      code,
      message: safeMessage(code),
      failedSources: agg.failed.map((f) => f.sourceId),
    }
  }

  // 建会话（内部会按偏好/排序选默认候选）
  const session = createSession(workId, episodeId, agg)

  // 取当前选中候选（candidateId 精确对应）
  const candidate = getSelectedCandidate()
  if (!isPlayableCandidate(candidate)) {
    return {
      ok: false,
      code: 'INVALID_CANDIDATES',
      message: safeMessage('INVALID_CANDIDATES'),
      failedSources: [],
    }
  }

  return {
    ok: true,
    params: {
      // 🔴 播放来源来自候选，不是路由内容来源
      sourceId: candidate.sourceId,
      workId: session.workId,
      episodeId: session.episodeId,
      url: candidate.url,
      uriKind: 'network',
      headers: candidate.headers,
      title: candidate.sourceName,
    },
    candidateCount: agg.candidates.length,
  }
}

/**
 * 自检模式：只用 APK 内置素材。
 *
 * 🔴 不接触解析器、不建会话、不产生任何网络请求。
 */
export function prepareSelfTestPlayback(
  workId: string,
  episodeId: string,
): NativePlaybackParams {
  return {
    sourceId: 'selftest',
    workId,
    episodeId,
    url: SELF_TEST_ASSET_URI,
    uriKind: 'asset',
    title: '阶段1 自检素材',
  }
}

/** 切换候选结果 */
export type SwitchResult =
  | { ok: true; params: NativePlaybackParams }
  | { ok: false; message: string }

/**
 * 切换到指定候选（`candidateId` 精确选择）。
 *
 * 🔴 必须传 `candidateId`；传 `sourceId` 会失败（同源多线路无法区分）。
 */
export function switchCandidate(
  candidateId: string,
  workId: string,
  episodeId: string,
): SwitchResult {
  const c = selectCandidate(candidateId)
  if (!isPlayableCandidate(c)) {
    return { ok: false, message: '该线路不可用' }
  }
  return {
    ok: true,
    params: {
      sourceId: c.sourceId,
      workId,
      episodeId,
      url: c.url,
      uriKind: 'network',
      headers: c.headers,
      title: c.sourceName,
    },
  }
}

/**
 * 读取当前会话所有可切换候选（供 UI 列表）。
 *
 * 🔴 只返回展示所需的元信息，**不返回 URL**——避免 URL 流入组件状态被意外持久化。
 */
export interface CandidateOption {
  candidateId: string
  sourceId: string
  sourceName: string
  protocol: string
  selected: boolean
}

export function listCandidateOptions(): CandidateOption[] {
  const s = getCurrentSession()
  if (!s) return []
  return s.candidates.map((c) => ({
    candidateId: c.candidateId,
    sourceId: c.sourceId,
    sourceName: c.sourceName,
    protocol: c.protocol,
    selected: c.candidateId === s.selectedCandidateId,
  }))
}
