/**
 * 阅读路由与返回恢复测试（P1 第4子步）
 *
 * 覆盖用户裁定的全部规则：
 *   R1 四段式路径构造
 *   R2 旧路由重定向（只映射 local、保留 ?p=、replace）
 *   R3 state.from 校验与安全 fallback
 *   R4 阅读历史来源判定（新字段优先、旧记录回退）
 *   R5 三个入口的路径与 state.from
 *   R6 页码恢复
 *   R7 旧历史记录兼容
 */
import { describe, it, expect } from 'vitest'
import {
  LOCAL_SOURCE_ID,
  READER_FALLBACK_PATH,
  readerPath,
  localReaderPath,
  legacyReaderTarget,
  legacyReaderRedirectUrl,
  sanitizeFromPath,
  resolveBackTarget,
  resolveHistorySource,
  historyMangaId,
  historyReaderPath,
} from '../src/modules/reader/readerRoute'

/* ══════════════════ R1 · 四段式路径构造 ══════════════════ */

describe('R1 · 四段式路径构造', () => {
  it('R1a · 基本四段式路径', () => {
    expect(readerPath({ sourceId: 'mangadex', mangaId: 'm1', chapterId: 'c1' }))
      .toBe('/reader/mangadex/m1/c1')
  })

  it('R1b · local 来源路径', () => {
    expect(localReaderPath('m1', 'c1')).toBe('/reader/local/m1/c1')
  })

  it('R1c · page > 0 时附加 ?p=', () => {
    expect(localReaderPath('m1', 'c1', 12)).toBe('/reader/local/m1/c1?p=12')
  })

  it('R1d · page = 0 时不附加（避免 ?p=0 噪音）', () => {
    expect(localReaderPath('m1', 'c1', 0)).toBe('/reader/local/m1/c1')
  })

  it('R1e · page 为 undefined 时不附加', () => {
    expect(localReaderPath('m1', 'c1')).toBe('/reader/local/m1/c1')
  })

  it('R1f · 参数做 URL 编码（防特殊字符破坏路由）', () => {
    expect(readerPath({ sourceId: 'a/b', mangaId: 'm 1', chapterId: 'c?1' }))
      .toBe('/reader/a%2Fb/m%201/c%3F1')
  })

  it('R1g · 🔴 实际调用点使用真实来源 ID（不是显示名称）', async () => {
    // readerPath 是通用构造函数，不做 sourceId 合法性校验（校验职责在调用方）。
    // 这里断言**真实调用点**产出的路径用的是小写真实 ID。
    expect(localReaderPath('m', 'c')).toBe('/reader/local/m/c')

    // 在线来源由 historyReaderPath 从 history.sourceId 取值，
    // sourceId 来自适配器的 sourceId 字段（'mangadex'），不是 UI 显示名
    const p = historyReaderPath({ itemId: 'mangadex-m', chapterId: 'c', sourceId: 'mangadex' })
    expect(p).toBe('/reader/mangadex/m/c')
    expect(p).not.toContain('MangaDex')
  })
})

/* ══════════════════ R2 · 旧路由重定向 ══════════════════ */

describe('R2 · 旧三段式路由 → local', () => {
  it('R2a · 旧路由只映射到 local', () => {
    expect(legacyReaderTarget('m1', 'c1').sourceId).toBe(LOCAL_SOURCE_ID)
    expect(LOCAL_SOURCE_ID).toBe('local')
  })

  it('R2b · 🔴 旧路由绝不猜测成 mangadex', () => {
    const t = legacyReaderTarget('m1', 'c1')
    expect(t.sourceId).not.toBe('mangadex')
    expect(legacyReaderRedirectUrl('m1', 'c1')).not.toContain('mangadex')
  })

  it('R2c · 重定向 URL 是四段式', () => {
    expect(legacyReaderRedirectUrl('m1', 'c1')).toBe('/reader/local/m1/c1')
  })

  it('R2d · 🔴 保留查询参数 ?p=12（不能丢页码）', () => {
    expect(legacyReaderRedirectUrl('m1', 'c1', '?p=12')).toBe('/reader/local/m1/c1?p=12')
  })

  it('R2e · 无查询串时不追加 ?', () => {
    expect(legacyReaderRedirectUrl('m1', 'c1', '')).toBe('/reader/local/m1/c1')
    expect(legacyReaderRedirectUrl('m1', 'c1')).toBe('/reader/local/m1/c1')
  })

  it('R2f · search 不带前导 ? 也能正确拼接', () => {
    expect(legacyReaderRedirectUrl('m1', 'c1', 'p=7')).toBe('/reader/local/m1/c1?p=7')
  })

  it('R2g · 保留多参数查询串', () => {
    expect(legacyReaderRedirectUrl('m1', 'c1', '?p=3&x=1'))
      .toBe('/reader/local/m1/c1?p=3&x=1')
  })

  it('R2h · legacyReaderTarget 原样携带 search', () => {
    expect(legacyReaderTarget('m1', 'c1', '?p=9').search).toBe('?p=9')
  })
})

/* ══════════════════ R3 · state.from 校验 ══════════════════ */

describe('R3 · state.from 安全校验', () => {
  it('R3a · 合法站内路径通过', () => {
    for (const p of ['/favorites', '/library', '/local/abc', '/search', '/discovery']) {
      expect(sanitizeFromPath(p)).toBe(p)
    }
  })

  it('R3b · 保留查询参数', () => {
    expect(sanitizeFromPath('/search?kw=test')).toBe('/search?kw=test')
  })

  it('R3c · 🔴 拒绝外部 URL（http/https）', () => {
    expect(sanitizeFromPath('http://evil.com')).toBeNull()
    expect(sanitizeFromPath('https://evil.com/x')).toBeNull()
  })

  it('R3d · 🔴 拒绝协议相对 URL（//host）', () => {
    expect(sanitizeFromPath('//evil.com')).toBeNull()
  })

  it('R3e · 🔴 拒绝 javascript: / data:', () => {
    expect(sanitizeFromPath('javascript:alert(1)')).toBeNull()
    expect(sanitizeFromPath('data:text/html,x')).toBeNull()
  })

  it('R3f · 拒绝空值与非字符串', () => {
    for (const v of [null, undefined, '', 0, {}, [], true]) {
      expect(sanitizeFromPath(v)).toBeNull()
    }
  })

  it('R3g · 🔴 拒绝回到阅读器自身（避免返回后仍在阅读器）', () => {
    expect(sanitizeFromPath('/reader/local/m1/c1')).toBeNull()
    expect(sanitizeFromPath('/reader/m1/c1')).toBeNull()
  })

  it('R3h · 拒绝未知路径（白名单）', () => {
    expect(sanitizeFromPath('/unknown-page')).toBeNull()
  })

  it('R3i · 首尾空白被裁剪', () => {
    expect(sanitizeFromPath('  /favorites  ')).toBe('/favorites')
  })
})

/* ══════════════════ R3 · 返回目标决策 ══════════════════ */

describe('R3 · resolveBackTarget 决策', () => {
  it('R3j · 有合法 from 时用 from', () => {
    const r = resolveBackTarget({ from: '/favorites' })
    expect(r).toEqual({ kind: 'from', path: '/favorites' })
  })

  it('R3k · 无 state 时 fallback 到 /library', () => {
    expect(resolveBackTarget(undefined)).toEqual({ kind: 'fallback', path: READER_FALLBACK_PATH })
    expect(resolveBackTarget(null)).toEqual({ kind: 'fallback', path: READER_FALLBACK_PATH })
    expect(resolveBackTarget({})).toEqual({ kind: 'fallback', path: READER_FALLBACK_PATH })
  })

  it('R3l · 🔴 from 非法时 fallback，不使用它', () => {
    const r = resolveBackTarget({ from: 'https://evil.com' })
    expect(r.kind).toBe('fallback')
    expect(r.path).toBe('/library')
  })

  it('R3m · fallback 目标是 /library（不是首页）', () => {
    expect(READER_FALLBACK_PATH).toBe('/library')
  })

  it('R3n · 从 LocalDetailPage 返回原作品详情', () => {
    const r = resolveBackTarget({ from: '/local/abc123' })
    expect(r).toEqual({ kind: 'from', path: '/local/abc123' })
  })
})

/* ══════════════════ R4 · 阅读历史来源判定 ══════════════════ */

describe('R4 · 阅读历史来源判定', () => {
  it('R4a · 🔴 新记录优先用 sourceId 字段', () => {
    expect(resolveHistorySource({ sourceId: 'local', itemId: 'local-x' }).kind).toBe('local')
    expect(resolveHistorySource({ sourceId: 'mangadex', itemId: 'mangadex-x' }).kind).toBe('online')
  })

  it('R4b · sourceId 优先于 itemId 前缀（字段更权威）', () => {
    // 即使 itemId 前缀看起来矛盾，也以字段为准
    const r = resolveHistorySource({ sourceId: 'mangadex', itemId: 'local-x' })
    expect(r.kind).toBe('online')
    expect(r.sourceId).toBe('mangadex')
  })

  it('R4c · 🔴 旧记录（无 sourceId）回退到前缀', () => {
    expect(resolveHistorySource({ itemId: 'local-abc' }).kind).toBe('local')
    expect(resolveHistorySource({ itemId: 'mangadex-abc' }).kind).toBe('online')
  })

  it('R4d · 旧 local 记录仍判定为 local（行为不变）', () => {
    const r = resolveHistorySource({ itemId: 'local-abc' })
    expect(r.kind).toBe('local')
    expect(r.sourceId).toBe('local')
  })

  it('R4e · 无法识别时返回 unknown', () => {
    expect(resolveHistorySource({ itemId: 'weird-id' }).kind).toBe('unknown')
    expect(resolveHistorySource({ itemId: '' }).kind).toBe('unknown')
    expect(resolveHistorySource({}).kind).toBe('unknown')
  })
})

/* ══════════════════ R4 · mangaId 提取 ══════════════════ */

describe('R4 · historyMangaId 提取', () => {
  it('R4f · 旧 local 记录正确剥离前缀', () => {
    expect(historyMangaId('local-abc')).toBe('abc')
  })

  it('R4g · 新 local 记录（带 sourceId）正确剥离', () => {
    expect(historyMangaId('local-abc', 'local')).toBe('abc')
  })

  it('R4h · 在线记录正确剥离', () => {
    expect(historyMangaId('mangadex-abc', 'mangadex')).toBe('abc')
    expect(historyMangaId('mangadex-abc')).toBe('abc')
  })

  it('R4i · 无前缀时原样返回', () => {
    expect(historyMangaId('abc')).toBe('abc')
  })

  it('R4j · UUID 形式的 mangaId 完整保留（含连字符）', () => {
    const uuid = 'b5b21ca1-1234-5678-9abc-def012345678'
    expect(historyMangaId(`mangadex-${uuid}`, 'mangadex')).toBe(uuid)
    expect(historyMangaId(`local-${uuid}`)).toBe(uuid)
  })
})

/* ══════════════════ R5/R6 · 继续阅读路径 ══════════════════ */

describe('R5/R6 · historyReaderPath', () => {
  it('R5a · 本地历史生成四段式 local 路径', () => {
    expect(historyReaderPath({ itemId: 'local-m1', chapterId: 'c1' }))
      .toBe('/reader/local/m1/c1')
  })

  it('R5b · 🔴 在线历史生成 mangadex 路径（旧代码做不到）', () => {
    expect(historyReaderPath({ itemId: 'mangadex-m1', chapterId: 'c1', sourceId: 'mangadex' }))
      .toBe('/reader/mangadex/m1/c1')
  })

  it('R6a · 🔴 页码恢复：pageIndex 转成 ?p=', () => {
    expect(historyReaderPath({ itemId: 'local-m1', chapterId: 'c1', pageIndex: 7 }))
      .toBe('/reader/local/m1/c1?p=7')
  })

  it('R6b · pageIndex=0 时不附加', () => {
    expect(historyReaderPath({ itemId: 'local-m1', chapterId: 'c1', pageIndex: 0 }))
      .toBe('/reader/local/m1/c1')
  })

  it('R5c · 缺 chapterId 返回 null（不生成坏链接）', () => {
    expect(historyReaderPath({ itemId: 'local-m1' })).toBeNull()
  })

  it('R5d · unknown 来源返回 null', () => {
    expect(historyReaderPath({ itemId: 'weird', chapterId: 'c1' })).toBeNull()
  })

  it('R5e · 旧记录（无 sourceId）仍能生成 local 路径', () => {
    expect(historyReaderPath({ itemId: 'local-abc', chapterId: 'c1' }))
      .toBe('/reader/local/abc/c1')
  })
})

/* ══════════════════ R7 · 旧记录兼容（关键回归） ══════════════════ */

describe('R7 · 旧历史记录完全兼容', () => {
  it('R7a · 🔴 旧 local 记录：判定、提取、路径 三步都正常', () => {
    const old = { itemId: 'local-manga123', chapterId: 'chap456', pageIndex: 3 }
    expect(resolveHistorySource(old).kind).toBe('local')
    expect(historyMangaId(old.itemId)).toBe('manga123')
    expect(historyReaderPath(old)).toBe('/reader/local/manga123/chap456?p=3')
  })

  it('R7b · 🔴 旧记录经过旧路由也能到达同一目标', () => {
    // 旧浏览器历史里的 /reader/manga123/chap456?p=3
    const viaLegacy = legacyReaderRedirectUrl('manga123', 'chap456', '?p=3')
    const viaNew = historyReaderPath({ itemId: 'local-manga123', chapterId: 'chap456', pageIndex: 3 })
    expect(viaLegacy).toBe(viaNew)
  })

  it('R7c · 旧记录 itemId 格式未被改变', () => {
    // 用户裁定：不删除、不改变既有 itemId 格式
    const src = require('node:fs').readFileSync(
      new URL('../src/modules/reader/ReaderPage.tsx', import.meta.url), 'utf-8',
    )
    // 写入仍以 `${sourceId}-${mangaId}` 形式；sourceId=local 时等价 local-${mangaId}
    expect(src).toContain('itemId: `${sourceId}-${mangaId}`')
  })

  it('R7d · local 来源时 itemId 与旧格式逐字一致', () => {
    const mangaId = 'manga123'
    expect(`${LOCAL_SOURCE_ID}-${mangaId}`).toBe(`local-${mangaId}`)
  })
})
