/** CORS/防盗链工具：allorigins 免费代理（0 预算） */
export const PROXY = (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`

/** 图片兜底代理：onError 时换一次代理地址（dataset 防循环） */
export function imgFallback(e: React.SyntheticEvent<HTMLImageElement>) {
  const el = e.target as HTMLImageElement
  const src = el.getAttribute('src') || ''
  if (!src || el.dataset.fell || src.startsWith('https://api.allorigins.win')) { el.style.visibility = 'hidden'; return }
  el.dataset.fell = '1'
  el.src = PROXY(src)
}
