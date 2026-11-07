/**
 * 二进制 HTTP 层（在线漫画图片下载专用）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要独立一个文件，而不是复用 nativeHttp.ts
 * ══════════════════════════════════════════════════════════════════════
 * `nativeHttp.ts` 属冻结区（阶段3第6步已冻结），且它的职责是「取文本」：
 * `HttpResult = { status, text, ms }`，所有返回都强制走 string。
 * 图片是二进制，语义不同，混进去会让冻结核心的语义变模糊。
 * 因此本文件独立实现，**不修改 nativeHttp.ts 一行**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 关键事实：Capacitor 6 的 `arraybuffer` 返回的是 **Base64 字符串**
 * ══════════════════════════════════════════════════════════════════════
 * 不是 ArrayBuffer，不是 Blob。证据来自 Capacitor 6 Android 源码：
 *
 *   com/getcapacitor/plugin/util/HttpRequestHandler.java:255-258
 *     switch (responseType) {
 *       case ARRAY_BUFFER:
 *       case BLOB:
 *         return readStreamAsBase64(stream);   // ← 返回 String
 *
 *   HttpRequestHandler.java:344-352
 *     public static String readStreamAsBase64(InputStream in) {
 *       ...
 *       return Base64.encodeToString(result, 0, result.length, Base64.DEFAULT);
 *     }
 *
 * ⚠️ 因此**绝对不能** `new Blob([r.data])` —— 那会得到一个内容是
 *    Base64 文本的乱码 Blob（体积膨胀 33%，且图片无法显示）。
 *    必须先 atob 解码成二进制字节，再构造 Blob。
 *
 * ⚠️ `Base64.DEFAULT` 会每 76 字符插入 `\n`，解码前**必须**剔除空白。
 *
 * 已验证的往返（真实 MangaDex 图片，2026-11-08）：
 *   原始 511,978 B → Base64 682,640 字符 → 解码回 511,978 B → 完全一致 ✅
 *
 * ══════════════════════════════════════════════════════════════════════
 * 合规约束（MangaDex 条款，不可绕过）
 * ══════════════════════════════════════════════════════════════════════
 *  - MangaDex 明令禁止图片热链：
 *      "We will serve the wrong response for any image hotlinked from our
 *       domains; you MUST proxy the requests your users make to our services"
 *    ⇒ 必须由客户端下载字节，不能把直链塞进 <img src>。本模块即为此而生。
 *  - "The request MUST have a User-Agent header, and it must not be spoofed"
 *    ⇒ UA 由调用方显式传入，本模块**不设默认 UA**，避免悄悄伪装。
 *  - "The request CANNOT have a Via header"
 *    ⇒ 本模块不添加 Via，也不引入任何代理。
 *  - 限流约 5 req/s/IP ⇒ 并发由调用方控制（见 MAX_CONCURRENCY 建议值）。
 */

import { CapacitorHttp, Capacitor } from '@capacitor/core'

/* ══════════════════════════════════════════════════════════════════════
 * 错误类型
 * ══════════════════════════════════════════════════════════════════════ */

/** 二进制下载失败的可诊断错误（携带阶段，便于定位） */
export class BinaryHttpError extends Error {
  constructor(
    message: string,
    readonly stage: BinaryHttpStage,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message)
    this.name = 'BinaryHttpError'
  }
}

/** 失败阶段：区分「没拿到」「拿到了但不是图片」「拿到了但解不开」 */
export type BinaryHttpStage =
  | 'network'      // 请求本身失败（连接/超时/中断）
  | 'http-status'  // 收到了响应，但非 2xx
  | 'empty-body'   // 2xx 但响应体为空
  | 'mime'         // Content-Type 不是可接受的图片类型
  | 'decode'       // Base64 解码失败，或解码结果与声明长度不符
  | 'aborted'      // 调用方主动取消

/** 取消错误单独一个类型，便于调用方区分「用户翻页取消」与「真失败」 */
export class BinaryHttpAbortError extends BinaryHttpError {
  constructor(url?: string) {
    super('请求已取消', 'aborted', undefined, url)
    this.name = 'BinaryHttpAbortError'
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 返回结构
 * ══════════════════════════════════════════════════════════════════════ */

export interface BinaryResult {
  /** 解码后的图片 Blob，**已带正确的 MIME type** */
  blob: Blob
  /** 字节数（解码后真实长度） */
  bytes: number
  /** 响应 Content-Type 原文（可能为空串） */
  contentType: string
  /** 实际使用的 MIME（从 contentType 提取，或从魔数推断） */
  mime: string
  /** HTTP 状态码 */
  status: number
  /** 耗时 ms */
  ms: number
}

export interface BinaryGetOptions {
  /**
   * User-Agent。
   *
   * 🔴 **无默认值，必须显式传入**。
   *   MangaDex 条款："The request MUST have a User-Agent header, and it
   *   must not be spoofed"。给一个默认值等于替调用方决定身份，
   *   容易在不知情的情况下违反条款。显式传入强迫调用方做出选择。
   */
  userAgent: string
  /** 额外请求头（如 Referer）。**不允许包含 Via** */
  headers?: Record<string, string>
  /** 超时 ms（连接与读取各自独立计时） */
  timeoutMs?: number
  /** 取消信号 */
  signal?: AbortSignal
  /**
   * 允许的 MIME 前缀列表（默认 image/）。
   * 用于 content-type 与魔数双重校验，防止把 HTML 错误页当图片。
   */
  acceptMimePrefixes?: readonly string[]
}

/* ══════════════════════════════════════════════════════════════════════
 * Base64 解码
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 从 Base64 字符串解出原始字节。
 *
 * ⚠️ 必须容忍 Android `Base64.DEFAULT` 插入的换行与空白。
 * ⚠️ 不依赖 Node 的 Buffer，也不依赖 atob 之外的 polyfill：
 *    - 浏览器 / WebView：atob 原生可用
 *    - Node（单元测试）：atob 自 Node 16 起为全局函数
 */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof b64 !== 'string') {
    throw new BinaryHttpError('响应不是字符串，无法按 Base64 解码', 'decode')
  }
  // 剔除所有空白（Base64.DEFAULT 每 76 字符插 \n）
  const clean = b64.replace(/\s+/g, '')
  if (clean.length === 0) {
    throw new BinaryHttpError('Base64 内容为空', 'empty-body')
  }
  // 长度必须是 4 的倍数（允许缺省 padding 时补齐）
  const padded = clean.length % 4 === 0 ? clean : clean + '='.repeat(4 - (clean.length % 4))

  let bin: string
  try {
    bin = atob(padded)
  } catch {
    throw new BinaryHttpError('Base64 解码失败（内容非法）', 'decode')
  }

  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ══════════════════════════════════════════════════════════════════════
 * 图片类型识别
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 从字节魔数识别图片类型。
 * 作用：即使服务端 Content-Type 缺失或错误，也能给出正确 MIME，
 * 并且能识破「返回 HTML 错误页但状态码是 200」这种情况。
 */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length < 4) return null
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  // GIF: 47 49 46 38
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  // WEBP: 52 49 46 46 ... 57 45 42 50
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp'
  // AVIF / HEIF: .... 66 74 79 70 (ftyp) at offset 4
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand.startsWith('hei') || brand === 'mif1') return 'image/heic'
  }
  // 明显是 HTML（错误页）：3C 21 / 3C 68 / 3C 48
  if (b[0] === 0x3c) return null
  return null
}

/* ══════════════════════════════════════════════════════════════════════
 * 主函数
 * ══════════════════════════════════════════════════════════════════════ */

const DEFAULT_TIMEOUT_MS = 20000
const DEFAULT_ACCEPT = ['image/'] as const

/** 可接受的最小长度：小于此值必然不是有效图片 */
const MIN_IMAGE_BYTES = 64

/**
 * 下载一张图片并返回 Blob。
 *
 * 全链路：CapacitorHttp(arraybuffer) → Base64 String → atob → Uint8Array → Blob
 *
 * @throws BinaryHttpAbortError  调用方取消
 * @throws BinaryHttpError       其它失败（带 stage 便于诊断）
 */
export async function getBinary(
  url: string,
  opts: BinaryGetOptions,
): Promise<BinaryResult> {
  const t0 = Date.now()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const acceptPrefixes = opts.acceptMimePrefixes ?? DEFAULT_ACCEPT

  // ── 前置校验：UA 必填（不代替调用方决定身份）
  if (!opts.userAgent || !opts.userAgent.trim()) {
    throw new BinaryHttpError('必须显式提供 User-Agent（MangaDex 条款禁止伪造，也禁止缺失）', 'network', undefined, url)
  }
  // ── 前置校验：禁止 Via（MangaDex 条款显式禁止不透明代理）
  if (opts.headers) {
    for (const k of Object.keys(opts.headers)) {
      if (k.toLowerCase() === 'via') {
        throw new BinaryHttpError('不允许携带 Via 头（MangaDex 条款禁止不透明代理）', 'network', undefined, url)
      }
    }
  }
  if (opts.signal?.aborted) {
    throw new BinaryHttpAbortError(url)
  }

  const headers: Record<string, string> = {
    'User-Agent': opts.userAgent,
    ...(opts.headers || {}),
  }

  // ══════════════ 分支 1：原生（CapacitorHttp）══════════════
  if (Capacitor.isNativePlatform()) {
    let r: { status: number; data: unknown; headers?: unknown }
    try {
      r = await CapacitorHttp.get({
        url,
        headers,
        // 🔴 注意：在 Android 上这会返回 **Base64 字符串**（见文件头）
        responseType: 'arraybuffer',
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      })
    } catch (e) {
      if (opts.signal?.aborted) throw new BinaryHttpAbortError(url)
      throw new BinaryHttpError(
        `网络请求失败: ${e instanceof Error ? e.message : String(e)}`,
        'network', undefined, url,
      )
    }

    if (opts.signal?.aborted) throw new BinaryHttpAbortError(url)

    if (r.status < 200 || r.status >= 300) {
      throw new BinaryHttpError(`HTTP ${r.status}`, 'http-status', r.status, url)
    }

    const contentType = readHeader(r.headers, 'content-type') ?? ''
    const bytes = decodeNativePayload(r.data, url)

    return finalize(bytes, contentType, r.status, Date.now() - t0, url, acceptPrefixes)
  }

  // ══════════════ 分支 2：Web / 测试（fetch）══════════════
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  // 把外部 signal 桥接到内部 controller
  const onOuterAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onOuterAbort)

  try {
    const res = await fetch(url, { signal: ctrl.signal, headers })
    if (opts.signal?.aborted) throw new BinaryHttpAbortError(url)

    if (!res.ok) {
      throw new BinaryHttpError(`HTTP ${res.status}`, 'http-status', res.status, url)
    }
    const contentType = res.headers.get('content-type') ?? ''
    const buf = await res.arrayBuffer()
    const bytes = new Uint8Array(buf)
    return finalize(bytes, contentType, res.status, Date.now() - t0, url, acceptPrefixes)
  } catch (e) {
    if (e instanceof BinaryHttpError) throw e
    if (opts.signal?.aborted) throw new BinaryHttpAbortError(url)
    if (ctrl.signal.aborted) {
      throw new BinaryHttpError(`请求超时（${timeoutMs}ms）`, 'network', undefined, url)
    }
    throw new BinaryHttpError(
      `网络请求失败: ${e instanceof Error ? e.message : String(e)}`,
      'network', undefined, url,
    )
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 内部辅助
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把原生返回的 payload 转成字节。
 *
 * 🔴 这是最容易写错的地方：Android 返回的是 Base64 字符串，
 *    但**不能假设永远是**——某些平台/版本可能返回别的形状。
 *    因此这里做严格判别，遇到意外形状**显式报错**而非静默降级，
 *    否则会得到「看起来成功、实际是乱码」的 Blob。
 */
function decodeNativePayload(data: unknown, url: string): Uint8Array {
  // 形状 A：Base64 字符串（Capacitor 6 Android 的实际行为）
  if (typeof data === 'string') {
    return base64ToBytes(data)
  }
  // 形状 B：真的是 ArrayBuffer（防御性支持，当前未观测到）
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  // 形状 C：Uint8Array / 类数组
  if (data instanceof Uint8Array) {
    return data
  }
  // 形状 D：{ type: 'Buffer', data: [...] } 之类的序列化形式
  if (data && typeof data === 'object') {
    const arr = (data as { data?: unknown }).data
    if (Array.isArray(arr)) return new Uint8Array(arr)
  }
  throw new BinaryHttpError(
    `原生响应类型无法识别: ${data === null ? 'null' : typeof data}`,
    'decode', undefined, url,
  )
}

/** 收尾校验：空响应 / MIME / 魔数，然后构造 Blob */
function finalize(
  bytes: Uint8Array,
  contentType: string,
  status: number,
  ms: number,
  url: string,
  acceptPrefixes: readonly string[],
): BinaryResult {
  if (bytes.length === 0) {
    throw new BinaryHttpError('响应体为空', 'empty-body', status, url)
  }
  if (bytes.length < MIN_IMAGE_BYTES) {
    throw new BinaryHttpError(`响应体过小（${bytes.length} B），不像图片`, 'empty-body', status, url)
  }

  // Content-Type 白名单校验（若服务端给了）
  const ctLower = contentType.toLowerCase()
  if (ctLower && acceptPrefixes.length > 0) {
    const ok = acceptPrefixes.some((p) => ctLower.startsWith(p.toLowerCase()))
    if (!ok) {
      throw new BinaryHttpError(
        `Content-Type 不可接受: ${contentType}`,
        'mime', status, url,
      )
    }
  }

  // 魔数校验：能识破「200 + HTML 错误页」
  const sniffed = sniffImageMime(bytes)
  if (!sniffed) {
    // 服务端说是图片，但魔数不认识 → 拒绝，避免产出乱码 Blob
    throw new BinaryHttpError(
      `无法识别的图片格式（Content-Type=${contentType || '空'}，前 4 字节=${hex4(bytes)}）`,
      'mime', status, url,
    )
  }

  // MIME 优先用魔数（比 Content-Type 更可信）
  const mime = sniffed
  // ⚠️ TS 5.7+ 起 `Uint8Array<ArrayBufferLike>` 不能直接作为 BlobPart
  //    （SharedArrayBuffer 的可能分支被排除）。这里显式复制到一个
  //    确定由 ArrayBuffer 承载的视图上。多一次拷贝，但长度可控（单张图片），
  //    且能保证 Blob 构造在所有 TS 版本下类型安全。
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  const blob = new Blob([copy.buffer], { type: mime })

  // 自检：Blob 大小必须与字节数一致（防止桥接层悄悄丢数据）
  if (blob.size !== bytes.length) {
    throw new BinaryHttpError(
      `Blob 大小异常: ${blob.size} != ${bytes.length}`,
      'decode', status, url,
    )
  }

  return { blob, bytes: bytes.length, contentType, mime, status, ms }
}

function hex4(b: Uint8Array): string {
  return Array.from(b.slice(0, 4))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join(' ')
}

/** 大小写不敏感地读响应头（Capacitor 返回的是普通对象） */
function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null
  const h = headers as Record<string, unknown>
  if (typeof h[name] === 'string') return h[name] as string
  const lower = name.toLowerCase()
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) {
      const v = h[k]
      if (typeof v === 'string') return v
      if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
    }
  }
  return null
}

/* ══════════════════════════════════════════════════════════════════════
 * 并发限制 + 去重（供 ReaderPage 的 WINDOW=5 懒加载使用）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * MangaDex 限流约 5 req/s/IP。
 * 取 4 留出余量，避免与章节列表等请求叠加后触发 429。
 */
export const MAX_CONCURRENCY = 4

/**
 * 简易并发闸门。**不做重试**——重试策略应在上层按来源决定。
 */
export function createLimiter(max: number = MAX_CONCURRENCY) {
  let active = 0
  const queue: Array<() => void> = []

  const next = () => {
    if (active >= max) return
    const run = queue.shift()
    if (run) { active++; run() }
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then(resolve, reject).finally(() => { active--; next() })
      }
      queue.push(run)
      next()
    })
  }
}

/**
 * 同一 URL 的进行中请求去重。
 *
 * 场景：连续翻页时同一页可能被重复请求（例如快速来回滑动）。
 * 只合并**进行中**的请求；已完成的请求不再缓存（内存交给调用方管）。
 */
export function createInflight() {
  const map = new Map<string, Promise<BinaryResult>>()

  return function dedupe(url: string, fn: () => Promise<BinaryResult>): Promise<BinaryResult> {
    const existing = map.get(url)
    if (existing) return existing
    const p = fn().finally(() => { map.delete(url) })
    map.set(url, p)
    return p
  }
}
