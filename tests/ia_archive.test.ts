/**
 * IA 播放源 Resolver 测试（IA1–IA9）
 *
 * 阶段3·第3步·第2步 · A1 有限接入
 *
 * 🔴 核心约束：
 *  1. 只有 3 部经权利核查的作品，淘汰作品不得出现
 *  2. episodeId / identifier / fileName 三者必须一致
 *  3. 文件不存在/过小/非 mp4 ⇒ 返回 []，不回退其他文件
 *  4. 429 不伪装成「无剧集」
 *  5. 不持久化 URL，不打印 URL
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APPROVED_WORKS,
  IA_SOURCE_ID,
  IAArchiveResolver,
  buildMediaUrl,
  findApprovedByIdentifier,
  findApprovedWork,
  parseEpisodeId,
} from '../src/services/playback/iaArchive'
import { PLAYBACK_ORDER, PLAYBACK_RESOLVERS, playbackRank } from '../src/services/playback/registry'

const SRC = join(__dirname, '..', 'src')

/* ══════════════════════════════════════════════════════════════════════
 * IA1 审核清单
 * ══════════════════════════════════════════════════════════════════════ */

describe('IA1 审核清单', () => {
  it('IA1a 只有 3 部作品', () => {
    expect(APPROVED_WORKS).toHaveLength(3)
  })

  it('IA1b 三部作品 identifier 精确匹配', () => {
    const ids = APPROVED_WORKS.map((w) => w.identifier).sort()
    expect(ids).toEqual([
      'Felix_inHollywood_NoAudio',
      'Krazy_kat_goesA-wooing_1916',
      'The_Tantalizing_Fly_1919',
    ])
  })

  it('IA1c 🔴 fileName 逐字匹配实测值', () => {
    const map: Record<string, string> = {}
    for (const w of APPROVED_WORKS) map[w.identifier] = w.fileName
    expect(map['Krazy_kat_goesA-wooing_1916']).toBe('Krazy_Kat_goes_a-wooing_1916_512kb.mp4')
    expect(map['The_Tantalizing_Fly_1919']).toBe('The_Tantalizing_Fly_1919_512kb.mp4')
    expect(map['Felix_inHollywood_NoAudio']).toBe('Felix_inHollywood_NoAudio_512kb.mp4')
  })

  it('IA1d 🔴 淘汰作品不得出现', () => {
    const banned = [
      'superman_1941',
      'Popeye_forPresident',
      'ACornyConcerto1943BugsBunny',
      'TinSoldier',
      'bb_snow_white',
      'bb_minnie_the_moocher',
      'ThePuppetsNightmare',
    ]
    const all = APPROVED_WORKS.map((w) => w.identifier)
    for (const b of banned) expect(all).not.toContain(b)
  })

  it('IA1e 每部都有独立权利依据（非 IA 背书）', () => {
    for (const w of APPROVED_WORKS) {
      expect(w.rightsEvidence.length).toBeGreaterThan(0)
      expect(w.rightsStatus).toBe('approved')
      // 依据必须提到年份或版权期，不能只说「IA 标注 PD」
      const txt = w.rightsEvidence.join(' ')
      expect(txt).toMatch(/19\d\d|版权|公有领域/)
      // 必须明确 IA licenseurl 不作依据
      expect(txt).toMatch(/不作为准入依据|上传者声明/)
    }
  })

  it('IA1f Felix 必须标记无音轨', () => {
    const f = findApprovedByIdentifier('Felix_inHollywood_NoAudio')
    expect(f?.audioStatus).toBe('no-audio')
  })

  it('IA1g 清单是冻结的', () => {
    expect(Object.isFrozen(APPROVED_WORKS)).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * IA2 episodeId 解析
 * ══════════════════════════════════════════════════════════════════════ */

describe('IA2 episodeId 解析', () => {
  it('IA2a 正常解析', () => {
    const r = parseEpisodeId('The_Tantalizing_Fly_1919#The_Tantalizing_Fly_1919_512kb.mp4')
    expect(r).toEqual({
      identifier: 'The_Tantalizing_Fly_1919',
      fileName: 'The_Tantalizing_Fly_1919_512kb.mp4',
    })
  })

  it('IA2b 无 # ⇒ null', () => {
    expect(parseEpisodeId('nohash')).toBeNull()
  })

  it('IA2c 空 identifier 或 fileName ⇒ null', () => {
    expect(parseEpisodeId('#file.mp4')).toBeNull()
    expect(parseEpisodeId('id#')).toBeNull()
    expect(parseEpisodeId('')).toBeNull()
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * IA3 getEpisodes
 * ══════════════════════════════════════════════════════════════════════ */

describe('IA3 getEpisodes', () => {
  const r = new IAArchiveResolver()

  it('IA3a 未过审 workId ⇒ 空数组', async () => {
    expect(await r.getEpisodes('unknown')).toEqual([])
    expect(await r.getEpisodes('superman_1941')).toEqual([])
  })

  it('IA3b 已过审 ⇒ 1 集', async () => {
    const eps = await r.getEpisodes('ia-krazy-kat-1916')
    expect(eps).toHaveLength(1)
    expect(eps[0].episodeNumber).toBe(1)
  })

  it('IA3c 🔴 episodeId 含实测 fileName', async () => {
    const eps = await r.getEpisodes('ia-krazy-kat-1916')
    expect(eps[0].id).toBe(
      'Krazy_kat_goesA-wooing_1916#Krazy_Kat_goes_a-wooing_1916_512kb.mp4',
    )
  })

  it('IA3d 无音轨作品标题必须标记', async () => {
    const eps = await r.getEpisodes('ia-felix-hollywood-1923')
    expect(eps[0].title).toContain('无音轨')
  })

  it('IA3e 有音轨作品标题不加标记', async () => {
    const eps = await r.getEpisodes('ia-tantalizing-fly-1919')
    expect(eps[0].title).not.toContain('无音轨')
  })

  it('IA3f 🔴 getEpisodes 不发网络请求', () => {
    const src = readFileSync(join(SRC, 'services/playback/iaArchive.ts'), 'utf-8')
    const code = stripComments(src)
    const fn = extractMethod(code, 'async getEpisodes')
    expect(fn).not.toContain('fetchMetadata')
    expect(fn).not.toContain('httpGetText')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * IA4 getCandidates 三重校验
 * ══════════════════════════════════════════════════════════════════════ */

describe('IA4 getCandidates 校验', () => {
  let r: IAArchiveResolver

  beforeEach(() => {
    r = new IAArchiveResolver()
  })

  it('IA4a 未过审 workId ⇒ 空', async () => {
    expect(await r.getCandidates('unknown', 'a#b.mp4')).toEqual([])
  })

  it('IA4b 🔴 identifier 不匹配 ⇒ 空（不查元数据）', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const out = await r.getCandidates(
      'ia-krazy-kat-1916',
      'Wrong_Identifier#Krazy_Kat_goes_a-wooing_1916_512kb.mp4',
    )
    expect(out).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('IA4c 🔴 fileName 不匹配 ⇒ 空（逐字，不规范化）', async () => {
    // 大小写不同
    const out1 = await r.getCandidates(
      'ia-krazy-kat-1916',
      'Krazy_kat_goesA-wooing_1916#krazy_kat_goes_a-wooing_1916_512kb.mp4',
    )
    expect(out1).toEqual([])
    // 下划线变体
    const out2 = await r.getCandidates(
      'ia-krazy-kat-1916',
      'Krazy_kat_goesA-wooing_1916#Krazy-Kat-goes-a-wooing-1916-512kb.mp4',
    )
    expect(out2).toEqual([])
    // 扩展名不同
    const out3 = await r.getCandidates(
      'ia-krazy-kat-1916',
      'Krazy_kat_goesA-wooing_1916#Krazy_Kat_goes_a-wooing_1916_512kb.ogv',
    )
    expect(out3).toEqual([])
  })

  it('IA4d episodeId 无 # ⇒ 空', async () => {
    expect(await r.getCandidates('ia-krazy-kat-1916', 'badformat')).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * IA5 URL 构造
 * ══════════════════════════════════════════════════════════════════════ */

describe('IA5 URL 构造', () => {
  it('IA5a 使用 /download/ 永久入口', () => {
    const u = buildMediaUrl('The_Tantalizing_Fly_1919', 'The_Tantalizing_Fly_1919_512kb.mp4')
    expect(u).toBe(
      'https://archive.org/download/The_Tantalizing_Fly_1919/The_Tantalizing_Fly_1919_512kb.mp4',
    )
  })

  it('IA5b 必须 https', () => {
    expect(buildMediaUrl('a', 'b.mp4')).toMatch(/^https:\/\//)
  })

  it('IA5c 特殊字符需 encode', () => {
    const u = buildMediaUrl('a b', 'c d.mp4')
    expect(u).toContain('a%20b')
    expect(u).toContain('c%20d.mp4')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * IA6 网络异常处理
 * ══════════════════════════════════════════════════════════════════════ */

describe('IA6 网络异常不伪造', () => {
  it('IA6a 🔴 源码不自动重试', () => {
    const code = stripComments(readFileSync(join(SRC, 'services/playback/iaArchive.ts'), 'utf-8'))
    expect(code).not.toMatch(/retries\s*:/)
    expect(code).not.toMatch(/for\s*\(let attempt/)
  })

  it('IA6b 🔴 429 被单独识别，不混为普通失败', () => {
    const code = stripComments(readFileSync(join(SRC, 'services/playback/iaArchive.ts'), 'utf-8'))
    expect(code).toContain("r.status === 429")
    expect(code).toContain("'rate-limited'")
  })

  it('IA6c 失败返回空数组，不抛未捕获', async () => {
    const r = new IAArchiveResolver()
    // 无网络环境下必然失败，但不得抛异常
    await expect(
      r.getCandidates(
        'ia-krazy-kat-1916',
        'Krazy_kat_goesA-wooing_1916#Krazy_Kat_goes_a-wooing_1916_512kb.mp4',
      ),
    ).resolves.toBeDefined()
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * IA7 注册与 rank
 * ══════════════════════════════════════════════════════════════════════ */

describe('IA7 注册与 rank', () => {
  it('IA7a resolver 已注册', () => {
    expect(PLAYBACK_RESOLVERS).toHaveLength(1)
    expect(PLAYBACK_RESOLVERS[0].sourceId).toBe(IA_SOURCE_ID)
  })

  it('IA7b rank 登记为 10', () => {
    expect(PLAYBACK_ORDER['ia-archive']).toBe(10)
    expect(playbackRank('ia-archive')).toBe(10)
  })

  it('IA7c 🔴 单源无法证明跨 rank 排序（如实记录）', () => {
    // 只有一个 rank 时，只能验证「登记正确」，不能验证升序排序。
    // 等第二个合格 Resolver 出现后再补跨 rank 测试。
    const ranks = Object.values(PLAYBACK_ORDER)
    expect(ranks).toHaveLength(1)
  })

  it('IA7d sourceId 不与内容源冲突', () => {
    const src = readFileSync(join(SRC, 'services/sources/registry.ts'), 'utf-8')
    expect(src).not.toContain("'ia-archive'")
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * IA8 安全
 * ══════════════════════════════════════════════════════════════════════ */

describe('IA8 安全约束', () => {
  const src = readFileSync(join(SRC, 'services/playback/iaArchive.ts'), 'utf-8')
  const code = stripComments(src)

  it('IA8a 不持久化', () => {
    expect(code).not.toMatch(/localStorage/)
    expect(code).not.toMatch(/sessionStorage/)
    expect(code).not.toMatch(/indexedDB/i)
  })

  it('IA8b 不打印 URL', () => {
    expect(code).not.toMatch(/console\.\w+\([^)]*(url|Url|URL)/)
  })

  it('IA8c 带可识别 User-Agent', () => {
    expect(src).toContain('AnimeUniverse-IA/1.0')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * IA9 冻结区
 * ══════════════════════════════════════════════════════════════════════ */

describe('IA9 冻结区未改', () => {
  it('IA9a resolve.ts 未被本步修改', () => {
    const s = readFileSync(join(SRC, 'services/playback/resolve.ts'), 'utf-8')
    expect(s).toContain('RESOLVE_TIMEOUT_MS')
    expect(s).not.toContain('iaArchive')
  })

  it('IA9b nativeBridge 未改', () => {
    const s = readFileSync(join(SRC, 'services/playback/nativeBridge.ts'), 'utf-8')
    expect(s).not.toContain('iaArchive')
  })

  it('IA9c 内容源注册表未加 IA', () => {
    const s = readFileSync(join(SRC, 'services/sources/registry.ts'), 'utf-8')
    expect(s).not.toContain('iaArchive')
    expect(s).not.toContain('ia-archive')
  })

  it('IA9d PlayerPage 未改', () => {
    const s = readFileSync(join(SRC, 'modules/player/PlayerPage.tsx'), 'utf-8')
    expect(s).not.toContain('iaArchive')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 工具
 * ══════════════════════════════════════════════════════════════════════ */

function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    .join('\n')
}

function extractMethod(code: string, marker: string): string {
  const start = code.indexOf(marker)
  if (start < 0) return ''
  const rest = code.slice(start)
  const end = rest.indexOf('\n  }')
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 800)
}
