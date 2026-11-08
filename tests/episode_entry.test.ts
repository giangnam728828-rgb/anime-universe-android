/**
 * 批次③后续 · 详情页剧集入口测试（P40–P48）
 *
 * 核心约束：
 *  1. 剧集**必须**来自 getEpisodes()，不得从 `episodes?: number` 伪造
 *  2. 无解析器 ⇒ 无任何播放按钮，显示「暂无可用播放源」
 *  3. 有解析器但无剧集 ⇒ 显示「暂无可用剧集」，不伪造第一集
 *  4. 单源失败不影响其他来源
 *  5. 路由 sourceId 必须是播放源 id，不是内容来源 id
 *
 * ⚠️ 本项目无 jsdom，组件不可渲染测试。
 *    因此本文件测「数据通路契约」：源码断言 + 纯逻辑提取。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf-8')

const episodeList = read('modules/detail/EpisodeList.tsx')
const detailPage = read('modules/detail/DetailPage.tsx')
const workDetailTypes = read('services/sources/types.ts')

/* ══════════════════════════════════════════════════════════════════════
 * P40 数据来源真实性
 * ══════════════════════════════════════════════════════════════════════ */

describe('P40 剧集数据必须真实', () => {
  it('P40a WorkDetail 确实没有剧集列表（约束前提成立）', () => {
    // 这条断言锁住「为什么不能用详情数据伪造剧集」的事实基础。
    // 若将来 WorkDetail 增加了剧集字段，本测试会失败并提示重新评估。
    expect(workDetailTypes).toContain('episodes?: number')
    expect(workDetailTypes).not.toMatch(/episodes\s*:\s*PlaybackEpisode\[\]/)
  })

  it('P40b EpisodeList 使用 getEpisodes 获取剧集', () => {
    expect(episodeList).toContain('getEpisodes')
  })

  it('P40c 🔴 不构造任何非 getEpisodes 来源的剧集数组', () => {
    const code = stripComments(episodeList)
    // 不得出现 episodes 字段被赋值为 number
    expect(code).not.toMatch(/episodes\s*:\s*number/)
    // 🔴 不得用 Array.from / 长度循环 凭空造剧集
    expect(code).not.toMatch(/Array\.from\(/)
    expect(code).not.toMatch(/\.fill\(/)
    // 🔴 不得用 String(i + 1) / i + 1 之类序号当 id
    expect(code).not.toMatch(/String\(\s*i\s*\+\s*1\s*\)/)
    expect(code).not.toMatch(/id:\s*String\(/)
  })

  it('P40d 🔴 episodes 只能来自 getEpisodes 的返回值', () => {
    const code = stripComments(episodeList)
    // 找到所有「对象属性 episodes: 值」赋值处（排除类型注解 episodes: Type[]）
    const assigns = [...code.matchAll(/episodes:\s*([^,\n}]+)/g)]
      .map((m) => m[1].trim())
      .filter((v) => !/^\w+\[\]$/.test(v))
    expect(assigns.length).toBeGreaterThan(0)
    // 每个赋值都必须是变量（eps / []），不得是内联构造
    for (const a of assigns) {
      expect(a).toMatch(/^(eps|\[\])/)
    }
    // 且该变量必须来自 getEpisodes
    expect(code).toMatch(/const\s+eps\s*=\s*await\s+r\.getEpisodes\(/)
  })

  it('P40e 🔴 不硬编码第一集 id', () => {
    const code = stripComments(episodeList)
    expect(code).not.toMatch(/\/player\/[^`'"]*\/1['"`]/)
    expect(code).not.toMatch(/episodeId\s*:\s*['"]1['"]/)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * P41 空状态
 * ══════════════════════════════════════════════════════════════════════ */

describe('P41 空状态正确', () => {
  it('P41a 无解析器 ⇒ 暂无可用播放源', () => {
    expect(episodeList).toContain('暂无可用播放源')
  })

  it('P41b 无剧集 ⇒ 暂无可用剧集', () => {
    expect(episodeList).toContain('暂无可用剧集')
  })

  it('P41c 🔴 无解析器时提前返回且条件不可被短路', () => {
    const code = stripComments(episodeList)
    // 必须存在 `if (resolvers.length === 0) {` 这一确切守卫
    const guard = code.match(/if\s*\(\s*resolvers\.length\s*===\s*0\s*\)\s*\{/)
    expect(guard).not.toBeNull()
    // 🔴 守卫前不得有 false && / 取反 之类使条件失效的写法
    const before = code.slice(Math.max(0, guard!.index! - 40), guard!.index!)
    expect(before).not.toMatch(/false\s*&&/)
    // 守卫必须在渲染列表之前
    expect(guard!.index!).toBeLessThan(code.indexOf('groups.map'))
  })

  it('P41d 空剧集时不伪造「第 1 集」', () => {
    const code = stripComments(episodeList)
    expect(code).not.toContain('第 1 集')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * P42 失败隔离
 * ══════════════════════════════════════════════════════════════════════ */

describe('P42 单源失败不影响其他来源', () => {
  it('P42a 使用 allSettled 而非 all', () => {
    expect(episodeList).toContain('allSettled')
    expect(episodeList).not.toMatch(/Promise\.all\(/)
  })

  it('P42b 失败来源有独立提示', () => {
    expect(episodeList).toContain('error')
    expect(episodeList).toContain('剧集加载失败')
  })

  it('P42c 不展示原始错误消息', () => {
    const code = stripComments(episodeList)
    // 不得把 e.message 直接当展示文案
    expect(code).not.toMatch(/setError\([^)]*\.message/)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * P43 路由正确性
 * ══════════════════════════════════════════════════════════════════════ */

describe('P43 路由 sourceId 必须是播放源', () => {
  it('P43a 路由使用 group 的 sourceId，不是内容来源', () => {
    const code = stripComments(episodeList)
    // open() 内应使用 g.sourceId / sourceId 参数
    expect(code).toMatch(/\/player\/\$\{sourceId\}/)
    // 🔴 不得混入 contentSourceId
    const openFn = extractFn(code, 'const open')
    expect(openFn).not.toContain('contentSourceId')
  })

  it('P43b 路由格式为 /player/:sourceId/:workId/:episodeId', () => {
    const code = stripComments(episodeList)
    expect(code).toMatch(/\/player\/\$\{[^}]+\}\/\$\{[^}]+\}\/\$\{[^}]+\}/)
  })

  it('P43c 使用 ep.id 作为 episodeId，不是 episodeNumber', () => {
    const code = stripComments(episodeList)
    const openFn = extractFn(code, 'const open')
    expect(openFn).toContain('ep.id')
    expect(openFn).not.toContain('ep.episodeNumber')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * P44 不预取候选
 * ══════════════════════════════════════════════════════════════════════ */

describe('P44 不提前解析播放地址', () => {
  it('P44a EpisodeList 不调用 getCandidates', () => {
    const code = stripComments(episodeList)
    expect(code).not.toContain('getCandidates')
    expect(code).not.toContain('resolveCandidates')
  })

  it('P44b 不建会话', () => {
    const code = stripComments(episodeList)
    expect(code).not.toContain('createSession')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * P45 不持久化
 * ══════════════════════════════════════════════════════════════════════ */

describe('P45 不持久化剧集或地址', () => {
  it('P45a 无 localStorage / sessionStorage / indexedDB', () => {
    const code = stripComments(episodeList)
    expect(code).not.toMatch(/localStorage/)
    expect(code).not.toMatch(/sessionStorage/)
    expect(code).not.toMatch(/indexedDB/i)
  })

  it('P45b 不打印 URL', () => {
    const code = stripComments(episodeList)
    expect(code).not.toMatch(/console\.\w+\([^)]*url/i)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * P46 DetailPage 接入
 * ══════════════════════════════════════════════════════════════════════ */

describe('P46 DetailPage 接入正确', () => {
  it('P46a 动漫分支渲染 EpisodeList', () => {
    expect(detailPage).toContain('EpisodeList')
    expect(detailPage).toContain("d.kind === 'anime'")
  })

  it('P46b 需要 workId 才渲染', () => {
    expect(detailPage).toMatch(/d\.kind === 'anime' && !!d\.workId/)
  })

  it('P46c 漫画分支未被破坏', () => {
    expect(detailPage).toContain('sourceSupportsChapters')
    expect(detailPage).toContain('ChapterList')
  })

  it('P46d 传入的是内容来源，不是播放来源', () => {
    expect(detailPage).toContain('contentSourceId={d.sourceId}')
  })

  it('P46e 无硬编码 selftest 参数', () => {
    expect(detailPage).not.toContain('selftest')
    expect(detailPage).not.toContain('/player/selftest')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * P47 冻结区
 * ══════════════════════════════════════════════════════════════════════ */

describe('P47 冻结区未改', () => {
  it('P47a 播放解析层未被本步修改', () => {
    const resolve = read('services/playback/resolve.ts')
    expect(resolve).toContain('RESOLVE_TIMEOUT_MS')
    expect(resolve).not.toContain('EpisodeList')
  })

  it('P47b 会话服务未被本步修改', () => {
    const svc = read('services/playback/PlaybackService.ts')
    expect(svc).toContain('createSession')
    expect(svc).not.toContain('EpisodeList')
  })

  it('P47c 注册表仍为空表（不擅自加播放源）', () => {
    const reg = read('services/playback/registry.ts')
    expect(reg).toContain('PLAYBACK_RESOLVERS: PlaybackSourceResolver[] = []')
  })

  it('P47d 原生播放器未改', () => {
    const bridge = read('services/playback/nativeBridge.ts')
    expect(bridge).not.toContain('EpisodeList')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 工具
 * ══════════════════════════════════════════════════════════════════════ */

/** 去掉注释，避免注释里的设计说明被误判为代码 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    .join('\n')
}

/** 粗略提取一个箭头函数体（到下一个同级 const 或空行为止） */
function extractFn(code: string, marker: string): string {
  const start = code.indexOf(marker)
  if (start < 0) return ''
  const rest = code.slice(start)
  const end = rest.search(/\n  \}/)
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 600)
}
