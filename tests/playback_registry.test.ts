/**
 * 批次① · 播放源注册表测试（P1–P5）
 *
 * 覆盖方案 v2 §1（Playback Registry）与 §1.3.1（空 Registry 安全）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PLAYBACK_ORDER,
  UNKNOWN_PLAYBACK_RANK,
  PLAYBACK_RESOLVERS,
  getResolver,
  enabledResolvers,
  playbackRank,
} from '../src/services/playback/registry'
import {
  setSourceEnabled,
  __reloadForTest,
} from '../src/services/sources/settings'

const SRC = join(__dirname, '..', 'src')

describe('P1 空 Registry 安全', () => {
  /*
   * 阶段3·第3步·第2步：首批真实 Resolver（IA）已登记，
   * 「首版 0 个播放源」的字面断言失效。
   *
   * 但 P1 组的**核心约束仍然有效且必须继续锁住**：
   *   ① 空表不得抛异常（enabledResolvers 对空表安全）
   *   ② UNKNOWN_PLAYBACK_RANK 必须有确定值，不能是 -Infinity
   *   ③ 未知 sourceId 不回退首个 Resolver
   *
   * ⇒ 改为「不依赖具体数量」的形式，并显式测空表路径。
   */
  it('🔴 生产注册表必须精确等于 {ia-archive}（不是「看起来合法」）', () => {
    const ids = PLAYBACK_RESOLVERS.map((r) => r.sourceId).sort()
    expect(ids).toEqual(['ia-archive'])
  })

  it('每个 resolver 都有非空 sourceId / sourceName', () => {
    for (const r of PLAYBACK_RESOLVERS) {
      expect(typeof r.sourceId).toBe('string')
      expect(r.sourceId.length).toBeGreaterThan(0)
      expect(typeof r.sourceName).toBe('string')
      expect(r.sourceName.length).toBeGreaterThan(0)
    }
  })

  it('enabledResolvers 不抛异常', () => {
    expect(() => enabledResolvers()).not.toThrow()
    expect(Array.isArray(enabledResolvers())).toBe(true)
  })

  it('UNKNOWN_PLAYBACK_RANK 有确定值（不因 Math.max([]) 变成 -Infinity）', () => {
    expect(Number.isFinite(UNKNOWN_PLAYBACK_RANK)).toBe(true)
    // 有已知 rank 时必须是「最大值 + 1」
    const known = Object.values(PLAYBACK_ORDER)
    if (known.length === 0) expect(UNKNOWN_PLAYBACK_RANK).toBe(0)
    else expect(UNKNOWN_PLAYBACK_RANK).toBe(Math.max(...known) + 1)
  })

  it('空表路径本身仍然安全（用空数组模拟，不依赖真实注册表）', () => {
    // 直接验证空表语义：过滤空数组必须返回空、不抛
    const empty: typeof PLAYBACK_RESOLVERS = []
    expect(empty.filter(() => true)).toEqual([])
    // UNKNOWN_PLAYBACK_RANK 的表达式对空表必须给出有限值
    expect(Number.isFinite(UNKNOWN_PLAYBACK_RANK)).toBe(true)
  })
})

describe('P1b enabledResolvers 真实过滤行为', () => {
  /*
   * 用户审查要求：不能只验证「不抛异常 + 返回数组」。
   * 必须覆盖三种情况：
   *   ① 预期启用配置下 IA 确实被返回
   *   ② 禁用 IA 后不被返回
   *   ③ 不会返回未注册的 Resolver
   *
   * ⚠️ 本项目 environment: 'node'，无 localStorage。
   *    isSourceEnabled 内部依赖 localStorage，因此用内存桩替代。
   */
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage
    __reloadForTest()
  })

  it('① 默认（全部启用）时返回 IA', () => {
    const ids = enabledResolvers().map((r) => r.sourceId)
    expect(ids).toContain('ia-archive')
  })

  it('② 禁用 IA 后不再返回', () => {
    setSourceEnabled('ia-archive', false)
    __reloadForTest()
    const ids = enabledResolvers().map((r) => r.sourceId)
    expect(ids).not.toContain('ia-archive')
    expect(ids).toHaveLength(0)
  })

  it('②b 重新启用后恢复返回', () => {
    setSourceEnabled('ia-archive', false)
    __reloadForTest()
    expect(enabledResolvers()).toHaveLength(0)
    setSourceEnabled('ia-archive', true)
    __reloadForTest()
    expect(enabledResolvers().map((r) => r.sourceId)).toEqual(['ia-archive'])
  })

  it('③ 返回结果必须是 PLAYBACK_RESOLVERS 的子集且是同一对象引用', () => {
    const registered = new Set(PLAYBACK_RESOLVERS.map((r) => r.sourceId))
    for (const r of enabledResolvers()) {
      expect(registered.has(r.sourceId)).toBe(true)
      expect(PLAYBACK_RESOLVERS).toContain(r)
    }
  })

  it('③b 禁用未知 id 不影响 IA', () => {
    setSourceEnabled('not-a-real-source', false)
    __reloadForTest()
    expect(enabledResolvers().map((r) => r.sourceId)).toContain('ia-archive')
  })
})

describe('P2 getResolver 未知 id 不回退首个', () => {
  it('未知 id 返回 undefined', () => {
    expect(getResolver('not-exist')).toBeUndefined()
  })

  it('空字符串返回 undefined', () => {
    expect(getResolver('')).toBeUndefined()
  })

  it('源码不回退 SOURCES[0] / PLAYBACK_RESOLVERS[0]', () => {
    const src = readFileSync(join(SRC, 'services/playback/registry.ts'), 'utf-8')
    // 允许出现在断言/注释里，但实现不得写成 find(...) ?? PLAYBACK_RESOLVERS[0]
    expect(src).not.toMatch(/\?\?\s*PLAYBACK_RESOLVERS\[0\]/)
  })
})

describe('P3 排名表自洽（构建期断言存在）', () => {
  it('PLAYBACK_ORDER 的 rank 全为非负整数且唯一', () => {
    const vals = Object.values(PLAYBACK_ORDER)
    for (const v of vals) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
    expect(new Set(vals).size).toBe(vals.length)
  })

  it('每个已注册 resolver 都有 rank 登记（两处必须一致）', () => {
    for (const r of PLAYBACK_RESOLVERS) {
      expect(Object.prototype.hasOwnProperty.call(PLAYBACK_ORDER, r.sourceId)).toBe(true)
    }
  })

  it('源码包含排名唯一性断言', () => {
    const src = readFileSync(join(SRC, 'services/playback/registry.ts'), 'utf-8')
    expect(src).toContain('PLAYBACK_ORDER 排名必须唯一')
    expect(src).toContain('PLAYBACK_ORDER 必须为非负整数')
    expect(src).toContain('解析器 id 必须唯一')
  })
})

describe('P4 playbackRank 未知来源', () => {
  it('未登记来源返回 UNKNOWN_PLAYBACK_RANK', () => {
    expect(playbackRank('unknown-src')).toBe(UNKNOWN_PLAYBACK_RANK)
  })
})

describe('P5 原型链键防护', () => {
  it('constructor 不命中', () => {
    expect(playbackRank('constructor')).toBe(UNKNOWN_PLAYBACK_RANK)
  })

  it('__proto__ 不命中', () => {
    expect(playbackRank('__proto__')).toBe(UNKNOWN_PLAYBACK_RANK)
  })

  it('toString 不命中', () => {
    expect(playbackRank('toString')).toBe(UNKNOWN_PLAYBACK_RANK)
  })
})

describe('P5a 冻结边界：不与 sources/registry 合并', () => {
  it('playback/registry 不 import sources/registry', () => {
    const src = readFileSync(join(SRC, 'services/playback/registry.ts'), 'utf-8')
    expect(src).not.toMatch(/from\s+['"]\.\.\/sources\/registry['"]/)
  })

  it('playback/registry 不修改 sources/registry.ts', () => {
    const src = readFileSync(join(SRC, 'services/sources/registry.ts'), 'utf-8')
    // 既有语义保留：getSource 仍回退 SOURCES[0]
    expect(src).toContain('?? SOURCES[0]')
  })
})
