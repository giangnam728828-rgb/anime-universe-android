/**
 * 性能计时（阶段 2）—— 纯内存环形缓冲，不上传、不记录 Token/隐私/敏感参数
 * 查看方式：
 *  1) APP 内：我的 → 性能日志（调试）
 *  2) 远程采集：adb logcat -d | grep AU-PERF（WebView console 桥接）
 * 打点规范：phase=生命周期，sourceId=来源，ms=耗时，status=ok/fail/cache-hit
 */
export interface PerfEntry {
  t: number           // 时间戳 Date.now()
  phase: string       // home-mount | home-restore | hydrate | source-request | first-batch | img-load | home-complete
  sourceId?: string
  status?: 'ok' | 'fail' | 'cache-hit'
  ms?: number         // 耗时
  detail?: string     // 补充信息（不含敏感参数）
}

const MAX = 600
const LS_KEY = 'au_perf_log'

/** 持久化：localStorage（清"缓存"不清 localStorage——冷启动 force-stop 杀进程后数据不丢，
 *  全部场景可累积后一次性复制采集；仅"清除数据/卸载"才清空） */
function loadPersist(): PerfEntry[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] }
}
function savePersist(): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(buf)) } catch { /* 容量满静默 */ }
}

const buf: PerfEntry[] = loadPersist().slice(-MAX)

export function perf(e: Omit<PerfEntry, 't'>): void {
  const entry: PerfEntry = { t: Date.now(), ...e }
  buf.push(entry)
  if (buf.length > MAX) buf.shift()
  savePersist()
  // console 桥接（debug 构建可走 logcat；release 走剪贴板通道）
  console.log(`[AU-PERF] ${JSON.stringify(entry)}`)
}

export function getPerfLog(): PerfEntry[] {
  return [...buf].reverse() // 最新在前
}

export function clearPerf(): void {
  buf.length = 0
  try { localStorage.removeItem(LS_KEY) } catch { /* ignore */ }
  console.log('[AU-PERF] cleared')
}

/** 计时辅助：记录一个从 t0 到现在的时间段 */
export function perfSince(phase: string, t0: number, extra?: Omit<PerfEntry, 't' | 'phase' | 'ms'>): void {
  perf({ phase, ms: Date.now() - t0, ...extra })
}
