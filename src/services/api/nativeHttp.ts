/** 原生 HTTP 层：CapacitorHttp（Capacitor 6 官方内置）
 *  - APP 内：原生网络栈执行，不受 WebView CORS 限制（MAL/AC 等无 CORS 头的 RSS 直连可用）
 *  - Web 预览：退化为 fetch（受 CORS 限制，仅开发用）
 *  - 不使用任何第三方代理
 */
import { CapacitorHttp, Capacitor } from '@capacitor/core'

export interface HttpResult { status: number; text: string; ms: number }

const UA = 'Mozilla/5.0 (Linux; Android 14) AnimeUniverse/0.5 (RSS reader)'

export async function httpGetText(url: string, timeoutMs = 12000, extraHeaders?: Record<string, string>): Promise<HttpResult> {
  const t0 = Date.now()
  if (Capacitor.isNativePlatform()) {
    const r = await CapacitorHttp.get({
      url,
      headers: { 'User-Agent': UA, ...(extraHeaders || {}) },
      responseType: 'text',
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    })
    const data = r.data
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    return { status: r.status, text, ms: Date.now() - t0 }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/rss+xml, application/xml, text/xml, text/html, */*', ...(extraHeaders || {}) } })
    const text = await r.text()
    return { status: r.status, text, ms: Date.now() - t0 }
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
): Promise<HttpResult> {
  const t0 = Date.now()
  if (Capacitor.isNativePlatform()) {
    const r = await CapacitorHttp.post({
      url,
      headers: { 'Content-Type': 'application/json', ...headers },
      data: body,
      responseType: 'text',
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    })
    const data = r.data
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    return { status: r.status, text, ms: Date.now() - t0 }
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
    return { status: r.status, text, ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}
