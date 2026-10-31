/** 统一翻译服务（阶段 6.3 / 6.4 免费方案实测）
 *  引擎（手机网络实测 2026-10-31）：
 *  - openai 兼容预设：
 *    · 智谱GLM glm-4-flash：完全免费（open.bigmodel.cn 实测 401=通），动漫作品名翻译质量好
 *    · 硅基流动 Qwen2.5-7B-Instruct（免费模型档）：api.siliconflow.cn 实测通
 *    · DeepSeek / 其他 OpenAI 兼容：极低价（¥1/百万输入 token 量级）
 *  - deepl：api-free.deepl.com 实测 403=通；免费版每月 50 万字符；仅支持简体中文目标
 *  - Google gtx 免费端点实测超时不可达；MyMemory 免注册但质量不合格（作品名人名错译），不接入
 *  原则：密钥仅存本机；默认关闭；结果按 URL 缓存（LRU 300）不重复计费；失败回退原文不阻塞。
 */
import { httpPostJson } from '../api/nativeHttp'
import { EMBEDDED_TRANS_KEY } from './embedded'

export type TransProvider = 'openai' | 'deepl'

export interface TransCfg {
  enabled: boolean
  provider: TransProvider
  baseUrl: string
  apiKey: string
  model: string
  target: 'zh-CN' | 'zh-TW'
}

const CKEY = 'au_translate_cfg'
const CACHE_KEY = 'au_trans_cache'
const CACHE_MAX = 300

/** 默认配置：构建时嵌入了 key 则开箱即用（用户在设置页改过则以用户为准） */
function defaultCfg(): TransCfg {
  return {
    enabled: !!EMBEDDED_TRANS_KEY,
    provider: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: EMBEDDED_TRANS_KEY,
    model: 'glm-4-flash',
    target: 'zh-CN',
  }
}

export function getTransCfg(): TransCfg {
  try {
    const c = JSON.parse(localStorage.getItem(CKEY) || 'null')
    if (c) return { ...defaultCfg(), ...c }
  } catch { /* ignore */ }
  return defaultCfg()
}

export function setTransCfg(patch: Partial<TransCfg>) {
  const next = { ...getTransCfg(), ...patch }
  localStorage.setItem(CKEY, JSON.stringify(next))
}

/** 免费引擎预设（引擎按钮：一键填 baseUrl/model，key 仍需用户自己注册填写） */
export const PRESETS: { id: string; label: string; desc: string; baseUrl: string; model: string; provider: TransProvider; signup: string }[] = [
  { id: 'glm', label: '智谱GLM', desc: '完全免费 · glm-4-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', provider: 'openai', signup: 'open.bigmodel.cn 注册后在「API keys」创建' },
  { id: 'silicon', label: '硅基流动', desc: '免费模型档 · Qwen2.5-7B', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', provider: 'openai', signup: 'cloud.siliconflow.cn 注册后在「API密钥」创建' },
  { id: 'deepl', label: 'DeepL', desc: '免费版 50万字符/月 · 仅简中', baseUrl: 'https://api-free.deepl.com/v2', model: '', provider: 'deepl', signup: 'deepl.com/pro-api 选 Free 版，key 以 :fx 结尾' },
  { id: 'custom', label: '自定义', desc: '任意 OpenAI 兼容接口', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', provider: 'openai', signup: '填服务商的接口地址 /v1 与密钥' },
]

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

/** 翻译进度通知：每批写完缓存广播一次，页面可增量刷新 */
export const transEvents = new EventTarget()

export interface TransInput { link: string; title: string; summary?: string }

/** 翻译日文条目。LLM 引擎用单条并发（glm-4-flash 对批量 JSON 输出不稳定，实测漏条乱序；
 *  单条+文本格式实测 4/4 全对）；DeepL 引擎保留官方数组批量。返回成功条数。 */
export async function translateNews(items: TransInput[]): Promise<number> {
  const cfg = getTransCfg()
  if (!cfg.enabled || !cfg.apiKey || items.length === 0) return 0
  if (cfg.provider === 'deepl') {
    let okD = 0
    for (let i = 0; i < items.length; i += 40) {
      const batch = items.slice(i, i + 40)
      try { okD += await deeplBatch(batch, cfg) } catch {
        try { okD += await deeplBatch(batch, cfg) } catch { /* 放弃该批 */ }
      }
      if (okD > 0) transEvents.dispatchEvent(new Event('batch'))
    }
    return okD
  }
  // OpenAI 兼容：单条并发 3
  let ok = 0
  let idx = 0
  const worker = async () => {
    while (idx < items.length) {
      const it = items[idx++]
      let done = false
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        try {
          await translateOne(it, cfg)
          done = true; ok++
          transEvents.dispatchEvent(new Event('batch'))
        } catch { /* 重试或放弃该条，保留原文 */ }
      }
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker))
  return ok
}

const TARGET_NAME: Record<TransCfg['target'], string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文（台灣用語）',
}

/** 单条翻译：【标】/【摘】文本格式（比 JSON 结构化输出稳定），实测作品名/人名译名正确 */
async function translateOne(it: TransInput, cfg: TransCfg): Promise<void> {
  const sys =
    `把日文动漫新闻标题翻译成${TARGET_NAME[cfg.target]}。作品名用中文社区通用译名` +
    '（例：「薬屋のひとりごと」→《药屋少女的呢喃》）。输出两行：【标】中文标题 和（如有摘要）【摘】中文摘要。' +
    '没有摘要就只输出【标】行。不要输出其他任何内容。'
  const user = it.summary ? `${it.title}\n（摘要：${it.summary.slice(0, 140)}）` : it.title
  const r = await httpPostJson(
    `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${cfg.apiKey}` },
    { model: cfg.model, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] },
    30000,
  )
  if (r.status !== 200) throw new Error(`翻译 HTTP ${r.status}`)
  let content = ''
  try {
    const j = JSON.parse(r.text) as { choices?: { message?: { content?: string } }[] }
    content = j.choices?.[0]?.message?.content || ''
  } catch { throw new Error('翻译响应解析失败') }
  const tM = content.match(/【标】\s*(.+)/)
  if (!tM) throw new Error('翻译响应格式异常')
  const sM = content.match(/【摘】\s*([\s\S]+)/)
  putTransCache(it.link, tM[1].trim(), (sM?.[1] || '').trim())
}

/* ---------- DeepL 免费版（api-free.deepl.com，50万字符/月，仅简体中文目标） ---------- */
async function deeplBatch(batch: TransInput[], cfg: TransCfg): Promise<number> {
  // DeepL 无繁中 target（仅 ZH 简中）；选繁体时也输出简中（UI 已提示）
  const target = 'ZH'
  const titles = batch.map((b) => b.title)
  const withSummary = batch.map((b, i) => ({ b, i })).filter((x) => x.b.summary)
  const r = await httpPostJson(
    `${cfg.baseUrl.replace(/\/$/, '')}/translate`,
    { Authorization: `DeepL-Auth-Key ${cfg.apiKey}` },
    { text: titles, target_lang: target, source_lang: 'JA' },
    30000,
  )
  if (r.status !== 200) throw new Error(`DeepL HTTP ${r.status}`)
  let trans: { text: string }[] = []
  try {
    const j = JSON.parse(r.text) as { translations?: { text: string }[] }
    trans = j.translations || []
  } catch { throw new Error('DeepL 响应解析失败') }
  let ok = 0
  trans.forEach((t, i) => {
    const it = batch[i]
    if (it && t.text) {
      putTransCache(it.link, t.text.trim(), '')
      ok++
    }
  })
  // 摘要单独一批（有则翻）
  if (withSummary.length) {
    try {
      const r2 = await httpPostJson(
        `${cfg.baseUrl.replace(/\/$/, '')}/translate`,
        { Authorization: `DeepL-Auth-Key ${cfg.apiKey}` },
        { text: withSummary.map((x) => (x.b.summary || '').slice(0, 400)), target_lang: target, source_lang: 'JA' },
        30000,
      )
      if (r2.status === 200) {
        const j2 = JSON.parse(r2.text) as { translations?: { text: string }[] }
        ;(j2.translations || []).forEach((t, k) => {
          const src = withSummary[k]
          if (src && t.text) {
            const c = getTransCached(src.b.link)
            if (c) putTransCache(src.b.link, c.t, t.text.trim())
          }
        })
      }
    } catch { /* 摘要失败不影响标题 */ }
  }
  return ok
}
