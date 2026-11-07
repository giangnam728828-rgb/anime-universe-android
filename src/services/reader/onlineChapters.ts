/**
 * 在线章节服务层（P1 第3子步）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 职责边界
 * ══════════════════════════════════════════════════════════════════════
 * 本文件**只做数据获取与规范化**，不碰 UI、不碰路由、不碰数据库。
 * ReaderPage 通过这里拿 Blob，自己管理 WINDOW=5 的懒加载窗口。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 核心设计：图片清单 与 图片字节 必须分离
 * ══════════════════════════════════════════════════════════════════════
 *    getOnlinePages(chapterId)   → 只拿「有哪些图、编号、URL」    ← 轻，1 次请求
 *    getOnlinePageBlob(url)      → 真正下载某一页的字节         ← 重，按需
 *
 * 为什么不能合并：
 *   一章可能有 40-80 张图，每张 300-800 KB。
 *   一次性下载整章 = 20-60 MB 内存，正是 WINDOW=5 想避免的。
 *   分离后，Reader 只在自己滚动到附近时才触发 getOnlinePageBlob。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 命名空间与旧数据兼容（本子步最重要的核对结论）
 * ══════════════════════════════════════════════════════════════════════
 * 现状（已核对全部源码）：
 *   - 本地阅读历史主键：`local-${mangaId}`（ReaderPage.tsx:97）
 *   - 进度恢复读取：    `local-${mangaId}`（ReaderPage.tsx:52）
 *   - 书架进度读取：    `local-${mangaId}`（LibraryPage.tsx:23）
 *   - 删除联动：        `local-${mangaId}`（db.ts:180）
 *   - 历史页「继续」：   `h.itemId.startsWith('local-')` + `replace('local-','')`
 *                        （FavoritesPage.tsx:86-88）
 *
 * 结论与决策：
 *   1. **旧键完全不动**。`local-` 命名空间由本地阅读独占，不迁移、不改写。
 *   2. 在线阅读使用**独立命名空间** `mangadex-${mangaId}`，
 *      与本地键天然不冲突（前缀不同）。
 *   3. FavoritesPage 的 `startsWith('local-')` 判断
 *      ⇒ **在线记录目前不会显示「继续」按钮**。
 *         这是一个已知的 UI 缺口，属第5子步（ReaderPage 接入）范围，
 *         本子步**不修改 FavoritesPage**，只在此明确记录。
 *   4. 章节身份：MangaDex 原生 `chapterId`（UUID）。
 *      同章不同语言/扫描组是**不同的 UUID**，因此天然独立，不会碰撞。
 *      但 `chapter` 编号会重复（实测 ch=111 有 2 版、ch=113 有 3 版），
 *      所以**绝不能用 chapter 编号做 key**。
 *
 *   与收藏模块的一致性：
 *     收藏已使用 `favKeyOf = ${sourceId}-${kind}-${workId}`（DetailPage.tsx:12），
 *     在线阅读的 `${sourceId}-${mangaId}` 与其格式一致，风格统一。
 */

import { getBinary, createLimiter, createInflight, type BinaryResult } from '../api/binaryHttp'
import { MANGADEX_USER_AGENT } from '../sources/mangadex'
import type { ChapterItem, PageItem } from '../sources/types'

/* ══════════════════════════════════════════════════════════════════════
 * 命名空间
 * ══════════════════════════════════════════════════════════════════════ */

/** 在线阅读的历史/进度主键前缀（与本地 `local-` 并列，互不干扰） */
export const ONLINE_ITEM_PREFIX = 'mangadex-'

/** 构造在线阅读项主键：mangadex-${mangaId} */
export function onlineItemId(mangaId: string): string {
  return `${ONLINE_ITEM_PREFIX}${mangaId}`
}

/** 判断一个历史记录主键是否属于在线阅读 */
export function isOnlineItemId(itemId: string): boolean {
  return itemId.startsWith(ONLINE_ITEM_PREFIX)
}

/** 判断一个历史记录主键是否属于本地阅读（供 UI 区分用） */
export function isLocalItemId(itemId: string): boolean {
  return itemId.startsWith('local-')
}

/**
 * 章节身份键：来源 + 作品 + 章节。
 *
 * 🔴 **不使用 chapter 编号**（实测同章号有多版本）。
 *    UUID 是 MangaDex 为每个语言/扫描组版本分配的独立 ID，
 *    天然唯一，是唯一可靠的章节身份。
 */
export function chapterKey(sourceId: string, mangaId: string, chapterId: string): string {
  return `${sourceId}:${mangaId}:${chapterId}`
}

/* ══════════════════════════════════════════════════════════════════════
 * 图片清单（轻量）
 * ══════════════════════════════════════════════════════════════════════ */

/** 规范化的图片条目：只有元数据，**没有字节** */
export interface OnlinePageRef {
  /** 0 基页码，与 Reader 的 `cur` 直接对应 */
  index: number
  /** 图片完整 URL（MangaDex @Home 节点） */
  url: string
  /** 1 基页码（给 UI 显示「3 / 48」用） */
  pageNo: number
}

export interface OnlinePagesResult {
  sourceId: string
  mangaId: string
  chapterId: string
  /** 总页数 */
  total: number
  /** 有序图片清单（不含字节） */
  pages: OnlinePageRef[]
}

/**
 * 获取章节的**图片清单**（不下载任何字节）。
 *
 * @param adapter 具备 getPages 的适配器（当前仅 mangadex）
 * @param chapterId MangaDex 原生 chapter UUID
 */
export async function getOnlinePages(
  adapter: { getPages?: (chapterId: string, opts?: { refresh?: boolean }) => Promise<PageItem[]> },
  sourceId: string,
  mangaId: string,
  chapterId: string,
  opts?: { refresh?: boolean },
): Promise<OnlinePagesResult> {
  if (typeof adapter.getPages !== 'function') {
    throw new Error(`来源 ${sourceId} 不支持章节图片`)
  }
  const raw = await adapter.getPages(chapterId, opts)
  const pages: OnlinePageRef[] = (raw || [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((p) => ({ index: p.index, url: p.url, pageNo: p.index + 1 }))

  return { sourceId, mangaId, chapterId, total: pages.length, pages }
}

/* ══════════════════════════════════════════════════════════════════════
 * 章节列表规范化
 * ══════════════════════════════════════════════════════════════════════ */

/** 规范化的在线章节：保留区分版本所需的全部字段 */
export interface OnlineChapter {
  /** MangaDex 原生 UUID —— 唯一身份 */
  id: string
  sourceId: string
  mangaId: string
  /** 章节号（可能为空、可能是小数如 "61.2"） */
  chapter: string
  volume?: string
  title: string
  /** 页数（0 表示未知；实测 feed.pages 准确） */
  pages: number
  /** 语言代码，如 zh / zh-hk / en */
  language: string
  /** 语言中文标签（供 UI 直接显示） */
  languageLabel: string
  /** 扫描组名（可能为 Unknown / 空） */
  group?: string
  /** 发布时间 ISO 字符串 */
  publishAt?: string
  /** 是否外部链接（不在 MangaDex 上，无法阅读） */
  external: boolean
}

/** 语言代码 → 中文标签（用户要求「章节列表明确显示语言」） */
const LANG_LABEL: Record<string, string> = {
  zh: '简体中文',
  'zh-hans': '简体中文',
  'zh-cn': '简体中文',
  'zh-hk': '繁体中文（港）',
  'zh-tw': '繁体中文（台）',
  'zh-hant': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  es: '西班牙语',
  'es-la': '西班牙语（拉美）',
  fr: '法语',
  de: '德语',
  it: '意大利语',
  pt: '葡萄牙语',
  'pt-br': '葡萄牙语（巴西）',
  ru: '俄语',
  vi: '越南语',
  id: '印尼语',
  th: '泰语',
  ar: '阿拉伯语',
  tr: '土耳其语',
  pl: '波兰语',
  uk: '乌克兰语',
  hu: '匈牙利语',
  nl: '荷兰语',
}

export function languageLabel(lang: string): string {
  return LANG_LABEL[lang] || lang || '未知语言'
}

/** 是否中文学科（简繁都算） */
export function isChineseLanguage(lang: string): boolean {
  return (lang || '').toLowerCase().startsWith('zh')
}

/**
 * 把 MangaDex 的 ChapterItem 规范化为 OnlineChapter。
 *
 * 🔴 不丢弃任何字段：
 *   - `chapter` 为 '-'（适配器对空编号的占位）时归一化为空串
 *   - `group` 为 Unknown / 空照样保留（结构一致性优先）
 *   - 同章多版本全部保留为独立条目（UUID 不同）
 *
 * ⚠️ `ChapterItem` 当前**没有** publishAt 字段（类型定义见 types.ts:61-73），
 *    因此 publishAt 恒为 undefined。排序时按「无时间」处理。
 *    若将来 adapter 补上该字段，此处需要同步更新类型。
 */
export function normalizeChapter(
  c: ChapterItem,
  mangaId: string,
  sourceId = 'mangadex',
): OnlineChapter {
  const lang = (c.translatedLanguage || '').toLowerCase()
  // 适配器把空章节号写成 '-'，这里归一化为空串，避免排序/显示时出现横线
  const rawCh = c.chapter === '-' ? '' : (c.chapter ?? '')
  return {
    id: c.id,
    sourceId,
    mangaId,
    chapter: rawCh,
    volume: c.volume,
    title: c.title === '(无标题)' ? '' : (c.title || ''),
    pages: typeof c.pages === 'number' ? c.pages : 0,
    language: lang,
    languageLabel: languageLabel(lang),
    group: c.group && c.group !== 'Unknown' ? c.group : undefined,
    external: !!c.externalUrl,
  }
}

/**
 * 排序：按章节号数值升序，**同章号内保持版本独立**。
 *
 * 🔴 用户明确要求：
 *   「同章多版本不能简单合并或随机取一个」
 *   「默认排序应避免不同语言、不同扫描组的版本混杂」
 *
 * 实现：
 *   - 主序：章节号数值（支持 61.2 这种小数）
 *   - 次序：语言（中文优先，便于中文用户）
 *   - 三序：发布时间（新的在前）
 *   - 绝不去重：UUID 不同的版本全部保留
 */
export function sortChapters(list: OnlineChapter[]): OnlineChapter[] {
  const num = (s: string): number => {
    const n = parseFloat(s)
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY  // 无编号排最后
  }
  const langRank = (l: string): number => {
    if (l === 'zh' || l === 'zh-hans' || l === 'zh-cn') return 0
    if (l.startsWith('zh')) return 1
    if (l === 'en') return 2
    return 3
  }
  return list.slice().sort((a, b) => {
    const d = num(a.chapter) - num(b.chapter)
    if (d !== 0) return d
    const l = langRank(a.language) - langRank(b.language)
    if (l !== 0) return l
    const ta = a.publishAt ? Date.parse(a.publishAt) : 0
    const tb = b.publishAt ? Date.parse(b.publishAt) : 0
    return tb - ta    // 新的在前
  })
}

/**
 * 按语言分组（供 UI 显示「简体 3 章 / 繁体 98 章 / 英语 205 章」）。
 * **不做过滤**，只是分组视图。
 */
export function groupByLanguage(list: OnlineChapter[]): Array<{
  language: string; label: string; count: number; chapters: OnlineChapter[]
}> {
  const map = new Map<string, OnlineChapter[]>()
  for (const c of list) {
    const arr = map.get(c.language) || []
    arr.push(c)
    map.set(c.language, arr)
  }
  const order = ['zh', 'zh-hans', 'zh-cn', 'zh-hk', 'zh-tw', 'zh-hant', 'en', 'ja']
  return Array.from(map.entries())
    .map(([language, chapters]) => ({
      language,
      label: languageLabel(language),
      count: chapters.length,
      chapters,
    }))
    .sort((a, b) => {
      const ia = order.indexOf(a.language)
      const ib = order.indexOf(b.language)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
}

/** 中文章节统计（供「没有中文章节」提示） */
export function chineseStats(list: OnlineChapter[]): {
  total: number
  chinese: number
  simplified: number
  traditional: number
  hasChinese: boolean
} {
  let simplified = 0
  let traditional = 0
  for (const c of list) {
    const l = c.language
    if (l === 'zh' || l === 'zh-hans' || l === 'zh-cn') simplified++
    else if (l.startsWith('zh')) traditional++
  }
  return {
    total: list.length,
    chinese: simplified + traditional,
    simplified,
    traditional,
    hasChinese: simplified + traditional > 0,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 图片字节下载（重量，按需）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * MangaDex 限流约 5 req/s/IP。
 * 图片下载用 4，给章节列表等其它请求留余量。
 */
const limiter = createLimiter(4)

/** 同一张图进行中的请求去重（快速来回滑动时避免重复下载） */
const inflight = createInflight()

export interface OnlineBlobResult {
  blob: Blob
  bytes: number
  mime: string
  /** 实际耗时（含排队） */
  ms: number
}

/**
 * 下载单页图片字节。
 *
 * 🔴 UA-4 的真实落点：这里必须原样传递 MangaDex 专用 UA。
 * ⚠️ 不缓存已完成的结果 —— 内存由 Reader 的 WINDOW=5 管理，
 *    本层只合并**进行中**的请求。
 */
export async function getOnlinePageBlob(
  url: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<OnlineBlobResult> {
  const t0 = Date.now()

  const run = (): Promise<BinaryResult> =>
    limiter(() =>
      getBinary(url, {
        userAgent: MANGADEX_USER_AGENT,   // ★ UA-4：API 与图片共用同一身份
        timeoutMs: opts?.timeoutMs ?? 20000,
        signal: opts?.signal,
        acceptMimePrefixes: ['image/'],
      }),
    )

  // 已取消的请求不进入去重表（避免把取消错误传染给并发调用者）
  if (opts?.signal?.aborted) {
    const r = await run()      // 让 getBinary 抛标准的 AbortError
    return { blob: r.blob, bytes: r.bytes, mime: r.mime, ms: Date.now() - t0 }
  }

  const r = await inflight(url, run)
  return {
    blob: r.blob,
    bytes: r.bytes,
    mime: r.mime,
    ms: Date.now() - t0,
  }
}

/**
 * 便捷：按页码取 Blob（Reader 懒加载窗口直接调用）。
 */
export async function getPageBlobByIndex(
  pages: OnlinePagesResult,
  index: number,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<OnlineBlobResult | null> {
  const p = pages.pages.find((x) => x.index === index)
  if (!p) return null
  return getOnlinePageBlob(p.url, opts)
}
