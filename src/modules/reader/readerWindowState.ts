/**
 * 在线阅读窗口状态机（第9子步 · 批次②）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要它（修的是什么 Bug）
 * ══════════════════════════════════════════════════════════════════════
 * 第8子步之前的 `useOnlineWindow` 用**两个互不相干的结构**描述同一页：
 *
 *   requested: Set<number>   「曾经发起过请求」→ 只在切章和单页 retry 时清理
 *   blobs:     Map<number,Blob> 「当前手上有字节」→ 窗口淘汰 |i-cur|>win+3 时删除
 *
 * `requested` 单调累积、`blobs` 随窗口收缩，两者语义不同却**共同决定要不要发请求**：
 *
 *     requested.has(i) === true  但  blobs.has(i) === false  且  failed.has(i) === false
 *     ⇒ 不请求、无数据、无失败标记  ⇒ 永久 `rd-hold` 页码块（Bug A）
 *
 * 典型复现：翻到第 30 页再翻回第 5 页 —— 第 5 页的 blob 早被淘汰，
 * 但 `requested` 还记着它，于是永远不再下载。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 修复核心
 * ══════════════════════════════════════════════════════════════════════
 * **淘汰不删「请求历史」，而是把逻辑状态回退到 `idle`**，使该页重新可被调度。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 两个维度，两套记录（方案 §2.2.1）
 * ══════════════════════════════════════════════════════════════════════
 *   PageRecord      页面逻辑状态：决定 UI 与「要不要发起请求」
 *   InflightRequest 物理请求身份：决定「有没有占着并发名额」
 *
 * 二者生命周期不同，**不能用一个 status 字段同时表达**。
 * 典型合法组合：`queued` + 旧请求在途（C4）—— 用户 retry 时必然出现。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 settle 四阶段（方案 §2.3.1 / §2.3.1.1）
 * ══════════════════════════════════════════════════════════════════════
 *   S1 启动：注册 inflight，status → loading
 *   S2 settle：按 reqId 精确删 inflight，名额 -1
 *              ⚠️ 不得改 status、不得 pump
 *   S3 reconcile：依 chapterGen/epoch/窗口/结果决定最终逻辑状态
 *   S4 pump：只观察已 reconcile 的状态后重新调度
 *
 * **S2 → S3 必须在同一同步调用栈内连续执行，中间不得让出**
 * （禁止 await / then-finally / pump / 用户回调 / 事件派发）。
 * 原因：S2 删完 inflight 后 status 仍是 loading，会短暂形成 C6；
 * 只要不让出，事件循环中没有任何其他任务能观察到它。
 *
 * ⇒ 承诺边界：**C6 不允许成为可观察的稳定状态**，
 *    但不承诺它在同步栈内的指令级瞬时不存在（那不可能也不需要）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 本模块是**纯逻辑**，不依赖 React（便于完整测竞态）
 * ══════════════════════════════════════════════════════════════════════
 */

export type PageStatus = 'idle' | 'queued' | 'loading' | 'ready' | 'failed'

export interface PageRecord {
  status: PageStatus
  /** 页面逻辑代次：每次「产生新需求」+1（retry / 淘汰后重新请求） */
  epoch: number
  blob?: Blob
  error?: unknown
  /** 最近一次窗口计算时是否在窗口内 */
  inWindow: boolean
}

export interface InflightRequest {
  /** 🔴 全局自增唯一，请求身份。settle 时按它精确删除，绝不按页码盲删 */
  reqId: number
  pageIndex: number
  /** 发起时的页面 epoch */
  epoch: number
  /** 发起时的章节代次 */
  chapterGen: number
  /** 可逆的 stale 标记（U1：页面重新进入窗口要能清掉它） */
  stale: boolean
}

export interface WindowState {
  records: Map<number, PageRecord>
  inflight: Map<number, InflightRequest>
  chapterGen: number
  nextReqId: number
}

/** 一次 settle 的结果 */
export interface SettleResult {
  ok: boolean
  blob?: Blob
  error?: unknown
}

export function createWindowState(): WindowState {
  return { records: new Map(), inflight: new Map(), chapterGen: 0, nextReqId: 1 }
}

function rec(state: WindowState, i: number): PageRecord {
  let r = state.records.get(i)
  if (!r) {
    r = { status: 'idle', epoch: 0, inWindow: false }
    state.records.set(i, r)
  }
  return r
}

/* ══════════════════════════════════════════════════════════════════════
 * 派生视图（对外保持 ReaderPage 需要的三个结构，签名不变）
 * ══════════════════════════════════════════════════════════════════════ */

export function deriveBlobs(state: WindowState): Map<number, Blob> {
  const m = new Map<number, Blob>()
  for (const [i, r] of state.records) {
    // 🔴 双重判定：status 与 blob 必须同时满足（方案 §2.5 规则 4）
    if (r.status === 'ready' && r.blob !== undefined) m.set(i, r.blob)
  }
  return m
}

export function derivePending(state: WindowState): Set<number> {
  const s = new Set<number>()
  for (const [i, r] of state.records) {
    if (r.status === 'loading' || r.status === 'queued') s.add(i)
  }
  return s
}

export function deriveFailed(state: WindowState): Set<number> {
  const s = new Set<number>()
  for (const [i, r] of state.records) {
    if (r.status === 'failed') s.add(i)
  }
  return s
}

/* ══════════════════════════════════════════════════════════════════════
 * 窗口计算
 * ══════════════════════════════════════════════════════════════════════ */

/** 计算窗口范围（含边界裁剪） */
export function windowRange(cur: number, total: number, win: number): [number, number] {
  if (total <= 0) return [0, -1]
  return [Math.max(0, cur - win), Math.min(total - 1, cur + win)]
}

/**
 * 应用窗口变化：更新 inWindow、标记 stale、淘汰远处记录。
 *
 * **淘汰只作用于 `ready` / `failed`，永不作用于 `queued` / `loading`**
 * （方案 §2.5 规则 1）—— 正在下载的页不会因窗口移动丢失状态或被重复下载。
 */
export function applyWindow(
  state: WindowState,
  cur: number,
  total: number,
  win: number,
): void {
  const [lo, hi] = windowRange(cur, total, win)

  for (const [i, r] of state.records) {
    const inWin = i >= lo && i <= hi
    r.inWindow = inWin

    // stale 标记必须可逆（U1）
    const inf = state.inflight.get(i)
    if (inf) inf.stale = !inWin

    if (inWin) continue

    // 淘汰：只处理 ready / failed
    if (Math.abs(i - cur) > win + 3) {
      if (r.status === 'ready') {
        // 🔴 T11 原子性：同一次转换内同时清 status 和 blob
        r.status = 'idle'
        r.blob = undefined
        r.error = undefined
      } else if (r.status === 'failed') {
        // T12
        r.status = 'idle'
        r.blob = undefined
        r.error = undefined
      }
      // queued / loading：不动
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * T4：窗口移动时取消「尚未启动」的排队需求
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 返回应当取消的页码：**仍在排队（queued）但已离开窗口**。
 *
 * 依据方案 §3.4 T4：
 *   `queued` 尚未真正调用 `getBinary`，不占物理名额，出队零成本。
 *
 * 🔴 绝不取消 `loading`：
 *   已启动的请求即使离窗也只能标 `stale`，物理名额必须保留到 Promise settle
 *   （CapacitorHttp 无真中断能力，提前归还名额会让物理并发翻倍）。
 *   因此本函数**只返回 queued**。
 */
export function cancellableQueued(
  state: WindowState,
  cur: number,
  total: number,
  win: number,
): number[] {
  const [lo, hi] = windowRange(cur, total, win)
  const out: number[] = []
  for (const [i, r] of state.records) {
    if (r.status !== 'queued') continue
    if (i >= lo && i <= hi) continue
    out.push(i)
  }
  return out
}

/**
 * 取消一页的排队需求：回退到 `idle` 并清空错误。
 *
 * ⚠️ 只对 `queued` 生效；对 `loading` 调用是无效操作（保护物理名额）。
 */
export function cancelQueued(state: WindowState, i: number): boolean {
  const r = state.records.get(i)
  if (!r || r.status !== 'queued') return false
  r.status = 'idle'
  r.blob = undefined
  r.error = undefined
  return true
}

/* ══════════════════════════════════════════════════════════════════════
 * 调度决策：哪些页需要（重新）发起请求
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 返回窗口内应当发起请求的页码，按优先级排序。
 *
 * 排序键 `[距离, 方向(前进优先), 页码]` —— 全序无歧义，
 * 与 Map 迭代顺序无关，当前页 `d=0` 恒第一。
 */
export function pagesToRequest(
  state: WindowState,
  cur: number,
  total: number,
  win: number,
): number[] {
  const [lo, hi] = windowRange(cur, total, win)
  const out: number[] = []

  for (let i = lo; i <= hi; i++) {
    const r = state.records.get(i)
    if (!r) { out.push(i); continue }          // 从未请求
    if (r.status === 'idle') { out.push(i); continue }   // 淘汰后可重调度
    // queued / loading / ready / failed 都不再发起
    //   - queued/loading：已有需求在途
    //   - ready：有 Blob
    //   - failed：等用户显式 retry
  }

  return out.sort((a, b) => {
    const da = Math.abs(a - cur)
    const db = Math.abs(b - cur)
    if (da !== db) return da - db
    // 同距离：前进方向优先（阅读方向）
    const fa = a < cur ? 1 : 0
    const fb = b < cur ? 1 : 0
    if (fa !== fb) return fa - fb
    return a - b
  })
}

/* ══════════════════════════════════════════════════════════════════════
 * 状态转换
 * ══════════════════════════════════════════════════════════════════════ */

/** T2：idle → queued（有需求但尚未获得名额） */
export function markQueued(state: WindowState, i: number): void {
  const r = rec(state, i)
  if (r.status === 'idle') r.status = 'queued'
}

/**
 * S1：真正启动请求，queued/idle → loading，注册 inflight。
 *
 * 🔴 同时把 `inWindow` 置为 true：只有窗口内的页才会被 `pagesToRequest` 派发，
 *    因此「能进入 startRequest」本身就等价于「此刻在窗口内」。
 *    若不在此处落定，settle 时 `record.inWindow` 可能仍是初始值 false，
 *    导致成功的响应被误判为「窗口外」而回退到 idle（页面永远加载不出来）。
 *    页面在下载期间移出窗口的情形由 `applyWindow` 负责把 inWindow 改回 false。
 */
export function startRequest(state: WindowState, i: number): InflightRequest {
  const r = rec(state, i)
  r.status = 'loading'
  r.epoch += 1
  r.inWindow = true
  r.blob = undefined
  r.error = undefined

  const inf: InflightRequest = {
    reqId: state.nextReqId++,
    pageIndex: i,
    epoch: r.epoch,
    chapterGen: state.chapterGen,
    stale: false,
  }
  state.inflight.set(i, inf)
  return inf
}

/** T13/T14：用户 retry → queued（epoch++，不绕过调度器） */
export function markRetry(state: WindowState, i: number): void {
  const r = rec(state, i)
  r.status = 'queued'
  r.epoch += 1
  r.blob = undefined
  r.error = undefined
}

/** markFailed：只记录失败，不发起请求（第8子步契约，保持不变） */
export function markPageFailed(state: WindowState, i: number): void {
  const r = rec(state, i)
  // 已有在途请求时不改（等它 settle 走 reconcile）
  if (state.inflight.has(i)) return
  r.status = 'failed'
  r.error = r.error ?? new Error('render failed')
}

/**
 * S2 + S3：处理一次 settle。
 *
 * **必须同步连续执行，中间不得让出**（§2.3.1.1）。
 *
 * S2：按 reqId 精确删除 inflight，**不改 status**
 * S3：reconcile 决定最终逻辑状态
 *
 * @returns 是否真的处理了这条 settle（reqId 不匹配说明已被替换，忽略）
 */
export function settleRequest(
  state: WindowState,
  i: number,
  inf: InflightRequest,
  result: SettleResult,
): boolean {
  /* ── S2：物理清理 ─────────────────────────────────────────── */
  const current = state.inflight.get(i)
  if (!current || current.reqId !== inf.reqId) {
    // 这条 settle 对应的 inflight 已被别的请求替换 —— 不删、不改任何状态。
    // ⚠️ 物理名额由调度器按 Promise settle 自行释放，与这里无关。
    return false
  }
  state.inflight.delete(i)

  /* ── S3：reconcile ────────────────────────────────────────── */
  const r = state.records.get(i)

  // 分支 1：已切章 ⇒ 记录删除，不写任何状态（U4）
  if (inf.chapterGen !== state.chapterGen) {
    state.records.delete(i)
    return true
  }

  if (!r) return true

  // 分支 2：epoch 不同 ⇒ 期间产生过新需求，保留当前状态，只丢弃旧响应
  //          （这正是 X-7 死锁的解药：queued 不会被清掉）
  if (r.epoch !== inf.epoch) {
    // C8 特例：已 ready 有 Blob，旧请求 settle 不得删 Blob、不得改 ready
    if (r.status === 'ready') return true
    return true
  }

  // 分支 3：同代，三种结局
  if (!r.inWindow) {
    // 3c：窗口外 ⇒ idle（可重新调度）
    r.status = 'idle'
    r.blob = undefined
    r.error = undefined
    return true
  }

  if (result.ok && result.blob) {
    // 3a：窗口内 + 成功 ⇒ ready
    r.status = 'ready'
    r.blob = result.blob
    r.error = undefined
  } else {
    // 3b：窗口内 + 失败 ⇒ failed
    r.status = 'failed'
    r.error = result.error
    r.blob = undefined
  }
  return true
}

/** T15：切章 —— 整表重置，chapterGen++ */
export function resetForChapter(state: WindowState): void {
  state.records.clear()
  state.inflight.clear()
  state.chapterGen += 1
}

/* ══════════════════════════════════════════════════════════════════════
 * 不变量（测试用）
 * ══════════════════════════════════════════════════════════════════════ */

export interface InvariantViolation {
  kind: 'C6' | 'C10' | 'READY_WITHOUT_BLOB'
  pageIndex: number
}

/**
 * 检查方案 §2.2.2 的禁止组合：
 *   C6  = loading 但无 inflight
 *   C10 = failed  但有 inflight
 *   以及 §2.5 规则 4：ready 但 blob 不存在
 */
export function checkInvariants(state: WindowState): InvariantViolation[] {
  const out: InvariantViolation[] = []
  for (const [i, r] of state.records) {
    const has = state.inflight.has(i)
    if (r.status === 'loading' && !has) out.push({ kind: 'C6', pageIndex: i })
    if (r.status === 'failed' && has) out.push({ kind: 'C10', pageIndex: i })
    if (r.status === 'ready' && r.blob === undefined) {
      out.push({ kind: 'READY_WITHOUT_BLOB', pageIndex: i })
    }
  }
  return out
}
