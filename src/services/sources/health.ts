/**
 * 来源健康记忆（O1，阶段 2 性能优化）
 * 规则（用户指令）：
 *  - 连续 2 次真实请求失败 → 首页聚合跳过该来源 10 分钟（cooldown）
 *  - 冷却结束自动恢复探测（isSkipped 过期即 false，并重置计数给全新周期）
 *  - 请求成功立即清除失败计数
 *  - 取消请求不计入失败（当前无主动取消路径；若未来加入，调用方按 AbortError 过滤后再记）
 *  - 只作用于首页聚合路径（skipUnhealthy=true 才查询/记录）；用户主动搜索与详情请求不受影响
 *  - 按 sourceId 独立；localStorage 结构带版本号，损坏/缺失自动重置
 */
const KEY = 'au_source_health'
const VERSION = 1
const FAIL_THRESHOLD = 2
const COOLDOWN_MS = 10 * 60 * 1000

export interface HealthEntry { fails: number; lastFailAt?: number; skippedUntil?: number; lastError?: string }
interface HealthData { v: number; sources: Record<string, HealthEntry> }

function load(): HealthData {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (raw && raw.v === VERSION && raw.sources && typeof raw.sources === 'object' && !Array.isArray(raw.sources)) {
      return { v: VERSION, sources: raw.sources }
    }
  } catch { /* 损坏/缺失 → 重置 */ }
  return { v: VERSION, sources: {} }
}

let data: HealthData = load()

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(data)) } catch { /* 容量满静默 */ }
}

/** 首页是否应跳过该来源（冷却中=跳过；冷却结束=不跳过并重置计数，进入新探测周期） */
export function isHomeSkipped(sourceId: string): boolean {
  const e = data.sources[sourceId]
  if (!e?.skippedUntil) return false
  if (Date.now() < e.skippedUntil) return true
  // 冷却结束：重置进入新周期（自动重新探测）
  delete data.sources[sourceId]
  save()
  return false
}

/** 成功 → 立即清零 */
export function recordHomeSuccess(sourceId: string): void {
  if (data.sources[sourceId]) {
    delete data.sources[sourceId]
    save()
  }
}

/** 失败 → 计数；连续达到阈值 → 进入冷却 */
export function recordHomeFailure(sourceId: string, kind: string): void {
  const e = data.sources[sourceId] || { fails: 0 }
  e.fails += 1
  e.lastFailAt = Date.now()
  e.lastError = kind
  if (e.fails >= FAIL_THRESHOLD) {
    e.skippedUntil = Date.now() + COOLDOWN_MS
  }
  data.sources[sourceId] = e
  save()
}

/** 调试/日志：健康快照（不含敏感数据） */
export function getHealthSnapshot(): Record<string, HealthEntry> {
  return JSON.parse(JSON.stringify(data.sources))
}
