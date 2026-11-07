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
  it('首版 0 个播放源', () => {
    expect(PLAYBACK_RESOLVERS.length).toBe(0)
  })

  it('enabledResolvers 返回空数组，不抛异常', () => {
    expect(() => enabledResolvers()).not.toThrow()
    expect(enabledResolvers()).toEqual([])
  })

  it('空表时 UNKNOWN_PLAYBACK_RANK 有确定值（不因 Math.max([]) 变成 -Infinity）', () => {
    expect(Number.isFinite(UNKNOWN_PLAYBACK_RANK)).toBe(true)
    expect(UNKNOWN_PLAYBACK_RANK).toBe(0)
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
  it('首版 PLAYBACK_ORDER 为空对象', () => {
    expect(Object.keys(PLAYBACK_ORDER).length).toBe(0)
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
