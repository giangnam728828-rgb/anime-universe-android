/**
 * 批次③ · PlayerPage 接入测试（P30–P40）
 *
 * 覆盖方案 §5（PlayerPage 接入与自检模式隔离）
 *
 * 🔴 本项目没有 jsdom（environment: 'node'），组件无法直接渲染测试。
 *    因此把「解析 → 会话 → 候选 → 原生参数」抽到 `playerFlow.ts`，
 *    本文件测纯逻辑；组件行为用源码契约断言（P40）兜底。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  prepareRealPlayback,
  prepareSelfTestPlayback,
  switchCandidate,
  listCandidateOptions,
  isPlayableCandidate,
  SELF_TEST_ASSET_URI,
  type PrepareRealDeps,
} from '../src/modules/player/playerFlow'
import {
  clearSession,
  getCurrentSession,
  getSelectedCandidate,
  __setNowForTest,
  __resetPreferredSourceForTest,
} from '../src/services/playback/PlaybackService'
import type { PlaybackSourceResolver } from '../src/services/playback/PlaybackService'
import type { PlaybackCandidate } from '../src/services/playback/types'

const SRC = join(__dirname, '..', 'src')

function cand(sourceId: string, n: number, url?: string): PlaybackCandidate {
  return {
    candidateId: `${sourceId}#${n}`,
    sourceId,
    sourceName: `来源${sourceId}`,
    url: url ?? `https://cdn.example.com/${sourceId}/${n}.m3u8`,
    protocol: 'hls',
  }
}

function mkResolver(
  id: string,
  impl: () => Promise<PlaybackCandidate[]>,
): PlaybackSourceResolver {
  return {
    sourceId: id,
    sourceName: `来源${id}`,
    getEpisodes: async () => [],
    getCandidates: impl,
  } as unknown as PlaybackSourceResolver
}

beforeEach(() => {
  clearSession()
  __resetPreferredSourceForTest()
  __setNowForTest(() => 1_000_000)
})

/* ══════════════════════════════════════════════════════════════════════
 * real 模式
 * ══════════════════════════════════════════════════════════════════════ */

describe('P30 real 模式：解析 → 会话 → 候选', () => {
  it('P30a 有候选时返回 network 参数', async () => {
    const deps: PrepareRealDeps = {
      resolvers: [mkResolver('a', async () => [cand('a', 0)])],
    }
    const r = await prepareRealPlayback('w1', 'e1', deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.params.uriKind).toBe('network')
    expect(r.params.url).toBe('https://cdn.example.com/a/0.m3u8')
    expect(r.params.workId).toBe('w1')
    expect(r.params.episodeId).toBe('e1')
  })

  it('P30b 播放来源取自候选，不是路由内容来源', async () => {
    const deps: PrepareRealDeps = {
      resolvers: [mkResolver('playSrc', async () => [cand('playSrc', 0)])],
    }
    // 路由里传的是内容来源 'contentSrc'
    const r = await prepareRealPlayback('w', 'e', deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 🔴 sourceId 必须是播放源 playSrc，不是 contentSrc
    expect(r.params.sourceId).toBe('playSrc')
  })

  it('P30c 多源聚合后取排序首个', async () => {
    const deps: PrepareRealDeps = {
      resolvers: [
        mkResolver('a', async () => [cand('a', 0)]),
        mkResolver('b', async () => [cand('b', 0)]),
      ],
    }
    const r = await prepareRealPlayback('w', 'e', deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.candidateCount).toBe(2)
    expect(r.params.sourceId).toBe('a')   // 同 rank 保持解析器顺序
  })
})

describe('P31 real 失败：绝不回退自检', () => {
  it('P31a 无播放源 ⇒ NO_RESOLVER_ENABLED，不返回 asset', async () => {
    const r = await prepareRealPlayback('w', 'e', { resolvers: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('NO_RESOLVER_ENABLED')
    expect(r.message).toBe('暂无可用播放源')
    // 🔴 不含自检素材
    expect(JSON.stringify(r)).not.toContain('asset:///')
    expect(JSON.stringify(r)).not.toContain('test.mp4')
  })

  it('P31b 全部源失败 ⇒ ALL_SOURCES_FAILED，不返回 asset', async () => {
    const deps: PrepareRealDeps = {
      resolvers: [
        mkResolver('a', async () => {
          throw new Error('boom')
        }),
      ],
    }
    const r = await prepareRealPlayback('w', 'e', deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('ALL_SOURCES_FAILED')
    expect(JSON.stringify(r)).not.toContain('asset:///')
  })

  it('P31c 失败时不建立会话', async () => {
    await prepareRealPlayback('w', 'e', { resolvers: [] })
    expect(getCurrentSession()).toBeNull()
  })

  it('P31d 失败文案不泄露 URL', async () => {
    const deps: PrepareRealDeps = {
      resolvers: [
        mkResolver('a', async () => {
          throw new Error('https://secret.example.com/token=abc 失败')
        }),
      ],
    }
    const r = await prepareRealPlayback('w', 'e', deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).not.toContain('secret.example.com')
    expect(r.message).not.toContain('token')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * selftest 模式
 * ══════════════════════════════════════════════════════════════════════ */

describe('P32 selftest 模式隔离', () => {
  it('P32a 返回 asset 参数', () => {
    const p = prepareSelfTestPlayback('w', 'e')
    expect(p.uriKind).toBe('asset')
    expect(p.url).toBe(SELF_TEST_ASSET_URI)
    expect(p.url).toBe('asset:///test.mp4')
  })

  it('P32b 不建会话、不碰解析器', () => {
    prepareSelfTestPlayback('w', 'e')
    expect(getCurrentSession()).toBeNull()
  })

  it('P32c sourceId 是 selftest，不是内容来源', () => {
    const p = prepareSelfTestPlayback('w', 'e')
    expect(p.sourceId).toBe('selftest')
  })

  it('P32d 两种模式的 uriKind 不同', async () => {
    const real = await prepareRealPlayback('w', 'e', {
      resolvers: [mkResolver('a', async () => [cand('a', 0)])],
    })
    const self = prepareSelfTestPlayback('w', 'e')
    expect(real.ok).toBe(true)
    if (!real.ok) return
    expect(real.params.uriKind).toBe('network')
    expect(self.uriKind).toBe('asset')
    expect(real.params.url).not.toBe(self.url)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 候选校验与切换
 * ══════════════════════════════════════════════════════════════════════ */

describe('P33 候选校验', () => {
  it('P33a 合法候选', () => {
    expect(isPlayableCandidate(cand('a', 0))).toBe(true)
  })

  it('P33b 拒绝空 / 非 http(s) / 非法协议', () => {
    expect(isPlayableCandidate(null)).toBe(false)
    expect(isPlayableCandidate({ ...cand('a', 0), url: '' })).toBe(false)
    expect(isPlayableCandidate({ ...cand('a', 0), url: 'ftp://x/y' })).toBe(false)
    expect(
      isPlayableCandidate({ ...cand('a', 0), protocol: 'dash' as never }),
    ).toBe(false)
  })
})

describe('P34 线路切换（candidateId 精确）', () => {
  it('P34a 同源多候选可切换到指定那条', async () => {
    const deps: PrepareRealDeps = {
      resolvers: [mkResolver('a', async () => [cand('a', 0), cand('a', 1), cand('a', 2)])],
    }
    await prepareRealPlayback('w', 'e', deps)

    const r = switchCandidate('a#2', 'w', 'e')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.params.url).toBe('https://cdn.example.com/a/2.m3u8')
  })

  it('P34b 传 sourceId 会失败', async () => {
    const deps: PrepareRealDeps = {
      resolvers: [mkResolver('a', async () => [cand('a', 0), cand('a', 1)])],
    }
    await prepareRealPlayback('w', 'e', deps)
    const r = switchCandidate('a', 'w', 'e')
    expect(r.ok).toBe(false)
  })

  it('P34c 无会话时切换失败', () => {
    const r = switchCandidate('a#0', 'w', 'e')
    expect(r.ok).toBe(false)
  })
})

describe('P35 候选列表不含 URL', () => {
  it('P35a listCandidateOptions 不返回 url', async () => {
    const deps: PrepareRealDeps = {
      resolvers: [mkResolver('a', async () => [cand('a', 0), cand('a', 1)])],
    }
    await prepareRealPlayback('w', 'e', deps)
    const opts = listCandidateOptions()
    expect(opts).toHaveLength(2)
    // 🔴 只含元信息，不含 URL
    expect(JSON.stringify(opts)).not.toContain('http')
    expect(Object.keys(opts[0])).not.toContain('url')
  })

  it('P35b 标记当前选中项', async () => {
    const deps: PrepareRealDeps = {
      resolvers: [mkResolver('a', async () => [cand('a', 0), cand('a', 1)])],
    }
    await prepareRealPlayback('w', 'e', deps)
    switchCandidate('a#1', 'w', 'e')
    const opts = listCandidateOptions()
    expect(opts.find((o) => o.candidateId === 'a#1')?.selected).toBe(true)
    expect(opts.find((o) => o.candidateId === 'a#0')?.selected).toBe(false)
  })

  it('P35c 无会话返回空数组', () => {
    expect(listCandidateOptions()).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 源码契约（组件无法渲染测试，用契约断言兜底）
 * ══════════════════════════════════════════════════════════════════════ */

describe('P36 PlayerPage 源码契约', () => {
  const page = readFileSync(join(SRC, 'modules/player/PlayerPage.tsx'), 'utf-8')
  const flow = readFileSync(join(SRC, 'modules/player/playerFlow.ts'), 'utf-8')

  it('P36a 使用 playerFlow 而非自行解析', () => {
    expect(page).toContain("from './playerFlow'")
    expect(page).toContain('prepareRealPlayback')
    expect(page).toContain('prepareSelfTestPlayback')
    // 🔴 不在组件里直接调用聚合（只检查代码行，注释里说明设计是允许的）
    const pageCode = page
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n')
    expect(pageCode).not.toContain('resolveCandidates')
    expect(pageCode).not.toContain('enabledResolvers')
  })

  it('P36b 两种模式显式区分', () => {
    expect(page).toContain("'real'")
    expect(page).toContain("'selftest'")
  })

  it('P36c 保留自检素材（未删除）', () => {
    expect(flow).toContain('SELF_TEST_ASSET')
    expect(flow).toContain('asset:///')
  })

  it('P36d 🔴 real 失败路径不含自检调用', () => {
    // 取 handleRealPlay 函数体
    const start = page.indexOf('const handleRealPlay')
    const end = page.indexOf('const handleSelfTest')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = page.slice(start, end)
    expect(body).not.toContain('prepareSelfTestPlayback')
    expect(body).not.toContain('SELF_TEST_ASSET')
    expect(body).not.toContain('asset:///')
  })

  it('P36e 卸载时清理会话', () => {
    expect(page).toContain('clearSession')
  })

  it('P36f 解析期间卸载则丢弃迟到结果', () => {
    expect(page).toContain('aliveRef')
    expect(page).toMatch(/if\s*\(!aliveRef\.current\)\s*return/)
  })

  it('P36g 不持久化 URL', () => {
    expect(page).not.toMatch(/localStorage\s*\./)
    expect(page).not.toMatch(/sessionStorage\s*\./)
    expect(flow).not.toMatch(/localStorage\s*\./)
    expect(flow).not.toMatch(/indexedDB/i)
  })

  it('P36h 不在日志中打印 url', () => {
    expect(page).not.toMatch(/console\.\w+\([^)]*\.url/)
    expect(flow).not.toMatch(/console\.\w+\([^)]*\.url/)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 冻结区
 * ══════════════════════════════════════════════════════════════════════ */

describe('P37 冻结区未改', () => {
  it('P37a nativeBridge 不含批次③ 逻辑', () => {
    const src = readFileSync(join(SRC, 'services/playback/nativeBridge.ts'), 'utf-8')
    expect(src).not.toContain('prepareRealPlayback')
    expect(src).not.toContain('candidateId')
  })

  it('P37b resolve.ts 未被本批次修改', () => {
    const src = readFileSync(join(SRC, 'services/playback/resolve.ts'), 'utf-8')
    expect(src).toContain('RESOLVE_TIMEOUT_MS')
    expect(src).not.toContain('prepareRealPlayback')
  })

  it('P37c sources 注册表未动', () => {
    const src = readFileSync(join(SRC, 'services/sources/registry.ts'), 'utf-8')
    expect(src).toContain('?? SOURCES[0]')
  })
})
