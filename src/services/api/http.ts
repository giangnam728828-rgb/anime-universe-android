/** 网络层：内存缓存 + localStorage 持久缓存(TTL 30min) + 超时 + 有限重试 + 并发限制(4)
 *  持久缓存让重开 APP / 二次访问秒开（规划书第七章稳定性要求）
 */
type Json = unknown

const TTL = 5 * 60 * 1000          // 内存缓存
const PTTL = 30 * 60 * 1000        // 持久缓存
const PMAX = 40                    // 持久缓存条目上限
const PKEY = 'au_http_cache'

const cache = new Map<string, { t: number; v: Json }>()

function loadPersist(): Record<string, { t: number; v: Json }> {
  try { return JSON.parse(localStorage.getItem(PKEY) || '{}') } catch { return {} }
}
function savePersist(key: string, v: Json) {
  try {
    const store = loadPersist()
    store[key] = { t: Date.now(), v }
    // LRU：超限删最旧
    const keys = Object.keys(store)
    if (keys.length > PMAX) {
      keys.sort((a, b) => (store[a]?.t || 0) - (store[b]?.t || 0))
      keys.slice(0, keys.length - PMAX).forEach((k) => delete store[k])
    }
    localStorage.setItem(PKEY, JSON.stringify(store))
  } catch { /* 容量满等异常静默 */ }
}
function readPersist(key: string): Json | undefined {
  try {
    const e = loadPersist()[key]
    if (e && Date.now() - e.t < PTTL) return e.v
  } catch { /* ignore */ }
  return undefined
}

let active = 0
const MAX_CONCURRENT = 4
const waiters: (() => void)[] = []
async function acquire() {
  if (active < MAX_CONCURRENT) { active++; return }
  await new Promise<void>((r) => waiters.push(r))
  active++
}
function release() {
  active--
  const w = waiters.shift()
  if (w) w()
}

export async function cachedPost(url: string, body: unknown, opts: { timeout?: number; retries?: number } = {}): Promise<Json> {
  const key = url + JSON.stringify(body)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.t < TTL) return hit.v
  const persisted = readPersist(key)
  if (persisted !== undefined) { cache.set(key, { t: Date.now(), v: persisted }); return persisted }

  const { timeout = 10000, retries = 1 } = opts
  await acquire()
  try {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
        clearTimeout(timer)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const json = (await r.json()) as Json
        cache.set(key, { t: Date.now(), v: json })
        savePersist(key, json)
        return json
      } catch (e) {
        clearTimeout(timer)
        if (attempt >= retries) throw e instanceof Error ? e : new Error(String(e))
        await new Promise((r2) => setTimeout(r2, 600))
      }
    }
  } finally {
    release()
  }
}

export async function cachedGet(url: string, opts: { timeout?: number; retries?: number } = {}): Promise<string> {
  const hit = cache.get('G:' + url)
  if (hit && Date.now() - hit.t < TTL) return hit.v as string
  const persisted = readPersist('G:' + url)
  if (persisted !== undefined) { cache.set('G:' + url, { t: Date.now(), v: persisted }); return persisted as string }

  const { timeout = 10000, retries = 1 } = opts
  await acquire()
  try {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const r = await fetch(url, { signal: ctrl.signal })
        clearTimeout(timer)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const text = await r.text()
        cache.set('G:' + url, { t: Date.now(), v: text })
        savePersist('G:' + url, text)
        return text
      } catch (e) {
        clearTimeout(timer)
        if (attempt >= retries) throw e instanceof Error ? e : new Error(String(e))
        await new Promise((r2) => setTimeout(r2, 600))
      }
    }
  } finally {
    release()
  }
}
