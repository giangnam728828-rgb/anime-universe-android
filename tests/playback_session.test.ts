/**
 * 批次② · PlaybackService 会话贯通测试（P20–P34）
 *
 * 覆盖方案 v2 §4（会话创建与调用链）、§4.4（会话选择 vs 来源偏好）、
 * §4.5（当前候选失效自愈）、§7（TTL 与临时 URL 生命周期）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSession,
  getCurrentSession,
  getSelectedCandidate,
  selectCandidate,
  clearSession,
  getPreferredSourceId,
  setPlaybackState,
  getPlaybackState,
  subscribePlaybackState,
  SESSION_TTL_MS,
  __setNowForTest,
  __resetPreferredSourceForTest,
} from '../src/services/playback/PlaybackService'
import type { PlaybackCandidate } from '../src/services/playback/types'

const SRC = join(__dirname, '..', 'src')

/** 造候选 */
function cand(sourceId: string, n: number): PlaybackCandidate {
  return {
    candidateId: `${sourceId}#${n}`,
    sourceId,
    sourceName: sourceId,
    url: `https://cdn.example.com/${sourceId}/${n}.m3u8`,
    protocol: 'hls',
  }
}

/** 当前假时钟 */
let fakeNow = 1_000_000

beforeEach(() => {
  clearSession()
  __resetPreferredSourceForTest()
  fakeNow = 1_000_000
  __setNowForTest(() => fakeNow)
  setPlaybackState('idle')
})

/* ══════════════════════════════════════════════════════════════════════
 * 会话创建
 * ══════════════════════════════════════════════════════════════════════ */

describe('P20 createSession 接入聚合结果', () => {
  it('P20a 正常建立会话', () => {
    const s = createSession('w1', 'e1', { candidates: [cand('a', 0), cand('a', 1)] })
    expect(s.workId).toBe('w1')
    expect(s.episodeId).toBe('e1')
    expect(s.candidates).toHaveLength(2)
    expect(s.createdAt).toBe(fakeNow)
  })

  it('P20b 默认选中首个候选（用 candidateId）', () => {
    const s = createSession('w', 'e', { candidates: [cand('a', 0), cand('b', 0)] })
    // 🔴 存的是 candidateId，不是 sourceId
    expect(s.selectedCandidateId).toBe('a#0')
  })

  it('P20c 空候选抛 ALL_SOURCES_FAILED，不建立空会话', () => {
    expect(() => createSession('w', 'e', { candidates: [] })).toThrow(/ALL_SOURCES_FAILED/)
    expect(getCurrentSession()).toBeNull()
  })

  it('P20d 有来源偏好时，默认选中偏好来源的候选', () => {
    // 先建立会话并选中 b#0 ⇒ 记录偏好 b
    createSession('w', 'e', { candidates: [cand('a', 0), cand('b', 0)] })
    selectCandidate('b#0')
    expect(getPreferredSourceId()).toBe('b')

    // 重新建会话（新一集）：默认应选中 b 源
    const s2 = createSession('w', 'e2', { candidates: [cand('a', 0), cand('b', 0)] })
    expect(s2.selectedCandidateId).toBe('b#0')
  })

  it('P20e 偏好来源无候选时回落到首个', () => {
    createSession('w', 'e', { candidates: [cand('a', 0), cand('b', 0)] })
    selectCandidate('b#0')

    // 新一集只有 a 源
    const s2 = createSession('w', 'e2', { candidates: [cand('a', 0), cand('a', 1)] })
    expect(s2.selectedCandidateId).toBe('a#0')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * candidateId 精确选择（D-1）
 * ══════════════════════════════════════════════════════════════════════ */

describe('P21 candidateId 精确选择（D-1 修复验证）', () => {
  it('P21a 同源 3 候选分别选择第 1/2/3 条', () => {
    createSession('w', 'e', {
      candidates: [cand('a', 0), cand('a', 1), cand('a', 2)],
    })

    const c1 = selectCandidate('a#0')
    expect(c1?.url).toContain('/0.m3u8')

    const c2 = selectCandidate('a#1')
    expect(c2?.url).toContain('/1.m3u8')

    const c3 = selectCandidate('a#2')
    expect(c3?.url).toContain('/2.m3u8')

    // 🔴 关键：用 sourceId 查找永远只能取到第一条，这里能精确区分
    expect(getSelectedCandidate()?.url).toContain('/2.m3u8')
  })

  it('P21b 两源各多候选，身份不冲突', () => {
    createSession('w', 'e', {
      candidates: [cand('a', 0), cand('a', 1), cand('b', 0), cand('b', 1)],
    })
    expect(selectCandidate('a#1')?.url).toContain('/a/1.m3u8')
    expect(selectCandidate('b#0')?.url).toContain('/b/0.m3u8')
    expect(getSelectedCandidate()?.candidateId).toBe('b#0')
  })

  it('P21c 选择不存在的 candidateId ⇒ 返回 null，不改变当前选择', () => {
    createSession('w', 'e', { candidates: [cand('a', 0), cand('a', 1)] })
    selectCandidate('a#1')

    const r = selectCandidate('a#99')
    expect(r).toBeNull()
    // 🔴 无副作用
    expect(getSelectedCandidate()?.candidateId).toBe('a#1')
  })

  it('P21d 用 sourceId 选择会失败（证明必须用 candidateId）', () => {
    createSession('w', 'e', { candidates: [cand('a', 0), cand('a', 1)] })
    const r = selectCandidate('a')   // 传 sourceId
    expect(r).toBeNull()             // 找不到 candidateId='a'
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 当前候选失效自愈
 * ══════════════════════════════════════════════════════════════════════ */

describe('P22 当前候选失效自愈', () => {
  it('P22a 选中候选消失时回落首个并修正 id', () => {
    const s = createSession('w', 'e', {
      candidates: [cand('a', 0), cand('a', 1), cand('a', 2)],
    })
    selectCandidate('a#2')
    expect(s.selectedCandidateId).toBe('a#2')

    // 模拟会话被替换：候选列表里没有 a#2 了
    s.candidates = [cand('a', 0), cand('a', 1)]
    const got = getSelectedCandidate()

    expect(got?.candidateId).toBe('a#0')
    // 🔴 关键：会话内的 id 也被修正，不留悬空
    expect(s.selectedCandidateId).toBe('a#0')
  })

  it('P22b 自愈后再次调用稳定（不反复回退）', () => {
    const s = createSession('w', 'e', { candidates: [cand('a', 0), cand('a', 1)] })
    selectCandidate('a#1')
    s.candidates = [cand('a', 0)]
    expect(getSelectedCandidate()?.candidateId).toBe('a#0')
    expect(getSelectedCandidate()?.candidateId).toBe('a#0')
    expect(s.selectedCandidateId).toBe('a#0')
  })

  it('P22c 候选全空时返回 null（不崩溃）', () => {
    const s = createSession('w', 'e', { candidates: [cand('a', 0)] })
    s.candidates = []
    expect(getSelectedCandidate()).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * TTL 与临时 URL 生命周期
 * ══════════════════════════════════════════════════════════════════════ */

describe('P23 TTL 边界', () => {
  it('P23a TTL 常量是 30 分钟', () => {
    expect(SESSION_TTL_MS).toBe(30 * 60 * 1000)
  })

  it('P23b 29 分钟时会话仍有效', () => {
    createSession('w', 'e', { candidates: [cand('a', 0)] })
    fakeNow += 29 * 60 * 1000
    expect(getCurrentSession()).not.toBeNull()
    expect(getSelectedCandidate()).not.toBeNull()
  })

  it('P23c 31 分钟时会话失效', () => {
    createSession('w', 'e', { candidates: [cand('a', 0)] })
    fakeNow += 31 * 60 * 1000
    expect(getCurrentSession()).toBeNull()
  })

  it('P23d 过期后 getSelectedCandidate 返回 null（不返回过期 URL）', () => {
    createSession('w', 'e', { candidates: [cand('a', 0)] })
    fakeNow += 31 * 60 * 1000
    expect(getSelectedCandidate()).toBeNull()
  })

  it('P23e 过期后 selectCandidate 返回 null', () => {
    createSession('w', 'e', { candidates: [cand('a', 0), cand('a', 1)] })
    fakeNow += 31 * 60 * 1000
    expect(selectCandidate('a#1')).toBeNull()
  })

  it('P23f 过期边界精确（恰好 30 分钟仍有效）', () => {
    createSession('w', 'e', { candidates: [cand('a', 0)] })
    fakeNow += SESSION_TTL_MS        // 恰好等于 TTL，未超过
    expect(getCurrentSession()).not.toBeNull()

    fakeNow += 1                     // 超过 1ms
    expect(getCurrentSession()).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 会话清理
 * ══════════════════════════════════════════════════════════════════════ */

describe('P24 clearSession', () => {
  it('P24a 清空后返回 null', () => {
    createSession('w', 'e', { candidates: [cand('a', 0)] })
    clearSession()
    expect(getCurrentSession()).toBeNull()
    expect(getSelectedCandidate()).toBeNull()
  })

  it('P24b 清空会话保留来源偏好（用户 Q3）', () => {
    createSession('w', 'e', { candidates: [cand('a', 0), cand('b', 0)] })
    selectCandidate('b#0')
    clearSession()
    // 🔴 偏好跨会话保留
    expect(getPreferredSourceId()).toBe('b')
  })

  it('P24c 清空后重新建会话可用', () => {
    createSession('w', 'e', { candidates: [cand('a', 0)] })
    clearSession()
    const s = createSession('w', 'e2', { candidates: [cand('b', 0)] })
    expect(s.selectedCandidateId).toBe('b#0')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 播放状态（既有能力回归）
 * ══════════════════════════════════════════════════════════════════════ */

describe('P25 播放状态事件流', () => {
  it('P25a 状态变更通知订阅者', () => {
    const seen: string[] = []
    const off = subscribePlaybackState((s) => seen.push(s))
    setPlaybackState('buffering')
    setPlaybackState('playing')
    off()
    setPlaybackState('paused')
    expect(seen).toEqual(['buffering', 'playing'])
    expect(getPlaybackState()).toBe('paused')
  })

  it('P25b 监听器抛错不影响其他监听器', () => {
    const seen: string[] = []
    const off1 = subscribePlaybackState(() => {
      throw new Error('boom')
    })
    const off2 = subscribePlaybackState((s) => seen.push(s))
    setPlaybackState('ready')
    expect(seen).toEqual(['ready'])
    off1()
    off2()
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 安全边界（临时 URL 不持久化）
 * ══════════════════════════════════════════════════════════════════════ */

describe('P26 临时 URL 安全边界', () => {
  it('P26a PlaybackService 不写 localStorage / IndexedDB', () => {
    const src = readFileSync(join(SRC, 'services/playback/PlaybackService.ts'), 'utf-8')
    // 排除注释里的提及：只检查代码行
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toMatch(/localStorage\s*\./)
    expect(code).not.toMatch(/indexedDB/i)
    expect(code).not.toMatch(/sessionStorage\s*\./)
  })

  it('P26b types.ts 不写持久化', () => {
    const src = readFileSync(join(SRC, 'services/playback/types.ts'), 'utf-8')
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toMatch(/localStorage\s*\./)
    expect(code).not.toMatch(/indexedDB/i)
  })

  it('P26c 会话对象不被序列化到任何键', () => {
    const src = readFileSync(join(SRC, 'services/playback/PlaybackService.ts'), 'utf-8')
    expect(src).not.toMatch(/JSON\.stringify\(\s*currentSession/)
    expect(src).not.toMatch(/JSON\.stringify\(\s*session/)
  })

  it('P26d 来源偏好不持久化（源码无写存储调用）', () => {
    const src = readFileSync(join(SRC, 'services/playback/PlaybackService.ts'), 'utf-8')
    expect(src).not.toMatch(/setItem\([^)]*preferred/i)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 冻结边界
 * ══════════════════════════════════════════════════════════════════════ */

describe('P27 冻结边界', () => {
  it('P27a PlayerPage 未被本批次修改（仍无 getSelectedCandidate 调用）', () => {
    const src = readFileSync(join(SRC, 'modules/player/PlayerPage.tsx'), 'utf-8')
    // 批次③ 才接入；此刻不应出现
    expect(src).not.toContain('getSelectedCandidate')
  })

  it('P27b 原生桥未被修改', () => {
    const src = readFileSync(join(SRC, 'services/playback/nativeBridge.ts'), 'utf-8')
    expect(src).toContain('openNativePlayer')
    // 不含批次② 引入的会话逻辑
    expect(src).not.toContain('candidateId')
  })

  it('P27c 自检素材常量仍在（未被删除）', () => {
    // 批次③ 起常量迁到 playerFlow.ts（PlayerPage 改为经它取），
    // 断言随之改为「两处之一必须持有」，保证素材本身不被删除。
    const flow = readFileSync(join(SRC, 'modules/player/playerFlow.ts'), 'utf-8')
    expect(flow).toContain('SELF_TEST_ASSET')
    expect(flow).toContain('asset:///')
  })
})
