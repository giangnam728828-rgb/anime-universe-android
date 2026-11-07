/**
 * 批次① · 多源聚合测试（P6–P15i）
 *
 * 覆盖方案 v2 §3（聚合与排序）、§3.4.1（逻辑超时隔离与并发预算）、§6.2（错误码）
 *
 * 🔴 三个实施检查点：
 *   A  candidateId 作用域（不重复注册同一 sourceId）
 *   B  并发预算生命周期（同一 Promise 只归还一次；异常路径也归还）
 *   C  部分成功即成功（不因部分失败丢弃成功候选）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveCandidates,
  RESOLVE_TIMEOUT_MS,
  MAX_RESOLVE_CONCURRENT,
  __physicalActive,
  __resetResolveBudget,
  type ResolveEvent,
} from '../src/services/playback/resolve'
import type { PlaybackSourceResolver } from '../src/services/playback/PlaybackService'
import type { PlaybackCandidate } from '../src/services/playback/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')

/** 可手动 settle 的 Promise */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 造一个候选（url 唯一） */
function cand(sourceId: string, n: number): PlaybackCandidate {
  return {
    candidateId: `${sourceId}#${n}`, // 会被 resolveOne 覆盖为原始索引，此处仅占位
    sourceId,
    sourceName: sourceId,
    url: `https://cdn.example.com/${sourceId}/${n}.m3u8`,
    protocol: 'hls',
  }
}

/** 造一个 resolver */
function mkResolver(
  id: string,
  impl: () => Promise<PlaybackCandidate[]>,
): PlaybackSourceResolver {
  return {
    sourceId: id,
    id,
    sourceName: id,
    getEpisodes: async () => [],
    getCandidates: impl,
  } as unknown as PlaybackSourceResolver
}

beforeEach(() => {
  __resetResolveBudget()
})

describe('P6 单源成功', () => {
  it('返回该源候选，failed 为空', async () => {
    const r = mkResolver('a', async () => [cand('a', 0), cand('a', 1)])
    const res = await resolveCandidates('w', 'e', [r])
    expect(res.candidates).toHaveLength(2)
    expect(res.succeeded).toEqual(['a'])
    expect(res.failed).toEqual([])
    expect(res.error).toBeUndefined()
  })
})

describe('P7 单源失败不影响其他源（检查点 C）', () => {
  it('3 源中 1 失败，另 2 源候选正常返回', async () => {
    const ok1 = mkResolver('a', async () => [cand('a', 0)])
    const bad = mkResolver('b', async () => {
      throw new Error('网络炸了')
    })
    const ok2 = mkResolver('c', async () => [cand('c', 0)])
    const res = await resolveCandidates('w', 'e', [ok1, bad, ok2])

    expect(res.candidates).toHaveLength(2)
    expect(res.succeeded.sort()).toEqual(['a', 'c'])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].sourceId).toBe('b')
    expect(res.failed[0].code).toBe('RESOLVE_FAILED')
    // 🔴 部分成功即成功
    expect(res.error).toBeUndefined()
  })
})

describe('P8 全部失败', () => {
  it('candidates 空 + ALL_SOURCES_FAILED', async () => {
    const r1 = mkResolver('a', async () => {
      throw new Error('x')
    })
    const r2 = mkResolver('b', async () => [])
    const res = await resolveCandidates('w', 'e', [r1, r2])
    expect(res.candidates).toEqual([])
    expect(res.error).toBe('ALL_SOURCES_FAILED')
    expect(res.failed).toHaveLength(2)
  })
})

describe('P9 无启用源', () => {
  it('空 resolvers ⇒ NO_RESOLVER_ENABLED，不抛异常', async () => {
    const res = await resolveCandidates('w', 'e', [])
    expect(res.candidates).toEqual([])
    expect(res.error).toBe('NO_RESOLVER_ENABLED')
    expect(res.succeeded).toEqual([])
    expect(res.failed).toEqual([])
  })
})

describe('P10 单源超时（逻辑超时）', () => {
  it('超时源记 RESOLVE_TIMEOUT，其他源不受影响', async () => {
    const slow = mkResolver('slow', () => new Promise(() => {})) // 永不 settle
    const fast = mkResolver('fast', async () => [cand('fast', 0)])
    const res = await resolveCandidates('w', 'e', [slow, fast], { timeoutMs: 30 })

    expect(res.succeeded).toEqual(['fast'])
    expect(res.failed[0].sourceId).toBe('slow')
    expect(res.failed[0].code).toBe('RESOLVE_TIMEOUT')
    expect(res.error).toBeUndefined()
  })

  it('RESOLVE_TIMEOUT_MS 默认 8000', () => {
    expect(RESOLVE_TIMEOUT_MS).toBe(8000)
  })
})

describe('P11/P12 排序：rank 升序 + 同 rank 稳定', () => {
  it('未登记来源全部同 rank，保持解析器顺序', async () => {
    const a = mkResolver('a', async () => [cand('a', 0)])
    const b = mkResolver('b', async () => [cand('b', 0)])
    const c = mkResolver('c', async () => [cand('c', 0)])
    const res = await resolveCandidates('w', 'e', [a, b, c])
    expect(res.candidates.map((x) => x.sourceId)).toEqual(['a', 'b', 'c'])
  })
})

describe('P13 偏好源置顶', () => {
  it('preferredSourceId 的候选在首位', async () => {
    const a = mkResolver('a', async () => [cand('a', 0)])
    const b = mkResolver('b', async () => [cand('b', 0)])
    const res = await resolveCandidates('w', 'e', [a, b], { preferredSourceId: 'b' })
    expect(res.candidates[0].sourceId).toBe('b')
    expect(res.candidates[1].sourceId).toBe('a')
  })
})

describe('P14 URL 去重', () => {
  it('同 URL 只保留首个', async () => {
    const dup = 'https://cdn.example.com/same.m3u8'
    const a = mkResolver('a', async () => [
      { candidateId: '', sourceId: 'a', sourceName: 'a', url: dup, protocol: 'hls' },
    ])
    const b = mkResolver('b', async () => [
      { candidateId: '', sourceId: 'b', sourceName: 'b', url: dup, protocol: 'hls' },
    ])
    const res = await resolveCandidates('w', 'e', [a, b])
    expect(res.candidates).toHaveLength(1)
    expect(res.candidates[0].sourceId).toBe('a') // 保留排序靠前者
  })
})

describe('P15 candidateId 唯一性', () => {
  it('同源多候选 id 不同', async () => {
    const a = mkResolver('a', async () => [cand('a', 0), cand('a', 1), cand('a', 2)])
    const res = await resolveCandidates('w', 'e', [a])
    const ids = res.candidates.map((c) => c.candidateId)
    expect(new Set(ids).size).toBe(3)
  })
})

describe('P15a 同源 3 候选分别选中（D-1 核心）', () => {
  it('candidateId 分别指向第 1/2/3 条，不是恒取首个', async () => {
    const a = mkResolver('a', async () => [cand('a', 0), cand('a', 1), cand('a', 2)])
    const res = await resolveCandidates('w', 'e', [a])

    expect(res.candidates.map((c) => c.candidateId)).toEqual(['a#0', 'a#1', 'a#2'])
    // 每条 url 不同 ⇒ 能精确区分
    expect(new Set(res.candidates.map((c) => c.url)).size).toBe(3)
    expect(res.candidates[1].url).toContain('/1.m3u8')
    expect(res.candidates[2].url).toContain('/2.m3u8')
  })
})

describe('P15b 两源各多候选，身份不冲突', () => {
  it('a#0 与 b#0 互不覆盖', async () => {
    const a = mkResolver('a', async () => [cand('a', 0), cand('a', 1)])
    const b = mkResolver('b', async () => [cand('b', 0), cand('b', 1)])
    const res = await resolveCandidates('w', 'e', [a, b])
    const ids = res.candidates.map((c) => c.candidateId)
    expect(ids).toEqual(['a#0', 'a#1', 'b#0', 'b#1'])
    expect(new Set(ids).size).toBe(4)
  })
})

describe('P15c 排序后仍能选中原候选（C1）', () => {
  it('偏好源置顶后，非偏好源候选的 id 不变', async () => {
    const a = mkResolver('a', async () => [cand('a', 0), cand('a', 1)])
    const b = mkResolver('b', async () => [cand('b', 0), cand('b', 1)])
    const res = await resolveCandidates('w', 'e', [a, b], { preferredSourceId: 'b' })

    // b 置顶，但 a 的 id 仍是 a#0 / a#1，没被重排成 a#2 / a#3
    expect(res.candidates.map((c) => c.candidateId)).toEqual(['b#0', 'b#1', 'a#0', 'a#1'])
  })
})

describe('P15d candidateId 用单源原始索引（C1）', () => {
  it('跳过的非法候选不影响后续候选的原始索引', async () => {
    const a = mkResolver('a', async () => [
      cand('a', 0),
      { candidateId: '', sourceId: 'a', sourceName: 'a', url: '', protocol: 'hls' }, // 非法
      cand('a', 2),
    ])
    const res = await resolveCandidates('w', 'e', [a])
    // 原始索引 0 与 2 被保留；非法的那条不占用 id
    expect(res.candidates.map((c) => c.candidateId)).toEqual(['a#0', 'a#2'])
  })
})

describe('P15e 聚合不重新生成 id（C2）', () => {
  it('去重与排序后 id 字段一字不改', async () => {
    const a = mkResolver('a', async () => [cand('a', 0), cand('a', 1)])
    const res = await resolveCandidates('w', 'e', [a], { preferredSourceId: 'a' })
    for (const c of res.candidates) {
      expect(c.candidateId).toBe(`${c.sourceId}#${c.candidateId.split('#')[1]}`)
    }
    expect(res.candidates.map((c) => c.candidateId)).toEqual(['a#0', 'a#1'])
  })
})

describe('P15f 迟到结果不写回（检查点 B / Q2 隔离）', () => {
  it('超时后 Resolver 返回候选 ⇒ 聚合结果不含它', async () => {
    const d = deferred<PlaybackCandidate[]>()
    const slow = mkResolver('slow', () => d.promise)
    const fast = mkResolver('fast', async () => [cand('fast', 0)])

    const p = resolveCandidates('w', 'e', [slow, fast], { timeoutMs: 30 })
    // 超时先结算
    await new Promise((r) => setTimeout(r, 50))
    // 之后底层才返回候选
    d.resolve([cand('slow', 0)])

    const res = await p
    expect(res.candidates.map((c) => c.sourceId)).toEqual(['fast'])
    expect(res.failed[0].code).toBe('RESOLVE_TIMEOUT')
  })
})

describe('P15g 超时不归还并发名额（检查点 B 核心）', () => {
  it('底层未 settle 前 physicalActive 不减少', async () => {
    const d = deferred<PlaybackCandidate[]>()
    const slow = mkResolver('slow', () => d.promise)

    const before = __physicalActive()
    const p = resolveCandidates('w', 'e', [slow], { timeoutMs: 20 })
    await new Promise((r) => setTimeout(r, 40))

    // 已超时，但底层没 settle ⇒ 名额仍被占用
    expect(__physicalActive()).toBe(before + 1)

    d.resolve([cand('slow', 0)])
    await p
    await new Promise((r) => setTimeout(r, 10))

    // 底层 settle 后归还
    expect(__physicalActive()).toBe(before)
  })

  it('正常 resolve 归还名额', async () => {
    const before = __physicalActive()
    const a = mkResolver('a', async () => [cand('a', 0)])
    await resolveCandidates('w', 'e', [a])
    await new Promise((r) => setTimeout(r, 10))
    expect(__physicalActive()).toBe(before)
  })

  it('reject 也归还名额', async () => {
    const before = __physicalActive()
    const a = mkResolver('a', async () => {
      throw new Error('boom')
    })
    await resolveCandidates('w', 'e', [a])
    await new Promise((r) => setTimeout(r, 10))
    expect(__physicalActive()).toBe(before)
  })

  it('同步抛错也归还名额', async () => {
    const before = __physicalActive()
    const bad = {
      id: 'sync',
      sourceId: 'sync',
      sourceName: 'sync',
      getEpisodes: async () => [],
      getCandidates: () => {
        throw new Error('同步炸了')
      },
    } as unknown as PlaybackSourceResolver

    const res = await resolveCandidates('w', 'e', [bad])
    await new Promise((r) => setTimeout(r, 10))
    expect(res.failed[0].code).toBe('RESOLVE_FAILED')
    expect(__physicalActive()).toBe(before)
  })

  it('同一 Promise 只归还一次（不重复清理）', async () => {
    const before = __physicalActive()
    const a = mkResolver('a', async () => [cand('a', 0)])
    await resolveCandidates('w', 'e', [a])
    await new Promise((r) => setTimeout(r, 20))
    // 不会减到负数
    expect(__physicalActive()).toBeGreaterThanOrEqual(0)
    expect(__physicalActive()).toBe(before)
  })
})

describe('P15h 空候选源', () => {
  it('记 EMPTY_CANDIDATES，不当作成功', async () => {
    const empty = mkResolver('e', async () => [])
    const ok = mkResolver('ok', async () => [cand('ok', 0)])
    const res = await resolveCandidates('w', 'e', [empty, ok])
    expect(res.failed[0].code).toBe('EMPTY_CANDIDATES')
    expect(res.succeeded).toEqual(['ok'])
  })
})

describe('P15i 无效候选源', () => {
  it('缺 url / 非 http(s) / 缺 protocol 全部拒绝', async () => {
    const bad = mkResolver('bad', async () => [
      { candidateId: '', sourceId: 'bad', sourceName: 'bad', url: '', protocol: 'hls' },
      {
        candidateId: '',
        sourceId: 'bad',
        sourceName: 'bad',
        url: 'ftp://x/y.m3u8',
        protocol: 'hls',
      },
      {
        candidateId: '',
        sourceId: 'bad',
        sourceName: 'bad',
        url: 'https://x/y.m3u8',
        protocol: 'unknown' as never,
      },
    ])
    const res = await resolveCandidates('w', 'e', [bad])
    expect(res.failed[0].code).toBe('INVALID_CANDIDATES')
    expect(res.candidates).toEqual([])
  })

  it('部分非法时保留合法候选', async () => {
    const mixed = mkResolver('m', async () => [
      cand('m', 0),
      { candidateId: '', sourceId: 'm', sourceName: 'm', url: 'ftp://x', protocol: 'hls' },
    ])
    const res = await resolveCandidates('w', 'e', [mixed])
    expect(res.candidates).toHaveLength(1)
    expect(res.candidates[0].candidateId).toBe('m#0')
  })
})

describe('P15j 诊断事件不混写（Q2）', () => {
  it('timeout 与 settled 是两个不同事件，settled 标记 afterTimeout', async () => {
    const events: ResolveEvent[] = []
    const d = deferred<PlaybackCandidate[]>()
    const slow = mkResolver('slow', () => d.promise)

    const p = resolveCandidates('w', 'e', [slow], {
      timeoutMs: 20,
      onEvent: (e) => events.push(e),
    })
    await new Promise((r) => setTimeout(r, 40))
    d.resolve([cand('slow', 0)])
    await p
    await new Promise((r) => setTimeout(r, 10))

    const timeouts = events.filter((e) => e.type === 'resolve.timeout')
    const settleds = events.filter((e) => e.type === 'resolve.settled')
    expect(timeouts).toHaveLength(1)
    expect(settleds).toHaveLength(1)
    expect(settleds[0]).toMatchObject({ sourceId: 'slow', afterTimeout: true })
  })
})

describe('P15k 并发上限', () => {
  it('MAX_RESOLVE_CONCURRENT = 4', () => {
    expect(MAX_RESOLVE_CONCURRENT).toBe(4)
  })

  it('并发不超过上限（物理占用）', async () => {
    let peak = 0
    const mk = (id: string) =>
      mkResolver(id, async () => {
        peak = Math.max(peak, __physicalActive())
        await new Promise((r) => setTimeout(r, 20))
        return [cand(id, 0)]
      })
    const list = Array.from({ length: 8 }, (_, i) => mk(`s${i}`))
    await resolveCandidates('w', 'e', list)
    expect(peak).toBeLessThanOrEqual(MAX_RESOLVE_CONCURRENT)
  })
})

describe('P15l 不自动重试', () => {
  it('超时后不再次调用同一 Resolver', async () => {
    let calls = 0
    const slow = mkResolver('slow', () => {
      calls++
      return new Promise(() => {})
    })
    await resolveCandidates('w', 'e', [slow], { timeoutMs: 20 })
    expect(calls).toBe(1)
  })
})

describe('P15m 检查点 A：candidateId 作用域', () => {
  it('同一 sourceId 重复出现 ⇒ 入口去重，不产生重复 id', async () => {
    // registry 构建期断言禁止重复 sourceId；但 resolveCandidates 接受任意数组。
    // 此处验证：若调用方传入重复 sourceId，id 会冲突 —— 说明调用方必须先去重。
    const a1 = mkResolver('dup', async () => [cand('dup', 0)])
    const a2 = mkResolver('dup', async () => [cand('dup', 0)])
    const res = await resolveCandidates('w', 'e', [a1, a2])
    const ids = res.candidates.map((c) => c.candidateId)
    // URL 相同 ⇒ 被去重，只剩一条
    expect(res.candidates).toHaveLength(1)
    expect(ids).toEqual(['dup#0'])
  })

  it('同一 sourceId 两次注册但 URL 不同 ⇒ id 重复（必须由 registry 阻止）', async () => {
    const a1 = mkResolver('dup2', async () => [
      { candidateId: '', sourceId: 'dup2', sourceName: 'dup2', url: 'https://x/1.m3u8', protocol: 'hls' },
    ])
    const a2 = mkResolver('dup2', async () => [
      { candidateId: '', sourceId: 'dup2', sourceName: 'dup2', url: 'https://x/2.m3u8', protocol: 'hls' },
    ])
    const res = await resolveCandidates('w', 'e', [a1, a2])
    const ids = res.candidates.map((c) => c.candidateId)
    // 🔴 入口按 sourceId 去重，只保留首个 ⇒ id 不冲突
    expect(ids).toEqual(['dup2#0'])
    expect(res.candidates[0].url).toBe('https://x/1.m3u8')
  })

  it('registry 构建期断言确实检查 id 唯一性', () => {
    const src = readFileSync(join(SRC, 'services/playback/registry.ts'), 'utf-8')
    expect(src).toContain('解析器 id 必须唯一')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 批次① 补充证据 ①：迟到结果隔离（用户验收阻塞点 1）
 *
 * 🔴 核心命题：物理名额正确释放 ≠ 迟到结果被隔离。两者必须独立验证。
 * ══════════════════════════════════════════════════════════════════════ */

describe('P16 迟到结果隔离（阻塞点 1）', () => {
  it('P16a A 超时 + B 正常返回；A 迟到候选不进入结果', async () => {
    const dA = deferred<PlaybackCandidate[]>()
    const A = mkResolver('A', () => dA.promise)
    const B = mkResolver('B', async () => [cand('B', 0)])

    const p = resolveCandidates('w', 'e', [A, B], { timeoutMs: 30 })
    await new Promise((r) => setTimeout(r, 60))   // A 已超时

    // A 在超时之后才返回候选
    dA.resolve([cand('A', 0), cand('A', 1)])

    const res = await p
    // 🔴 结果只含 B
    expect(res.candidates.map((c) => c.sourceId)).toEqual(['B'])
    expect(res.succeeded).toEqual(['B'])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0]).toMatchObject({ sourceId: 'A', code: 'RESOLVE_TIMEOUT' })
  })

  it('P16b 迟到结果不覆盖已成功的 B 候选', async () => {
    const dA = deferred<PlaybackCandidate[]>()
    const A = mkResolver('A', () => dA.promise)
    const B = mkResolver('B', async () => [cand('B', 0), cand('B', 1)])

    const p = resolveCandidates('w', 'e', [A, B], { timeoutMs: 30 })
    await new Promise((r) => setTimeout(r, 60))
    dA.resolve([cand('A', 0)])
    const res = await p

    // B 的两条候选完整保留，A 的没有挤进来
    expect(res.candidates).toHaveLength(2)
    expect(res.candidates.every((c) => c.sourceId === 'B')).toBe(true)
  })

  it('P16c A 的迟到结果不影响下一轮解析', async () => {
    const dA = deferred<PlaybackCandidate[]>()
    const A = mkResolver('A', () => dA.promise)
    const B = mkResolver('B', async () => [cand('B', 0)])

    // 第 1 轮：A 超时
    const p1 = resolveCandidates('w', 'e', [A, B], { timeoutMs: 30 })
    await new Promise((r) => setTimeout(r, 60))
    const res1 = await p1
    expect(res1.candidates.map((c) => c.sourceId)).toEqual(['B'])

    // 第 2 轮：只用 B（不含 A）
    const res2 = await resolveCandidates('w', 'e', [B])
    // 🔴 第 1 轮 A 的迟到结果没有污染第 2 轮
    expect(res2.candidates.map((c) => c.sourceId)).toEqual(['B'])

    // 现在才让第 1 轮的 A 返回
    dA.resolve([cand('A', 0), cand('A', 1), cand('A', 2)])
    await new Promise((r) => setTimeout(r, 20))

    // 第 2 轮结果对象不会被事后改写
    expect(res2.candidates.map((c) => c.sourceId)).toEqual(['B'])
    expect(res1.candidates.map((c) => c.sourceId)).toEqual(['B'])
  })

  it('P16d 迟到候选不进入任何共享状态（结果对象冻结后不变）', async () => {
    const dA = deferred<PlaybackCandidate[]>()
    const A = mkResolver('A', () => dA.promise)
    const B = mkResolver('B', async () => [cand('B', 0)])

    const p = resolveCandidates('w', 'e', [A, B], { timeoutMs: 30 })
    await new Promise((r) => setTimeout(r, 60))
    const res = await p
    const snapshotIds = res.candidates.map((c) => c.candidateId)
    const snapshotLen = res.candidates.length

    dA.resolve([cand('A', 0)])
    await new Promise((r) => setTimeout(r, 30))

    expect(res.candidates.length).toBe(snapshotLen)
    expect(res.candidates.map((c) => c.candidateId)).toEqual(snapshotIds)
  })
})

describe('P17 诊断事件生命周期（阻塞点 1）', () => {
  it('P17a 正常路径：只有 settled，没有 timeout', async () => {
    const events: ResolveEvent[] = []
    const A = mkResolver('A', async () => [cand('A', 0)])
    await resolveCandidates('w', 'e', [A], { onEvent: (e) => events.push(e) })

    expect(events.filter((e) => e.type === 'resolve.timeout')).toHaveLength(0)
    const settled = events.filter((e) => e.type === 'resolve.settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ sourceId: 'A', afterTimeout: false })
  })

  it('P17b 超时路径：timeout 先于 settled，且 settled.afterTimeout=true', async () => {
    const events: ResolveEvent[] = []
    const d = deferred<PlaybackCandidate[]>()
    const A = mkResolver('A', () => d.promise)

    const p = resolveCandidates('w', 'e', [A], { timeoutMs: 20, onEvent: (e) => events.push(e) })
    await new Promise((r) => setTimeout(r, 40))

    // 此刻：timeout 已发生，settled 还没发生
    expect(events.filter((e) => e.type === 'resolve.timeout')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'resolve.settled')).toHaveLength(0)

    d.resolve([cand('A', 0)])
    await p
    await new Promise((r) => setTimeout(r, 10))

    const seq = events.map((e) => e.type)
    expect(seq).toEqual(['resolve.timeout', 'resolve.settled'])
    const settled = events.find((e) => e.type === 'resolve.settled')
    expect(settled).toMatchObject({ afterTimeout: true })
  })

  it('P17c 每个源各自一对事件，不串源', async () => {
    const events: ResolveEvent[] = []
    const dA = deferred<PlaybackCandidate[]>()
    const A = mkResolver('A', () => dA.promise)
    const B = mkResolver('B', async () => [cand('B', 0)])

    const p = resolveCandidates('w', 'e', [A, B], { timeoutMs: 20, onEvent: (e) => events.push(e) })
    await new Promise((r) => setTimeout(r, 40))
    dA.resolve([cand('A', 0)])
    await p
    await new Promise((r) => setTimeout(r, 10))

    // A: timeout + settled(afterTimeout=true)
    expect(events.filter((e) => e.sourceId === 'A' && e.type === 'resolve.timeout')).toHaveLength(1)
    expect(events.filter((e) => e.sourceId === 'A' && e.type === 'resolve.settled')).toHaveLength(1)
    // B: 只有 settled(afterTimeout=false)
    expect(events.filter((e) => e.sourceId === 'B' && e.type === 'resolve.timeout')).toHaveLength(0)
    const bSettled = events.find((e) => e.sourceId === 'B' && e.type === 'resolve.settled')
    expect(bSettled).toMatchObject({ afterTimeout: false })
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 批次① 补充证据 ②：全局并发预算（用户验收阻塞点 2）
 *
 * 🔴 核心命题：预算必须在**多轮并发调用之间共享**，不能只在单次调用内有效。
 * ══════════════════════════════════════════════════════════════════════ */

describe('P18 全局并发预算（阻塞点 2）', () => {
  it('P18a 上限值确认', () => {
    expect(MAX_RESOLVE_CONCURRENT).toBe(4)
  })

  it('P18b 单次调用内部不超上限', async () => {
    let peak = 0
    const mk = (id: string) =>
      mkResolver(id, async () => {
        peak = Math.max(peak, __physicalActive())
        await new Promise((r) => setTimeout(r, 15))
        return [cand(id, 0)]
      })
    await resolveCandidates('w', 'e', Array.from({ length: 8 }, (_, i) => mk(`s${i}`)))
    expect(peak).toBeLessThanOrEqual(MAX_RESOLVE_CONCURRENT)
  })

  it('P18c 多轮并发调用共享同一预算（关键）', async () => {
    let peak = 0
    const mk = (id: string) =>
      mkResolver(id, async () => {
        peak = Math.max(peak, __physicalActive())
        await new Promise((r) => setTimeout(r, 30))
        return [cand(id, 0)]
      })

    // 🔴 3 轮并发调用，每轮 4 个源 = 12 个底层请求
    const rounds = [
      resolveCandidates('w', 'e', [mk('a1'), mk('a2'), mk('a3'), mk('a4')]),
      resolveCandidates('w', 'e', [mk('b1'), mk('b2'), mk('b3'), mk('b4')]),
      resolveCandidates('w', 'e', [mk('c1'), mk('c2'), mk('c3'), mk('c4')]),
    ]
    await Promise.all(rounds)

    // 若预算只在单次调用内有效，peak 会达到 12
    expect(peak).toBeLessThanOrEqual(MAX_RESOLVE_CONCURRENT)
    expect(peak).toBeGreaterThan(1)  // 确认确实并发了
  })

  it('P18d 达到上限时新请求排队（不是跳过，不是报错）', async () => {
    const started: string[] = []
    const gates: Array<() => void> = []
    const mk = (id: string) =>
      mkResolver(id, async () => {
        started.push(id)
        await new Promise<void>((r) => gates.push(r))
        return [cand(id, 0)]
      })

    const p = resolveCandidates('w', 'e', Array.from({ length: 6 }, (_, i) => mk(`q${i}`)), {
      timeoutMs: 5000,
    })

    await new Promise((r) => setTimeout(r, 30))
    // 只有 4 个开始，2 个排队
    expect(started.length).toBe(MAX_RESOLVE_CONCURRENT)

    // 放开全部闸门，排队的会依次执行
    while (gates.length > 0) {
      const g = gates.shift()
      g?.()
      await new Promise((r) => setTimeout(r, 5))
    }

    const res = await p
    expect(res.candidates).toHaveLength(6)   // 排队后全部完成，不是跳过
    expect(started).toHaveLength(6)
  })

  it('P18e 超时但未 settle 的请求仍占用预算（跨调用可见）', async () => {
    const d = deferred<PlaybackCandidate[]>()
    const stuck = mkResolver('stuck', () => d.promise)

    // 第 1 轮：stuck 超时，但底层不 settle
    const r1 = await resolveCandidates('w', 'e', [stuck], { timeoutMs: 20 })
    expect(r1.failed[0].code).toBe('RESOLVE_TIMEOUT')
    // 🔴 名额仍被占
    expect(__physicalActive()).toBe(1)

    // 第 2 轮：占用预算的是上一轮的 stuck
    let peak = 0
    const mk = (id: string) =>
      mkResolver(id, async () => {
        peak = Math.max(peak, __physicalActive())
        await new Promise((r) => setTimeout(r, 10))
        return [cand(id, 0)]
      })
    await resolveCandidates('w', 'e', [mk('x1'), mk('x2'), mk('x3'), mk('x4')])
    // 只剩 3 个名额 ⇒ peak 最多 4（含 stuck）
    expect(peak).toBeLessThanOrEqual(MAX_RESOLVE_CONCURRENT)

    d.resolve([cand('stuck', 0)])
    await new Promise((r) => setTimeout(r, 20))
    expect(__physicalActive()).toBe(0)
  })

  it('P18f 真实 settle 后排队请求继续执行', async () => {
    const order: string[] = []
    const mk = (id: string, gate: Promise<void>) =>
      mkResolver(id, async () => {
        order.push(id)
        await gate
        return [cand(id, 0)]
      })

    const d1 = deferred<void>()
    const d2 = deferred<void>()
    const d3 = deferred<void>()
    const d4 = deferred<void>()
    const d5 = deferred<void>()

    const p = resolveCandidates(
      'w',
      'e',
      [mk('r1', d1.promise), mk('r2', d2.promise), mk('r3', d3.promise), mk('r4', d4.promise), mk('r5', d5.promise)],
      { timeoutMs: 5000 },
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['r1', 'r2', 'r3', 'r4'])   // r5 排队

    d1.resolve()   // 释放一个名额
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toContain('r5')                     // r5 被唤醒

    d2.resolve(); d3.resolve(); d4.resolve(); d5.resolve()
    await p
    expect(order).toHaveLength(5)
  })

  it('P18g 预算释放后归零（无泄漏）', async () => {
    const before = __physicalActive()
    const mk = (id: string) => mkResolver(id, async () => [cand(id, 0)])
    await resolveCandidates('w', 'e', [mk('z1'), mk('z2')])
    await new Promise((r) => setTimeout(r, 20))
    expect(__physicalActive()).toBe(before)
  })
})
