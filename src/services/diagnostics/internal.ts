/**
 * 诊断核心模块 · 内部实现 + 模块状态 + 测试钩子
 * （2a 测试钩子落码，用户裁定 2026-11-06；模块拆分方案 A）
 *
 * ⚠️ 本文件【不是】生产入口：生产入口为 ./index.ts（仅 re-export 正式公共 API）。
 *   - D1 裁定：`checkCommitted` 内部专用（不入生产门面）
 *   - D2 裁定：`makeAttemptId` 内部专用（不入生产门面）
 *   - 测试钩子（`__diagSnapshot`/`__isDiagEnabled`/`__maskJsonValue`/`__setTestDep`/`__resetTestDep`）
 *     与 `assertNoSentinelLeak` 仅在本模块导出，供测试入口访问。
 *
 * 原依据：诊断核心模块 · 公共 API（2a 第二项：§三 `beginRequest()` + 必要依赖）
 * 实施依据 = 2684 行版「方案_阶段3第2步_2a_诊断核心模块准备方案.md」
 *   §三 L377-447（五步顺序）、§3.1（身份校验）、§6.1/§6.1a/§6.1b（safePath 完整链）
 *   + 用户裁定 2026-11-06（第二项范围 = 选项 A）。
 *
 * 边界声明（用户裁定原文要点）：
 * - 本项实现：`beginRequest` + `validateIdentity`/`makeAttemptId` + `DIAG_ENABLED`
 *   + `pending` 模块级 Map + `countInFlight` + `safePath`（§6.1 必要依赖）。
 * - **不提前实现** §四 状态机、§五 失败映射、§六 其余机制（maskSnippet/assertNoLeakShape）、
 *   §七 终结核心（finalizeInternal/TTL 清理）；这些方法仍只存在于 `DiagnosticsApi` 契约中。
 * - **不添加**抛错 stub；本文件只导出【已实现的】函数，未实现的保持契约不导出运行时版本。
 * - 不接入 nativeHttp.ts（2b）、适配器（2c）、UI（2d）、CI（2e）；不触碰 android/。
 * - 类型与常量统一自 ./types 再导出。
 */
export * from './types'

import type {
  AttemptId,
  CommitCheck,
  DiagContext,
  EvidenceRecord,
  FailureStage,
  PendingRecord,
} from './types'
import { IN_FLIGHT_MAX, AWAIT_MAX, AWAIT_TTL_MS, RECORDS_MAX } from './types'

/* ══════════════════════════════════════════════════════════════
 * 模块开关（v6.10 L2760：默认关闭）
 * T6 开关测试（§8.2）与 2c 接入启用均需切换；导出 setter 属
 * 「实现模块开关」语义（方案 §一）的组成部分。
 * ══════════════════════════════════════════════════════════════ */
let DIAG_ENABLED = false
export function setDiagEnabled(v: boolean): void {
  DIAG_ENABLED = v
}

/**
 * ★ 2d 新增（用户裁定 2026-11-06，方案 A）：读取当前诊断开关真实状态。
 * 与 setDiagEnabled 职责对称；只读，不触碰 pending / records，无副作用。
 * 不使用测试钩子 __isDiagEnabled（V1：测试钩子禁入生产门面）。
 */
export function isDiagEnabled(): boolean {
  return DIAG_ENABLED
}

/* ══════════════════════════════════════════════════════════════
 * 模块级状态（C1：pending.set() 唯一写入点 = beginRequest 内）
 * T45-a：new Map() 声明唯一。
 * ══════════════════════════════════════════════════════════════ */
const pending = new Map<AttemptId, PendingRecord>()
/** §7.1 records：已终结记录（内存有界取证；§7.1b 同进程，非跨进程持久化） */
const records: EvidenceRecord[] = []

/* ══════════════════════════════════════════════════════════════
 * ★ 2d 新增：导出读取 + 缓冲清空（用户裁定 2026-11-06）
 *
 * 设计约束（全部为硬性）：
 * ① readExportRecords() 返回【深拷贝快照】，调用方修改不得污染内部 records。
 * ② 不暴露 PendingRecord、不暴露 pending Map、不暴露可变引用。
 * ③ 仅返回 EvidenceRecord —— 【不等于】导出白名单：
 *    导出层必须由 export.ts 重新按 16 字段白名单逐字段构造，
 *    ⚠️ 严禁 JSON.stringify(readExportRecords()) 或 {...r} 直接序列化。
 * ④ clearDiagRecords() 只清 records，不碰 pending / 开关 / 其它任何状态。
 * ⑤ 关闭诊断的正确顺序（唯一）：setDiagEnabled(false) → clearDiagRecords()，
 *    同一同步块内，中间不得 await。
 * ══════════════════════════════════════════════════════════════ */

/**
 * 返回诊断记录的只读深拷贝快照（供导出层使用）。
 * 🔴 仅供诊断导出页面内部使用，不作为通用 UI 数据接口。
 * 🔴 返回值不等于导出白名单，导出必须另行按 16 字段显式构造。
 */
export function readExportRecords(): ReadonlyArray<Readonly<EvidenceRecord>> {
  return structuredClone(records)
}

/**
 * 清空诊断内存缓冲，返回清理前的记录数量。
 * 🔴 只清 records；不清理 pending；不改变开关；不改变其它配置或业务状态。
 */
export function clearDiagRecords(): number {
  const n = records.length
  records.length = 0
  return n
}

/* ══════════════════════════════════════════════════════════════
 * §3.1 身份工具（v6.10 L1821-1823）
 * ══════════════════════════════════════════════════════════════ */
export function makeAttemptId(requestId: string, attempt: number): string {
  return `${requestId}:${attempt}`
}

/**
 * ★★ v6.8 身份字段防御性校验（注册入口，不依赖调用方守约）。
 * v6.10 L1824-1837 逐字实现；返回 null=通过，否则返回错误消息。
 * 调用端用 `idErr !== null` 判断失败。
 */
export function validateIdentity(ctx: DiagContext): string | null {
  if (typeof ctx.requestId !== 'string' || ctx.requestId.length === 0)
    return 'requestId 必须是非空字符串'
  if (!Number.isInteger(ctx.attempt) || ctx.attempt <= 0)
    return 'attempt 必须是正整数'
  if (typeof ctx.attemptId !== 'string' || ctx.attemptId.length === 0)
    return 'attemptId 必须是非空字符串'
  if (ctx.attemptId !== makeAttemptId(ctx.requestId, ctx.attempt))
    return 'attemptId 与 requestId/attempt 不一致' // ★ 三字段一致性
  return null // null = 通过
}

/* ══════════════════════════════════════════════════════════════
 * §2.2 容量统计：只数 state==='in_flight'（D-7/Q2）
 * 写法对齐 v6.10 awaitCount（L863-866）：遍历 pending.values()。
 * ══════════════════════════════════════════════════════════════ */
export function countInFlight(): number {
  let n = 0
  for (const r of pending.values()) if (r.state === 'in_flight') n++
  return n
}

/* ══════════════════════════════════════════════════════════════
 * §6.1 safePath 完整链（v6.10 L1318-1362 + D-20/D-21 + §6.1a/§6.1b 修订）
 * 常量与 normalize 按 v6.10 L1289-1292 / L1312-1317。
 * ══════════════════════════════════════════════════════════════ */
const SENSITIVE_PATH = /token|cookie|key|secret|sessdata|session|credential|auth/i // :1289
const MAX_DECODE = 3 // :1290
const RESIDUAL_ENC = /%[0-9a-f]{2}/i // :1291
const DOT_SEG_RE = /(^|\/)\.\.?(\/|$)/ // :1292 ★ . 或 .. 【路径段】，非字符串包含

/** v6.10 L1312-1317：仅用于【检测】，不做点段归一化入库 */
function normalize(p: string): string {
  const segs = p.split('/').filter((x) => x !== '' && x !== '.')
  const st: string[] = []
  for (const x of segs) {
    if (x === '..') {
      if (st.length) st.pop()
    } else {
      st.push(x)
    }
  }
  return '/' + st.join('/')
}

/**
 * §6.1a 修订版 extractRawPath（2a 偏离，非 v6.10 原文）。
 * 只加两个判定（D-20 / D-21），其余分支逐字保留 v6.10 L1295-1310。
 * 实施约束 A-1/A-2/A-3 必须满足（顺序不可调换）。
 */
function extractRawPath(input: string): { ok: true; path: string } | { ok: false } {
  let s = String(input)
  const h = s.indexOf('#')
  if (h >= 0) s = s.slice(0, h) // ① 剥离 fragment（同原文）
  const q = s.indexOf('?')
  if (q >= 0) s = s.slice(0, q) // ② 剥离 query（同原文）

  // ★★ D-20：协议相对路径 → 拒绝（必须先于所有 scheme 判定，A-1）
  if (s.startsWith('//')) return { ok: false }

  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(s) // ③ 带 '//' 的 scheme（捕获组，A-3）
  if (m) {
    // ★★ D-21：白名单判定必须在【剥离 authority 之前】（A-2）
    const scheme = m[1].toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return { ok: false }
    const rest = s.slice(m[0].length)
    const slash = rest.indexOf('/') // ★ 跳过 authority（含 userinfo）
    s = slash >= 0 ? rest.slice(slash) : '/' // 无路径 → '/'
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
    return { ok: false } // 不带 '//' 的 scheme → 拒绝（同原文）
  }
  if (!s.startsWith('/')) s = '/' + s // ④ 相对路径统一前缀（同原文）
  return { ok: true, path: s }
}

/**
 * §6.1 safePath 完整链。
 * 输出约定：rawPath / '[REDACTED_PATH]' / '[INVALID_URL]'。
 * 阶段 5 按 §6.1b：checkSet 一次性构造（variants ∪ 各自 normalize），不回写 variants。
 */
export function safePath(input: string): string {
  try {
    if (typeof input !== 'string' || !input) return '[REDACTED_PATH]'

    // ── 阶段 0：在【完整原始输入】上检测（先于提取）──
    if (input.includes('\\')) return '[REDACTED_PATH]' // 反斜杠
    if (SENSITIVE_PATH.test(input)) return '[REDACTED_PATH]' // 敏感词
    if (/%2e%2e|%2E%2E/i.test(input)) return '[REDACTED_PATH]' // 带码点段

    // ── 阶段 1：extractRawPath（§6.1a 修订版，含 D-20/D-21）──
    const ex = extractRawPath(input)
    if (!ex.ok) return '[REDACTED_PATH]'
    const rawPath = ex.path

    // ── 阶段 2：rawPath 点段检查 ──
    if (DOT_SEG_RE.test(rawPath)) return '[REDACTED_PATH]'

    // ── 阶段 3：URL 解析（仅用于【检测】，绝不作为返回值）──
    let viaUrl = ''
    try {
      viaUrl = new URL(input, 'https://placeholder.local').pathname
    } catch {
      return '[INVALID_URL]'
    }

    // ── 阶段 4：有限解码（≤ MAX_DECODE=3 轮；variants 初始含 rawPath 与 viaUrl）──
    const variants: string[] = [rawPath, viaUrl]
    let cur = rawPath
    let hitLimit = false
    for (let i = 0; i < MAX_DECODE; i++) {
      let next: string
      try {
        next = decodeURIComponent(cur)
      } catch {
        return '[REDACTED_PATH]' // 解码异常 → 拒绝
      }
      if (next === cur) break
      variants.push(next)
      cur = next
      if (DOT_SEG_RE.test(next)) return '[REDACTED_PATH]' // 每轮都查点段
      if (i === MAX_DECODE - 1 && RESIDUAL_ENC.test(next)) hitLimit = true
    }
    if (hitLimit) return '[REDACTED_PATH]' // ★ 3 轮后仍有 %XX 残留 → 保守拒绝

    // ── 阶段 5：对【全部】变体各生成一个 normalize 检测值（§6.1b：不回写 variants）──
    const checkSet: string[] = [...variants, ...variants.map((v) => normalize(v))]
    for (const v of checkSet) if (SENSITIVE_PATH.test(v)) return '[REDACTED_PATH]'

    // ★★ 返回值：独立提取的【原始 pathname】（绝不是 URL.pathname）
    return rawPath.length > 500 ? rawPath.slice(0, 500) + '…[TRUNCATED]' : rawPath
  } catch {
    return '[INVALID_URL]'
  }
}

/* ══════════════════════════════════════════════════════════════
 * §三 beginRequest 五步创建顺序（v6.10 L2082 最终权威版，顺序不可调换）
 * ① 身份校验（先于一切，不被 diagTracked 短路）
 * ② 上下文幂等（diagTracked，不是 Map 查询）
 * ③ 重复注册检查（pending.has + 身份核对；先于容量检查）
 * ④ 容量检查（只限制【新登记】）
 * 登记（pending.set 全代码库唯一写入点，C1）
 * ══════════════════════════════════════════════════════════════ */
export function beginRequest(ctx: DiagContext | undefined): string | undefined {
  // ★ 返回契约保留 v6.10 的 `string | undefined`（§3.3：D-11 非偏离）
  try {
    if (!ctx || !DIAG_ENABLED) return undefined

    // ══════════ ① 身份校验（先于一切，不被 diagTracked 短路）══════════
    // v6.9 教训：diagTracked 提前返回曾绕过此步
    const idErr = validateIdentity(ctx) // ★ 返回 string | null
    if (idErr !== null) {
      ctx.diagTracked = false // 身份损坏 → 撤销登记标记
      return ctx.requestId // ★ 不登记，原请求照常
    }

    // ══════════ ② 幂等（上下文标记，【不是】Map 查询）══════════
    if (ctx.diagTracked) return ctx.requestId

    // ══════════ ③ 重复注册检查（★ v6.10：先于容量检查）══════════
    if (pending.has(ctx.attemptId!)) {
      const existing = pending.get(ctx.attemptId!)!
      // ★ 不能仅凭「Map 键相同」就认定登记成功
      if (existing.requestId !== ctx.requestId || existing.attempt !== ctx.attempt) {
        ctx.diagTracked = false // 键碰撞但身份不一致 → 不认成功
        return ctx.requestId
      }
      ctx.diagTracked = true // 身份一致 → 确认已是登记状态
      return ctx.requestId
    }

    // ══════════ ④ 容量检查（★ 只限制【新登记】）══════════
    if (countInFlight() >= IN_FLIGHT_MAX) {
      ctx.diagTracked = false // untracked 旁路，业务不受影响
      return ctx.requestId
    }

    // ══════════ 登记（pending.set() 全代码库唯一写入点）══════════
    try {
      pending.set(ctx.attemptId!, {
        // ★★ 键 = attemptId，不是 requestId
        requestId: ctx.requestId!,
        attemptId: ctx.attemptId!,
        attempt: ctx.attempt,
        sourceId: ctx.sourceId,
        requestType: ctx.requestType,
        stage: 'pending', // ★ Q1 裁定：不用 v6.10 的 'http'（非法值）
        businessCheckMarked: false,
        state: 'in_flight',
        path: ctx.path != null ? safePath(ctx.path) : null, // ★★ path 唯一赋值点
        createdAt: Date.now(),
        httpDoneAt: null,
        status: null,
        contentType: null,
        durationMs: null,
        rawText: null,
        // ── 2a 新增内部状态字段（v6.10 无，必须显式初始化）──
        parseStarted: false,
        parsedReached: false,
        commitState: 'none',
        // ★ commitAt 【不在创建时赋值】—— 它是提交尝试的时间标记，
        //   只在 finalizeInternal 阶段 2 构造 rec 时写入；重试前须清除旧值。
      })
      ctx.diagTracked = true
    } catch {
      ctx.diagTracked = false // ★ 建表失败 → 视为 untracked
    }
    return ctx.requestId // ★ 新登记成功
  } catch {
    // ★ 用可选链：ctx 可能为 undefined，此处若写 ctx.requestId 会在 catch 内二次抛异常
    return ctx?.requestId // ★ 全局静默：异常绝不冒泡影响业务
  }
}

/* ══════════════════════════════════════════════════════════════
 * §四 双维度状态机与容量规则（v6.10 L798-832 + §4.1~§4.4 伪代码）
 * ① markHttpDone（4.1）：in_flight→awaiting_adapter 唯一迁移点；
 *    kind='ok' 才推进 stage→responded + 写 HTTP 字段；输入校验先于任何状态变更。
 * ② markParsing/markParsed/markBusinessCheck/markDone（4.2）：只校验记录存在，
 *    不校验 state；回退边界属设计未定义项（4.2a，由调用顺序+终结即删除保证）。
 * ③ enforceAwaitCapacity（4.3）：仅 awaiting_adapter，httpDoneAt 升序淘汰至 200。
 * ④ sweepAwaitingAdapter（4.4）：仅 awaiting_adapter，TTL 30s。
 * ══════════════════════════════════════════════════════════════ */

/** §2.2 容量统计：只数 state==='awaiting_adapter'（v6.10 L863-866） */
export function awaitCount(): number {
  let n = 0
  for (const r of pending.values()) if (r.state === 'awaiting_adapter') n++
  return n
}

/** §4.1 markHttpDone 精确语义（v6.10 L798-812；D-13/D-15） */
export function markHttpDone(
  attemptId: string | undefined,
  r?: { status: number; ms: number },
  kind: 'ok' | 'network' = 'ok',
  contentType?: string | null,
): void {
  // ★ D-13：v6.10 形参叫 rid 而函数体用 attemptId（未定义变量），2a 统一形参名
  try {
    if (!attemptId || !DIAG_ENABLED) return

    // ★★ 输入校验【必须先于任何状态变更】（4.1-a：kind='ok' 却无 r → 整体静默）
    if (kind === 'ok' && !r) return

    const p = pending.get(attemptId) // ★ 以 attemptId 定位
    if (!p) return // untracked/已清理 → 静默

    if (p.state !== 'in_flight') return // ★ 仅允许 in_flight → awaiting_adapter
    //   已是 awaiting_adapter → 忽略，不重置 httpDoneAt

    p.state = 'awaiting_adapter'
    p.httpDoneAt = Date.now() // ★ 仅首次迁移写入

    if (kind === 'ok') {
      p.stage = 'responded' // ★★ 首次推进 stage（v6.10 原文如此）
      p.status = r!.status // ★ !r 已在前置校验排除
      p.contentType = contentType ?? null // ★ 独立入参
      p.durationMs = r!.ms
    }
    // kind='network' → stage 保持 'pending'；HTTP 字段保持初始化时的 null

    enforceAwaitCapacity() // ★ 迁移后立即容量控制
  } catch { /* 静默 */ }
}

/** §4.2 markParsing：stage='parsing' 且 parseStarted=true */
export function markParsing(attemptId: string | undefined): void {
  try {
    if (!attemptId || !DIAG_ENABLED) return
    const p = pending.get(attemptId)
    if (!p) return
    p.stage = 'parsing'
    p.parseStarted = true
  } catch { /* 静默 */ }
}

/** §4.2 markParsed：stage='parsed' 且 parsedReached=true、parseStarted=true */
export function markParsed(attemptId: string | undefined): void {
  try {
    if (!attemptId || !DIAG_ENABLED) return
    const p = pending.get(attemptId)
    if (!p) return
    p.stage = 'parsed'
    p.parsedReached = true
    p.parseStarted = true
  } catch { /* 静默 */ }
}

/** §4.2 markBusinessCheck：businessCheckMarked=true */
export function markBusinessCheck(attemptId: string | undefined): void {
  try {
    if (!attemptId || !DIAG_ENABLED) return
    const p = pending.get(attemptId)
    if (!p) return
    p.businessCheckMarked = true
  } catch { /* 静默 */ }
}

/** §4.2 markDone：stage='done' */
export function markDone(attemptId: string | undefined): void {
  try {
    if (!attemptId || !DIAG_ENABLED) return
    const p = pending.get(attemptId)
    if (!p) return
    p.stage = 'done'
  } catch { /* 静默 */ }
}

/** §4.3 enforceAwaitCapacity：仅 awaiting_adapter，httpDoneAt 升序淘汰至 AWAIT_MAX */
export function enforceAwaitCapacity(): void {
  try {
    if (awaitCount() <= AWAIT_MAX) return // ★ 快速返回（v6.10:852）

    // 按 httpDoneAt 升序（最旧优先），淘汰至 AWAIT_MAX
    const aw = [...pending.values()]
      .filter((r) => r.state === 'awaiting_adapter') // ★ 前置筛选：永不含 in_flight
      .sort((a, b) => (a.httpDoneAt ?? 0) - (b.httpDoneAt ?? 0))
    while (aw.length > AWAIT_MAX) {
      const victim = aw.shift()
      if (victim) pending.delete(victim.attemptId) // ★ D-14：用 attemptId（v6.10 误写 requestId）
    }
  } catch { /* ★ fail-open：清理失败允许暂时超 200，下次再收敛 */ }
}

/** §4.4 TTL 清理（仅 awaiting_adapter） */
export function sweepAwaitingAdapter(now: number): void {
  try {
    for (const [k, p] of pending) {
      if (p.state !== 'awaiting_adapter') continue // ★ in_flight 永不
      if (p.httpDoneAt != null && now - p.httpDoneAt > AWAIT_TTL_MS) pending.delete(k)
    }
  } catch { /* 静默 */ }
}

/* ══════════════════════════════════════════════════════════════
 * §五 DiagStage 与失败类型映射（v6.10 L934-943 + D-19 + D-18）
 * stageToFailure：唯一映射实现（五种合法映射 + D-19 default）；
 * safeStage：取值入口，只分发不吞异常（D-18）；
 * safeErrType：F6 受限类型标签（string | null，用户裁定 A）。
 * ══════════════════════════════════════════════════════════════ */

/** §5.1 stageToFailure（v6.10 L934-943 + D-19）：入参是整条 pending（v6.10:934） */
export function stageToFailure(p: PendingRecord): FailureStage {
  switch (p.stage) {
    case 'pending': return 'network' // v6.10 原文，五种合法映射不变
    case 'responded': return 'http'
    case 'parsing': return 'parse'
    case 'parsed':
      // ★★ 只有显式标记过业务检查，才算来源业务错误
      return p.businessCheckMarked ? 'source_error' : 'internal_error'
    case 'done': return 'ok'
    default: // ★ D-19（2a 设计偏离，非 v6.10 原文）
      return 'internal_error' // 保证运行时返回契约 FailureStage 成立
  }
}

/** §5.3b safeStage（D-18）：取值入口，只做分发，不吞异常（异常由调用方边界处理） */
export function safeStage(p: PendingRecord): FailureStage {
  // ★ A 方案（用户裁定）：经 DEP 转发，使 T47-c 可【真实替换】底层映射函数。
  //   若直接调用词法绑定的 stageToFailure，替换 DEP.stageToFailure 不生效 → 假注入。
  return DEP.stageToFailure(p) // ★ 唯一实现；不得在此分支出第二个映射表
}

/** §5.x safeErrType（v6.10 F6 受限类型标签；用户裁定 A：string | null） */
const ERR_TYPE_ALLOW = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
])

export function safeErrType(e: unknown): string | null {
  try {
    if (e === null || e === undefined) return null // ① null/undefined → null
    const name = (e as { constructor?: { name?: unknown } })?.constructor?.name
    if (typeof name !== 'string') return 'Unknown' // ② 无构造器名 → Unknown
    return ERR_TYPE_ALLOW.has(name) ? name : 'Unknown' // ③ 白名单外 → Unknown
  } catch {
    return 'Unknown' // ④ getter/Proxy 抛错 → Unknown
  }
}

/* ══════════════════════════════════════════════════════════════
 * §六 路径安全与脱敏（其余机制：maskSnippet + assertNoLeakShape）
 * maskSnippet（v6.10 L1131-1158 权威版）+ assertNoLeakShape（L1412-1419）。
 * RESIDUAL_ENC 复用 §6.1 已定义常量（L82），不重复定义。
 * ══════════════════════════════════════════════════════════════ */

/** §6.2 敏感键名源（v6.10 SENS_SRC，BARE_KV_RE/LEAK_SHAPE_RE 用） */
const SENS_SRC =
  'token|cookie|bearer|authorization|password|secret|access_key|refresh_token|' +
  'sessdata|session|sessionid|credential'

/** §6.2 SENS_RE（v6.10 L1012）：结构化脱敏键名判定 */
const SENS_RE = /token|cookie|bearer|authorization|password|secret|access_key|refresh_token|sessdata|session|sessionid|credential/i

/** §6.2 文本级脱敏规则（v6.10 L1096-1101） */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g
const COOKIE_LINE_RE = /^([ \t]*(?:set-)?cookie[ \t]*:?[ \t]*)(.*)$/gim
const BARE_KV_RE = new RegExp(
  '(^|[\\s,;&?{])([\\w-]*(?:' + SENS_SRC + ')[\\w-]*)(\\s*[:=]\\s*)' +
  '(?:bearer\\s+|basic\\s+)?([^"\\\'\\s;,}&]+)', 'gi')
const SCRIPT_RE = /<script[\s\S]*?<\/script>/gi

/** §6.2 maskJsonValue（v6.10 L1104 权威版）：递归掩码 */
function maskJsonValue(v: unknown, depth = 0): unknown {
  if (depth > 20) return '[DEEP]'
  if (Array.isArray(v)) return v.map((x) => maskJsonValue(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENS_RE.test(k) ? '***' : maskJsonValue(val, depth + 1)
    }
    return out
  }
  return v
}

/** §6.2 maskTextLevel（v6.10 L1118）：文本级脱敏（三条路径共用） */
function maskTextLevel(t: string): string {
  t = t.replace(EMAIL_RE, '***@***')
  t = t.replace(PHONE_RE, '1**********')
  t = t.replace(COOKIE_LINE_RE, '$1"***"')
  t = t.replace(BARE_KV_RE, '$1$2$3"***"')
  return t
}

/** §6.2 maskSnippet（v6.10 L1131-1158 权威版）：先1000→脱敏→最终200 */
export function maskSnippet(raw: string | null): string | null {
  if (raw == null) return null
  let t = String(raw).slice(0, 1000) // ① 先截断（性能）
  const looksJson = /^\s*[\[{]/.test(t)
  let parsed = false
  if (looksJson) {
    try {
      t = JSON.stringify(maskJsonValue(JSON.parse(t)))
      parsed = true
    } catch { /* 解析失败 → parsed=false */ }
  }
  t = maskTextLevel(t) // ③ 无条件执行
  if (looksJson && !parsed) {
    // ★ JSON 候选但解析失败 → 保守降级（用户裁定）
    t = '[UNPARSEABLE_REDACTED]'
  } else if (!looksJson && RESIDUAL_ENC.test(t)) {
    // ★ 非 JSON 但含残余编码 → 可疑，降级
    t = '[UNPARSEABLE_REDACTED]'
  }
  t = t.replace(SCRIPT_RE, '[SCRIPT_REMOVED]') // ⑤ 脚本标签剥离（T3）
  return t.slice(0, 200) // ⑥ 最终片段 ≤200
}

/** §6.3 LEAK_SHAPE_RE（v6.10 L1161 双反斜杠写法，✅ 修正-02：L1398 单反斜杠为原文缺陷） */
const LEAK_SHAPE_RE = new RegExp(
  '(?:bearer|basic)\\s+(?!\\*)[A-Za-z0-9._~+/-]{8,}' +
  '|(?:^|[\\s;])(?:set-)?cookie[\\w-]*\\s*[:=]\\s*(?!["\\*])\\S{4,}' +
  '|(?:' + SENS_SRC + ')[\\w-]*\\s*[:=]\\s*(?!["\\*])[^\\s,;&}"]{4,}' +
  '|[\\w.+-]+@[\\w-]+\\.[\\w.-]+|(?<!\\d)1[3-9]\\d{9}(?!\\d)' +
  '|%[0-9a-f]{2}',
  'i')

/** §6.3 assertNoLeakShape（v6.10 L1412-1419）：写入前快速自检（非权威） */
export function assertNoLeakShape(masked: string): boolean {
  try {
    return !LEAK_SHAPE_RE.test(masked) // true = 形状检查通过
  } catch {
    return false // ★ 异常 → 保守判为「不通过」
  }
}

/** §6.2 / v6.10 L1247 assertNoSentinelLeak（T40，归属 2a）：哨兵值在最终导出串中必须完全不存在 */
export function assertNoSentinelLeak(exported: string, sentinels: string[]): boolean {
  return sentinels.every((s) => !exported.includes(s))
}

/* ══════════════════════════════════════════════════════════════
 * A 方案依赖对象（DEP）：三注入点独立可替换（用户裁定 2026-11-06）
 * 🔴 DEP 由模块内部对象字面量创建（非 frozen/sealed/Proxy）；
 *    三属性均为【可写、非访问器的数据属性】（初始化不变量见 __depInvariantOk）。
 * ══════════════════════════════════════════════════════════════ */
type DepFns = {
  maskSnippet: (raw: string | null) => string | null
  safeStage: (p: PendingRecord) => FailureStage
  stageToFailure: (p: PendingRecord) => FailureStage
}
const DEP: DepFns = { maskSnippet, safeStage, stageToFailure }
/** 模块加载时保存的原始引用（__resetTestDep 只回填此对象，不接受外部值） */
const DEP_ORIG: DepFns = { ...DEP }

/** DEP 写入条件不变量：三属性必须是可写的数据属性（非访问器） */
function depInvariantOk(): boolean {
  for (const k of ['maskSnippet', 'safeStage', 'stageToFailure'] as const) {
    const d = Object.getOwnPropertyDescriptor(DEP, k)
    if (!d || !('value' in d) || d.writable !== true) return false
  }
  return true
}

/** 重入守卫：__setTestDep/__resetTestDep 共用；守卫置位后任何重入立即抛错 */
let DEP_WRITE_GUARD = false
function withDepGuard<T>(fn: () => T): T {
  if (DEP_WRITE_GUARD) throw new Error('DEP 写入重入被拒绝（不允许重入）')
  DEP_WRITE_GUARD = true
  try {
    return fn()
  } finally {
    DEP_WRITE_GUARD = false // ★ 任何路径（含抛错）都解除，不泄漏守卫状态
  }
}

/* ══════════════════════════════════════════════════════════════
 * §七 终结幂等与部分提交恢复
 * finalizeInternal（§7.1 v8 控制流，2a 签名见 §2.2/D-22）
 * + checkCommitted（§7.1c 三态 CommitCheck）
 * 恢复语义：同进程（§7.1b），非跨进程崩溃恢复。
 * ══════════════════════════════════════════════════════════════ */

/** §7.1c checkCommitted（三态，非 boolean）：提交核实（v7 定稿） */
export function checkCommitted(attemptId: string, at: number | undefined): CommitCheck {
  if (at === undefined) return 'unknown' // ★ commitAt 缺失 → 无法核实
  try {
    const hit = records.some((r) => r.attemptId === attemptId && r.at === at)
    return hit ? 'committed' : 'not_committed'
  } catch {
    return 'unknown' // ★ 核实本身异常 → 无法核实
  }
}

/** §7.1 finalizeInternal（v8 完整控制流；2a 签名 §2.2，D-22） */
export function finalizeInternal(
  attemptId: string | undefined,
  kind: 'failure' | 'success',
  e?: unknown,
): void {
  try {
    if (!attemptId || !DIAG_ENABLED) return
    const p = pending.get(attemptId)
    if (!p) return

    // ═══ 第 0 步：已确认提交保护（committed 状态禁止再次 push）═══
    if (p.commitState === 'committed') {
      try { pending.delete(attemptId) } catch { /* 留待下次 */ }
      return // ★ 绝不 push；delete 失败也不得回退 commitState
    }

    // ═══ 第 0.5 步：残留 'committing' → 必须三态核实 ═══
    if (p.commitState === 'committing') {
      switch (checkCommitted(attemptId, p.commitAt)) {
        case 'committed':
          p.commitState = 'committed' // 补记
          try { pending.delete(attemptId) } catch { /* 静默 */ }
          return // ★ 不再 push
        case 'unknown':
          return // ★ 保留 committing，禁止任何 push
        case 'not_committed':
          // ★ 唯一的「允许恢复提交流程」入口
          p.commitState = 'none'
          p.commitAt = undefined // ★★ 必须清除旧提交身份
          break // ★ 落到阶段 1，本次调用即重试
      }
    }

    // ═══ 阶段 1：字段计算（失败 → 放弃，commitState 保持进入时值）═══
    let rec: EvidenceRecord
    try {
      const parseSuccess =
        p.parsedReached === true ? true
        : p.parseStarted === true ? false
        : null // ★ 三态，不看 done

      // ── ① 脱敏链：rawText → maskSnippet → assertNoLeakShape（全在阶段 1 内）──
      let snippet: string | null = null
      if (p.rawText != null) {
        const masked = DEP.maskSnippet(p.rawText) // ← 可能抛（→ 外层 catch → return）★经 DEP（T47-a 缝）
        // ★ ⑦ 必须作用于【最终 200 截断后、真正待写入】的串
        if (masked !== null && assertNoLeakShape(masked)) {
          snippet = masked // ★ 赋给【通过检查的同一个变量】
        }
        // 检查未通过 → snippet 保持 null（★ 不是空串，不写入原文或部分脱敏文本）
      }

      rec = {
        requestId: p.requestId, attempt: p.attempt, attemptId: p.attemptId,
        sourceId: p.sourceId, requestType: p.requestType,
        stage: p.stage, status: p.status, contentType: p.contentType,
        durationMs: p.durationMs, httpDoneAt: p.httpDoneAt,
        failureStage: kind === 'success' ? 'ok' : DEP.safeStage(p), // ← 可能抛（→ 外层 catch）★经 DEP（T47-b 缝）
        errorTypeLabel: kind === 'failure' ? safeErrType(e) : null,
        responseSnippet: snippet, // ★ 同一变量，不重新计算
        path: p.path,
        parseSuccess,
        finalized: true,
        at: Date.now(), // ★ Date.now() 也在阶段 1 内
      }
      // ⚠️ 无 rawText/headers/url 及任何临时字段（W1~W3）
    } catch {
      return // ★ 阶段 1 任意异常 → 直接返回，【未 push、未 delete】，pending 完整保留
    }

    // ═══ 阶段 2：三段式提交 ═══
    // ★ commitAt 只在此处生成（beginRequest 不赋值）；重试前已清除旧值（硬断言 ⑤）
    p.commitAt = rec.at // ★ 构造时固定，核实环节不重生成
    p.commitState = 'committing' // ① 中间态（不假定成败）

    let ok = false
    try {
      records.push(rec)
      ok = true
    } catch {
      const check = checkCommitted(attemptId, p.commitAt)
      if (check === 'unknown') return // ★ 保留 committing，禁止重试
      ok = (check === 'committed')
    }
    if (!ok) { // 明确 not_committed
      p.commitState = 'none'
      p.commitAt = undefined
      return // 允许下次调用重试（本次不递归）
    }

    p.commitState = 'committed' // ② 确认已提交（此后永不回退）
    // ★ T7 修复（用户裁定 2026-11-06）：records FIFO 容量淘汰（v6.10 L1499-1500）
    //   位置约束：必须在 committed 之后、pending.delete 之前。
    //   splice 异常不得进入 checkCommitted、不得把已提交误判为未提交、不得再次 push。
    try {
      if (records.length > RECORDS_MAX) {
        records.splice(0, records.length - RECORDS_MAX) // ★ FIFO：删除最旧，保留最新
      }
    } catch {
      // 淘汰失败不回退已提交状态
    }
    try { pending.delete(attemptId) } catch { /* delete 失败无害（第 0 步兜底） */ }
  } catch { /* 全局静默 */ }
}

/**
 * §2.2 核心函数签名（API 契约，类型参考）。
 * 已实现的方法见上方；本项（§四+§五+§六+§七）已实现 markHttpDone/markParsing/markParsed/
 * markBusinessCheck/markDone/enforceAwaitCapacity/sweepAwaitingAdapter/awaitCount/
 * stageToFailure/safeStage/safeErrType/maskSnippet/assertNoLeakShape/finalizeInternal；
 * 核心模块全部函数已实现（checkCommitted 为 §7.1c 内部依赖）；无抛错 stub。
 * （§四~§七 全部核心函数已落码，无未实现项。）
 */
export interface DiagnosticsApi {
  // ── 生命周期 ──
  /** ★ v6.10 契约：返回值 = ctx.requestId；无 ctx 时为 undefined */
  beginRequest(ctx: DiagContext | undefined): string | undefined
  /**
   * ★ 以 attemptId 定位，非 requestId；
   * r = HttpResult 子集（text 不传）；★★ contentType 独立入参，不改 HttpResult
   */
  markHttpDone(
    attemptId: string | undefined,
    r?: { status: number; ms: number },
    kind?: 'ok' | 'network',
    contentType?: string | null,
  ): void
  markParsing(attemptId: string | undefined): void
  markParsed(attemptId: string | undefined): void
  markBusinessCheck(attemptId: string | undefined): void
  markDone(attemptId: string | undefined): void
  /** ★ D-22：按 attemptId 终结（不接 DiagContext）；2a 唯一终结核心 */
  finalizeInternal(
    attemptId: string | undefined,
    kind: 'failure' | 'success',
    e?: unknown,
  ): void
  /** ★ awaiting_adapter 容量淘汰（方案 §2.2 在生命周期/容量两处列出；接口仅保留此 1 处入口） */
  enforceAwaitCapacity(): void

  // ── 校验/工具 ──
  /** ★ Q5：与 v6.10 一致；返回 null=通过，否则返回错误消息（调用端用 idErr !== null 判断失败） */
  validateIdentity(ctx: DiagContext): string | null
  /** 输出约定：rawPath / '[REDACTED_PATH]' / '[INVALID_URL]' */
  safePath(raw: string): string
  /** v6.10 完整脱敏链（方案 §6.2：先 1000 截断 → 脱敏 → 最终 200，顺序不可调换） */
  maskSnippet(raw: string | null): string | null
  /** 写入前快速自检（非权威） */
  assertNoLeakShape(masked: string): boolean
  /** ★ 入参是整条 pending（v6.10:934） */
  stageToFailure(p: PendingRecord): FailureStage
  /** ★ D-18：唯一映射实现的取值入口 */
  safeStage(p: PendingRecord): FailureStage
  safeErrType(e: unknown): string | null

  // ── 容量 ──
  /** ★ 只数 state==='in_flight'（D-7/Q2） */
  countInFlight(): number
  /** ★ 只数 state==='awaiting_adapter'（v6.10:863） */
  awaitCount(): number
  /** ★ 仅扫 awaiting_adapter（TTL） */
  sweepAwaitingAdapter(now: number): void

  /** ★ D-24（2a API 扩展）：仅修改模块级 DIAG_ENABLED；不改变 pending、无持久化副作用 */
  setDiagEnabled(v: boolean): void

  // ── ★ 2d 新增（用户裁定 2026-11-06）：正式 API 19 → 22 ──
  /** 读取诊断开关真实状态（只读，无副作用）；与 setDiagEnabled 对称 */
  isDiagEnabled(): boolean
  /** 返回记录深拷贝快照；⚠️ 不等于导出白名单，导出须另行按 16 字段构造 */
  readExportRecords(): ReadonlyArray<Readonly<EvidenceRecord>>
  /** 清空 records 并返回清理前数量；不清理 pending、不改开关 */
  clearDiagRecords(): number
}

/* ══════════════════════════════════════════════════════════════
 * 测试专用钩子（v5.1 方案；🔴 不进入生产门面 index.ts）
 * 隔离：带 __ 前缀；生产代码不得调用；测试经本模块（测试入口）访问。
 * ══════════════════════════════════════════════════════════════ */

/** 只读快照：structuredClone 深拷贝（保留 undefined 字段），不暴露内部引用 */
export function __diagSnapshot(): {
  pending: PendingRecord[]
  records: EvidenceRecord[]
} {
  return {
    pending: structuredClone([...pending.values()]),
    records: structuredClone(records),
  }
}

/** 只读开关状态 */
export function __isDiagEnabled(): boolean {
  return DIAG_ENABLED
}

/** 测试专用脱敏入口（T1/T38）：转发 maskJsonValue（保持默认 depth=0 行为） */
export function __maskJsonValue(v: unknown, depth?: number): unknown {
  return maskJsonValue(v, depth ?? 0)
}

/** DEP 写入条件自检（测试用）：三属性均为可写数据属性 */
export function __depInvariantOk(): boolean {
  return depInvariantOk()
}

const TEST_DEP_KEYS = ['maskSnippet', 'safeStage', 'stageToFailure'] as const
type TestDepKey = (typeof TEST_DEP_KEYS)[number]

/**
 * 测试专用：替换 DEP 指定依赖（两阶段原子校验；详见方案 §3.2c）
 * ① 拒绝访问器属性（读描述符，不执行 getter）
 * ② 额外属性（自有字符串/不可枚举/Symbol 键）一律拒绝
 * ③ 非函数值拒绝；非法 patch → 抛错且 DEP【零部分写入】
 * ④ 同步重入被守卫拒绝；Proxy trap 抛错 fail-closed
 */
export function __setTestDep(patch: unknown): void {
  return withDepGuard(() => {
    // ═══ 阶段一：完整读取与校验（★ 全程不修改 DEP；★ 不执行任何 getter）═══
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('__setTestDep: patch 必须是非 null 对象')
    }
    const presentKeys: (string | symbol)[] = [
      ...Object.getOwnPropertyNames(patch),
      ...Object.getOwnPropertySymbols(patch),
    ]
    for (const k of presentKeys) {
      if (typeof k === 'symbol' || !(TEST_DEP_KEYS as readonly string[]).includes(k)) {
        throw new Error(`__setTestDep: 不允许的属性 ${String(k)}`)
      }
    }
    const staged: Array<[TestDepKey, (...a: never[]) => unknown]> = []
    for (const k of TEST_DEP_KEYS) {
      const d = Object.getOwnPropertyDescriptor(patch, k) // ★ 只此一处取描述符
      if (d === undefined) continue // 未提供 → 跳过
      if (!('value' in d)) throw new Error(`__setTestDep: ${k} 必须是数据属性（拒绝访问器）`)
      if (d.value === undefined) continue // 显式 undefined → 视为未提供
      if (typeof d.value !== 'function') throw new Error(`__setTestDep: ${k} 必须是函数`)
      staged.push([k, d.value as (...a: never[]) => unknown])
    }
    // ═══ 阶段二：统一赋值（只对已验证的三属性逐项赋值；★ 禁 Object.assign）═══
    for (const [k, v] of staged) {
      if (k === 'maskSnippet') DEP.maskSnippet = v as DepFns['maskSnippet']
      else if (k === 'safeStage') DEP.safeStage = v as DepFns['safeStage']
      else DEP.stageToFailure = v as DepFns['stageToFailure']
    }
  })
}

/**
 * 测试专用：恢复三个原始函数引用（不接受外部恢复函数；幂等；失败显式抛错）
 * 测试必须在 finally 中调用。
 */
export function __resetTestDep(): void {
  return withDepGuard(() => {
    DEP.maskSnippet = DEP_ORIG.maskSnippet
    DEP.safeStage = DEP_ORIG.safeStage
    DEP.stageToFailure = DEP_ORIG.stageToFailure
    if (
      DEP.maskSnippet !== DEP_ORIG.maskSnippet ||
      DEP.safeStage !== DEP_ORIG.safeStage ||
      DEP.stageToFailure !== DEP_ORIG.stageToFailure
    ) {
      throw new Error('__resetTestDep: 恢复失败（引用与原始不一致）')
    }
  })
}
