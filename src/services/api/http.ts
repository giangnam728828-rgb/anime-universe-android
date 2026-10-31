/** 网络层：内存缓存(TTL 5min) + 超时 + 有限重试 + 并发限制(4) —— 满足规划书第七章要求 */
type Json = unknown

const cache = new Map<string, { t: number; v: Json }>()
const TTL = 5 * 60 * 1000

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
        if (cache.size > 100) {
          const first = cache.keys().next().value
          if (first) cache.delete(first)
        }
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

  const { timeout = 12000, retries = 1 } = opts
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
        if (cache.size > 100) {
          const first = cache.keys().next().value
          if (first) cache.delete(first)
        }
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
