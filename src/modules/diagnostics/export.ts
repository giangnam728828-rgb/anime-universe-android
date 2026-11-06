/**
 * 总方案·阶段3·第2步·2d：诊断导出白名单构造（纯函数，无副作用）
 *
 * 依据：
 *   - 2d前置《诊断导出技术方案》L341-352：16 字段白名单
 *   - v6.10 不变量 W1：最终记录只能由显式白名单构造
 *   - D6 七项断言（a/b/c/d/d2/e/f）
 *
 * 🔴 硬性禁止（全部为不可协商约束）：
 *   ① 禁止 JSON.stringify(records)
 *   ② 禁止 JSON.stringify(records.map(r => ({ ...r })))
 *   ③ 禁止 Object.assign / 任何对象展开合并
 *   ④ 禁止把 parseSuccess 加入导出（它合法存在于 EvidenceRecord，但【故意】不导出；
 *      这是 D6-d2 的现成反例：字段存在 ≠ 应被导出）
 *
 * 本文件不导入任何 Capacitor 插件，不做 IO，不发起网络请求 —— 纯数据变换，便于单测。
 */
import type { EvidenceRecord } from '../../services/diagnostics/types'

/**
 * 导出白名单（16 个字段，顺序固定）。
 * ⚠️ 未来 EvidenceRecord 新增字段时，只要不显式加入本数组，就不会进入导出结果（D6-d2）。
 */
export const EXPORT_FIELDS = [
  'requestId',
  'attempt',
  'attemptId',
  'sourceId',
  'requestType',
  'stage',
  'status',
  'contentType',
  'durationMs',
  'httpDoneAt',
  'path',
  'failureStage',
  'errorTypeLabel',
  'responseSnippet',
  'finalized',
  'at',
] as const

export type ExportField = (typeof EXPORT_FIELDS)[number]

/** 单条记录的导出形态：仅含白名单 16 字段 */
export type ExportRecord = { [K in ExportField]: EvidenceRecord[K] }

/** 导出文件顶层结构 */
export interface ExportPayload {
  version: 1
  exportedAt: number
  records: ExportRecord[]
}

/**
 * 按白名单逐字段显式构造导出对象。
 * 🔴 逐字段赋值，绝不使用对象合并；即便入参被外部挂载了额外字段也不会带出。
 */
export function toExportRecord(r: EvidenceRecord): ExportRecord {
  const out = {} as ExportRecord
  for (const k of EXPORT_FIELDS) {
    // 逐字段显式取值；undefined 也原样保留（不因缺字段而删除键）
    ;(out as Record<string, unknown>)[k] = r[k]
  }
  return out
}

/**
 * 构造导出载荷（未序列化）。
 * 导出前应先展示 records.length 作为「本次导出条数」。
 */
export function buildExportPayload(
  records: ReadonlyArray<Readonly<EvidenceRecord>>,
  exportedAt: number = Date.now(),
): ExportPayload {
  return {
    version: 1,
    exportedAt,
    records: records.map((r) => toExportRecord(r as EvidenceRecord)),
  }
}

/** 构造导出 JSON 字符串（唯一序列化入口） */
export function buildExportJson(
  records: ReadonlyArray<Readonly<EvidenceRecord>>,
  exportedAt: number = Date.now(),
): string {
  return JSON.stringify(buildExportPayload(records, exportedAt))
}

/** 导出文件名：带时间戳，便于用户区分多次导出 */
export function buildExportFileName(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const ts =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `anime-universe-diag-${ts}.json`
}

/** 旧导出文件的匹配前缀（清理时只删本应用前缀，绝不触碰其它缓存文件） */
export const EXPORT_FILE_PREFIX = 'anime-universe-diag-'
