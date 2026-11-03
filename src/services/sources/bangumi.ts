/**
 * Bangumi（bgm.tv）中文元数据适配器
 *
 * 归属：**独立来源工作线**，不属总方案阶段3（不要编号为阶段3-8）。
 * 评级：来源策略 v2.0 之 **A 级**（官方公开 API，无需登录）。
 *
 * 能力边界：
 *  - ✅ 搜索（中文优先，type=2 动画 / type=1 书籍）
 *  - ✅ 详情（/v0/subjects/{id}）
 *  - ❌ 不提供播放/章节阅读（Bangumi 是元数据站，无视频流）
 *
 * 设计约定（经用户 Q1~Q5 裁定）：
 *  - Q3：kind='manga' 走 type=1「书籍」大类，formatCn 必须诚实标为「书籍（Bangumi）」，
 *        **不得谎称为"漫画"**（type=1 混合漫画/轻小说/画集）。
 *  - Q5：无 name_cn 时 title=name（日文）且 titleLang='ja'，**不谎报中文**。
 *  - Q4：status() 只报告已知结果，**不发起任何网络请求**。
 *  - 节流：官方建议 ≤1 req/s，**所有实际请求**（搜索/详情）统一串行节流。
 */
import { httpGetText, httpPostJson } from '../api/nativeHttp'
import { normalizeCover } from '../../utils/cover'
import type { SourceAdapter, WorkItem, WorkDetail, SearchOptions, SearchResult, Kind, StaffRole } from './types'

const BASE = 'https://api.bgm.tv'
const UA = 'AnimeUniverse/0.6 (https://github.com/giangnam728828-rgb/anime-universe-android)'
const PAGE_SIZE = 20
const REQ_TIMEOUT_MS = 6000

/** 官方建议 ≤1 req/s 的最小请求间隔 */
const MIN_INTERVAL_MS = 1000

/** status() 判定"信息陈旧"的阈值：5 分钟 */
const STALE_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// 串行节流（★ 覆盖所有实际发出的 Bangumi 请求，不只是搜索）
// ---------------------------------------------------------------------------

let lastAt = 0

/**
 * 串行节流：保证两次真实网络请求之间至少间隔 MIN_INTERVAL_MS。
 *
 * ★ search / getDetail 全部经由 bgmFetch → throttled，
 *   因此详情请求同样受限，不会出现"只限搜索、放过详情"的漏洞。
 */
async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastAt))
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait))
  lastAt = Date.now()
  return fn()
}

// ---------------------------------------------------------------------------
// status() 状态记录（★ 纯读取，零网络请求）
// ---------------------------------------------------------------------------

interface LastResult {
  ok: boolean
  at: number
}

let lastResult: LastResult | null = null

/** 由真实请求结果驱动；不对外导出，避免业务侧伪造状态 */
function noteResult(ok: boolean): void {
  lastResult = { ok, at: Date.now() }
}

/** 仅供测试重置模块级状态 */
export function __resetBangumiStateForTest(): void {
  lastAt = 0
  lastResult = null
}

/** 仅供测试读取节流时间戳 */
export function __getLastRequestAtForTest(): number {
  return lastAt
}

// ---------------------------------------------------------------------------
// 底层请求（所有调用都经 throttled）
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
async function bgmGet(path: string): Promise<any> {
  return throttled(async () => {
    const res = await httpGetText(BASE + path, REQ_TIMEOUT_MS, {
      'User-Agent': UA,
      Accept: 'application/json',
    })
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    return JSON.parse(res.text)
  })
}

async function bgmPost(path: string, body: unknown): Promise<any> {
  return throttled(async () => {
    const res = await httpPostJson(
      BASE + path,
      { 'User-Agent': UA, Accept: 'application/json' },
      body,
      REQ_TIMEOUT_MS,
    )
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    return JSON.parse(res.text)
  })
}

// ---------------------------------------------------------------------------
// 字段映射
// ---------------------------------------------------------------------------

/**
 * 题材白名单：Bangumi 的 tags 混有大量人名（泽野弘之）、公司（WITSTUDIO）、
 * 年份（2013年4月）等噪声，只保留真正的题材标签。
 */
const GENRE_WHITELIST = new Set([
  '热血', '奇幻', '战斗', '悬疑', '科幻', '恋爱', '日常', '校园', '搞笑',
  '治愈', '机战', '机甲', '运动', '音乐', '恐怖', '推理', '冒险', '历史',
  '百合', '耽美', '剧情', '萌系', '后宫', '超自然', '心理', '惊悚',
])

const MAX_GENRES = 8

function pickGenres(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const t of tags) {
    const name = typeof t === 'object' && t !== null ? String((t as { name?: unknown }).name ?? '') : ''
    if (name && GENRE_WHITELIST.has(name) && !out.includes(name)) {
      out.push(name)
      if (out.length >= MAX_GENRES) break
    }
  }
  return out
}

/**
 * Q3 裁定：书籍大类必须诚实标记。
 * kind='manga' → 固定「书籍（Bangumi）」，不因 type=1 有漫画就谎称"漫画"。
 */
function mapFormat(platform: unknown, kind: Kind): string {
  if (kind === 'manga') return '书籍（Bangumi）'
  const p = String(platform ?? '').trim()
  if (!p) return 'Bangumi'
  if (p === 'TV') return '电视动画'
  if (p === '剧场版') return '剧场版'
  if (p === 'OVA' || p === 'OAD') return 'OVA'
  if (p === 'WEB') return '网络动画'
  return p
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function strOrUndef(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s : undefined
}

function yearOf(date: unknown): number | undefined {
  const m = /^(\d{4})/.exec(String(date ?? ''))
  return m ? Number(m[1]) : undefined
}

function mapToWorkItem(d: any, kind: Kind): WorkItem | null {
  const id = d?.id
  if (id === undefined || id === null) return null
  const name = strOrUndef(d.name)
  const nameCn = strOrUndef(d.name_cn)
  // Q5：中文优先；无中文名回退日文，并如实标注语言
  const title = nameCn || name
  if (!title) return null

  return {
    sourceId: 'bangumi',
    workId: String(id),
    kind,
    title,
    titleNative: name || undefined,
    cover: normalizeCover(strOrUndef(d.images?.large) || strOrUndef(d.images?.common) || strOrUndef(d.image)),
    description: strOrUndef(d.summary),
    score: numOrUndef(d.rating?.score),
    year: yearOf(d.date),
    genres: pickGenres(d.tags),
    episodes: numOrUndef(d.eps) ?? numOrUndef(d.total_episodes),
    favorites: numOrUndef(d.collection?.collect),
    formatCn: mapFormat(d.platform, kind),
    titleLang: nameCn ? 'zh-hans' : 'ja',
    descLang: strOrUndef(d.summary) ? 'zh-hans' : undefined,
  }
}

/** 从 Bangumi infobox 提取制作公司（key 通常为「动画制作」/「製作」） */
function pickStudios(infobox: unknown): string[] {
  if (!Array.isArray(infobox)) return []
  const keys = new Set(['动画制作', '製作', '制作', '制作公司', '动画制作公司'])
  const out: string[] = []
  for (const item of infobox) {
    const key = String((item as { key?: unknown })?.key ?? '').trim()
    if (!keys.has(key)) continue
    const value = (item as { value?: unknown }).value
    const push = (v: unknown) => {
      const s = typeof v === 'string' ? v.trim() : ''
      if (s && !out.includes(s)) out.push(s)
    }
    if (Array.isArray(value)) value.forEach((v) => push(typeof v === 'object' && v !== null ? (v as { v?: unknown }).v : v))
    else push(value)
  }
  return out
}

const STAFF_KEYS: Array<[string, string]> = [
  ['原作', '原作'],
  ['导演', '导演'],
  ['脚本', '脚本'],
  ['音乐', '音乐'],
]

/** StaffRole 结构为 { role, name }（一角色一名字），多人时展开为多条 */
function pickStaff(infobox: unknown): StaffRole[] {
  if (!Array.isArray(infobox)) return []
  const out: StaffRole[] = []
  for (const [key, role] of STAFF_KEYS) {
    const item = infobox.find((i: any) => String(i?.key ?? '').trim() === key)
    if (!item) continue
    const value = (item as { value?: unknown }).value
    const names: string[] = []
    const push = (v: unknown) => {
      const s = typeof v === 'string' ? v.trim() : ''
      if (s && !names.includes(s)) names.push(s)
    }
    if (Array.isArray(value)) value.forEach((v) => push(typeof v === 'object' && v !== null ? (v as { v?: unknown }).v : v))
    else push(value)
    for (const name of names) out.push({ role, name })
  }
  return out
}

function mapToDetail(d: any, kind: Kind, workId: string): WorkDetail {
  const base = mapToWorkItem({ ...d, id: d?.id ?? workId }, kind)
  const title = base?.title ?? workId
  return {
    ...(base ?? {
      sourceId: 'bangumi',
      workId,
      kind,
      title,
      genres: [],
    }),
    studios: pickStudios(d.infobox),
    staff: pickStaff(d.infobox),
    volumes: numOrUndef(d.volumes),
    siteUrl: `https://bgm.tv/subject/${workId}`,
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

const bangumi: SourceAdapter = {
  id: 'bangumi',
  name: 'Bangumi',

  async search(o: SearchOptions): Promise<SearchResult> {
    const kw = (o.kw ?? '').trim()
    // 空关键词：不发起任何请求
    if (!kw) return { items: [], hasNext: false }

    // type: 1=书籍 2=动画（Bangumi 无独立"漫画"类型，Q3 已裁定如实标注）
    const type = o.kind === 'manga' ? 1 : 2
    const page = Math.max(1, Number(o.page) || 1)
    const offset = (page - 1) * PAGE_SIZE

    try {
      const json = await bgmPost(`/v0/search/subjects?limit=${PAGE_SIZE}&offset=${offset}`, {
        keyword: kw,
        filter: { type: [type] },
      })
      noteResult(true)
      const data: any[] = Array.isArray(json?.data) ? json.data : []
      const items = data.map((d) => mapToWorkItem(d, o.kind)).filter((x): x is WorkItem => x !== null)
      const total = Number(json?.total ?? 0)
      return { items, hasNext: offset + PAGE_SIZE < total }
    } catch (e) {
      noteResult(false)
      throw e
    }
  },

  async getDetail(kind: Kind, workId: string): Promise<WorkDetail> {
    try {
      const json = await bgmGet(`/v0/subjects/${encodeURIComponent(workId)}`)
      noteResult(true)
      return mapToDetail(json, kind, workId)
    } catch (e) {
      noteResult(false)
      throw e
    }
  },

  /**
   * Q4 裁定：不引入不必要的网络探活。
   * 只读取最近一次真实请求的结果；从未请求过时报告"未探测"（不悲观也不乐观地断言故障）。
   */
  async status(): Promise<{ ok: boolean; message?: string }> {
    if (lastResult === null) return { ok: true, message: '未探测（尚无请求记录）' }
    const age = Date.now() - lastResult.at
    if (age > STALE_MS) {
      return {
        ok: lastResult.ok,
        message: `信息陈旧（${Math.max(1, Math.round(age / 60000))} 分钟前）`,
      }
    }
    return { ok: lastResult.ok, message: lastResult.ok ? '最近请求成功' : '最近请求失败' }
  },
}

export default bangumi
