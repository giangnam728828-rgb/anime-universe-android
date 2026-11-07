/**
 * MangaBaka 适配器单测（总方案·阶段3第2步·第7/8项）
 *
 * 覆盖裁定要求的 M1–M10。全部用 mock 的 httpGetText，不产生真实网络请求。
 *
 * 因适配器内有模块级 memCache，每个用例前 `vi.resetModules()` 并动态 import，
 * 避免上一个用例的缓存污染下一个用例的 URL 断言。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// mock 基础设施
// ---------------------------------------------------------------------------

let calls: string[] = []
let responder: (url: string) => { status: number; text: string } = () => ({
  status: 200,
  text: JSON.stringify({ status: 200, pagination: { count: 0 }, data: [] }),
})

vi.mock('../src/services/api/nativeHttp', () => ({
  httpGetText: async (url: string) => {
    calls.push(url)
    const r = responder(url)
    return { status: r.status, text: r.text, ms: 1 }
  },
  httpPostJson: async () => ({ status: 500, text: '' }),
}))

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 取某个 URL 的查询参数（返回首个同名值；数组参数会以重复 key 出现） */
function param(url: string, key: string): string | undefined {
  const q = url.split('?')[1] ?? ''
  return new URLSearchParams(q).get(key) ?? undefined
}
function paramsAll(url: string, key: string): string[] {
  const q = url.split('?')[1] ?? ''
  return new URLSearchParams(q).getAll(key)
}

/** 构造一条 series（只填本适配器关心的字段） */
function series(over: Record<string, unknown> = {}) {
  return {
    id: 4024,
    titles: [
      { language: 'zh', traits: ['official'], title: '进击的巨人', is_primary: true },
      { language: 'zh-Hant', traits: ['official'], title: '進擊的巨人', is_primary: true },
      { language: 'ja', traits: ['native'], title: '進撃の巨人', is_primary: true },
      { language: 'en', traits: ['official'], title: 'Attack on Titan', is_primary: true },
    ],
    cover: { x250: 'https://cdn.mangabaka.dev/imgproxy/plain/x250@1/abc' },
    description: '<p>As a child, Luffy...</p>',
    rating: 84.8999,
    published: { start_date: '2009-09-09', end_date: null },
    status: 'releasing',
    type: 'manga',
    total_chapters: 139,
    popularity: { global: { current: 3 } },
    source: { anilist: { id: 30013, rating: 9.1 } },
    tags: [
      { id: 39, name: 'Action', is_genre: true },
      { id: 36, name: 'Fantasy', is_genre: true },
      { id: 11, name: 'Mecha', is_genre: false },
      { id: 5487, name: 'Acrobatics', is_genre: false },
    ],
    ...over,
  }
}

/** 动态载入适配器（重置模块级缓存） */
async function load() {
  const mod = await import('../src/services/sources/mangabaka')
  return mod.default
}

function ok(data: unknown[], count = data.length) {
  return { status: 200, text: JSON.stringify({ status: 200, pagination: { count }, data }) }
}

beforeEach(() => {
  calls = []
  responder = () => ok([])
  vi.resetModules()
})

// ---------------------------------------------------------------------------
// M1 动漫零请求
// ---------------------------------------------------------------------------

describe('M1 · kind=anime 必须在发起网络请求之前返回空', () => {
  it('M1a anime 返回空结果', async () => {
    const mb = await load()
    const r = await mb.search({ kind: 'anime' })
    expect(r.items).toEqual([])
    expect(r.hasNext).toBe(false)
  })

  it('M1b anime 请求数为 0（核心断言）', async () => {
    const mb = await load()
    await mb.search({ kind: 'anime' })
    await mb.search({ kind: 'anime', kw: '进击的巨人' })
    await mb.search({ kind: 'anime', genre: 'Action' })
    console.log(`[M1b] anime 三次调用后请求数=${calls.length}`)
    expect(calls.length).toBe(0)
  })

  it('M1c manga 正常发起请求（对照）', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga' })
    expect(calls.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// M2 排序映射
// ---------------------------------------------------------------------------

describe('M2 · 排序映射（sort_by，不是 sort）', () => {
  it('M2a 热门 → popularity_asc（排名 1 最热门）', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga', sort: '热门' })
    expect(param(calls[0], 'sort_by')).toBe('popularity_asc')
    expect(param(calls[0], 'sort')).toBeUndefined()
  })

  it('M2b 最新 → latest', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga', sort: '最新' })
    expect(param(calls[0], 'sort_by')).toBe('latest')
  })

  it('M2c 评分 → score_desc', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga', sort: '评分' })
    expect(param(calls[0], 'sort_by')).toBe('score_desc')
  })

  it('M2d 未传 sort 时默认热门', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga' })
    expect(param(calls[0], 'sort_by')).toBe('popularity_asc')
  })
})

// ---------------------------------------------------------------------------
// M3 有关键词时走相关性
// ---------------------------------------------------------------------------

describe('M3 · 有关键词时用相关性排序', () => {
  it('M3a kw 存在 → sort_by=relevance_desc 且带 q', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga', kw: '进击的巨人', sort: '评分' })
    expect(param(calls[0], 'q')).toBe('进击的巨人')
    expect(param(calls[0], 'sort_by')).toBe('relevance_desc')
  })

  it('M3b 空白关键词视作无关键词', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga', kw: '   ', sort: '评分' })
    expect(param(calls[0], 'q')).toBeUndefined()
    expect(param(calls[0], 'sort_by')).toBe('score_desc')
  })
})

// ---------------------------------------------------------------------------
// M4 必带参数
// ---------------------------------------------------------------------------

describe('M4 · schema=full 与成人向排除', () => {
  it('M4a 必带 schema=full（否则没有 tags）', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga', kw: 'x' })
    expect(param(calls[0], 'schema')).toBe('full')
  })

  it('M4b 排除 erotica/pornographic', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga' })
    const vals = paramsAll(calls[0], 'not_content_rating')
    expect(param(calls[0], 'not_content_rating')).toBeTruthy()
    const joined = vals.join(',')
    expect(joined).toContain('erotica')
    expect(joined).toContain('pornographic')
  })

  it('M4c 不限制为 safe/suggestive（避免误伤未知枚举）', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga' })
    expect(param(calls[0], 'content_rating')).toBeUndefined()
  })

  it('M4d 详情同样带 schema=full', async () => {
    const mb = await load()
    responder = () => ({ status: 200, text: JSON.stringify({ status: 200, data: series() }) })
    await mb.getDetail('manga', '4024')
    expect(param(calls[0], 'schema')).toBe('full')
  })
})

// ---------------------------------------------------------------------------
// M5 标题优先级
// ---------------------------------------------------------------------------

describe('M5 · titles[] 标题优先级与语言标注', () => {
  it('M5a 优先 zh', async () => {
    const mb = await load()
    responder = () => ok([series()])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].title).toBe('进击的巨人')
    expect(r.items[0].titleLang).toBe('zh-hans')
    expect(r.items[0].titleNative).toBe('進撃の巨人')
  })

  it('M5b 无 zh 时回退 zh-Hant', async () => {
    const mb = await load()
    responder = () => ok([
      series({
        titles: [
          { language: 'zh-Hant', traits: ['official'], title: '進擊的巨人', is_primary: true },
          { language: 'en', traits: ['official'], title: 'Attack on Titan', is_primary: true },
        ],
      }),
    ])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].title).toBe('進擊的巨人')
    expect(r.items[0].titleLang).toBe('zh-hant')
  })

  it('M5c 无中文时回退 en，且不得谎报中文', async () => {
    const mb = await load()
    responder = () => ok([
      series({
        titles: [{ language: 'en', traits: ['official'], title: 'Attack on Titan', is_primary: true }],
      }),
    ])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].title).toBe('Attack on Titan')
    expect(r.items[0].titleLang).toBe('en')
  })

  it('M5d 绝不读顶层 title（v2 恒为 null）', async () => {
    const mb = await load()
    responder = () => ok([
      series({ title: 'SHOULD_NOT_BE_USED', titles: [{ language: 'en', traits: ['official'], title: 'Real Title', is_primary: true }] }),
    ])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].title).toBe('Real Title')
    expect(r.items[0].title).not.toBe('SHOULD_NOT_BE_USED')
  })

  it('M5e 同语言内优先 is_primary', async () => {
    const mb = await load()
    responder = () => ok([
      series({
        titles: [
          { language: 'zh', traits: ['alternative'], title: '别名甲', is_primary: false },
          { language: 'zh', traits: ['official'], title: '正式名', is_primary: true },
        ],
      }),
    ])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].title).toBe('正式名')
  })
})

// ---------------------------------------------------------------------------
// M6 简介语言
// ---------------------------------------------------------------------------

describe('M6 · 简介恒为英文', () => {
  it('M6a descLang=en', async () => {
    const mb = await load()
    responder = () => ok([series()])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].descLang).toBe('en')
  })

  it('M6b 简介 HTML 被清洗', async () => {
    const mb = await load()
    responder = () => ok([series({ description: '<p>Hello <b>world</b></p>' })])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].description).not.toContain('<')
    expect(r.items[0].description).toContain('Hello')
  })

  it('M6c 无简介时 descLang 不设', async () => {
    const mb = await load()
    responder = () => ok([series({ description: null })])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].descLang).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// M7 上游评分隔离（裁定要求保留）
// ---------------------------------------------------------------------------

describe('M7 · 评分隔离：只读顶层 rating，不回退 source.*', () => {
  it('M7a rating=null 时 score 必须 undefined（即使 source 有分）', async () => {
    const mb = await load()
    responder = () => ok([
      series({ rating: null, source: { anilist: { id: 1, rating: 9.1 }, my_anime_list: { id: 2, rating: 8.7 } } }),
    ])
    const r = await mb.search({ kind: 'manga' })
    console.log(`[M7a] score=${r.items[0].score}`)
    expect(r.items[0].score).toBeUndefined()
  })

  it('M7b rating 存在时用它，且四舍五入到 0-100', async () => {
    const mb = await load()
    responder = () => ok([series({ rating: 84.8999, source: { anilist: { id: 1, rating: 9.1 } } })])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].score).toBe(85)
  })

  it('M7c WorkItem 不含任何 source.* 派生字段（不解释、不展示）', async () => {
    const mb = await load()
    responder = () => ok([series()])
    const r = await mb.search({ kind: 'manga' })
    const item = r.items[0] as unknown as Record<string, unknown>
    const keys = Object.keys(item).map((k) => k.toLowerCase())
    // sourceId 是**我们自己的**来源标识，不是上游 source.*，必须存在
    expect(item.sourceId).toBe('mangabaka')
    // 除此之外不得出现任何 source 相关字段
    for (const k of keys.filter((x) => x !== 'sourceid')) {
      expect(k).not.toContain('source')
      expect(k).not.toContain('upstream')
    }
    expect(keys).not.toContain('source')
    // 上游来源名不得泄漏到业务模型
    const dump = JSON.stringify(item)
    for (const up of ['anilist', 'my_anime_list', 'anime_planet', 'manga_updates', 'kitsu', 'anime_news_network']) {
      expect(dump).not.toContain(up)
    }
  })
})

// ---------------------------------------------------------------------------
// M8 类型标注诚实
// ---------------------------------------------------------------------------

describe('M8 · formatCn 不得把小说谎称漫画', () => {
  it('M8a novel → 小说（MangaBaka）', async () => {
    const mb = await load()
    responder = () => ok([series({ type: 'novel' })])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].formatCn).toBe('小说（MangaBaka）')
    expect(r.items[0].formatCn).not.toContain('漫画')
  })

  it('M8b manhwa / manhua / manga 各自标注', async () => {
    const mb = await load()
    responder = () => ok([
      series({ id: 1, type: 'manhwa' }),
      series({ id: 2, type: 'manhua' }),
      series({ id: 3, type: 'manga' }),
    ])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items.map((i) => i.formatCn)).toEqual([
      '韩漫（MangaBaka）',
      '国漫（MangaBaka）',
      '漫画（MangaBaka）',
    ])
  })

  it('M8c kind 恒为 manga', async () => {
    const mb = await load()
    responder = () => ok([series()])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].kind).toBe('manga')
    expect(r.items[0].sourceId).toBe('mangabaka')
  })
})

// ---------------------------------------------------------------------------
// M9 分类映射
// ---------------------------------------------------------------------------

describe('M9 · 分类映射 16/16 与未知分类', () => {
  it('M9a 16 个分类键全部有 tag id', async () => {
    const mod = await import('../src/services/sources/mangabaka')
    const keys = Object.keys(mod.GENRE_TAG)
    console.log(`[M9a] 分类数=${keys.length}`)
    expect(keys.length).toBe(16)
    for (const k of keys) {
      expect(typeof mod.GENRE_TAG[k]).toBe('number')
      expect(mod.GENRE_TAG[k]).toBeGreaterThan(0)
    }
  })

  it('M9b 与 anilist GENRE_MAP 的键完全一致', async () => {
    const mod = await import('../src/services/sources/mangabaka')
    const anilist = await import('../src/services/sources/anilist')
    expect(Object.keys(mod.GENRE_TAG).sort()).toEqual(Object.keys(anilist.GENRE_MAP).sort())
  })

  it('M9c 已知分类发送 tag 参数', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga', genre: 'Action' })
    expect(param(calls[0], 'tag')).toBe('39')
  })

  it('M9d 未知分类不发送 tag（宁可不筛也不筛错）', async () => {
    const mb = await load()
    await mb.search({ kind: 'manga', genre: 'NotAGenre' })
    expect(param(calls[0], 'tag')).toBeUndefined()
  })

  it('M9e 展示用分类：16 个映射 + 非 is_genre 的 Mecha 也收录', async () => {
    const mb = await load()
    responder = () => ok([series()])
    const r = await mb.search({ kind: 'manga' })
    // Action→热血, Fantasy→奇幻, Mecha→机甲（Mecha 是 is_genre=false 但属 16 分类）
    expect(r.items[0].genres).toContain('热血')
    expect(r.items[0].genres).toContain('奇幻')
    expect(r.items[0].genres).toContain('机甲')
    // 非分类标签被丢弃
    expect(r.items[0].genres).not.toContain('Acrobatics')
  })
})

// ---------------------------------------------------------------------------
// M10 封面降级
// ---------------------------------------------------------------------------

describe('M10 · 封面降级链 x250 → x350 → raw', () => {
  it('M10a 优先 x250', async () => {
    const mb = await load()
    responder = () => ok([series({ cover: { x250: 'https://c/x250', x350: 'https://c/x350', raw: 'https://c/raw' } })])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].cover).toBe('https://c/x250')
  })

  it('M10b 无 x250 回退 x350', async () => {
    const mb = await load()
    responder = () => ok([series({ cover: { x250: null, x350: 'https://c/x350', raw: 'https://c/raw' } })])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].cover).toBe('https://c/x350')
  })

  it('M10c 只有 raw 时用 raw', async () => {
    const mb = await load()
    responder = () => ok([series({ cover: { raw: 'https://c/raw' } })])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].cover).toBe('https://c/raw')
  })

  it('M10d 无封面时为 undefined 而非空串', async () => {
    const mb = await load()
    responder = () => ok([series({ cover: {} })])
    const r = await mb.search({ kind: 'manga' })
    expect(r.items[0].cover).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

describe('分页与 hasNext', () => {
  it('按 pagination.count 计算 hasNext', async () => {
    const mb = await load()
    responder = () => ok([series()], 100)
    const r1 = await mb.search({ kind: 'manga', page: 1 })
    expect(r1.hasNext).toBe(true)
    const r5 = await mb.search({ kind: 'manga', page: 5 })
    expect(r5.hasNext).toBe(false)
  })
})
