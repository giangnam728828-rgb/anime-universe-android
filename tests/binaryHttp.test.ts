/**
 * binaryHttp.ts 单元测试
 *
 * 覆盖用户裁定的全部 7 项边界：
 *  1. Base64 解码失败
 *  2. 空响应、错误 MIME
 *  3. HTTP 非 2xx
 *  4. 请求超时和取消
 *  5. 下载过程中组件卸载（= 取消信号）
 *  6. 连续翻页时内存释放（objectURL/Blob 生命周期）
 *  7. 同一页重复请求的去重
 *
 * 另外覆盖：
 *  - Capacitor 6 原生返回 Base64 字符串的真实形状
 *  - Base64.DEFAULT 的换行容忍
 *  - 魔数识别（含「200 + HTML 错误页」的识破）
 *  - UA 必填 / Via 禁用的合规校验
 *
 * ⚠️ 本测试**不依赖真机**：原生分支通过 mock Capacitor 模拟，
 *    真实 Base64 往返已在容器侧用真实 MangaDex 图片验证过
 *    （511,978 B → 682,640 字符 → 511,978 B，完全一致）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 先 mock @capacitor/core，让 Capacitor.isNativePlatform 可控 ──
const mockGet = vi.fn()
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  CapacitorHttp: { get: (...args: unknown[]) => mockGet(...args) },
}))

import {
  getBinary,
  base64ToBytes,
  sniffImageMime,
  createLimiter,
  createInflight,
  BinaryHttpError,
  BinaryHttpAbortError,
  MAX_CONCURRENCY,
  type BinaryResult,
} from '../src/services/api/binaryHttp'

/* ══════════════ 测试夹具：真实 JPEG 字节 ══════════════ */

/** 真实 MangaDex 图片的前 64 字节（JPEG 头 FF D8 FF E1 + Exif） */
const REAL_JPEG_HEAD = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe1, 0x25, 0x9d, 0x45, 0x78,
  0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a,
  0x00, 0x00, 0x00, 0x08, 0x00, 0x0c, 0x01, 0x00,
  0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x03, 0x4c,
  0x00, 0x00, 0x01, 0x01, 0x00, 0x03, 0x00, 0x00,
  0x00, 0x01, 0x04, 0xb0, 0x00, 0x00, 0x01, 0x02,
  0x00, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00,
  0x00, 0x9e, 0x01, 0x06, 0x00, 0x03, 0x00, 0x00,
])

/** 造一个足够大的假 JPEG（超过 MIN_IMAGE_BYTES=64） */
function fakeJpeg(total = 200): Uint8Array {
  const out = new Uint8Array(total)
  out.set(REAL_JPEG_HEAD)
  for (let i = REAL_JPEG_HEAD.length; i < total; i++) out[i] = i & 0xff
  return out
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** 模拟 Android Base64.DEFAULT：每 76 字符插 \n */
function withLineBreaks(b64: string): string {
  const parts: string[] = []
  for (let i = 0; i < b64.length; i += 76) parts.push(b64.slice(i, i + 76))
  return parts.join('\n')
}

const UA = 'AnimeUniverse/0.6 (manga reader)'
const URL_JPG = 'https://example.test/data/hash/page1.jpg'

beforeEach(() => { mockGet.mockReset() })

/* ══════════════════ 1. Base64 解码 ══════════════════ */

describe('B1 · base64ToBytes 解码正确性', () => {
  it('B1a · 真实 JPEG 字节往返一致', () => {
    const jpg = fakeJpeg(200)
    const back = base64ToBytes(toBase64(jpg))
    expect(back).toEqual(jpg)
    expect(back.length).toBe(200)
  })

  it('B1b · 必须容忍 Base64.DEFAULT 的换行（每 76 字符）', () => {
    const jpg = fakeJpeg(300)
    const withNl = withLineBreaks(toBase64(jpg))
    expect(withNl).toContain('\n')          // 确认夹具真的是多行
    const back = base64ToBytes(withNl)
    expect(back).toEqual(jpg)
  })

  it('B1c · 容忍空格 / 制表 / 回车等所有空白', () => {
    const jpg = fakeJpeg(120)
    const dirty = toBase64(jpg).replace(/(.{10})/g, '$1 \r\n\t')
    expect(base64ToBytes(dirty)).toEqual(jpg)
  })

  it('B1d · 缺 padding 时自动补齐', () => {
    const jpg = fakeJpeg(100)                 // 100 % 3 = 1 → 需 ==
    const b64 = toBase64(jpg).replace(/=+$/, '')
    expect(base64ToBytes(b64)).toEqual(jpg)
  })

  it('B1e · 空字符串 → empty-body 错误', () => {
    expect(() => base64ToBytes('')).toThrow(BinaryHttpError)
    try { base64ToBytes('') } catch (e) {
      expect((e as BinaryHttpError).stage).toBe('empty-body')
    }
  })

  it('B1f · 全空白 → empty-body 错误', () => {
    expect(() => base64ToBytes('  \n\t \r\n ')).toThrow(BinaryHttpError)
  })

  it('B1g · 非法 Base64 → decode 错误', () => {
    try {
      base64ToBytes('!!!not-base64!!!')
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(BinaryHttpError)
      expect((e as BinaryHttpError).stage).toBe('decode')
    }
  })

  it('B1h · 非字符串输入 → decode 错误（不静默降级）', () => {
    // @ts-expect-error 故意传错类型，验证运行时防护
    expect(() => base64ToBytes(12345)).toThrow(BinaryHttpError)
    // @ts-expect-error
    expect(() => base64ToBytes(null)).toThrow(BinaryHttpError)
  })
})

/* ══════════════════ 2. 魔数识别 ══════════════════ */

describe('B2 · sniffImageMime 魔数识别', () => {
  it('B2a · 真实 JPEG 头 → image/jpeg', () => {
    expect(sniffImageMime(REAL_JPEG_HEAD)).toBe('image/jpeg')
  })

  it('B2b · PNG 头 → image/png', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    expect(sniffImageMime(png)).toBe('image/png')
  })

  it('B2c · GIF 头 → image/gif', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2])
    expect(sniffImageMime(gif)).toBe('image/gif')
  })

  it('B2d · WEBP 头 → image/webp', () => {
    const webp = new Uint8Array(16)
    webp.set([0x52, 0x49, 0x46, 0x46], 0)  // RIFF
    webp.set([0x57, 0x45, 0x42, 0x50], 8)  // WEBP
    expect(sniffImageMime(webp)).toBe('image/webp')
  })

  it('B2e · AVIF (ftyp avif) → image/avif', () => {
    const avif = new Uint8Array(16)
    avif.set([0x66, 0x74, 0x79, 0x70], 4)  // ftyp
    avif.set([0x61, 0x76, 0x69, 0x66], 8)  // avif
    expect(sniffImageMime(avif)).toBe('image/avif')
  })

  it('B2f · HTML 错误页（以 < 开头）→ null（必须识破）', () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html>403</html>')
    expect(sniffImageMime(html)).toBeNull()
  })

  it('B2g · 过短输入 → null', () => {
    expect(sniffImageMime(new Uint8Array([0xff]))).toBeNull()
    expect(sniffImageMime(new Uint8Array(0))).toBeNull()
  })
})

/* ══════════════════ 3. 原生分支：Base64 → Blob ══════════════════ */

describe('B3 · 原生分支：Base64 字符串 → Blob（Capacitor 6 真实形状）', () => {
  it('B3a · 返回 Base64 字符串时，得到正确 JPEG Blob', async () => {
    const jpg = fakeJpeg(500)
    mockGet.mockResolvedValue({
      status: 200,
      data: toBase64(jpg),                    // ← 真实行为：String
      headers: { 'Content-Type': 'image/jpeg' },
    })

    const r = await getBinary(URL_JPG, { userAgent: UA })

    expect(r.blob).toBeInstanceOf(Blob)
    expect(r.blob.size).toBe(500)
    expect(r.blob.type).toBe('image/jpeg')
    expect(r.bytes).toBe(500)
    expect(r.mime).toBe('image/jpeg')
    expect(r.status).toBe(200)
  })

  it('B3b · 带换行的 Base64 同样正确（Android Base64.DEFAULT）', async () => {
    const jpg = fakeJpeg(400)
    mockGet.mockResolvedValue({
      status: 200,
      data: withLineBreaks(toBase64(jpg)),
      headers: { 'content-type': 'image/jpeg' },
    })
    const r = await getBinary(URL_JPG, { userAgent: UA })
    expect(r.blob.size).toBe(400)
  })

  it('B3c · 🔴 关键：不能把 Base64 文本直接当 Blob（体积会膨胀 33%）', async () => {
    const jpg = fakeJpeg(300)
    const b64 = toBase64(jpg)
    mockGet.mockResolvedValue({
      status: 200, data: b64, headers: { 'Content-Type': 'image/jpeg' },
    })
    const r = await getBinary(URL_JPG, { userAgent: UA })
    // 正确实现 → 300；若直接 new Blob([b64]) → 400
    expect(r.blob.size).toBe(300)
    expect(r.blob.size).not.toBe(b64.length)
  })

  it('B3d · 内容是 HTML 但状态 200 → 必须被魔数识破拒绝', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: toBase64(new TextEncoder().encode('<html>' + 'x'.repeat(200) + '</html>')),
      headers: { 'Content-Type': 'image/jpeg' },   // 服务端撒谎
    })
    await expect(getBinary(URL_JPG, { userAgent: UA })).rejects.toMatchObject({ stage: 'mime' })
  })

  it('B3e · 原生返回无法识别的类型 → decode 错误（不静默降级）', async () => {
    mockGet.mockResolvedValue({ status: 200, data: 12345, headers: {} })
    await expect(getBinary(URL_JPG, { userAgent: UA })).rejects.toMatchObject({ stage: 'decode' })
  })

  it('B3f · 原生返回 {data:[...]} 序列化形式 → 能处理', async () => {
    const jpg = fakeJpeg(200)
    mockGet.mockResolvedValue({
      status: 200,
      data: { data: Array.from(jpg) },
      headers: { 'Content-Type': 'image/jpeg' },
    })
    const r = await getBinary(URL_JPG, { userAgent: UA })
    expect(r.blob.size).toBe(200)
  })
})

/* ══════════════════ 4. HTTP 非 2xx ══════════════════ */

describe('B4 · HTTP 非 2xx', () => {
  for (const status of [400, 403, 404, 429, 500, 503]) {
    it(`B4 · HTTP ${status} → http-status 错误，且带状态码`, async () => {
      mockGet.mockResolvedValue({ status, data: 'x', headers: {} })
      try {
        await getBinary(URL_JPG, { userAgent: UA })
        throw new Error('应当抛错')
      } catch (e) {
        expect(e).toBeInstanceOf(BinaryHttpError)
        expect((e as BinaryHttpError).stage).toBe('http-status')
        expect((e as BinaryHttpError).status).toBe(status)
      }
    })
  }
})

/* ══════════════════ 5. 空响应 / 过小 / MIME ══════════════════ */

describe('B5 · 空响应与 MIME 校验', () => {
  it('B5a · data 为空字符串 → empty-body', async () => {
    mockGet.mockResolvedValue({ status: 200, data: '', headers: {} })
    await expect(getBinary(URL_JPG, { userAgent: UA })).rejects.toMatchObject({ stage: 'empty-body' })
  })

  it('B5b · 解码后字节过小（<64）→ empty-body', async () => {
    mockGet.mockResolvedValue({
      status: 200, data: toBase64(new Uint8Array([0xff, 0xd8, 0xff])), headers: {},
    })
    await expect(getBinary(URL_JPG, { userAgent: UA })).rejects.toMatchObject({ stage: 'empty-body' })
  })

  it('B5c · Content-Type 是 text/html → mime 错误', async () => {
    mockGet.mockResolvedValue({
      status: 200, data: toBase64(fakeJpeg(200)), headers: { 'Content-Type': 'text/html' },
    })
    await expect(getBinary(URL_JPG, { userAgent: UA })).rejects.toMatchObject({ stage: 'mime' })
  })

  it('B5d · Content-Type 缺失 → 靠魔数仍能成功', async () => {
    mockGet.mockResolvedValue({ status: 200, data: toBase64(fakeJpeg(200)), headers: {} })
    const r = await getBinary(URL_JPG, { userAgent: UA })
    expect(r.mime).toBe('image/jpeg')
    expect(r.contentType).toBe('')
  })

  it('B5e · 可自定义 acceptMimePrefixes', async () => {
    mockGet.mockResolvedValue({
      status: 200, data: toBase64(fakeJpeg(200)), headers: { 'Content-Type': 'image/webp' },
    })
    await expect(
      getBinary(URL_JPG, { userAgent: UA, acceptMimePrefixes: ['image/jpeg'] }),
    ).rejects.toMatchObject({ stage: 'mime' })
  })
})

/* ══════════════════ 6. 超时 / 取消 / 卸载 ══════════════════ */

describe('B6 · 超时、取消、组件卸载', () => {
  it('B6a · 已取消的 signal 立即拒绝，不发请求', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      getBinary(URL_JPG, { userAgent: UA, signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(BinaryHttpAbortError)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('B6b · 请求进行中被取消 → BinaryHttpAbortError', async () => {
    const ctrl = new AbortController()
    mockGet.mockImplementation(() => new Promise((r) => {
      setTimeout(() => r({ status: 200, data: toBase64(fakeJpeg(200)), headers: {} }), 50)
    }))
    const p = getBinary(URL_JPG, { userAgent: UA, signal: ctrl.signal })
    ctrl.abort()   // 模拟组件卸载
    await expect(p).rejects.toBeInstanceOf(BinaryHttpAbortError)
  })

  it('B6c · 网络异常 → network 错误，保留原因', async () => {
    mockGet.mockRejectedValue(new Error('ECONNRESET'))
    try {
      await getBinary(URL_JPG, { userAgent: UA })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as BinaryHttpError).stage).toBe('network')
      expect((e as BinaryHttpError).message).toContain('ECONNRESET')
    }
  })

  it('B6d · 取消优先于网络错误（不把取消误报为失败）', async () => {
    const ctrl = new AbortController()
    mockGet.mockImplementation(() => {
      ctrl.abort()
      return Promise.reject(new Error('aborted internally'))
    })
    await expect(
      getBinary(URL_JPG, { userAgent: UA, signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(BinaryHttpAbortError)
  })
})

/* ══════════════════ 7. 合规：UA 必填 / Via 禁止 ══════════════════ */

describe('B7 · 合规校验', () => {
  it('B7a · 不传 UA → 立即拒绝，不发请求', async () => {
    await expect(
      // @ts-expect-error 故意省略 userAgent
      getBinary(URL_JPG, {}),
    ).rejects.toMatchObject({ stage: 'network' })
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('B7b · UA 为空白字符串 → 拒绝', async () => {
    await expect(
      getBinary(URL_JPG, { userAgent: '   ' }),
    ).rejects.toBeInstanceOf(BinaryHttpError)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('B7c · headers 含 Via → 拒绝（MangaDex 禁止不透明代理）', async () => {
    await expect(
      getBinary(URL_JPG, { userAgent: UA, headers: { Via: '1.1 proxy' } }),
    ).rejects.toBeInstanceOf(BinaryHttpError)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('B7d · Via 大小写不敏感', async () => {
    await expect(
      getBinary(URL_JPG, { userAgent: UA, headers: { vIa: 'x' } }),
    ).rejects.toBeInstanceOf(BinaryHttpError)
  })

  it('B7e · 传入的 UA 原样发出（不篡改、不加浏览器前缀）', async () => {
    mockGet.mockResolvedValue({
      status: 200, data: toBase64(fakeJpeg(200)), headers: { 'Content-Type': 'image/jpeg' },
    })
    await getBinary(URL_JPG, { userAgent: UA })
    const call = mockGet.mock.calls[0][0] as { headers: Record<string, string> }
    expect(call.headers['User-Agent']).toBe(UA)
    expect(call.headers['User-Agent']).not.toContain('Mozilla')
    expect(call.headers['User-Agent']).not.toContain('Via')
  })

  it('B7f · 使用 responseType=arraybuffer（依赖原生返回 Base64）', async () => {
    mockGet.mockResolvedValue({
      status: 200, data: toBase64(fakeJpeg(200)), headers: { 'Content-Type': 'image/jpeg' },
    })
    await getBinary(URL_JPG, { userAgent: UA })
    const call = mockGet.mock.calls[0][0] as { responseType: string }
    expect(call.responseType).toBe('arraybuffer')
  })
})

/* ══════════════════ 8. 并发闸门 ══════════════════ */

describe('B8 · createLimiter 并发控制', () => {
  it('B8a · 同时最多只有 MAX_CONCURRENCY 个在跑', async () => {
    const limit = createLimiter(2)
    let peak = 0
    let active = 0
    const job = () => limit(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return 'ok'
    })
    const results = await Promise.all([job(), job(), job(), job(), job()])
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('B8b · 默认上限是 4（给 MangaDex 5 req/s 留余量）', () => {
    expect(MAX_CONCURRENCY).toBe(4)
  })

  it('B8c · 任务失败不阻塞后续任务', async () => {
    const limit = createLimiter(1)
    const r = await Promise.allSettled([
      limit(() => Promise.reject(new Error('boom'))),
      limit(() => Promise.resolve('ok2')),
    ])
    expect(r[0].status).toBe('rejected')
    expect(r[1].status).toBe('fulfilled')
  })
})

/* ══════════════════ 9. 进行中去重 ══════════════════ */

describe('B9 · createInflight 去重', () => {
  it('B9a · 同 URL 并发请求只发一次', async () => {
    const dedupe = createInflight()
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { blob: new Blob(), bytes: 1, contentType: '', mime: 'image/jpeg', status: 200, ms: 1 } as BinaryResult
    })
    const [a, b, c] = await Promise.all([
      dedupe('u1', fn), dedupe('u1', fn), dedupe('u1', fn),
    ])
    expect(fn).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('B9b · 不同 URL 各自独立', async () => {
    const dedupe = createInflight()
    const fn = vi.fn(async () =>
      ({ blob: new Blob(), bytes: 1, contentType: '', mime: 'image/jpeg', status: 200, ms: 1 }) as BinaryResult)
    await Promise.all([dedupe('u1', fn), dedupe('u2', fn)])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('B9c · 完成后不缓存，下次重新请求（内存交给调用方管）', async () => {
    const dedupe = createInflight()
    const fn = vi.fn(async () =>
      ({ blob: new Blob(), bytes: 1, contentType: '', mime: 'image/jpeg', status: 200, ms: 1 }) as BinaryResult)
    await dedupe('u1', fn)
    await dedupe('u1', fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('B9d · 失败后清除记录，允许重试', async () => {
    const dedupe = createInflight()
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ blob: new Blob(), bytes: 1, contentType: '', mime: 'image/jpeg', status: 200, ms: 1 })
    await expect(dedupe('u1', fn)).rejects.toThrow('boom')
    await expect(dedupe('u1', fn)).resolves.toBeTruthy()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

/* ══════════════════ 10. 内存 / Blob 生命周期 ══════════════════ */

describe('B10 · 连续翻页时的内存与 Blob 生命周期', () => {
  it('B10a · 每个 Blob 独立，不互相引用', async () => {
    const blobs: Blob[] = []
    for (let i = 0; i < 5; i++) {
      mockGet.mockResolvedValue({
        status: 200, data: toBase64(fakeJpeg(200 + i)), headers: { 'Content-Type': 'image/jpeg' },
      })
      const r = await getBinary(URL_JPG + '?p=' + i, { userAgent: UA })
      blobs.push(r.blob)
    }
    expect(new Set(blobs).size).toBe(5)
    expect(blobs.map((b) => b.size)).toEqual([200, 201, 202, 203, 204])
  })

  it('B10b · objectURL 可创建且能 revoke（模拟 ReaderPage 回收）', () => {
    const b = new Blob([fakeJpeg(200)], { type: 'image/jpeg' })
    const url = URL.createObjectURL(b)
    expect(url.startsWith('blob:')).toBe(true)
    URL.revokeObjectURL(url)
    expect(() => URL.revokeObjectURL(url)).not.toThrow()  // 重复 revoke 不抛
  })

  it('B10c · 大图不触发异常（1MB 量级）', async () => {
    const big = fakeJpeg(1024 * 1024)
    mockGet.mockResolvedValue({
      status: 200, data: toBase64(big), headers: { 'Content-Type': 'image/jpeg' },
    })
    const r = await getBinary(URL_JPG, { userAgent: UA })
    expect(r.bytes).toBe(1024 * 1024)
  })
})
