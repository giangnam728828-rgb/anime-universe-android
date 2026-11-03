/**
 * 阶段3-5a · 搜索结果 → 详情页的会话级上下文桥接
 *
 * 设计要点（已通过设计审查）：
 *  - **单槽**：同一时刻只保留一个上下文，新令牌必然覆盖旧令牌
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
}

/** 上下文有效期：30 秒。过期保护，不是主要身份校验手段 */
export const CTX_TTL_MS = 30_000

/** 单槽存储 */
let slot: SessionSlot | null = null
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

/** 复制 + 逐个冻结，返回运行时不可变的快照数组 */
function freezeEntries(src: readonly SourceEntry[]): readonly EntrySnapshot[] {
  const copy = src.map((e) =>
    Object.freeze({
      sourceId: e.sourceId,
      kind: e.kind,
      workId: e.workId,
      title: e.title ?? '',
      titleNative: e.titleNative,
    }),
  )
  return Object.freeze(copy)
}

/**
 * 创建（或覆盖）单槽令牌。
 * 无条件覆盖旧槽：旧令牌在本次调用后立即失效。
 */
export function createToken(srcEntries: readonly SourceEntry[], route: RouteIdentity): string {
  const token = newToken()
  slot = {
    token,
    entries: freezeEntries(srcEntries),
    // ★ 复制 + 冻结：不保存调用方传入的引用
    route: Object.freeze({
      sourceId: route.sourceId,
      kind: route.kind,
      workId: route.workId,
    }),
    createdAt: Date.now(),
  }
  return token
}

/**
 * 纯读取校验。顺序固定：参数 → 槽存在 → token → route 三元组 → TTL。
 * 任何一步失败返回 null，且**不清理**有效上下文。
 */
export function peek(
  token: string | undefined | null,
  route: RouteIdentity,
): readonly EntrySnapshot[] | null {
  if (!token) return null
  const s = slot
  if (!s) return null
  if (s.token !== token) return null
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
