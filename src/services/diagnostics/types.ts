/**
 * 诊断核心模块 · 数据类型与常量契约（2a 第一项；实施依据 = 2654 行版
 * 「方案_阶段3第2步_2a_诊断核心模块准备方案.md」§2.1/§2.2 + Q12-1 裁定 + D-23 登记）
 *
 * 边界声明：
 * - 本文件为纯类型与常量，**不含任何运行逻辑**；函数 API 契约见 ./index.ts 的 `DiagnosticsApi`。
 * - 不修改 `src/services/api/nativeHttp.ts`（2b 范围）；不触碰任何 `android/` 目录。
 * - D-23（用户裁定 2026-11-06，Q12-1 选项 A）：`DiagContext` = v6.10 L286 六字段逐字
 *   + 补可选 `path?: string` —— 仅补齐类型契约，不改变运行行为。
 */

// ── 身份三字段（v6.10 §7.5.3；方案 §2.1）──
export type RequestId = string // 逻辑请求标识，【重试循环外】生成
export type Attempt = number // 尝试序号 1,2,...，【循环内】递增
export type AttemptId = string // `${requestId}:${attempt}` —— 唯一 Map 键

// ── 请求类型（★ 联合值严格采用 v6.10 L88，不扩大范围）──
export type RequestType =
  | 'anime_list'
  | 'manga_search'
  | 'anime_detail'
  | 'other'

// ── pending 生命周期（两态，★ Q3 裁定：删除 'finalized'）──
// finalized 不是 PendingState；终结后通过移入 records 并从 pending 删除来表达
export type PendingState = 'in_flight' | 'awaiting_adapter'

// ── 诊断阶段（五态）──
export type DiagStage = 'pending' | 'responded' | 'parsing' | 'parsed' | 'done'

// ── 失败类型（由 stageToFailure 映射）──
export type FailureStage =
  | 'ok'
  | 'network'
  | 'http'
  | 'parse'
  | 'source_error'
  | 'internal_error'

// ── 诊断上下文（Q12-1 裁定：v6.10 L286 六字段逐字段保留原类型、可选性与语义 + D-23 补 path）──
export interface DiagContext {
  sourceId: string
  requestType: RequestType
  attempt: number
  /** ★ 已分配（不等于已登记）；跨尝试不变 */
  requestId?: string
  /** ★★ v6.6：单次尝试唯一身份 = `${requestId}:${attempt}` */
  attemptId?: string
  /** ★★ true=已登记；false/undefined=未登记（untracked 旁路） */
  diagTracked?: boolean
  /**
   * ★ D-23（2a 类型缺口补齐，用户裁定 2026-11-06）：
   * 适配器传入的【原始路径片段】（不含 host/query/fragment）。
   * 证据：v6.10 L286 定义无此字段，但 v6.10 L1892/L1991/L2118 均使用 `ctx.path`。
   * 契约：保持可选，不强制旧调用方提供；只允许在 `beginRequest()` 中写入
   * `PendingRecord.path`（方案 §三/§6.1 唯一赋值点），随后由 `safePath()` 处理，
   * 不得将原始路径直接写入最终记录。
   */
  path?: string
}

// ── 待处理记录（含临时字段，【不入最终记录】）──
export interface PendingRecord {
  requestId: RequestId
  attempt: Attempt
  attemptId: AttemptId
  sourceId: string
  requestType: string
  stage: DiagStage
  /** ★ P4 补齐（v6.10 L242 有；仅 markBusinessCheck() 置 true） */
  businessCheckMarked: boolean
  state: PendingState
  /** ★ 非可选，唯一写入点在 beginRequest() */
  path: string | null
  createdAt: number
  httpDoneAt: number | null
  /** ★ Q4：与初始化写入 null 一致，不用 undefined */
  status: number | null
  contentType: string | null
  durationMs: number | null
  /** ★★ 临时字段，【绝不入最终记录】 */
  rawText: string | null
  /** ★★ 同上 */
  _tmpHeaders?: Record<string, string>

  // ★★ 以下为【内部状态字段】，必须显式声明，绝不复制到 EvidenceRecord
  // ★ P3 裁定：前三项在 beginRequest() 中【显式初始化】，不依赖 undefined 兜底
  /** 初始 false；markParsing() 置 true —— 解析已开始 */
  parseStarted: boolean
  /** 初始 false；markParsed() 置 true（并保证 parseStarted=true） */
  parsedReached: boolean
  /** 初始 'none'；T55 部分提交恢复 */
  commitState: 'none' | 'committing' | 'committed'
  /**
   * ★ 保持可选：只在提交阶段生成，【不】在创建时写虚假时间戳
   * 语义：提交尝试的时间标记（≠ commitState 状态）；
   * 重试提交前必须清除旧值（方案 §7.1 硬断言 ⑤）
   */
  commitAt?: number
}

// ── 提交核实三态（§7.1c：不是 boolean；unknown ≠ not_committed）──
export type CommitCheck = 'committed' | 'not_committed' | 'unknown'

// ── 最终记录（★★ 独立显式接口 —— 类型白名单，第二道防线）──
// 不继承 PendingRecord：从类型层排除 rawText / state / createdAt / businessCheckMarked
// （v6.10 原文用 Omit<>，会把 state/createdAt/businessCheckMarked 一并带入 —— 已裁定改为独立声明）
export interface EvidenceRecord {
  requestId: string
  attemptId: string
  attempt: number
  sourceId: string
  requestType: string
  stage: DiagStage
  status: number | null
  contentType: string | null
  durationMs: number | null
  httpDoneAt: number | null
  path: string | null
  failureStage: FailureStage
  errorTypeLabel: string | null
  /** ≤200；assertNoLeakShape 失败时为 null（不写入） */
  responseSnippet: string | null
  /**
   * ★ T9（用户裁定 A）：解析阶段结果，三态判定（方案 §2.1/§8.9 同一口径，条件互斥且完备）：
   * parsedReached === true                                → true
   * parseStarted === true && parsedReached !== true        → false
   * parseStarted !== true && parsedReached !== true        → null
   * （必须优先判断 parsedReached；不得把第二行简写成 parseStarted===true → false）
   */
  parseSuccess: boolean | null
  finalized: boolean
  at: number
}
// ⚠️ 类型白名单【不等于】运行时防泄漏：终结逻辑必须显式逐字段构造，
//    禁止 ...p / Object.assign / 任何对象合并。

// ── 覆盖率口径常量（方案 §2.2；名称对齐 v6.10:316，如 AWAIT_MAX 而非 AWAITING_MAX）──
export const IN_FLIGHT_MAX = 300
export const AWAIT_MAX = 200
export const RECORDS_MAX = 100
export const RECORD_BYTES_MAX = 1024
export const BUFFER_BYTES_MAX = 100 * 1024
export const SNIPPET_CHARS_MAX = 200
export const AWAIT_TTL_MS = 30_000
