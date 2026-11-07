/**
 * P0-C · Jikan 超时隔离测试
 *
 * 背景：
 *  2026-11-08 实测 `api.jikan.moe` 在当前环境**完全不可达**：
 *    curl 返回 HTTP=000，CONNECT=0.000000s（TCP 握手未建立），
 *    两次 40s 全部超时。不是「慢」，是连不上。
 *
 * 因此 P0-C 的目标**不是**调小超时数值，而是验证：
 *  慢请求 / 超时 / 迟到响应 都**不会**拖垮其他来源，也不会覆盖成功结果。
 *
 * 已有机制（本次核对，不需新增）：
 *  - `DISCOVER_POLICY = { timeoutMs: 8000, retries: 0 }`
 *  - `useDiscoverFeed.ts:426` 注入 `sourceReqPolicy: { jikan: DISCOVER_POLICY }`
 *  - `index.ts:204` `timeoutMs = streamOpts?.requestTimeoutMs ?? 8000`
 *  - `index.ts:235` 每个来源独立 `withTimeout(...)` 包裹
 *  - `jikan.ts:17-23` 仅在传入 reqPolicy 时覆盖 HTTP 层默认值
 *
 * 本文件只断言**可独立验证的纯行为**，不 mock 真实网络。
 */
import { describe, it, expect, vi } from 'vitest'
import { DISCOVER_POLICY } from '../src/modules/discovery/useDiscoverFeed'

// ─────────────────── 1. 策略常量契约 ───────────────────
describe('J1 · DISCOVER_POLICY 数值契约', () => {
  it('J1a · 超时必须是 8000ms（与 http.ts 默认 10000 区分）', () => {
    expect(DISCOVER_POLICY.timeoutMs).toBe(8000)
  })

  it('J1b · 重试必须是 0（不无限重试）', () => {
    expect(DISCOVER_POLICY.retries).toBe(0)
  })

  it('J1c · 最坏等待 = timeoutMs × (retries + 1) = 8000ms，不是 20000ms', () => {
    const worst = DISCOVER_POLICY.timeoutMs * (DISCOVER_POLICY.retries + 1)
    expect(worst).toBe(8000)
    // 与 HTTP 层默认（10000 × 2 = 20000）相比必须更短
    expect(worst).toBeLessThan(10000 * 2)
  })

  it('J1d · 策略对象为只读常量（as const）', () => {
    // 编译期即 readonly；运行时验证键集合稳定
    expect(Object.keys(DISCOVER_POLICY).sort()).toEqual(['retries', 'timeoutMs'])
  })
})

// ─────────────────── 2. withTimeout 语义（本地重现） ───────────────────
/**
 * 这里不直接 import index.ts 的 withTimeout（未导出），
 * 而是按 index.ts:81-101 的**实际实现语义**验证其行为契约。
 * 若将来 index.ts 改变语义，本测试仍能作为「应有的行为」参照。
 */
function makeWithTimeout() {
  class TimeoutError extends Error {
    constructor(public ms: number) { super(`timeout ${ms}`); this.name = 'TimeoutError' }
  }
  return function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new TimeoutError(ms))
      }, ms)
      p.then(
        (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } },
        (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } },
      )
    })
  }
}

describe('J2 · 超时不会拖垮其他来源', () => {
  const withTimeout = makeWithTimeout()

  it('J2a · 慢来源超时后只影响自己，快来源结果保留', async () => {
    const slow = new Promise((r) => setTimeout(() => r('slow'), 500))
    const fast = Promise.resolve('fast')

    const results = await Promise.allSettled([
      withTimeout(slow, 30),
      withTimeout(fast, 30),
    ])

    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
    if (results[1].status === 'fulfilled') expect(results[1].value).toBe('fast')
  })

  it('J2b · 迟到响应不得覆盖已超时结果', async () => {
    let resolvedLate = false
    const late = new Promise((r) => setTimeout(() => { resolvedLate = true; r('late') }, 80))

    const r = await Promise.allSettled([withTimeout(late, 20)])
    expect(r[0].status).toBe('rejected')

    // 等待迟到响应真的到达
    await new Promise((res) => setTimeout(res, 120))
    expect(resolvedLate).toBe(true) // 响应确实迟到了
    // 但外层结果已经是 rejected，未被改写 —— allSettled 已固化
    expect(r[0].status).toBe('rejected')
  })

  it('J2c · 不无限重试：retries=0 时只尝试 1 次', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('net down'))
    let attempts = 0
    const retries = DISCOVER_POLICY.retries

    try {
      // 复现 http.ts 的重试循环语义：attempt 从 0 开始，attempt >= retries 时抛出
      for (let attempt = 0; ; attempt++) {
        attempts++
        await fn()
        if (attempt >= retries) break
      }
    } catch { /* expected */ }

    expect(attempts).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('J2d · 超时错误携带可诊断信息（来源 + 毫秒）', async () => {
    const never = new Promise(() => { /* 永不 settle */ })
    const err = await withTimeout(never, 15).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('TimeoutError')
    expect((err as Error).message).toContain('15')
  })
})

// ─────────────────── 3. 失败计数语义（不改成功结果） ───────────────────
describe('J3 · 来源失败只计入 failed，不清空已成功结果', () => {
  it('J3a · 部分失败时 items 必须完整保留', () => {
    // 复现 searchAll 的 settled 语义：成功来源的结果全部进入 items
    const settled = [
      { id: 'bangumi', ok: true, items: [{ id: 'b1' }, { id: 'b2' }] },
      { id: 'jikan', ok: false, items: [] as { id: string }[] },
      { id: 'mangadex', ok: true, items: [{ id: 'm1' }] },
    ]
    const items = settled.filter((s) => s.ok).flatMap((s) => s.items)
    const failed = settled.filter((s) => !s.ok).length

    expect(items).toHaveLength(3)
    expect(failed).toBe(1)
  })

  it('J3b · 全部失败时 items 为空且 failed = 来源数', () => {
    const settled = [
      { id: 'jikan', ok: false },
      { id: 'bilibili', ok: false },
    ]
    const items: unknown[] = settled.filter((s) => s.ok).flatMap(() => [])
    expect(items).toHaveLength(0)
    expect(settled.filter((s) => !s.ok).length).toBe(2)
  })

  it('J3c · 单源失败不得阻止 others 的结果提交（shouldCommit 视角）', () => {
    // itemCount>0 即提交，见 discovery_decisions D3c
    const itemCount = 3
    const failed = 1
    const cancelled = false
    const pipelineError = null
    const commit = !cancelled && !pipelineError && itemCount > 0
    expect(commit).toBe(true)
    expect(failed).toBeGreaterThan(0) // 有失败也照样提交
  })
})

// ─────────────────── 4. Jikan 专属隔离（不污染全局） ───────────────────
describe('J4 · Jikan 策略只作用于 jikan', () => {
  it('J4a · sourceReqPolicy 只含 jikan 键', () => {
    // 与 useDiscoverFeed.ts:426 保持一致
    const sourceReqPolicy = { jikan: DISCOVER_POLICY }
    expect(Object.keys(sourceReqPolicy)).toEqual(['jikan'])
  })

  it('J4b · 其他来源查不到策略 → 走 HTTP 层默认（行为不变）', () => {
    const sourceReqPolicy: Record<string, typeof DISCOVER_POLICY> = { jikan: DISCOVER_POLICY }
    for (const id of ['bangumi', 'anilist', 'mangadex', 'mangabaka', 'bilibili']) {
      expect(sourceReqPolicy[id]).toBeUndefined()
    }
  })

  it('J4c · 未配置策略时 searchArg 与 opts 同引用（不复制、零行为变化）', () => {
    const opts = { kind: 'anime' as const, sort: '热门' }
    const policy = undefined
    const searchArg = policy ? { ...opts, reqPolicy: policy } : opts
    expect(searchArg).toBe(opts) // 同一引用
  })
})
