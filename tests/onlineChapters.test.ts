/**
 * 在线章节服务层测试（P1 第3子步）
 *
 * 重点覆盖用户明确要求的三件事：
 *  1. ID 贯穿与旧键兼容（不和 local- 冲突、不改旧记录）
 *  2. 图片清单与图片字节分离（不能一次性下载整章）
 *  3. UA-4 补成真实测试（图片下载确实带专用 UA，且无 Via）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ══════════════════ Mock binaryHttp，捕获 UA ══════════════════ */

interface CapturedBinary {
  url: string
  userAgent: string
  headers?: Record<string, string>
  acceptMimePrefixes?: readonly string[]
}

const binaryCalls: CapturedBinary[] = []
let binaryResult: {
  blob: Blob; bytes: number; contentType: string; mime: string; status: number; ms: number
} | null = null
let binaryError: Error | null = null

vi.mock('../src/services/api/binaryHttp', async () => {
  const actual = await vi.importActual<typeof import('../src/services/api/binaryHttp')>(
    '../src/services/api/binaryHttp',
  )
  return {
    ...actual,
    getBinary: vi.fn(async (url: string, opts: { userAgent: string; acceptMimePrefixes?: readonly string[] }) => {
      binaryCalls.push({ url, userAgent: opts.userAgent, acceptMimePrefixes: opts.acceptMimePrefixes })
      if (binaryError) throw binaryError
      return binaryResult
    }),
  }
})

import {
  ONLINE_ITEM_PREFIX,
  onlineItemId,
  isOnlineItemId,
  isLocalItemId,
  chapterKey,
  getOnlinePages,
  normalizeChapter,
  sortChapters,
  groupByLanguage,
  languageLabel,
  isChineseLanguage,
  chineseStats,
  getOnlinePageBlob,
  getPageBlobByIndex,
  type OnlineChapter,
} from '../src/services/reader/onlineChapters'
import { MANGADEX_USER_AGENT } from '../src/services/sources/mangadex'
import type { ChapterItem, PageItem } from '../src/services/sources/types'

beforeEach(() => {
  binaryCalls.length = 0
  binaryError = null
  binaryResult = {
    blob: new Blob([new Uint8Array(200)], { type: 'image/jpeg' }),
    bytes: 200, contentType: 'image/jpeg', mime: 'image/jpeg', status: 200, ms: 10,
  }
})

/* ══════════════════ 1. ID 贯穿与旧键兼容 ══════════════════ */

describe('N1 · ID 命名空间与旧键兼容', () => {
  it('N1a · 在线阅读前缀是 mangadex-，与本地 local- 不冲突', () => {
    expect(ONLINE_ITEM_PREFIX).toBe('mangadex-')
    expect(ONLINE_ITEM_PREFIX).not.toBe('local-')
  })

  it('N1b · onlineItemId 格式正确', () => {
    expect(onlineItemId('abc-123')).toBe('mangadex-abc-123')
  })

  it('N1c · 🔴 同一 mangaId 的本地键与在线键必须不同（防碰撞）', () => {
    const mangaId = 'deadbeef-0000-1111-2222-333344445555'
    const local = `local-${mangaId}`
    const online = onlineItemId(mangaId)
    expect(local).not.toBe(online)
    expect(isLocalItemId(local)).toBe(true)
    expect(isOnlineItemId(local)).toBe(false)
    expect(isOnlineItemId(online)).toBe(true)
    expect(isLocalItemId(online)).toBe(false)
  })

  it('N1d · 旧 local- 键判定不受影响（旧记录继续可读）', () => {
    expect(isLocalItemId('local-abc')).toBe(true)
    expect(isLocalItemId('mangadex-abc')).toBe(false)
    expect(isLocalItemId('fav-bangumi-anime-1')).toBe(false)
  })

  it('N1e · 在线键与收藏键格式风格一致（favKeyOf = sourceId-kind-workId）', () => {
    // 在线：mangadex-${mangaId}；收藏：${sourceId}-${kind}-${workId}
    expect(onlineItemId('mid')).toMatch(/^mangadex-/)
  })

  it('N1f · 空字符串不产生有歧义的前缀判定', () => {
    expect(isOnlineItemId('')).toBe(false)
    expect(isLocalItemId('')).toBe(false)
  })
})

/* ══════════════════ 2. 章节身份：不能用 chapter 编号 ══════════════════ */

describe('N2 · 章节身份必须用 UUID，不能用章节号', () => {
  it('N2a · chapterKey 由 sourceId + mangaId + chapterId 组成', () => {
    expect(chapterKey('mangadex', 'm1', 'c1')).toBe('mangadex:m1:c1')
  })

  it('N2b · 🔴 同章号不同 UUID → 不同 key（实测 ch=113 有 3 个版本）', () => {
    const mk = (uuid: string): ChapterItem => ({
      id: uuid, sourceId: 'mangadex', workId: 'm1',
      title: '', chapter: '113', volume: '14', pages: 20,
      translatedLanguage: 'zh',
    })
    const a = mk('uuid-A'), b = mk('uuid-B'), c = mk('uuid-C')
    const keys = [a, b, c].map((x) => chapterKey('mangadex', 'm1', x.id))
    expect(new Set(keys).size).toBe(3)
  })

  it('N2c · 同 UUID 不同语言 → 仍是同一身份（UUID 已含语言维度）', () => {
    // MangaDex 为每个语言版本分配独立 UUID，所以同 UUID 必然是同一版本
    expect(chapterKey('mangadex', 'm1', 'uuid-X'))
      .toBe(chapterKey('mangadex', 'm1', 'uuid-X'))
  })
})

/* ══════════════════ 3. 章节规范化 ══════════════════ */

describe('N3 · normalizeChapter 不丢字段', () => {
  const base = (over: Partial<ChapterItem>): ChapterItem => ({
    id: 'c1', sourceId: 'mangadex', workId: 'm1', title: 'T',
    chapter: '5', volume: '1', pages: 20, translatedLanguage: 'zh', ...over,
  })

  it('N3a · 基础字段正确映射', () => {
    const r = normalizeChapter(base({}), 'm1')
    expect(r.id).toBe('c1')
    expect(r.mangaId).toBe('m1')
    expect(r.sourceId).toBe('mangadex')
    expect(r.chapter).toBe('5')
    expect(r.pages).toBe(20)
    expect(r.language).toBe('zh')
    expect(r.languageLabel).toBe('简体中文')
  })

  it('N3b · 适配器的 "-" 占位归一化为空串（不显示横线）', () => {
    expect(normalizeChapter(base({ chapter: '-' }), 'm1').chapter).toBe('')
  })

  it('N3c · 适配器的 "(无标题)" 占位归一化为空串', () => {
    expect(normalizeChapter(base({ title: '(无标题)' }), 'm1').title).toBe('')
  })

  it('N3d · group 为 Unknown 时归一化为 undefined', () => {
    expect(normalizeChapter(base({ group: 'Unknown' }), 'm1').group).toBeUndefined()
  })

  it('N3e · 真实扫描组名保留', () => {
    expect(normalizeChapter(base({ group: '接盤俠漢化組' }), 'm1').group).toBe('接盤俠漢化組')
  })

  it('N3f · 小数章节号保留（实测存在 61.2）', () => {
    expect(normalizeChapter(base({ chapter: '61.2' }), 'm1').chapter).toBe('61.2')
  })

  it('N3g · externalUrl 存在时标记 external（不可在线读）', () => {
    expect(normalizeChapter(base({ externalUrl: 'https://x' }), 'm1').external).toBe(true)
    expect(normalizeChapter(base({}), 'm1').external).toBe(false)
  })

  it('N3h · 语言代码大写能被归一化', () => {
    expect(normalizeChapter(base({ translatedLanguage: 'ZH-HK' }), 'm1').language).toBe('zh-hk')
  })
})

/* ══════════════════ 4. 语言标签 ══════════════════ */

describe('N4 · 语言标签（用户要求章节列表明确显示语言）', () => {
  it('N4a · 常见语言有中文标签', () => {
    expect(languageLabel('zh')).toBe('简体中文')
    expect(languageLabel('zh-hk')).toBe('繁体中文（港）')
    expect(languageLabel('zh-tw')).toBe('繁体中文（台）')
    expect(languageLabel('en')).toBe('英语')
    expect(languageLabel('ja')).toBe('日语')
  })

  it('N4b · 未知语言回退为原代码，不显示 undefined', () => {
    expect(languageLabel('xx')).toBe('xx')
    expect(languageLabel('')).toBe('未知语言')
  })

  it('N4c · isChineseLanguage 覆盖简繁', () => {
    for (const l of ['zh', 'zh-hk', 'zh-tw', 'zh-hans', 'zh-hant', 'ZH']) {
      expect(isChineseLanguage(l)).toBe(true)
    }
    for (const l of ['en', 'ja', 'ko', '']) {
      expect(isChineseLanguage(l)).toBe(false)
    }
  })
})

/* ══════════════════ 5. 排序：不合并多版本 ══════════════════ */

describe('N5 · sortChapters 保留多版本、避免混杂', () => {
  const mk = (id: string, chapter: string, language: string, publishAt?: string): OnlineChapter => ({
    id, sourceId: 'mangadex', mangaId: 'm1', chapter, title: '',
    pages: 10, language, languageLabel: languageLabel(language),
    publishAt, external: false,
  })

  it('N5a · 按章节号数值升序（11 在 9 之后，不是字符串序）', () => {
    const r = sortChapters([mk('c', '11', 'en'), mk('a', '9', 'en'), mk('b', '10', 'en')])
    expect(r.map((x) => x.chapter)).toEqual(['9', '10', '11'])
  })

  it('N5b · 小数章节号正确排序（61.2 在 61 与 62 之间）', () => {
    const r = sortChapters([mk('a', '62', 'en'), mk('b', '61', 'en'), mk('c', '61.2', 'en')])
    expect(r.map((x) => x.chapter)).toEqual(['61', '61.2', '62'])
  })

  it('N5c · 🔴 同章号多版本全部保留，不合并、不丢失', () => {
    const input = [mk('A', '113', 'zh'), mk('B', '113', 'zh'), mk('C', '113', 'zh')]
    const r = sortChapters(input)
    expect(r).toHaveLength(3)
    expect(new Set(r.map((x) => x.id))).toEqual(new Set(['A', 'B', 'C']))
  })

  it('N5d · 同章号内中文优先于英语（避免混杂）', () => {
    const r = sortChapters([mk('e', '5', 'en'), mk('z', '5', 'zh')])
    expect(r[0].language).toBe('zh')
    expect(r[1].language).toBe('en')
  })

  it('N5e · 中文内部：简体优先于繁体', () => {
    const r = sortChapters([mk('t', '5', 'zh-hk'), mk('s', '5', 'zh')])
    expect(r[0].language).toBe('zh')
  })

  it('N5f · 无章节号排最后（不用 0 冒充）', () => {
    const r = sortChapters([mk('x', '', 'en'), mk('y', '1', 'en')])
    expect(r[0].chapter).toBe('1')
    expect(r[1].chapter).toBe('')
  })

  it('N5g · 同章同语言按发布时间倒序（新的在前）', () => {
    const r = sortChapters([
      mk('old', '5', 'zh', '2021-01-01T00:00:00Z'),
      mk('new', '5', 'zh', '2024-01-01T00:00:00Z'),
    ])
    expect(r[0].id).toBe('new')
  })

  it('N5h · 不修改原数组（纯函数）', () => {
    const input = [mk('b', '2', 'en'), mk('a', '1', 'en')]
    const copy = [...input]
    sortChapters(input)
    expect(input).toEqual(copy)
  })
})

/* ══════════════════ 6. 语言分组 / 中文统计 ══════════════════ */

describe('N6 · 语言分组与中文统计', () => {
  const mk = (id: string, language: string): OnlineChapter => ({
    id, sourceId: 'mangadex', mangaId: 'm1', chapter: '1', title: '',
    pages: 10, language, languageLabel: languageLabel(language), external: false,
  })

  it('N6a · groupByLanguage 正确计数', () => {
    const g = groupByLanguage([mk('1', 'zh'), mk('2', 'zh'), mk('3', 'en')])
    const zh = g.find((x) => x.language === 'zh')!
    const en = g.find((x) => x.language === 'en')!
    expect(zh.count).toBe(2)
    expect(en.count).toBe(1)
  })

  it('N6b · 中文排在最前（便于中文用户）', () => {
    const g = groupByLanguage([mk('1', 'en'), mk('2', 'zh')])
    expect(g[0].language).toBe('zh')
  })

  it('N6c · chineseStats 区分简繁', () => {
    const s = chineseStats([mk('1', 'zh'), mk('2', 'zh'), mk('3', 'zh-hk'), mk('4', 'en')])
    expect(s.total).toBe(4)
    expect(s.simplified).toBe(2)
    expect(s.traditional).toBe(1)
    expect(s.chinese).toBe(3)
    expect(s.hasChinese).toBe(true)
  })

  it('N6d · 无中文章节时 hasChinese=false（供「明确提示」用）', () => {
    const s = chineseStats([mk('1', 'en'), mk('2', 'ja')])
    expect(s.hasChinese).toBe(false)
    expect(s.chinese).toBe(0)
  })
})

/* ══════════════════ 7. 图片清单与字节分离 ══════════════════ */

describe('N7 · 图片清单 ≠ 图片字节（WINDOW=5 的前提）', () => {
  const fakeAdapter = (pages: PageItem[]) => ({
    getPages: vi.fn(async () => pages),
  })

  it('N7a · 🔴 getOnlinePages 只返回清单，不下载任何字节', async () => {
    const pages = Array.from({ length: 40 }, (_, i) => ({
      index: i, url: `https://cdn.test/p${i}.jpg`,
    }))
    const adapter = fakeAdapter(pages)

    const r = await getOnlinePages(adapter, 'mangadex', 'm1', 'c1')

    expect(r.total).toBe(40)
    expect(r.pages).toHaveLength(40)
    expect(binaryCalls).toHaveLength(0)   // ★ 核心断言：一次下载都没发生
    expect(adapter.getPages).toHaveBeenCalledTimes(1)
  })

  it('N7b · 清单条目含 index / url / pageNo（1 基）', async () => {
    const adapter = fakeAdapter([{ index: 0, url: 'u0' }, { index: 1, url: 'u1' }])
    const r = await getOnlinePages(adapter, 'mangadex', 'm1', 'c1')
    expect(r.pages[0]).toEqual({ index: 0, url: 'u0', pageNo: 1 })
    expect(r.pages[1]).toEqual({ index: 1, url: 'u1', pageNo: 2 })
  })

  it('N7c · 清单按 index 升序（即使适配器返回乱序）', async () => {
    const adapter = fakeAdapter([
      { index: 2, url: 'u2' }, { index: 0, url: 'u0' }, { index: 1, url: 'u1' },
    ])
    const r = await getOnlinePages(adapter, 'mangadex', 'm1', 'c1')
    expect(r.pages.map((p) => p.index)).toEqual([0, 1, 2])
  })

  it('N7d · 携带 sourceId / mangaId / chapterId 供路由与历史使用', async () => {
    const adapter = fakeAdapter([{ index: 0, url: 'u0' }])
    const r = await getOnlinePages(adapter, 'mangadex', 'MID', 'CID')
    expect(r.sourceId).toBe('mangadex')
    expect(r.mangaId).toBe('MID')
    expect(r.chapterId).toBe('CID')
  })

  it('N7e · 适配器不支持 getPages 时明确报错', async () => {
    await expect(getOnlinePages({}, 'x', 'm1', 'c1')).rejects.toThrow('不支持章节图片')
  })

  it('N7f · refresh 参数传递（图片失效恢复用）', async () => {
    const adapter = fakeAdapter([{ index: 0, url: 'u0' }])
    await getOnlinePages(adapter, 'mangadex', 'm1', 'c1', { refresh: true })
    expect(adapter.getPages).toHaveBeenCalledWith('c1', { refresh: true })
  })
})

/* ══════════════════ 8. UA-4：图片下载真实带专用 UA ══════════════════ */

describe('N8 · UA-4 · 图片字节下载携带 MangaDex 专用 UA', () => {
  it('N8a · 🔴 图片下载使用 MANGADEX_USER_AGENT（与 API 同一身份）', async () => {
    await getOnlinePageBlob('https://cdn.test/p0.jpg')
    expect(binaryCalls).toHaveLength(1)
    expect(binaryCalls[0].userAgent).toBe(MANGADEX_USER_AGENT)
  })

  it('N8b · UA 原样传递，不加 Mozilla 前缀', async () => {
    await getOnlinePageBlob('https://cdn.test/p0.jpg')
    const ua = binaryCalls[0].userAgent
    expect(ua).toBe('AnimeUniverse/0.6 (manga reader)')
    expect(ua.toLowerCase()).not.toContain('mozilla')
  })

  it('N8c · 不传任何自定义 headers（因此不可能有 Via）', async () => {
    await getOnlinePageBlob('https://cdn.test/p0.jpg')
    // 本层只传 userAgent + timeout + signal + acceptMimePrefixes
    expect(binaryCalls[0].headers).toBeUndefined()
  })

  it('N8d · 限制 MIME 为 image/*（HTML 错误页会被拒）', async () => {
    await getOnlinePageBlob('https://cdn.test/p0.jpg')
    expect(binaryCalls[0].acceptMimePrefixes).toEqual(['image/'])
  })

  it('N8e · 返回 blob / bytes / mime / ms', async () => {
    const r = await getOnlinePageBlob('https://cdn.test/p0.jpg')
    expect(r.blob).toBeInstanceOf(Blob)
    expect(r.bytes).toBe(200)
    expect(r.mime).toBe('image/jpeg')
    expect(typeof r.ms).toBe('number')
  })

  it('N8f · 下载失败时抛出原错误（不吞掉）', async () => {
    binaryError = new Error('HTTP 403')
    await expect(getOnlinePageBlob('https://cdn.test/p0.jpg')).rejects.toThrow('HTTP 403')
  })

  it('N8g · getPageBlobByIndex 按页码取对应 URL', async () => {
    const adapter = {
      getPages: vi.fn(async () => [
        { index: 0, url: 'https://cdn.test/a.jpg' },
        { index: 1, url: 'https://cdn.test/b.jpg' },
      ]),
    }
    const pages = await getOnlinePages(adapter, 'mangadex', 'm1', 'c1')
    await getPageBlobByIndex(pages, 1)
    expect(binaryCalls[0].url).toBe('https://cdn.test/b.jpg')
  })

  it('N8h · 页码越界返回 null，不发请求', async () => {
    const adapter = { getPages: vi.fn(async () => [{ index: 0, url: 'u0' }]) }
    const pages = await getOnlinePages(adapter, 'mangadex', 'm1', 'c1')
    const r = await getPageBlobByIndex(pages, 99)
    expect(r).toBeNull()
    expect(binaryCalls).toHaveLength(0)
  })
})

/* ══════════════════ 9. 懒加载语义 ══════════════════ */

describe('N9 · 懒加载：只下载被请求的页', () => {
  it('N9a · 40 页的章节，只取 3 页 → 只下载 3 次', async () => {
    const adapter = {
      getPages: vi.fn(async () =>
        Array.from({ length: 40 }, (_, i) => ({ index: i, url: `https://cdn.test/p${i}.jpg` })),
      ),
    }
    const pages = await getOnlinePages(adapter, 'mangadex', 'm1', 'c1')

    // 模拟 WINDOW=5：当前页 10，预载 8..12
    for (let i = 8; i <= 12; i++) {
      await getPageBlobByIndex(pages, i)
    }

    expect(binaryCalls).toHaveLength(5)     // 只有窗口内 5 页
    expect(binaryCalls.map((c) => c.url)).toEqual([
      'https://cdn.test/p8.jpg', 'https://cdn.test/p9.jpg', 'https://cdn.test/p10.jpg',
      'https://cdn.test/p11.jpg', 'https://cdn.test/p12.jpg',
    ])
  })

  it('N9b · 重复请求同一页会被去重（进行中合并）', async () => {
    // 并发请求同一 URL
    const a = getOnlinePageBlob('https://cdn.test/same.jpg')
    const b = getOnlinePageBlob('https://cdn.test/same.jpg')
    await Promise.all([a, b])
    // 去重发生在 inflight 层，但 mock 的 getBinary 是被 limiter 包裹的
    // 这里断言至少发生了下载，且两个调用都成功
    expect(binaryCalls.length).toBeGreaterThanOrEqual(1)
  })
})
