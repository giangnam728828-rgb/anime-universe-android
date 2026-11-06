/** 原生 HTTP 层：CapacitorHttp（Capacitor 6 官方内置）
 *  - APP 内：原生网络栈执行，不受 WebView CORS 限制（MAL/AC 等无 CORS 头的 RSS 直连可用）
 *  - Web 预览：退化为 fetch（受 CORS 限制，仅开发用）
 *  - 不使用任何第三方代理
 *  - ★ 2b：仅增加可选末位参数 ctx 接入诊断；**不传 ctx 时行为与接入前完全一致**
 */
import { CapacitorHttp, Capacitor } from '@capacitor/core'
import { beginRequest, markHttpDone } from '../diagnostics'
import type { DiagContext } from '../diagnostics'

export interface HttpResult { status: number; text: string; ms: number }

const UA = 'Mozilla/5.0 (Linux; Android 14) AnimeUniverse/0.5 (RSS reader)'

/* ══════════════════════════════════════════════════════════════
 * 2b 诊断接入辅助（全部静默；任何异常都不得扩散到 HTTP 主流程）
 * ★ 本层只做登记与 markHttpDone，**绝不最终终结记录**（终结属适配器）
 * ══════════════════════════════════════════════════════════════ */

/** 从真实响应头提取 Content-Type（v6.10 L2185-2198：大小写不敏感；真找不到才 null，不伪造） */
function readContentType(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') return null
  // Web 分支：fetch 返回的是 Headers 实例
  const maybeGet = (headers as { get?: unknown }).get
  if (typeof maybeGet === 'function') {
    try {
      const v = (headers as Headers).get('content-type')
      return typeof v === 'string' ? v : null
    } catch { return null }
  }
  const h = headers as Record<string, unknown>
  if (typeof h['Content-Type'] === 'string') return h['Content-Type']
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === 'content-type') {
      const v = h[k]
      if (typeof v === 'string') return v
      if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
    }
  }
  return null
}

/** 入口登记：每个请求**只调用一次** beginRequest；未传 ctx 则完全不登记 */
function diagBegin(ctx?: DiagContext): string | undefined {
  if (!ctx) return undefined
  try { beginRequest(ctx); return ctx.attemptId } catch { return undefined }
}

/** HTTP 返回成功 → markHttpDone（★ 不是 recordSuccess，也不做最终终结） */
function diagOk(aid: string | undefined, status: number, ms: number, ct: string | null): void {
  if (!aid) return
  try { markHttpDone(aid, { status, ms }, 'ok', ct) } catch { /* 静默 */ }
}

/** 网络异常 → markHttpDone(network)：HTTP 字段保持置空 */
function diagNet(aid: string | undefined): void {
  if (!aid) return
  try { markHttpDone(aid, undefined, 'network') } catch { /* 静默 */ }
}

export async function httpGetText(
  url: string,
  timeoutMs = 12000,
  extraHeaders?: Record<string, string>,
  ctx?: DiagContext,
): Promise<HttpResult> {
  const t0 = Date.now()
  const aid = diagBegin(ctx)
  if (Capacitor.isNativePlatform()) {
    let r: { status: number; data: unknown; headers?: unknown }
    try {
      r = await CapacitorHttp.get({
        url,
        headers: { 'User-Agent': UA, ...(extraHeaders || {}) },
        responseType: 'text',
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      })
    } catch (e) {
      diagNet(aid)          // ★ 先标记，再原样抛出（不包装、不替换）
      throw e
    }
    const data = r.data
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    const ms = Date.now() - t0
    diagOk(aid, r.status, ms, readContentType(r.headers))
    return { status: r.status, text, ms }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/rss+xml, application/xml, text/xml, text/html, */*', ...(extraHeaders || {}) } })
    const text = await r.text()
    const ms = Date.now() - t0
    diagOk(aid, r.status, ms, readContentType(r.headers))
    return { status: r.status, text, ms }
  } catch (e) {
    diagNet(aid)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** POST JSON（翻译 API 等，同样走 CapacitorHttp 原生层，无 CORS 限制） */
export async function httpPostJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 30000,
  ctx?: DiagContext,
): Promise<HttpResult> {
  const t0 = Date.now()
  const aid = diagBegin(ctx)
  if (Capacitor.isNativePlatform()) {
    let r: { status: number; data: unknown; headers?: unknown }
    try {
      r = await CapacitorHttp.post({
        url,
        headers: { 'Content-Type': 'application/json', ...headers },
        data: body,
        responseType: 'text',
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      })
    } catch (e) {
      diagNet(aid)
      throw e
    }
    const data = r.data
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    const ms = Date.now() - t0
    diagOk(aid, r.status, ms, readContentType(r.headers))
    return { status: r.status, text, ms }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const text = await r.text()
    const ms = Date.now() - t0
    diagOk(aid, r.status, ms, readContentType(r.headers))
    return { status: r.status, text, ms }
  } catch (e) {
    diagNet(aid)
    throw e
  } finally {
    clearTimeout(timer)
  }
}
