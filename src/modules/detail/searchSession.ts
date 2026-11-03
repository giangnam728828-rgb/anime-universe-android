/**
 * 阶段3-5a · 搜索结果 → 详情页的会话级上下文桥接
 *
 * 设计要点：
 *  - **有界多令牌（阶段3第5b子步）**：最多同时存活 MAX_TOKENS 个上下文。
 *    每个令牌代表**一次独立的导航上下文**，即使两个令牌绑定同一 route 也**独立并存**，
 *    因此支持 A→B→A 这类返回导航（同作品在历史中出现多次，各有各的上下文）。
 *    容量满时**只按最小 insertSeq** 淘汰最旧令牌，route **不参与**淘汰决策。
 *  - **令牌 + 路由三元组 + TTL 三重校验**，任一不满足即视为无上下文
 *  - **peek() 纯读取**：不消费、不修改任何模块状态，因此不受 React 18
 *    StrictMode 的 setup→cleanup→setup 双调用影响（本模块刻意不提供 consume / clear）
 *  - **运行时不可变**：entries 与 route 均在 createToken 内部复制并 Object.freeze
 *  - **刷新降级**：刷新会重新初始化本模块，slot 回到 null，即使浏览器保留了
 *    history state，旧 token 也无法通过 peek 校验
 *
 * 不含任何网络调用；本模块只做内存数据搬运。
 */
import type { Kind } from '../../services/sources'
import type { SourceEntry } from '../../services/sources/aggregate'

/** 详情页可展示的单个来源快照（只保留身份 + 展示标题，不含聚合展示字段） */
export interface EntrySnapshot {
  readonly sourceId: string
  readonly kind: Kind
  readonly workId: string
  /** 该来源自己的标题（来自 SourceEntry.title，不是聚合统一标题） */
  readonly title: string
  /** 该来源自己的原文标题（可为空） */
  readonly titleNative?: string
}

/** 令牌绑定的路由身份 */
export interface RouteIdentity {
  readonly sourceId: string
  readonly kind: Kind
  readonly workId: string
}

interface SessionSlot {
  token: string
  entries: readonly EntrySnapshot[]
  route: Readonly<RouteIdentity>
  createdAt: number
  /** 单调递增写入序号。仅用于容量淘汰，判定结果与系统时间无关 */
  insertSeq: number
}

/** 上下文有效期：30 秒。过期保护，不是主要身份校验手段 */
export const CTX_TTL_MS = 30_000

/** 容量上限：最多同时存活 8 个上下文令牌 */
const MAX_TOKENS = 8
/** 令牌 -> 槽。Map 保持插入顺序；淘汰另按 insertSeq 判定（不依赖时间戳） */
const slots = new Map<string, SessionSlot>()
/** 写入计数器：保证 insertSeq 单调且永不并列 */
let insertCounter = 0
/** 上一个发出的令牌，用于保证新旧必异 */
let lastToken: string | null = null
/** 退化兜底用的单调计数器 */
let seq = 0
/**
 * 进入兜底模式的标记。
 * 一旦常规路径连续碰撞，说明随机源已退化（例如 randomUUID 恒返回同值），
 * 此后所有令牌都走兜底分支，避免"碰撞→兜底→下一轮又碰撞"的抖动。
 */
let degraded = false

/** 常规令牌生成（UUID 优先，退化用时间戳+计数器+随机） */
function genToken(s: number): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `t${Date.now().toString(36)}-${s.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 生成与上一次必然不同的令牌。
 * 有限重试（3 次）→ 兜底用递增计数器循环，**不递归**、**不依赖随机源**。
 */
function newToken(): string {
  if (!degraded) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = genToken(seq)
      if (t !== lastToken) {
        lastToken = t
        return t
      }
      seq += 1
    }
    degraded = true // ★ 常规路径连续碰撞：判定随机源退化，此后一律走兜底
  }
  seq += 1
  let forced: string
  do {
    forced = `f-${Date.now().toString(36)}-${seq.toString(36)}`
    seq += 1
  } while (forced === lastToken) // 兜底也保证新旧必异，且无递归
  lastToken = forced
  return forced
}

/**
 * 令牌快照的可接受输入：
 *  - `SourceEntry`     ：搜索页聚合结果（字段超集，含 item/genres/matchKey 等）
 *  - `EntrySnapshot`   ：详情页链路里 peek 出来的快照（只有 5 个身份字段）
 * 两者都以**顶层** sourceId/kind/workId/title/titleNative 承载身份信息，
 * 因此只需读取这 5 个共有字段即可归一化，不需要任何 `as` 断言。
 */
export type EntryInput = SourceEntry | EntrySnapshot
export type EntryInputList = readonly EntryInput[]

/**
 * 归一化为 EntrySnapshot（复制 + 冻结）。
 * 含运行时最小校验：身份字段非法时**抛错**而不是静默产出脏快照。
 */
function toSnapshot(e: EntryInput): EntrySnapshot {
  if (
    typeof e?.sourceId !== 'string' ||
    typeof e.workId !== 'string' ||
    (e.kind !== 'anime' && e.kind !== 'manga')
  ) {
    throw new TypeError('createToken: 非法条目')
  }
  return Object.freeze({
    sourceId: e.sourceId,
    kind: e.kind,
    workId: e.workId,
    title: typeof e.title === 'string' ? e.title : '',
    titleNative: typeof e.titleNative === 'string' ? e.titleNative : undefined,
  })
}

/** 复制 + 逐个冻结，返回运行时不可变的快照数组 */
function freezeEntries(src: EntryInputList): readonly EntrySnapshot[] {
  return Object.freeze(src.map(toSnapshot))
}

/**
 * 容量淘汰：仅在写满时按最小 insertSeq 删除最旧令牌。
 * **route 完全不参与淘汰判定** —— 同一 route 的多个令牌必须独立存活，
 * 否则 A→B→A 的返回导航会丢失先前页面的上下文。
 */
function evictIfNeeded(): void {
  while (slots.size >= MAX_TOKENS) {
    let oldestKey: string | null = null
    let oldestSeq = Infinity
    for (const [k, v] of slots) {
      if (v.insertSeq < oldestSeq) {
        oldestSeq = v.insertSeq
        oldestKey = k
      }
    }
    if (oldestKey === null) break
    slots.delete(oldestKey)
  }
}

/**
 * 创建令牌并写入有界存储（阶段3第5b子步）。
 * 不影响任何其他令牌：不同令牌即使绑定同一 route 也各自独立存活。
 * 只有容量（MAX_TOKENS）与 TTL 会让上下文失效。
 */
export function createToken(srcEntries: EntryInputList, route: RouteIdentity): string {
  const token = newToken()
  const snap: SessionSlot = Object.freeze({
    token,
    entries: freezeEntries(srcEntries),
    // ★ 复制 + 冻结：不保存调用方传入的引用
    route: Object.freeze({
      sourceId: route.sourceId,
      kind: route.kind,
      workId: route.workId,
    }),
    createdAt: Date.now(),
    insertSeq: insertCounter++,
  })
  evictIfNeeded()
  slots.set(token, snap)
  return token
}

/**
 * 纯读取校验。顺序固定：参数 → 令牌精确命中 → route 三元组 → TTL。
 * 任何一步失败返回 null，且**不消费、不删除、不修改**任何模块状态。
 *
 * ★ token 是第一索引：两个绑定同一 route 的令牌各读各的快照，绝不会互相读到对方。
 */
export function peek(
  token: string | undefined | null,
  route: RouteIdentity,
): readonly EntrySnapshot[] | null {
  if (!token) return null
  const s = slots.get(token)
  if (!s) return null // 令牌不存在 / 已被容量淘汰
  if (
    s.route.sourceId !== route.sourceId ||
    s.route.kind !== route.kind ||
    s.route.workId !== route.workId
  ) {
    return null
  }
  const age = Date.now() - s.createdAt
  if (age < 0 || age > CTX_TTL_MS) return null // ★ 负时间差（系统时间回拨）同样拒绝
  // 返回隔离副本：内部对象已冻结，共享 entry 引用安全，但数组是新引用
  return Object.freeze(s.entries.slice())
}

/**
 * 仅供测试读取当前存活令牌数。
 * 只返回数量，**不暴露 Map、令牌内容或任何内部对象**，也不提供任何修改入口。
 * 生产业务代码不得调用。
 */
export function __tokenCount(): number {
  return slots.size
}
