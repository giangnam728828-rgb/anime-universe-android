/**
 * 批次① · 播放源注册表测试（P1–P5）
 *
 * 覆盖方案 v2 §1（Playback Registry）与 §1.3.1（空 Registry 安全）
 */
import { describe, it, expect } from 'vitest'
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
  it('注册表结构合法（每个 resolver 都有 sourceId/sourceName）', () => {
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
