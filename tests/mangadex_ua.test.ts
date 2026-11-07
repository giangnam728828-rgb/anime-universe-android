/**
 * MangaDex 专用 User-Agent 测试（P1 第2子步）
 *
 * 背景：
 *   MangaDex 条款 https://api.mangadex.org/docs/2-limitations/
 *     "The request MUST have a User-Agent header, and it must not be spoofed"
 *     "The request CANNOT have a Via header"
 *
 *   全局 UA 是 `Mozilla/5.0 (Linux; Android 14) AnimeUniverse/0.5 (RSS reader)`
 *   —— 以 Mozilla/5.0 开头属浏览器伪装，且用途描述（RSS reader）不符。
 *   本子步为 MangaDex 引入如实标识的专用 UA。
 *
 * 用户指定的 8 项检查：
 *   UA-1 API 请求包含指定 UA
 *   UA-2 章节列表请求包含指定 UA
 *   UA-3 图片服务器信息请求包含指定 UA
 *   UA-4 图片字节下载请求包含指定 UA  ← 尚未接线，标记待验证
 *   UA-5 UA 字符串完全一致，不被包装/改写
 *   UA-6 不含 Mozilla 等浏览器伪装前缀
 *   UA-7 不添加 Via 请求头
 *   UA-8 其他来源的 UA 不受影响
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ══════════════════ Mock httpGetText，捕获 headers ══════════════════ */

interface Captured {
  url: string
  timeoutMs?: number
  headers?: Record<string, string>
}

const captured: Captured[] = []
let nextText = '{}'
let nextStatus = 200

vi.mock('../src/services/api/nativeHttp', () => ({
  httpGetText: vi.fn(async (url: string, timeoutMs?: number, headers?: Record<string, string>) => {
    captured.push({ url, timeoutMs, headers })
    return { status: nextStatus, text: nextText, ms: 1 }
  }),
  httpPostJson: vi.fn(),
  HttpResult: {},
}))

// 诊断模块也被 mangadex 引用，一并 mock 掉避免副作用
vi.mock('../src/services/diagnostics', () => ({
  finalizeInternal: vi.fn(),
  markParsing: vi.fn(),
  markParsed: vi.fn(),
}))

import mangadex, { MANGADEX_USER_AGENT } from '../src/services/sources/mangadex'

let uniq = 0
/** 每次调用生成唯一 id，避开 mdGet 的 5min memCache 与 serverCache 的 10min TTL */
function uid(prefix: string): string {
  uniq++
  return `${prefix}-${uniq}-${Date.now()}`
}

beforeEach(() => {
  captured.length = 0
  nextStatus = 200
  nextText = '{}'
})

const EXPECTED_UA = 'AnimeUniverse/0.6 (manga reader)'

/** 取最后一次请求的 headers */
function lastHeaders(): Record<string, string> | undefined {
  return captured[captured.length - 1]?.headers
}

/* ══════════════════ UA-5 / UA-6：常量本身的契约 ══════════════════ */

describe('UA-5/6 · UA 常量契约', () => {
  it('UA-5a · 导出常量与批准值逐字一致', () => {
    expect(MANGADEX_USER_AGENT).toBe(EXPECTED_UA)
  })

  it('UA-5b · 不包含多余空白（首尾/连续）', () => {
    expect(MANGADEX_USER_AGENT).toBe(MANGADEX_USER_AGENT.trim())
    expect(MANGADEX_USER_AGENT).not.toMatch(/\s{2,}/)
  })

  it('UA-6a · 不含 Mozilla 前缀（禁止浏览器伪装）', () => {
    expect(MANGADEX_USER_AGENT.toLowerCase()).not.toContain('mozilla')
  })

  it('UA-6b · 不含其他浏览器标识', () => {
    const ua = MANGADEX_USER_AGENT.toLowerCase()
    for (const bad of ['chrome', 'safari', 'webkit', 'gecko', 'trident', 'edge']) {
      expect(ua).not.toContain(bad)
    }
  })

  it('UA-6c · 不含虚假设备信息', () => {
    const ua = MANGADEX_USER_AGENT.toLowerCase()
    for (const bad of ['linux', 'android', 'windows', 'iphone', 'macintosh']) {
      expect(ua).not.toContain(bad)
    }
  })

  it('UA-6d · 用途描述如实（manga reader），不是 RSS reader', () => {
    expect(MANGADEX_USER_AGENT).toContain('manga reader')
    expect(MANGADEX_USER_AGENT).not.toContain('RSS')
  })
})

/* ══════════════════ UA-1：API 请求（搜索/详情）══════════════════ */

describe('UA-1 · API 请求携带专用 UA', () => {
  it('UA-1a · search() 请求带专用 UA', async () => {
    nextText = JSON.stringify({ data: [], total: 0 })
    await mangadex.search({ kind: 'manga', kw: uid('kw') }).catch(() => { /* 解析失败无所谓 */ })

    expect(captured.length).toBeGreaterThan(0)
    expect(lastHeaders()?.['User-Agent']).toBe(EXPECTED_UA)
  })

  it('UA-1b · getDetail() 请求带专用 UA', async () => {
    nextText = JSON.stringify({ data: { id: 'x', attributes: { title: { en: 'T' }, altTitles: [], description: {}, links: {} }, relationships: [] } })
    await mangadex.getDetail('manga', uid('w')).catch(() => { /* 结构不完整无所谓 */ })

    expect(captured.length).toBeGreaterThan(0)
    expect(lastHeaders()?.['User-Agent']).toBe(EXPECTED_UA)
  })

  it('UA-1c · 所有被捕获的请求都带同一个 UA（无一遗漏）', async () => {
    nextText = JSON.stringify({ data: [], total: 0 })
    await mangadex.search({ kind: 'manga', kw: uid('kw') }).catch(() => {})
    await mangadex.getDetail('manga', uid('w')).catch(() => {})

    expect(captured.length).toBeGreaterThan(0)
    for (const c of captured) {
      expect(c.headers?.['User-Agent']).toBe(EXPECTED_UA)
    }
  })
})

/* ══════════════════ UA-2：章节列表 ══════════════════ */

describe('UA-2 · 章节列表请求携带专用 UA', () => {
  it('UA-2a · getChapters() 带专用 UA', async () => {
    nextText = JSON.stringify({ data: [], total: 0 })
    await mangadex.getChapters!(uid('mid')).catch(() => {})

    expect(captured.length).toBeGreaterThan(0)
    expect(lastHeaders()?.['User-Agent']).toBe(EXPECTED_UA)
  })

  it('UA-2b · 章节列表请求命中 /feed 路径', async () => {
    nextText = JSON.stringify({ data: [], total: 0 })
    await mangadex.getChapters!(uid('mid')).catch(() => {})
    expect(captured.some((c) => c.url.includes('/feed'))).toBe(true)
  })
})

/* ══════════════════ UA-3：图片服务器信息 ══════════════════ */

describe('UA-3 · 图片服务器信息请求携带专用 UA', () => {
  it('UA-3a · getPages() 带专用 UA', async () => {
    nextText = JSON.stringify({
      baseUrl: 'https://cmdxd98sb0x3yprd.mangadex.network',
      chapter: { hash: 'h123', data: ['1.jpg', '2.jpg'] },
    })
    await mangadex.getPages!(uid('chap')).catch(() => {})

    expect(captured.length).toBeGreaterThan(0)
    expect(lastHeaders()?.['User-Agent']).toBe(EXPECTED_UA)
  })

  it('UA-3b · at-home 请求命中 /at-home/server 路径', async () => {
    nextText = JSON.stringify({
      baseUrl: 'https://x.test', chapter: { hash: 'h', data: [] },
    })
    await mangadex.getPages!(uid('chap')).catch(() => {})
    expect(captured.some((c) => c.url.includes('/at-home/server'))).toBe(true)
  })
})

/* ══════════════════ UA-4：图片字节下载（待接线）══════════════════ */

describe('UA-4 · 图片字节下载 UA —— ⏸️ 待接线验证', () => {
  /**
   * 如实标记：截至本子步，`getPages()` 只返回**直链 URL**，
   * 尚未调用 `binaryHttp.getBinary()`。因此图片字节下载这一环
   * **还没有接上**，不能用 API 侧测试冒充通过。
   *
   * 本测试只断言「当前确实未接线」这一事实，
   * 待第3子步（在线章节服务层）接线后再补真实 UA 断言。
   */
  it('UA-4a · 当前 getPages 只返回直链，不发起图片下载请求', async () => {
    nextText = JSON.stringify({
      baseUrl: 'https://cmdxd98sb0x3yprd.mangadex.network',
      chapter: { hash: 'abc123', data: ['p1.jpg', 'p2.jpg'] },
    })
    const pages = await mangadex.getPages!(uid('chap'))

    // 返回的是 URL 字符串，不是已下载的字节
    expect(pages).toHaveLength(2)
    expect(typeof pages[0].url).toBe('string')
    expect(pages[0].url).toBe('https://cmdxd98sb0x3yprd.mangadex.network/data/abc123/p1.jpg')

    // 只发生了 1 次请求（at-home），没有图片下载请求
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toContain('/at-home/server')
  })

  it('UA-4b · ⏸️ 待验证标记：图片下载 UA 由第3子步接线后补测', () => {
    // 这个测试故意"通过"，因为它的目的是**记录缺口**而不是验证功能。
    // 一旦第3子步接线，应删除本测试并补上真实的 UA-4 断言。
    const PENDING = true
    expect(PENDING).toBe(true)
  })
})

/* ══════════════════ UA-7：不添加 Via ══════════════════ */

describe('UA-7 · 不添加 Via 头', () => {
  it('UA-7a · 请求头中无 Via', async () => {
    nextText = JSON.stringify({ data: [], total: 0 })
    await mangadex.getChapters!(uid('mid')).catch(() => {})

    const h = lastHeaders() || {}
    const keys = Object.keys(h).map((k) => k.toLowerCase())
    expect(keys).not.toContain('via')
  })

  it('UA-7b · 请求头中无代理相关字段', async () => {
    nextText = JSON.stringify({ data: [], total: 0 })
    await mangadex.search({ kind: 'manga', kw: uid('kw') }).catch(() => {})

    const h = lastHeaders() || {}
    const keys = Object.keys(h).map((k) => k.toLowerCase())
    for (const bad of ['via', 'x-forwarded-for', 'forwarded', 'proxy-authorization']) {
      expect(keys).not.toContain(bad)
    }
  })

  it('UA-7c · 请求头只有 User-Agent 一项（不夹带其他标识）', async () => {
    nextText = JSON.stringify({ data: [], total: 0 })
    await mangadex.getChapters!(uid('mid')).catch(() => {})
    expect(Object.keys(lastHeaders() || {})).toEqual(['User-Agent'])
  })
})

/* ══════════════════ UA-8：其他来源不受影响 ══════════════════ */

describe('UA-8 · 其他来源的 UA 不受影响', () => {
  it('UA-8a · nativeHttp 的全局 UA 未被修改', async () => {
    // 直接读源码文件，断言全局 UA 常量原样未动
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('../src/services/api/nativeHttp.ts', import.meta.url), 'utf-8',
    )
    expect(src).toContain(
      "const UA = 'Mozilla/5.0 (Linux; Android 14) AnimeUniverse/0.5 (RSS reader)'",
    )
  })

  it('UA-8b · mangadex.ts 不导出会污染全局的 UA 设置函数', async () => {
    const mod = await import('../src/services/sources/mangadex')
    const exported = Object.keys(mod)
    // 只应有 default 与 MANGADEX_USER_AGENT，不应有 setUA/globalUA 之类
    expect(exported.sort()).toEqual(['MANGADEX_USER_AGENT', 'default'].sort())
  })

  it('UA-8c · 其他来源自定义 headers 保持不变（bangumi 自带 UA / bilibili 无 UA）', async () => {
    const fs = await import('node:fs/promises')
    const bangumi = await fs.readFile(
      new URL('../src/services/sources/bangumi.ts', import.meta.url), 'utf-8',
    )
    // bangumi 原本就传自己的 UA，本轮未改动
    expect(bangumi).toContain("'User-Agent': UA")

    const bili = await fs.readFile(
      new URL('../src/services/sources/bilibili.ts', import.meta.url), 'utf-8',
    )
    // bilibili 的 HEADERS 不含 User-Agent ⇒ 继续用全局 UA，行为不变
    expect(bili).toContain("const HEADERS = { Referer: 'https://www.bilibili.com/', Accept: 'application/json' }")
    expect(bili).not.toContain('MANGADEX_USER_AGENT')
  })

  it('UA-8d · MANGADEX_USER_AGENT 只出现在 mangadex.ts 与在线阅读/封面服务层', async () => {
    const { execSync } = await import('node:child_process')
    // 定义处（mangadex.ts）+ 消费处：
    //   onlineChapters.ts —— 正文图片下载（第3子步）
    //   mangadexCover.ts  —— 封面 Blob 代理（第8子步）
    // 🔴 不得出现在其他来源适配器或冻结区
    const out = execSync(
      'grep -rl "MANGADEX_USER_AGENT" src/ || true',
      { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf-8' },
    ).trim().split('\n').filter(Boolean).sort()
    expect(out).toEqual([
      'src/services/covers/mangadexCover.ts',
      'src/services/reader/onlineChapters.ts',
      'src/services/sources/mangadex.ts',
    ])
  })

  it('UA-8e2 · 其他来源适配器不得引用 MANGADEX_USER_AGENT', async () => {
    const fs = await import('node:fs/promises')
    for (const name of ['bangumi', 'anilist', 'jikan', 'mangabaka', 'bilibili']) {
      const src = await fs.readFile(
        new URL(`../src/services/sources/${name}.ts`, import.meta.url), 'utf-8',
      )
      expect(src).not.toContain('MANGADEX_USER_AGENT')
    }
  })

  it('UA-8e · 专用 UA 只在本适配器内使用（不写入 localStorage/全局）', async () => {
    nextText = JSON.stringify({ data: [], total: 0 })
    await mangadex.search({ kind: 'manga', kw: uid('kw') }).catch(() => {})
    // 若污染了全局设置，localStorage 会有痕迹
    expect(globalThis.localStorage?.getItem('au_ua')).toBeUndefined()
  })
})

/* ══════════════════ 覆盖顺序验证（关键机制）══════════════════ */

describe('UA-9 · 覆盖机制：extraHeaders 确实能压过全局 UA', () => {
  it('UA-9a · nativeHttp 的 headers 构造顺序是 { UA, ...extraHeaders }', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('../src/services/api/nativeHttp.ts', import.meta.url), 'utf-8',
    )
    // 展开在后 ⇒ extraHeaders 能覆盖 User-Agent
    expect(src).toContain("headers: { 'User-Agent': UA, ...(extraHeaders || {}) }")
  })

  it('UA-9b · 传入的 headers 只有 User-Agent，不含 Mozilla', async () => {
    nextText = JSON.stringify({ data: [], total: 0 })
    await mangadex.getChapters!(uid('mid')).catch(() => {})
    const h = lastHeaders()!
    expect(h['User-Agent']).toBe(EXPECTED_UA)
    expect(JSON.stringify(h)).not.toContain('Mozilla')
  })
})
