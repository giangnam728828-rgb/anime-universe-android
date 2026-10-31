/** 统一翻译服务（阶段 6.3）
 *  - OpenAI 兼容接口（用户自配 baseUrl/key/model，存 localStorage，绝不硬编码密钥）
 *  - 默认关闭；必须由用户在「来源管理 → 翻译设置」主动开启
 *  - 未配置时日文资讯以原文显示并标记 [日文]，不阻塞、不报错
 *  - 翻译结果按文章 URL 缓存（au_trans_cache，LRU 300），已翻译文章刷新不重译
 *  - 批量翻译（10 条/请求）省钱省时；单批失败重试 1 次，最终失败回退原文
 *  - 费用：由用户所选服务商计费（如 OpenAI gpt-4o-mini 约 $0.15/百万输入 token），
 *    本 APP 不承诺免费无限翻译，也不代付费
 */
import { httpPostJson } from '../api/nativeHttp'

export interface TransCfg {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  target: 'zh-CN' | 'zh-TW'
}

const CKEY = 'au_translate_cfg'
const CACHE_KEY = 'au_trans_cache'
const CACHE_MAX = 300

export function getTransCfg(): TransCfg {
  try {
    const c = JSON.parse(localStorage.getItem(CKEY) || 'null')
    if (c) return { enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', target: 'zh-CN', ...c }
  } catch { /* ignore */ }
  return { enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', target: 'zh-CN' }
}

export function setTransCfg(patch: Partial<TransCfg>) {
  const next = { ...getTransCfg(), ...patch }
  localStorage.setItem(CKEY, JSON.stringify(next))
}

interface TransEntry { t: string; s: string; at: number }

export function getTransCached(link: string): TransEntry | null {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, TransEntry>
    return cache[link] || null
  } catch { return null }
}

function putTransCache(link: string, t: string, s: string) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, TransEntry>
    cache[link] = { t, s, at: Date.now() }
    const keys = Object.keys(cache)
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => cache[a].at - cache[b].at)
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k]
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch { /* 容量不足忽略 */ }
}

export function clearTransCache() {
  localStorage.removeItem(CACHE_KEY)
}

export interface TransInput { link: string; title: string; summary?: string }

/** 翻译日文条目（批量）。返回成功条数；失败抛错由调用方决定回退 */
export async function translateNews(items: TransInput[]): Promise<number> {
  const cfg = getTransCfg()
  if (!cfg.enabled || !cfg.apiKey || items.length === 0) return 0
  const batchSize = 10
  let okCount = 0
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    try {
      const n = await translateBatch(batch, cfg)
      okCount += n
    } catch {
      // 单批失败重试 1 次
      try {
        const n = await translateBatch(batch, cfg)
        okCount += n
      } catch { /* 该批放弃，保留原文 */ }
    }
  }
  return okCount
}

const TARGET_NAME: Record<TransCfg['target'], string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文（台灣用語）',
}

async function translateBatch(batch: TransInput[], cfg: TransCfg): Promise<number> {
  const lines = batch.map((it, i) =>
    `[${i}] 标题: ${it.title}${it.summary ? `\n    摘要: ${it.summary.slice(0, 140)}` : ''}`,
  ).join('\n')
  const sys =
    `你是动漫资讯标题翻译器。把日文动漫新闻的标题和摘要翻译成${TARGET_NAME[cfg.target]}。` +
    '保留作品名《》【】书名号格式与人名汉字。只输出 JSON 数组，不要任何其他文字：' +
    '[{"i":索引,"title":"中文标题","summary":"中文摘要"}]。无摘要则 summary 为空字符串。'
  const r = await httpPostJson(
    `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${cfg.apiKey}` },
    {
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: lines },
      ],
    },
    30000,
  )
  if (r.status !== 200) throw new Error(`翻译 HTTP ${r.status}`)
  let content = ''
  try {
    const j = JSON.parse(r.text) as { choices?: { message?: { content?: string } }[] }
    content = j.choices?.[0]?.message?.content || ''
  } catch { throw new Error('翻译响应解析失败') }
  // 容错：剥掉 markdown 代码围栏
  const m = content.match(/\[[\s\S]*\]/)
  if (!m) throw new Error('翻译响应无 JSON')
  const arr = JSON.parse(m[0]) as { i: number; title: string; summary?: string }[]
  let ok = 0
  arr.forEach((o) => {
    const it = batch[o.i]
    if (it && o.title) {
      putTransCache(it.link, o.title.trim(), (o.summary || '').trim())
      ok++
    }
  })
  return ok
}
