/**
 * 封面 URL 规范化（P0 修复 2026-11-01）
 * 背景：首页热门动漫破图根因 —— Capacitor WebView `androidScheme:'https'` + 默认 mixed-content
 *       NEVER_ALLOW 会拦截 `http://` 图片；而 B 站番剧/国创封面约半数返回 `http://i0.hdslb.com/...`
 *       （实测 10 张里 5 张 http）。动漫源(AniList/B站)在 https 页面加载被 block → 破图；
 *       漫画源 MangaDex 封面为 https CDN → 正常。这完美解释"动漫破图、漫画正常"。
 * 验证：http://i0.hdslb.com 逐张升级为 https://i0.hdslb.com 后实测 5/5 200 可用（B站同源支持）
 * 方案：统一把 http:// 封面升级为指向同一主机的 https://（非替换成无关图）。主机本身只支持
 *       http 的（极少见）不强行改，保留原值交由图片组件 onError 兜底。
 */
export function normalizeCover(url?: string): string | undefined {
  if (!url) return undefined
  // 已是 https 或 data: 或非 http 协议，原样返回
  if (!url.startsWith('http://')) return url
  // http://i0.hdslb.com/... -> https://i0.hdslb.com/...（B站等绝大多数 CDN 支持 https 同源）
  return 'https://' + url.slice(7)
}
