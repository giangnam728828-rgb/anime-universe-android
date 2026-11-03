/**
 * 搜索页状态 store（阶段 3 · 第 7 步）
 *
 * 目标：搜索结果、关键词、范围、进度、错误在**跨越页面卸载**后仍可恢复。
 *
 * 关键设计（已通过 v3.3 设计审查）：
 *  - **单一快照**：所有可见状态收在一个不可变对象里，`useSyncExternalStore` 直接返回引用。
 *  - **初始快照非 null**：模块加载即建稳定空快照，Hook 里没有 null 分支。
 *  - **双序号独立**：作品 workSeq 与资讯 newsSeq 各自单调递增、各自失效，绝不共用。
 *  - **序号镜像同步**：`emitSnapshot` 在展开 patch 之后强制写入两个序号，
 *    因此任何公开方法返回时 `getSnapshot().workSeq === currentWorkSeq()` 恒成立。
 *  - **mapper 不进快照**：`UiKeyMapper` 是有状态可变对象，塞进冻结快照是自相矛盾的契约。
 *    它由本模块独占持有，只能是 store 的写入口推进。
 *  - **三段提交**：会话校验（零副作用） / 准备与计算（mapper 为暂存态，失败整体丢弃） /
 *    提交与通知（不会抛错）。
 *  - **epoch 隔离**：仅计算失败重建 mapper 时推进，保证新旧 UI key 空间不相交。
 *
 * 本模块不含网络调用。
 */
import type { WorkItem } from '../../services/sources'
import { toSourceEntry, dedupWithinSource, aggregate, type SourceEntry } from '../../services/sources/aggregate'
import { createUiKeyMapper, type KeyedGroup } from './uiKeyMap'
import type { NewsItem } from '../../services/news'

export type Scope = 'all' | 'anime' | 'manga' | 'news'

/** 搜索页的完整可见状态快照（冻结，整体替换） */
export interface SearchSnapshot {
  // ── 用户输入 ──
  readonly q: string
  readonly scope: Scope
  /** 已提交搜索的关键词；空串表示"从未搜索" */
  readonly searched: string

  // ── 作品域 ──
  readonly workGroups: readonly KeyedGroup[]
  readonly entries: readonly SourceEntry[]
  readonly workLoading: boolean
  readonly workDone: number
  readonly workTotal: number
  readonly workFailed: Readonly<Record<string, string>>

  // ── 资讯域 ──
  readonly newsResults: readonly NewsItem[]
  readonly newsLoading: boolean
  readonly newsError?: string

  // ── 通用错误 ──
  readonly pipelineError?: string

  // ── 会话序号只读镜像（权威值在模块级计数器）──
  readonly workSeq: number
  readonly newsSeq: number
}

/** 批次提交结果 */
export type CommitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'stale' }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: unknown }

// ─────────────────────────── 模块级私有状态 ───────────────────────────

const EMPTY_GROUPS: readonly KeyedGroup[] = Object.freeze([])
const EMPTY_ENTRIES: readonly SourceEntry[] = Object.freeze([])
const EMPTY_NEWS: readonly NewsItem[] = Object.freeze([])
const EMPTY_FAILED: Readonly<Record<string, string>> = Object.freeze({})

/** 作品会话序号：单调递增，跨挂载不归零 */
let workSeqCounter = 0
/** 资讯会话序号：与作品独立，绝不共用 */
let newsSeqCounter = 0

/** 已提交的条目累积体（只在 commit 的段③ 被替换） */
let entries: SourceEntry[] = []
/** UI key 映射器：有状态可变对象，本模块独占持有 */
let mapper = createUiKeyMapper()
/** key 空间 epoch：仅计算失败重建 mapper 时推进 */
let mapperEpoch = 0

const listeners = new Set<() => void>()

function emptySnapshot(): SearchSnapshot {
  return Object.freeze({
    q: '',
    scope: 'all' as Scope,
    searched: '',
    workGroups: EMPTY_GROUPS,
    entries: EMPTY_ENTRIES,
    workLoading: false,
    workDone: 0,
    workTotal: 0,
    workFailed: EMPTY_FAILED,
    newsResults: EMPTY_NEWS,
    newsLoading: false,
    newsError: undefined,
    pipelineError: undefined,
    workSeq: workSeqCounter,
    newsSeq: newsSeqCounter,
  })
}

/** 当前快照。模块加载即有稳定对象，永不为 null */
let snapshot: SearchSnapshot = emptySnapshot()

// ─────────────────────────── 测试专用故障注入 ───────────────────────────

/** @internal 仅供测试注入故障点；业务组件 / Hook / 生产调用链一律不得引用 */
type FailPoint = 'aggregate' | 'assign' | 'epoch' | null
let failPoint: FailPoint = null

/**
 * @internal 仅供测试使用：设置故障注入点。
 * 每项测试结束后必须恢复为 null，避免测试之间互相污染。
 * 支持且仅支持 'aggregate' | 'assign' | 'epoch' 三个注入点。
 */
export function __setFailPoint(p: 'aggregate' | 'assign' | 'epoch' | null): void {
  failPoint = p
}

// ─────────────────────────── 内部工具 ───────────────────────────

function assertNotFailedAt(p: 'aggregate' | 'assign' | 'epoch'): void {
  if (failPoint === p) throw new Error(`[injected] fail at ${p}`)
}

/**
 * 唯一的快照产出点。
 * ★ 先落定快照，再通知订阅者；
 * ★ 每个订阅者单独 try/catch，单个异常不中断其余、不向调用方抛出；
 * ★ workSeq / newsSeq 放在 ...patch 之后写入，调用方无法覆盖，镜像永不脱节。
 */
function emitSnapshot(patch: Partial<SearchSnapshot>): void {
  snapshot = Object.freeze({
    ...snapshot,
    ...patch,
    workSeq: workSeqCounter,
    newsSeq: newsSeqCounter,
  })
  for (const l of Array.from(listeners)) {
    try {
      l()
    } catch (e) {
      console.error('[searchStore:notify] 订阅者异常', e)
    }
  }
}

/** 推进作品序号（私有；公开方法返回前必须已 emit，保证镜像同步） */
function bumpWorkSeq(): void {
  workSeqCounter += 1
}

/** 推进资讯序号（私有；同上） */
function bumpNewsSeq(): void {
  newsSeqCounter += 1
}

/** 重建 mapper 并推进 epoch：只有计算失败恢复时调用 */
function rebuildMapper(): void {
  mapperEpoch += 1
  mapper = createUiKeyMapper()
}

/** 原地重置作品运行时（私有，只允许 beginWorkSession / clearEmptySearch 调用） */
function resetWorkRuntimeUnsafe(): void {
  entries = []
  // 直接换新实例：语义等价于 reset()，但旧状态在对象层面彻底丢弃。
  // ★ 不推进 epoch：新搜索是干净的重新开始，不是错误恢复；
  //   保持 epoch 才能让 React 在新旧结果间正常 diff（而非整屏重挂载）。
  mapper = createUiKeyMapper()
}

/** 给一批 keyed 结果打上当前 epoch（只改 uiKey 字符串，不动 group 内容） */
function withEpoch(keyed: readonly KeyedGroup[], epoch: number): KeyedGroup[] {
  return keyed.map((k) => ({ group: k.group, uiKey: `e${epoch}:${k.uiKey}` }))
}

/** 计算失败恢复：丢弃暂存 mapper、推进 epoch、只写 pipelineError（不写 workFailed） */
function recoverCommitFailure(error: unknown): void {
  rebuildMapper()
  console.error('[searchStore:commit] 批次提交失败', error)
  emitSnapshot({
    pipelineError: `结果聚合异常：${(error as Error)?.message ?? '未知'}`,
  })
}

// ─────────────────────────── 公共 API ───────────────────────────

/** 订阅快照变化。返回退订函数（幂等） */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 读取当前快照。引用稳定：未变更时多次调用返回同一对象 */
export function getSnapshot(): SearchSnapshot {
  return snapshot
}

/** 当前作品会话序号（只读）。仅供 Hook 的 isAlive 闭包比对 */
export function currentWorkSeq(): number {
  return workSeqCounter
}

/** 当前资讯会话序号（只读） */
export function currentNewsSeq(): number {
  return newsSeqCounter
}

/** 当前 key 空间 epoch（只读，供测试与调试观察） */
export function currentMapperEpoch(): number {
  return mapperEpoch
}

/**
 * 开始新作品会话：**先推进序号**（旧会话立即失效），再重置运行时，最后一次 emit。
 * 只作用于作品域；资讯域字段原样保留。
 * @returns 新序号
 */
export function beginWorkSession(opts: { loading: boolean }): number {
  bumpWorkSeq()
  resetWorkRuntimeUnsafe()
  emitSnapshot({
    workGroups: EMPTY_GROUPS,
    entries: EMPTY_ENTRIES,
    workLoading: opts.loading,
    workDone: 0,
    workTotal: 0,
    workFailed: EMPTY_FAILED,
    // ★ 阶段3第7步行为变更（经用户批准）：新搜索清空上一轮的管线错误
    pipelineError: undefined,
  })
  return workSeqCounter
}

/**
 * 开始新资讯会话：推进资讯序号并置 loading。
 * 保持原有语义：**不清空**旧的 newsError（成功时才清，见 finishNewsSuccess）。
 * @returns 新序号
 */
export function beginNewsSession(): number {
  bumpNewsSeq()
  emitSnapshot({ newsLoading: true })
  return newsSeqCounter
}

/** 资讯成功：写入结果并清除旧错误（阶段3第7步行为变更，经用户批准） */
export function finishNewsSuccess(items: readonly NewsItem[]): void {
  emitSnapshot({ newsResults: items, newsError: undefined, newsLoading: false })
}

/** 资讯失败 */
export function finishNewsFailure(message: string): void {
  emitSnapshot({ newsError: message, newsLoading: false })
}

/** 单独作废作品会话（序号前进，旧批次立即失效） */
export function invalidateWorkSession(): void {
  bumpWorkSeq()
  emitSnapshot({ workLoading: false })
}

/** 单独作废资讯会话 */
export function invalidateNewsSession(): void {
  bumpNewsSeq()
  emitSnapshot({ newsLoading: false })
}

/**
 * 卸载时调用：两个序号同时前进 + 两个 loading 同时归 false，一次 emit。
 * 保留 q / scope / searched / workGroups / entries / 进度 / 错误 / 资讯结果。
 */
export function invalidateAllSessions(): void {
  bumpWorkSeq()
  bumpNewsSeq()
  emitSnapshot({ workLoading: false, newsLoading: false })
}

/**
 * 空关键词分支：作废双会话 + 清空作品运行时 + 清空 searched。
 * 资讯结果保留（保持现有语义），但关闭 newsLoading 并清除 newsError。
 */
export function clearEmptySearch(): void {
  bumpWorkSeq()
  bumpNewsSeq()
  resetWorkRuntimeUnsafe()
  emitSnapshot({
    workGroups: EMPTY_GROUPS,
    entries: EMPTY_ENTRIES,
    workLoading: false,
    workDone: 0,
    workTotal: 0,
    workFailed: EMPTY_FAILED,
    searched: '',
    newsLoading: false,
    newsError: undefined,
    // ★ newsResults 不动；pipelineError 也不动（保持现状）
  })
}

/**
 * 作品批次原子提交。
 *
 * 阶段①：会话序号校验。过期直接返回 stale，零副作用。
 * 阶段②：准备与计算（try 包住全部）。mapper.assign() 在此推进，属**暂存状态**；
 *         withEpoch / Object.freeze 等所有可能失败的准备也都在此段内完成。
 *         任一步失败 → 不提交 entries、不更新作品快照、重建 mapper + 推进 epoch、
 *         只写 pipelineError、不写 workFailed。
 * 阶段③：提交 entries 并 emit。此处不含任何可能抛错的计算。
 */
export function commitWorkBatch(expectedWorkSeq: number, batch: readonly WorkItem[]): CommitResult {
  // ── 阶段① 会话校验（零副作用）──
  if (expectedWorkSeq !== workSeqCounter) return { ok: false, reason: 'stale' }

  // ── 阶段② 准备与计算 ──
  let nextEntries: SourceEntry[]
  let patch: { workGroups: readonly KeyedGroup[]; entries: readonly SourceEntry[] }
  try {
    const accepted: SourceEntry[] = []
    for (const w of batch) {
      const e = toSourceEntry(w, undefined, () => {})
      if (e) accepted.push(e)
    }
    nextEntries = entries.concat(accepted)

    assertNotFailedAt('aggregate')
    const deduped = dedupWithinSource(nextEntries)
    const groups = aggregate(deduped.map((e) => e.item))

    assertNotFailedAt('assign')
    const keyed = mapper.assign(groups)

    // ★ 所有可能抛错的准备都必须在段② 内完成，不能拖到段③
    assertNotFailedAt('epoch')
    const keyedWithEpoch = withEpoch(keyed, mapperEpoch)
    const frozenGroups = Object.freeze(keyedWithEpoch)
    const frozenEntries = Object.freeze(nextEntries.slice())
    patch = { workGroups: frozenGroups, entries: frozenEntries }
  } catch (error) {
    recoverCommitFailure(error)
    return { ok: false, reason: 'failed', error }
  }

  // ── 阶段③ 提交与通知（不含可能抛错的计算）──
  entries = nextEntries
  emitSnapshot(patch)
  return { ok: true }
}

/** 通用状态补丁（如 q / scope / searched / workTotal / workDone / workFailed / enabledMap 以外的字段） */
export function patchSnapshot(patch: Partial<SearchSnapshot>): void {
  emitSnapshot(patch)
}
