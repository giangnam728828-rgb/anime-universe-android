/**
 * 诊断核心模块 · 生产门面（production facade）
 * 2a 测试钩子落码 + 模块拆分（方案 A；用户裁定 2026-11-06）
 *
 * 结构（方案 §1.6）：
 *   ./internal.ts = 诊断核心逻辑 + 模块状态（pending / records / DIAG_ENABLED / DEP）+ 测试钩子
 *   ./index.ts    = 本文件：生产门面，【只】导出正式公共 API 与 DiagnosticsApi 类型
 *
 * 🔴 本文件【不导出】任何 `__` 测试钩子（V1）；测试请从 './internal'（测试入口）访问。
 * 🔴 正式导出集合（D1/D2 裁定后）= 19 个函数 + DiagnosticsApi 类型：
 *    - `checkCommitted`  → 内部专用，不入生产门面（D1）
 *    - `makeAttemptId`   → 内部专用，不入生产门面（D2；§2.2 未列，继续供 beginRequest 内部使用）
 *    - `assertNoSentinelLeak` → 内部专用（测试入口，不入生产门面；D3）
 *    - 原 `export * from './types'` 保持不变（维持拆分前的类型/常量公共面）
 *
 * 拆分约束：不得改变正式 API 的导出集合、函数引用关系或运行时行为（V-EXPORT / V-BINDING）。
 */
export * from './types'

export {
  // ── 开关 ──
  setDiagEnabled,
  // ── 生命周期 ──
  beginRequest,
  markHttpDone,
  markParsing,
  markParsed,
  markBusinessCheck,
  markDone,
  finalizeInternal,
  // ── 容量 ──
  countInFlight,
  awaitCount,
  enforceAwaitCapacity,
  sweepAwaitingAdapter,
  // ── 校验 / 工具 ──
  validateIdentity,
  safePath,
  maskSnippet,
  assertNoLeakShape,
  stageToFailure,
  safeStage,
  safeErrType,
  // ── ★ 2d 新增（用户裁定 2026-11-06）：正式 API 19 → 22 ──
  isDiagEnabled,
  readExportRecords,
  clearDiagRecords,
} from './internal'

export type { DiagnosticsApi } from './internal'
