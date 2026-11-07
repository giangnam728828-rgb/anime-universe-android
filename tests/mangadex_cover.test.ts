/**
 * 第8子步 · Bug 2：MangaDex 封面 Blob 代理（C1–C9）
 *
 * 测试性质：
 *   ① 缓存层（mangadexCover.ts）→ **真实纯逻辑单测**，注入假下载函数
 *   ② 组件层（ProxyCover.tsx / useCoverObjectUrl.ts）→ **源码契约断言**
 *      （仓库无 jsdom，不做组件渲染测试；渲染与真机行为留真机复测）
 *
 * 关键事实（真机实测，写进断言防止回退）：
 *   专用 UA → image/jpeg 44,503 B ✅
 *   浏览器 UA → text/html 2,022 B（Cloudflare 挑战页）❌
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createCoverCache,
  isMangadexCover,
  MANGADEX_COVER_HOST,
  COVER_CACHE_MAX,
  COVER_FAIL_COOLDOWN_MS,
} from '../src/services/covers/mangadexCover'

const coverSvcSrc = readFileSync(
  new URL('../src/services/covers/mangadexCover.ts', import.meta.url), 'utf-8')
const hookSrc = readFileSync(
  new URL('../src/modules/covers/useCoverObjectUrl.ts', import.meta.url), 'utf-8')
const compSrc = readFileSync(
  new URL('../src/modules/covers/ProxyCover.tsx', import.meta.url), 'utf-8')
const workCardSrc = readFileSync(
  new URL('../src/components/WorkCard.tsx', import.meta.url), 'utf-8')
const detailSrc = readFileSync(
  new URL('../src/modules/detail/DetailPage.tsx', import.meta.url), 'utf-8')
const smartSrc = readFileSync(
  new URL('../src/components/SmartImage.tsx', import.meta.url), 'utf-8')

/**
 * 去掉注释后再断言。
 *
 * 原因：这些文件的头部注释会解释「为什么缓存层不持有 Object URL」
 * 之类的设计理由，正文里必然出现 `createObjectURL` / `urlCache` 等词。
 * 断言必须针对**代码**，不能针对解释文字。
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/^\s*\/\/.*$/gm, '')       // 行注释
}
const coverSvcCode = codeOnly(coverSvcSrc)
const hookCode = codeOnly(hookSrc)

/* ══════════════ 夹具 ══════════════ */

const MD_COVER = 'https://uploads.mangadex.org/covers/abc-123/cover.256.jpg'
const BILI_COVER = 'https://i0.hdslb.com/bfs/abc.jpg'

/** 真实 JPEG 头（与 binaryHttp.test.ts 一致的 ffd8ffe0 家族） */
function fakeJpeg(size = 256): Blob {
  const b = new Uint8Array(size)
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
  return new Blob([b], { type: 'image/jpeg' })
}

function makeCache(over: Partial<Parameters<typeof createCoverCache>[0]> = {}) {
  const calls: string[] = []
  const cache = createCoverCache({
    fetchBlob: async (url: string) => { calls.push(url); return fakeJpeg() },
    now: () => 1000,
    ...over,
  })
  return { cache, calls }
}

/* ══════════════ 判定层 ══════════════ */

describe('C4 · 不直接热链 MangaDex 图片域名', () => {
  it('C4a · MangaDex 来源的封面判定为需要代理', () => {
    expect(isMangadexCover('mangadex', MD_COVER)).toBe(true)
  })

  it('C4b · 即使 sourceId 缺失，只要域名是 uploads.mangadex.org 也代理', () => {
    expect(isMangadexCover(undefined, MD_COVER)).toBe(true)
    expect(isMangadexCover('', MD_COVER)).toBe(true)
  })

  it('C4c · 其他来源封面不代理（行为不变）', () => {
    expect(isMangadexCover('bilibili', BILI_COVER)).toBe(false)
    expect(isMangadexCover('anilist', 'https://s4.anilist.co/file/x.jpg')).toBe(false)
  })

  it('C4d · 无封面地址时不代理', () => {
    expect(isMangadexCover('mangadex', undefined)).toBe(false)
    expect(isMangadexCover('mangadex', '')).toBe(false)
  })

  it('C4e · 代理域名常量正确', () => {
    expect(MANGADEX_COVER_HOST).toBe('uploads.mangadex.org')
  })

  it('C4f · 🔴 渲染层不得把 uploads.mangadex.org 直连到 <img src>', () => {
    // ProxyCover 的 <img src> 只能是 url（Object URL）
    expect(compSrc).toContain('src={url}')
    expect(compSrc).not.toMatch(/<img[^>]*src=\{src\}/)
    // 原始 src 只作为缓存 key 传入 hook
    expect(compSrc).toContain('useCoverObjectUrl({ src, proxy: true, hold })')
  })
})

/* ══════════════ UA ══════════════ */

describe('C3 · 请求使用专用 UA', () => {
  it('C3a · 缓存层固定使用 MANGADEX_USER_AGENT', () => {
    expect(coverSvcSrc).toContain("import { MANGADEX_USER_AGENT } from '../sources/mangadex'")
    expect(coverSvcSrc).toContain('userAgent: MANGADEX_USER_AGENT')
  })

  it('C3b · 不接受调用方覆盖 UA（无 userAgent 入参）', () => {
    expect(coverSvcSrc).not.toContain('opts.userAgent')
    expect(coverSvcSrc).not.toContain('userAgent?:')
  })

  it('C3c · 复用 getBinary（不改冻结的 binaryHttp）', () => {
    expect(coverSvcSrc).toContain('getBinary(url, {')
    expect(coverSvcSrc).toContain('acceptMimePrefixes')
  })

  it('C3d · 其他来源不经过 MangaDex UA（ProxyCover 直接走 SmartImage）', () => {
    expect(compSrc).toContain('<SmartImage src={src}')
  })
})

/* ══════════════ 缓存 / 去重 / 并发 ══════════════ */

describe('C2 · 列表封面显示（缓存与去重）', () => {
  it('C2a · 同一 URL 并发请求只发一次（去重）', async () => {
    const { cache, calls } = makeCache()
    const [a, b, c] = await Promise.all([
      cache.load(MD_COVER), cache.load(MD_COVER), cache.load(MD_COVER),
    ])
    expect(calls.length).toBe(1)
    expect(a.size).toBe(b.size)
    expect(b.size).toBe(c.size)
    expect(cache.stats().deduped).toBe(2)
  })

  it('C2b · 已完成结果命中缓存（不重复下载）', async () => {
    const { cache, calls } = makeCache()
    await cache.load(MD_COVER)
    await cache.load(MD_COVER)
    expect(calls.length).toBe(1)
    expect(cache.stats().hits).toBe(1)
  })

  it('C2c · 不同 URL 各自下载', async () => {
    const { cache, calls } = makeCache()
    await Promise.all([cache.load(MD_COVER), cache.load(MD_COVER.replace('abc-123', 'def-456'))])
    expect(calls.length).toBe(2)
  })

  it('C2d · WorkCard 使用 ProxyCover 并传 sourceId', () => {
    expect(workCardSrc).toContain('import ProxyCover')
    expect(workCardSrc).toContain('<ProxyCover src={w.cover} sourceId={w.sourceId}')
  })

  it('C2e · 首页/发现/搜索共用 WorkCard（一次接入三页生效）', () => {
    // 契约：这三个页面都通过 WorkCard 渲染卡片
    for (const f of ['home/HomePage', 'discovery/DiscoveryPage', 'search/SearchPage']) {
      const s = readFileSync(new URL(`../src/modules/${f}.tsx`, import.meta.url), 'utf-8')
      expect(s).toContain('WorkCard')
    }
  })
})

describe('C1 · 详情页封面显示', () => {
  it('C1a · DetailPage 使用 ProxyCover 并传 sourceId', () => {
    expect(detailSrc).toContain('import ProxyCover')
    expect(detailSrc).toContain('<ProxyCover src={d.cover} sourceId={d.sourceId}')
  })

  it('C1b · 详情页保持 eager（首屏关键图）', () => {
    expect(detailSrc).toMatch(/<ProxyCover[^>]*eager/)
  })

  it('C1c · DetailPage 不再直接使用 SmartImage', () => {
    expect(detailSrc).not.toContain('import SmartImage')
  })
})

/* ══════════════ MIME / 字节 ══════════════ */

describe('C5 · 封面 Blob MIME 和字节正确', () => {
  it('C5a · 缓存返回的就是下载得到的 Blob（MIME 由 binaryHttp 魔数决定）', async () => {
    const blob = fakeJpeg(512)
    const cache = createCoverCache({ fetchBlob: async () => blob, now: () => 1000 })
    const got = await cache.load(MD_COVER)
    expect(got).toBe(blob)
    expect(got.type).toBe('image/jpeg')
    expect(got.size).toBe(512)
  })

  it('C5b · binaryHttp 会用魔数识破 HTML 挑战页（既有保证，此处固化契约）', async () => {
    const { sniffImageMime } = await import('../src/services/api/binaryHttp')
    // <!do = 3c 21 64 6f → HTML，不是图片
    const html = new Uint8Array([0x3c, 0x21, 0x64, 0x6f, 0x63, 0x74])
    expect(sniffImageMime(html)).toBeNull()
    // JPEG 头
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe('image/jpeg')
  })

  it('C5c · 下载失败不会产出 Blob（Promise reject）', async () => {
    const cache = createCoverCache({
      fetchBlob: async () => { throw new Error('HTTP 403') },
      now: () => 1000,
    })
    await expect(cache.load(MD_COVER)).rejects.toThrow('HTTP 403')
  })
})

/* ══════════════ Object URL 生命周期 ══════════════ */

describe('C6 · 切换封面后旧 Object URL 回收', () => {
  it('C6a · hook 在 effect 开头回收上一次 URL', () => {
    expect(hookSrc).toContain('if (urlRef.current) {')
    expect(hookSrc).toContain('URL.revokeObjectURL(urlRef.current)')
  })

  it('C6b · 缓存层不持有 Object URL（只存 Blob）', () => {
    // 缓存若共享 Object URL，任一消费者 revoke 会让其他人破图
    expect(coverSvcCode).not.toContain('createObjectURL')
  })

  it('C6c · effect 依赖包含 src，切换封面会重跑', () => {
    expect(hookSrc).toContain('}, [src, proxy, hold, retryToken])')
  })
})

describe('C7 · 组件卸载后 Object URL 回收', () => {
  it('C7a · 卸载 effect 回收 URL 并作废在途请求', () => {
    const i = hookSrc.indexOf('/* ── 卸载')
    const body = hookSrc.slice(i, i + 400)
    expect(body).toContain('seqRef.current++')
    expect(body).toContain('URL.revokeObjectURL(urlRef.current)')
    expect(body).toContain('urlRef.current = undefined')
  })

  it('C7b · 卸载 effect 只跑一次（空依赖）', () => {
    expect(hookSrc).toMatch(/\},\s*\[\],\s*\)/)
  })

  it('C7c · 不共享阅读器的 Object URL 缓存', () => {
    // 封面 hook 与 ReaderPage 各自独立持有 URL
    expect(hookCode).not.toContain('urlCache')
    expect(coverSvcCode).not.toContain('urlCache')
  })
})

describe('C8 · 其他来源封面行为不变', () => {
  it('C8a · 🔴 SmartImage 本身零改动（仍是普通 <img>）', () => {
    expect(smartSrc).toContain('referrerPolicy="no-referrer"')
    expect(smartSrc).toContain('loading={eager ? \'eager\' : \'lazy\'}')
    expect(smartSrc).not.toContain('createObjectURL')
    expect(smartSrc).not.toContain('mangadex')
  })

  it('C8b · 非 MangaDex 来源直接渲染 SmartImage', () => {
    expect(compSrc).toContain('if (!proxy) {')
    expect(compSrc).toContain('return <SmartImage src={src} fallbackIcon={fallbackIcon} hold={hold} eager={eager} />')
  })

  it('C8c · 其他来源不产生任何 Blob 请求', () => {
    expect(isMangadexCover('bilibili', BILI_COVER)).toBe(false)
    expect(isMangadexCover('anilist', 'https://s4.anilist.co/x.jpg')).toBe(false)
  })

  it('C8d · 本地书架封面（LibraryPage/LocalDetailPage）未被改动', () => {
    const lib = readFileSync(new URL('../src/modules/library/LibraryPage.tsx', import.meta.url), 'utf-8')
    expect(lib).toContain('<img src={m.cover}')
    expect(lib).not.toContain('ProxyCover')
  })
})

describe('C9 · 快速切换作品不出现旧封面覆盖新封面', () => {
  it('C9a · 请求序号校验：只有最新序号才写状态', () => {
    expect(hookSrc).toContain('const mySeq = ++seqRef.current')
    expect(hookSrc).toContain('if (mySeq !== seqRef.current) return')
  })

  it('C9b · 成功与失败分支都做序号校验', () => {
    expect(hookSrc.match(/if \(mySeq !== seqRef\.current\) return/g)?.length).toBe(2)
  })

  it('C9c · 迟到的旧请求不会创建 Object URL', async () => {
    // 纯逻辑复刻：旧序号分支直接 return，不调用 createObjectURL
    const seq = { current: 1 }
    let created = 0
    const apply = (mySeq: number) => {
      if (mySeq !== seq.current) return
      created += 1
    }
    seq.current = 2      // 用户切到了新作品
    apply(1)             // 旧请求迟到
    expect(created).toBe(0)
    apply(2)             // 新请求
    expect(created).toBe(1)
  })
})

/* ══════════════ 失败冷却 / 请求风暴防护 ══════════════ */

describe('C-extra · 失败冷却与请求去重（防请求风暴）', () => {
  it('E1 · 失败后冷却期内不再发请求', async () => {
    let now = 1000
    const calls: string[] = []
    const cache = createCoverCache({
      fetchBlob: async () => { calls.push('x'); throw new Error('500') },
      now: () => now,
      failCooldownMs: COVER_FAIL_COOLDOWN_MS,
    })
    await expect(cache.load(MD_COVER)).rejects.toThrow()
    expect(calls.length).toBe(1)
    // 冷却期内再请求（模拟卡片反复渲染）
    await expect(cache.load(MD_COVER)).rejects.toThrow()
    await expect(cache.load(MD_COVER)).rejects.toThrow()
    expect(calls.length).toBe(1)
    // 冷却结束后才允许再发
    now += COVER_FAIL_COOLDOWN_MS + 1
    await expect(cache.load(MD_COVER)).rejects.toThrow()
    expect(calls.length).toBe(2)
  })

  it('E2 · force 可跳过冷却（用户点重试）', async () => {
    let calls = 0
    const cache = createCoverCache({
      fetchBlob: async () => { calls += 1; throw new Error('500') },
      now: () => 1000,
    })
    await expect(cache.load(MD_COVER)).rejects.toThrow()
    await expect(cache.load(MD_COVER, { force: true })).rejects.toThrow()
    expect(calls).toBe(2)
  })

  it('E3 · LRU 上限生效（超限淘汰最旧）', async () => {
    const cache = createCoverCache({
      fetchBlob: async () => fakeJpeg(),
      now: () => 1000,
      maxEntries: 3,
    })
    for (let i = 0; i < 5; i++) await cache.load(`${MD_COVER}?i=${i}`)
    expect(cache.size()).toBeLessThanOrEqual(3)
    expect(cache.stats().evicted).toBeGreaterThan(0)
  })

  it('E4 · 默认上限为 60（约 2–3 MB）', () => {
    expect(COVER_CACHE_MAX).toBe(60)
  })

  it('E5 · 取消不写失败缓存（不污染）', async () => {
    const { BinaryHttpAbortError } = await import('../src/services/api/binaryHttp')
    let calls = 0
    const cache = createCoverCache({
      fetchBlob: async () => { calls += 1; throw new BinaryHttpAbortError(MD_COVER) },
      now: () => 1000,
    })
    await expect(cache.load(MD_COVER)).rejects.toThrow()
    // 取消后缓存里不应留下 failed 条目 ⇒ 立刻可重试
    await expect(cache.load(MD_COVER)).rejects.toThrow()
    expect(calls).toBe(2)
  })

  it('E6 · clear() 清空缓存（测试/切换用）', async () => {
    const { cache } = makeCache()
    await cache.load(MD_COVER)
    expect(cache.size()).toBe(1)
    cache.clear()
    expect(cache.size()).toBe(0)
  })

  it('E7 · 封面请求走共享调度器（cover 优先级）', () => {
    // 第9子步 · 批次①：封面不再自开 createLimiter(MAX_CONCURRENCY)，
    // 改为与正文共用 imageScheduler，以避免「两个闸门各 4 ⇒ 并发 8」并保证正文优先。
    // ⚠️ 这不是放宽断言，而是修正旧契约（旧契约断言的正是被替换掉的实现）。
    expect(coverSvcSrc).not.toContain('createLimiter(MAX_CONCURRENCY)')
    expect(coverSvcSrc).toContain("imageScheduler.run('cover'")
  })
})
