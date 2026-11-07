/**
 * 详情页章节列表测试（P1 第7子步）
 *
 * 覆盖用户指定的 U1–U11。
 * 说明：本仓库测试环境无 DOM，采用**纯逻辑单测 + 源码契约断言**，
 * 组件级真机行为留到第6子步复测。
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { sourceSupportsChapters } from '../src/modules/detail/ChapterList'
import {
  normalizeChapter,
  sortChapters,
  languageLabel,
  isChineseLanguage,
  type OnlineChapter,
} from '../src/services/reader/onlineChapters'
import { readerPath, LOCAL_SOURCE_ID } from '../src/modules/reader/readerRoute'
import type { ChapterItem } from '../src/services/sources/types'

const SRC = new URL('../src/modules/detail/', import.meta.url)
const listSrc = readFileSync(new URL('ChapterList.tsx', SRC), 'utf-8')
const detailSrc = readFileSync(new URL('DetailPage.tsx', SRC), 'utf-8')

/* ══════════════════ 构造测试数据 ══════════════════ */

const mkChapter = (over: Partial<ChapterItem> = {}): ChapterItem => ({
  id: 'uuid-1',
  sourceId: 'mangadex',
  workId: 'manga-1',
  title: '',
  chapter: '1',
  volume: undefined,
  pages: 20,
  translatedLanguage: 'zh',
  group: undefined,
  externalUrl: undefined,
  ...over,
})

/* ══════════════════ U1 · MangaDex 漫画显示章节列表 ══════════════════ */

describe('U1 · MangaDex 漫画显示章节列表', () => {
  it('U1a · mangadex 适配器声明了 getChapters', () => {
    expect(sourceSupportsChapters('mangadex')).toBe(true)
  })

  it('U1b · DetailPage 在 manga + 支持章节时渲染 ChapterList', () => {
    expect(detailSrc).toContain("d.kind === 'manga'")
    expect(detailSrc).toContain('sourceSupportsChapters(d.sourceId)')
    expect(detailSrc).toContain('<ChapterList')
  })

  it('U1c · 章节列表调用 adapter.getChapters（真实数据源）', () => {
    expect(listSrc).toContain('adapter.getChapters(workId')
  })

  it('U1d · 不再写死「漫画阅读待开发」作为唯一内容', () => {
    // 原 EmptyState 仍保留（作为 else 分支），但必须被条件包裹
    expect(detailSrc).toContain('漫画阅读待开发')
    expect(detailSrc).toMatch(/\) : \(\s*<EmptyState/)
  })
})

/* ══════════════════ U2 · 不支持章节的来源 ══════════════════ */

describe('U2 · 不支持章节的来源不显示错误入口', () => {
  it('U2a · 无 getChapters 的来源返回 false', () => {
    // bangumi/anilist/jikan 无 getChapters（资料源）
    expect(sourceSupportsChapters('anilist')).toBe(false)
    expect(sourceSupportsChapters('jikan')).toBe(false)
    expect(sourceSupportsChapters('bangumi')).toBe(false)
  })

  it('U2b · 未知来源不抛异常，返回 false', () => {
    expect(sourceSupportsChapters('nonexistent-source-xyz')).toBe(false)
  })

  it('U2c · 不支持的来源渲染明确说明，而非空列表', () => {
    expect(listSrc).toContain('此来源不提供章节')
  })

  it('U2d · 🔴 不为不支持章节的来源伪造 MangaDex 章节', () => {
    // 组件只使用传入的 sourceId 取适配器，不硬编码 mangadex
    expect(listSrc).not.toMatch(/getSource\(['"]mangadex['"]\)/)
    expect(listSrc).toContain('getSource(sourceId)')
  })
})

/* ══════════════════ U3 · 非漫画类型 ══════════════════ */

describe('U3 · 非漫画类型不显示漫画章节列表', () => {
  it('U3a · 条件严格限定 kind === manga', () => {
    expect(detailSrc).toMatch(/d\.kind === 'manga' &&/)
  })

  it('U3b · anime 类型走原有「正片播放待开发」分支', () => {
    expect(detailSrc).toContain("'正片播放待开发'")
  })

  it('U3c · 三个条件必须同时满足（AND 而非 OR）', () => {
    // kind && workId && supports
    expect(detailSrc).toMatch(/d\.kind === 'manga' && !!d\.workId && sourceSupportsChapters/)
  })
})

/* ══════════════════ U4 · 语言标签 ══════════════════ */

describe('U4 · 简体/繁体/英语语言标签正确', () => {
  it('U4a · 简体中文', () => {
    expect(languageLabel('zh')).toBe('简体中文')
    expect(languageLabel('zh-hans')).toBe('简体中文')
    expect(languageLabel('zh-cn')).toBe('简体中文')
  })

  it('U4b · 繁体中文（港/台）', () => {
    expect(languageLabel('zh-hk')).toBe('繁体中文（港）')
    expect(languageLabel('zh-tw')).toBe('繁体中文（台）')
  })

  it('U4c · 英语', () => {
    expect(languageLabel('en')).toBe('英语')
  })

  it('U4d · isChineseLanguage 覆盖简繁', () => {
    for (const l of ['zh', 'zh-hk', 'zh-tw', 'zh-hans', 'zh-hant']) {
      expect(isChineseLanguage(l)).toBe(true)
    }
    expect(isChineseLanguage('en')).toBe(false)
  })

  it('U4e · 🔴 语言必须在 UI 中渲染（不能只有数据没有展示）', () => {
    expect(listSrc).toContain('{c.languageLabel}')
  })

  it('U4f · 中文版本有视觉区分', () => {
    expect(listSrc).toContain('isChineseLanguage(c.language)')
  })
})

/* ══════════════════ U5 · 同章多 UUID 全部保留 ══════════════════ */

describe('U5 · 同章多 UUID 全部保留，不去重', () => {
  it('U5a · 🔴 同章节号 3 个 UUID → 3 条记录', () => {
    const items = [
      mkChapter({ id: 'A', chapter: '113', translatedLanguage: 'zh' }),
      mkChapter({ id: 'B', chapter: '113', translatedLanguage: 'zh-hk' }),
      mkChapter({ id: 'C', chapter: '113', translatedLanguage: 'en' }),
    ]
    const norm = items.map((c) => normalizeChapter(c, 'manga-1'))
    const sorted = sortChapters(norm)
    expect(sorted).toHaveLength(3)
    expect(new Set(sorted.map((c) => c.id))).toEqual(new Set(['A', 'B', 'C']))
  })

  it('U5b · 组件渲染用 c.id 作 key（UUID 唯一）', () => {
    expect(listSrc).toContain('key={c.id}')
  })

  it('U5c · 🔴 组件中不存在按 chapter 去重的逻辑', () => {
    expect(listSrc).not.toMatch(/new Set\([^)]*\.chapter\)/)
    expect(listSrc).not.toMatch(/filter\([^)]*indexOf[^)]*chapter/)
  })

  it('U5d · 合并多页数据时也不去重（append 直接 concat）', () => {
    expect(listSrc).toContain('[...prev, ...list]')
  })
})

/* ══════════════════ U6 · 扫描组 ══════════════════ */

describe('U6 · 扫描组正确显示或合理缺省', () => {
  it('U6a · 有扫描组时保留', () => {
    const r = normalizeChapter(mkChapter({ group: '接盤俠漢化組' }), 'm')
    expect(r.group).toBe('接盤俠漢化組')
  })

  it('U6b · group 为 Unknown 时归一化为 undefined', () => {
    expect(normalizeChapter(mkChapter({ group: 'Unknown' }), 'm').group).toBeUndefined()
  })

  it('U6c · 无扫描组时 undefined（不伪造）', () => {
    expect(normalizeChapter(mkChapter({ group: undefined }), 'm').group).toBeUndefined()
  })

  it('U6d · 🔴 UI 仅在 group 存在时渲染（不显示 "undefined"）', () => {
    expect(listSrc).toContain('{c.group &&')
  })

  it('U6e · 不同扫描组同章号保留为独立条目', () => {
    const items = [
      mkChapter({ id: 'A', chapter: '5', group: '组甲' }),
      mkChapter({ id: 'B', chapter: '5', group: '组乙' }),
    ]
    const sorted = sortChapters(items.map((c) => normalizeChapter(c, 'm')))
    expect(sorted).toHaveLength(2)
    expect(sorted.map((c) => c.group).sort()).toEqual(['组乙', '组甲'].sort())
  })
})

/* ══════════════════ U7 · 页数，无 N+1 ══════════════════ */

describe('U7 · 页数正确显示且不产生额外批量请求', () => {
  it('U7a · pages 来自 feed 字段，直接映射', () => {
    expect(normalizeChapter(mkChapter({ pages: 51 }), 'm').pages).toBe(51)
  })

  it('U7b · pages 为 0 时保留 0（不伪造）', () => {
    expect(normalizeChapter(mkChapter({ pages: 0 }), 'm').pages).toBe(0)
  })

  it('U7c · 🔴 组件不调用 getPages（否则就是 N+1）', () => {
    expect(listSrc).not.toContain('getPages')
  })

  it('U7d · 🔴 组件不调用 at-home 或下载图片（只看代码，排除注释）', () => {
    // 去掉块注释与行注释后再断言，避免注释里的说明文字造成误判
    const code = listSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('at-home')
    expect(code).not.toContain('getOnlinePageBlob')
    expect(code).not.toContain('getBinary')
  })

  it('U7e · 🔴 每次加载只发一次 getChapters 请求', () => {
    // 统计调用点：应只有 load() 内一处
    const calls = listSrc.match(/adapter\.getChapters\(/g) || []
    expect(calls.length).toBe(1)
  })

  it('U7f · UI 仅在 pages > 0 时显示页数', () => {
    expect(listSrc).toContain('{c.pages > 0 &&')
  })
})

/* ══════════════════ U8 · 四段式路由 ══════════════════ */

describe('U8 · 点击进入正确四段式路由', () => {
  it('U8a · 使用 readerPath 工具，不手写路径', () => {
    expect(listSrc).toContain('readerPath({')
    expect(listSrc).not.toMatch(/`\/reader\/\$\{/)
  })

  it('U8b · 传入 sourceId / mangaId / chapterId / page=0', () => {
    expect(listSrc).toContain('sourceId,')
    expect(listSrc).toContain('mangaId: workId')
    expect(listSrc).toContain('chapterId: c.id')
    expect(listSrc).toContain('page: 0')
  })

  it('U8c · 🔴 章节 ID 用 UUID（c.id），不用章节号', () => {
    expect(listSrc).toContain('chapterId: c.id')
    expect(listSrc).not.toContain('chapterId: c.chapter')
  })

  it('U8d · 生成的四段式路径正确', () => {
    const p = readerPath({ sourceId: 'mangadex', mangaId: 'mid', chapterId: 'cid', page: 0 })
    expect(p).toBe('/reader/mangadex/mid/cid')
  })

  it('U8e · 本地来源仍生成 local 路径（不回归）', () => {
    const p = readerPath({ sourceId: LOCAL_SOURCE_ID, mangaId: 'm', chapterId: 'c', page: 0 })
    expect(p).toBe('/reader/local/m/c')
  })
})

/* ══════════════════ U9 · state.from ══════════════════ */

describe('U9 · state.from 能返回详情页', () => {
  it('U9a · 传 state.from', () => {
    expect(listSrc).toContain('state: { from:')
  })

  it('U9b · from 用当前详情页路径', () => {
    expect(listSrc).toContain('fromPath || location.pathname')
  })

  it('U9c · DetailPage 传入 location.pathname', () => {
    expect(detailSrc).toContain('fromPath={location.pathname}')
  })

  it('U9d · /detail/ 在返回白名单内', () => {
    // 由 reader_route 的 ALLOWED_FROM_PREFIXES 保证，此处断言组件确实传了该路径
    expect(listSrc).toContain('location.pathname')
  })
})

/* ══════════════════ U10 · 三种状态 ══════════════════ */

describe('U10 · 加载中/空/失败状态', () => {
  it('U10a · 加载中显示 Loading', () => {
    expect(listSrc).toContain('<Loading text="加载章节…" />')
  })

  it('U10b · 空章节有明确说明', () => {
    expect(listSrc).toContain('暂无章节')
  })

  it('U10c · 失败有错误提示 + 重试', () => {
    expect(listSrc).toContain('章节加载失败')
    expect(listSrc).toContain('onAction={() => void load(false)}')
  })

  it('U10d · 失败不崩溃（try/catch 包裹）', () => {
    expect(listSrc).toContain('catch (e)')
  })

  it('U10e · 加载更多失败不清空已有列表', () => {
    // append=true 时不设置 error
    expect(listSrc).toMatch(/if \(!append\) setError/)
  })
})

/* ══════════════════ U11 · 本地不回归 ══════════════════ */

describe('U11 · 原有本地详情页与阅读入口不回归', () => {
  it('U11a · LocalDetailPage 仍用 localReaderPath', () => {
    const local = readFileSync(new URL('../src/modules/library/LocalDetailPage.tsx', import.meta.url), 'utf-8')
    expect(local).toContain('localReaderPath(m.id, c.id)')
  })

  it('U11b · LibraryPage 入口不变', () => {
    const lib = readFileSync(new URL('../src/modules/library/LibraryPage.tsx', import.meta.url), 'utf-8')
    expect(lib).toContain('localReaderPath(m.id, h.chapterId, h.pageIndex)')
  })

  it('U11c · 🔴 ChapterList 不修改本地阅读路径', () => {
    expect(listSrc).not.toContain('localReaderPath')
  })

  it('U11d · DetailPage 原有收藏/返回逻辑未被改动', () => {
    expect(detailSrc).toContain('favKeyOf')
    expect(detailSrc).toContain('toggleFavorite')
    expect(detailSrc).toContain('const goBack = () =>')
  })

  it('U11e · 未引入新依赖', () => {
    expect(listSrc).not.toContain('axios')
    expect(listSrc).not.toContain('react-query')
    expect(listSrc).not.toContain('swr')
  })

  it('U11f · 未触碰冻结模块', () => {
    expect(listSrc).not.toContain('nativeHttp')
    expect(listSrc).not.toContain('binaryHttp')
  })
})

/* ══════════════════ 排序规则保持 ══════════════════ */

describe('S · 排序规则保持（章节号数值 → 语言 → 时间）', () => {
  const mk = (id: string, chapter: string, language: string): OnlineChapter => ({
    id, sourceId: 'mangadex', mangaId: 'm', chapter, title: '',
    pages: 10, language, languageLabel: languageLabel(language), external: false,
  })

  it('S1 · 数值升序（9 < 10 < 11）', () => {
    const r = sortChapters([mk('c', '11', 'en'), mk('a', '9', 'en'), mk('b', '10', 'en')])
    expect(r.map((x) => x.chapter)).toEqual(['9', '10', '11'])
  })

  it('S2 · 小数章节号正确', () => {
    const r = sortChapters([mk('a', '62', 'en'), mk('b', '61', 'en'), mk('c', '61.2', 'en')])
    expect(r.map((x) => x.chapter)).toEqual(['61', '61.2', '62'])
  })

  it('S3 · 同章号中文优先', () => {
    const r = sortChapters([mk('e', '5', 'en'), mk('z', '5', 'zh')])
    expect(r[0].language).toBe('zh')
  })

  it('S4 · 组件使用 sortChapters（规则统一）', () => {
    expect(listSrc).toContain('sortChapters(chapters)')
  })
})

/* ══════════════════ 章节号为空不伪造 ══════════════════ */

describe('E · 章节号为空不伪造编号', () => {
  it('E1 · 适配器的 "-" 占位归一化为空串', () => {
    expect(normalizeChapter(mkChapter({ chapter: '-' }), 'm').chapter).toBe('')
  })

  it('E2 · 🔴 UI 显示「无编号章节」而非编造数字', () => {
    expect(listSrc).toContain('无编号章节')
    expect(listSrc).toContain("c.chapter ? `第 ${c.chapter} 话`")
  })

  it('E3 · 空章节号仍参与列表（不丢弃）', () => {
    const r = sortChapters([normalizeChapter(mkChapter({ id: 'x', chapter: '-' }), 'm')])
    expect(r).toHaveLength(1)
    expect(r[0].chapter).toBe('')
  })
})
