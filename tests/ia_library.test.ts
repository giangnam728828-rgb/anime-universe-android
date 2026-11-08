/**
 * IA 独立内容入口测试（L1–L8）
 *
 * 阶段3·第3步·A1
 *
 * 🔴 核心约束：
 *  1. 列表只能来自 APPROVED_WORKS，不硬编码、不扩清单
 *  2. `episodeId` 含 `#`，必须 encodeURIComponent
 *  3. 编码后能完整还原（往返一致）
 *  4. 不重复解码（Router 已自动解码）
 *  5. 本页不发网络请求
 *  6. 无音轨必须标记
 *  7. 冻结区零改动
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPlayerPath,
  parsePlayerPath,
} from '../src/modules/player/IALibraryPage'
import {
  APPROVED_WORKS,
  IA_SOURCE_ID,
  iaArchiveResolver,
} from '../src/services/playback/iaArchive'

const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf-8')

const page = read('modules/player/IALibraryPage.tsx')
const app = read('App.tsx')
const profile = read('modules/profile/ProfilePage.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * L1 数据源
 * ══════════════════════════════════════════════════════════════════════ */

describe('L1 列表来自审核清单', () => {
  it('L1a 页面引用 APPROVED_WORKS', () => {
    expect(page).toContain('APPROVED_WORKS')
  })

  it('L1b 不硬编码作品标题', () => {
    // 标题必须来自数据，不能写死在 JSX 里
    for (const w of APPROVED_WORKS) {
      expect(page).not.toContain(w.title)
    }
  })

  it('L1c 清单仍是 3 部（未擅自扩大）', () => {
    expect(APPROVED_WORKS).toHaveLength(3)
  })

  it('L1d 页面不引用淘汰作品', () => {
    for (const banned of ['superman_1941', 'Popeye', 'BugsBunny', 'bb_snow_white']) {
      expect(page).not.toContain(banned)
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * L2 路径构造与编码
 * ══════════════════════════════════════════════════════════════════════ */

describe('L2 路径构造必须编码 #', () => {
  it('L2a 路径含 %23（# 已编码）', () => {
    const ep = 'Krazy_kat_goesA-wooing_1916#Krazy_Kat_goes_a-wooing_1916_512kb.mp4'
    const p = buildPlayerPath('ia-krazy-kat-1916', ep)
    expect(p).toContain('%23')
    expect(p).not.toContain('#')
  })

  it('L2b 路径格式正确', () => {
    const ep = 'a#b.mp4'
    expect(buildPlayerPath('w1', ep)).toBe('/player/ia-archive/w1/a%23b.mp4')
  })

  it('L2c 🔴 不编码会截断（反证）', () => {
    const ep = 'identifier#file.mp4'
    const bad = `/player/${IA_SOURCE_ID}/w/${ep}` // 故意不编码
    const u = new URL('https://x.test' + bad)
    // 不编码时 pathname 丢失 # 之后内容
    expect(u.pathname).not.toContain('file.mp4')
    expect(u.hash).toContain('file.mp4')
  })

  it('L2d sourceId 使用 IA_SOURCE_ID', () => {
    const p = buildPlayerPath('w', 'a#b.mp4')
    expect(p.startsWith(`/player/${IA_SOURCE_ID}/`)).toBe(true)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * L3 编码往返
 * ══════════════════════════════════════════════════════════════════════ */

describe('L3 编码往返一致', () => {
  it('L3a 三部真实作品的 episodeId 都能往返', async () => {
    for (const w of APPROVED_WORKS) {
      const eps = await iaArchiveResolver.getEpisodes(w.workId)
      expect(eps).toHaveLength(1)
      const original = eps[0].id

      const path = buildPlayerPath(w.workId, original)

      // 🔴 先过真实 URL 解析：若未编码，# 会被当作 fragment 截断
      const u = new URL('https://app.test' + path)
      expect(u.hash).toBe('')          // 不应产生 fragment
      expect(u.pathname).toBe(path)    // pathname 必须完整保留

      const parsed = parsePlayerPath(path)
      expect(parsed).not.toBeNull()
      expect(parsed!.sourceId).toBe(IA_SOURCE_ID)
      expect(parsed!.workId).toBe(w.workId)
      // 🔴 必须逐字还原
      expect(parsed!.episodeId).toBe(original)
    }
  })

  it('L3b 还原后的 episodeId 能直接喂给 getCandidates 通过校验', async () => {
    const w = APPROVED_WORKS[0]
    const eps = await iaArchiveResolver.getEpisodes(w.workId)
    const path = buildPlayerPath(w.workId, eps[0].id)
    const parsed = parsePlayerPath(path)!

    // 用还原值重新解析 episodeId，identifier 与 fileName 都必须匹配
    const i = parsed.episodeId.indexOf('#')
    expect(parsed.episodeId.slice(0, i)).toBe(w.identifier)
    expect(parsed.episodeId.slice(i + 1)).toBe(w.fileName)
  })

  it('L3c 🔴 不重复解码（页面内不调用 decodeURIComponent）', () => {
    // parsePlayerPath 是测试辅助，页面渲染路径不调用它
    const body = page.slice(page.indexOf('export default function IALibraryPage'))
    expect(body).not.toContain('decodeURIComponent')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * L4 无音轨标记
 * ══════════════════════════════════════════════════════════════════════ */

describe('L4 无音轨必须标记', () => {
  it('L4a 页面根据 audioStatus 显示标记', () => {
    expect(page).toContain('audioStatus')
    expect(page).toContain('无音轨')
  })

  it('L4b Felix 数据确为 no-audio', () => {
    const f = APPROVED_WORKS.find((w) => w.workId === 'ia-felix-hollywood-1923')
    expect(f?.audioStatus).toBe('no-audio')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * L5 画质诚实
 * ══════════════════════════════════════════════════════════════════════ */

describe('L5 画质提示诚实', () => {
  it('L5a 页面标注 240p 限制', () => {
    expect(page).toContain('240p')
  })

  it('L5b 不宣传高清', () => {
    expect(page).not.toMatch(/高清|HD|1080|4K/)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * L6 冻结区
 * ══════════════════════════════════════════════════════════════════════ */

describe('L6 冻结区零改动', () => {
  it('L6a PlayerPage 未引用 IA 浏览页', () => {
    expect(read('modules/player/PlayerPage.tsx')).not.toContain('IALibraryPage')
  })

  it('L6b playerFlow 未改', () => {
    const s = read('modules/player/playerFlow.ts')
    expect(s).not.toContain('IALibraryPage')
    expect(s).toContain('prepareRealPlayback')
  })

  it('L6c iaArchive 未因本步改动', () => {
    const s = read('services/playback/iaArchive.ts')
    expect(s).not.toContain('IALibraryPage')
    expect(s).toContain('APPROVED_WORKS')
  })

  it('L6d 播放注册表未改', () => {
    const s = read('services/playback/registry.ts')
    expect(s).not.toContain('IALibraryPage')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * L7 无网络请求
 * ══════════════════════════════════════════════════════════════════════ */

describe('L7 本页不发网络请求', () => {
  it('L7a 页面不直接 fetch', () => {
    expect(page).not.toMatch(/\bfetch\s*\(/)
  })

  it('L7b 页面不调 httpGetText', () => {
    expect(page).not.toContain('httpGetText')
  })

  it('L7c getEpisodes 本身不发请求（沿用 IA3f 约束）', async () => {
    const eps = await iaArchiveResolver.getEpisodes('ia-krazy-kat-1916')
    expect(eps).toHaveLength(1)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * L8 路由集成
 * ══════════════════════════════════════════════════════════════════════ */

describe('L8 路由集成', () => {
  it('L8a App.tsx 注册 /ia-library', () => {
    expect(app).toContain('path="/ia-library"')
    expect(app).toContain('IALibraryPage')
  })

  it('L8b 既有播放路由未被改动', () => {
    expect(app).toContain('path="/player/:sourceId/:workId/:episodeId"')
  })

  it('L8c ProfilePage 有入口且指向 /ia-library', () => {
    expect(profile).toContain("nav('/ia-library')")
    expect(profile).toContain('公共领域动画')
  })

  it('L8d 🔴 点击后三个参数均正确（端到端路径验证）', async () => {
    for (const w of APPROVED_WORKS) {
      const eps = await iaArchiveResolver.getEpisodes(w.workId)
      const path = buildPlayerPath(w.workId, eps[0].id)
      const parsed = parsePlayerPath(path)

      // 🔴 真实 URL 解析：未编码时 hash 非空、pathname 被截断
      const u = new URL('https://app.test' + path)
      expect(u.hash).toBe('')
      expect(u.pathname).toBe(path)

      expect(parsed).not.toBeNull()
      // 三个参数逐一验证，不是只测字符串拼接
      expect(parsed!.sourceId).toBe('ia-archive')
      expect(parsed!.workId).toBe(w.workId)
      expect(parsed!.episodeId).toBe(eps[0].id)
      // 且该路径能被既有播放路由模式匹配
      expect(path).toMatch(/^\/player\/[^/]+\/[^/]+\/[^/]+$/)
    }
  })

  it('L8e 路径段数正确（不会因 # 多出段）', () => {
    const ep = 'identifier#file.mp4'
    const p = buildPlayerPath('w', ep)
    expect(p.split('/')).toHaveLength(5) // ['', 'player', sourceId, workId, episodeId]
  })
})
