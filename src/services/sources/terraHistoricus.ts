/**
 * 泰拉记事社 漫画适配器（阶段3·第4步）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 来源性质
 * ══════════════════════════════════════════════════════════════════════
 * 鹰角网络（Hypergryph，《明日方舟》开发商）官方免费漫画平台。
 *  - 无认证、无 VIP、无付费
 *  - robots.txt 重定向到首页 ⇒ 无爬虫限制
 *  - 大陆可达性：用户 vivo 浏览器实测「打得开」
 *
 * ⚠️ 已知不确定性（如实记录，不粉饰）：
 *    鹰角用户协议页由 JS 渲染，静态抓取为空，**条款内容未核实**。
 *    本适配器的准入依据是「robots 无限制 + 公开可访问 + 非盗版」，
 *    **不是**基于明确的第三方客户端授权。若将来确认条款禁止，
 *    应移除本适配器。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 三个必须处理的坑（实测发现，见 tests/terra_source.test.ts）
 * ══════════════════════════════════════════════════════════════════════
 *  1. `episodes` 是**倒序**返回的（如 ['03','02','01']）
 *     ⇒ 必须升序排序，否则阅读顺序颠倒
 *  2. 有**两个** topicKey（terra-historicus 22 部 + talos-ii-historicus 6 部）
 *     ⇒ 只取一个会漏掉内容；合并后需按 cid 去重
 *  3. 图片 URL 是**时效签名**（实测同一 URL 4 小时后 403，重取即 200）
 *     ⇒ 绝不缓存签名 URL；每次 getPages 实时取
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 本批次**未**接通的能力（不得宣称已完成）
 * ══════════════════════════════════════════════════════════════════════
 *  - **403 自动刷新签名**：`getPages(chapterId, { refresh: true })` 已按契约实现，
 *    但基线 `useOnlineWindow.ts:263` 的 `retry()` 实际执行
 *    `dispatch(index, ref.url, 20000)`，即**重新下载原 URL**，
 *    并未调用 `getPages({ refresh })`。因此签名失效时的单页自动重试
 *    **在真实阅读链路中尚未接通**，需单独批准修改阅读链路。
 *  - **阅读方向与跨页排版**：接口返回 `direction` / `readConfig` /
 *    `pageInfos[].doublePage`，但现有 `WorkDetail` / `ChapterItem` / `PageItem`
 *    均无对应字段，`ReaderPage` 也不消费。本批次**不解冻阅读器核心**，
 *    故这些字段**不传递**，日漫式右起排版与跨页图排版待后续兼容任务。
 */
import { httpGetText } from '../api/nativeHttp'
import type {
  SourceAdapter,
  WorkItem,
  WorkDetail,
  SearchOptions,
  SearchResult,
  Kind,
  ChapterItem,
  PageItem,
} from './types'

const BASE = 'https://comic.hypergryph.com'

/** 来源 id（与 SOURCE_ORDER 的键一致） */
export const TERRA_SOURCE_ID = 'terra-historicus'

/**
 * 🔴 两个 topicKey 都要取。
 * 主题 = 作品分类，不是分页。只取一个会漏内容（实测 22 + 6 = 28 部）。
 */
const TOPIC_KEYS = ['terra-historicus', 'talos-ii-historicus'] as const

/** 取签名 URL 的并发上限（实测 8 路取 61 页 = 1.29s，无限流） */
const PAGE_CONCURRENCY = 8

/** 请求超时 */
const TIMEOUT_MS = 10000

/**
 * 如实描述自身的 UA。
 * 与 MangaDex 适配器同样的理由：不用浏览器伪装 UA，不声明无关用途。
 */
export const TERRA_USER_AGENT = 'AnimeUniverse/0.6 (manga reader)'

function terraHeaders(): Record<string, string> {
  return { 'User-Agent': TERRA_USER_AGENT }
}

/* ══════════════════════════════════════════════════════════════════════
 * 接口层
 * ══════════════════════════════════════════════════════════════════════ */

/** 泰拉接口统一响应包装 */
interface TerraResponse<T> {
  code: number
  data?: T
  msg?: string
}

/** 列表项 */
interface TerraListItem {
  cid: string
  type: number
  cover: string
  title: string
  subtitle: string | null
  authors: string[]
}

/** 章节项 */
interface TerraEpisode {
  cid: string
  type: number
  shortTitle: string
  title: string
  displayTime: number
}

/** 作品详情 */
interface TerraDetail {
  cid: string
  cover: string
  title: string
  subtitle: string | null
  authors: string[]
  keywords?: string[]
  introduction?: string
  direction?: string
  episodes?: TerraEpisode[]
}

/** 章节图片信息 */
interface TerraPageInfo {
  width: number
  height: number
  doublePage: boolean
}

/**
 * GET 一个泰拉接口。
 *
 * 🔴 不重试、不缓存。失败原样抛错，由上层决定返回空还是报错。
 * 缓存会破坏签名 URL 的实时性，因此这里**刻意不做任何缓存**。
 */
async function terraGet<T>(path: string): Promise<T> {
  const r = await httpGetText(`${BASE}${path}`, TIMEOUT_MS, terraHeaders())
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
  const json = JSON.parse(r.text) as TerraResponse<T>
  if (json.code !== 0) throw new Error(json.msg || `接口错误 code=${json.code}`)
  if (json.data === undefined || json.data === null) throw new Error('接口返回空数据')
  return json.data
}

/* ══════════════════════════════════════════════════════════════════════
 * 数据映射
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 列表项 → WorkItem。
 *
 * 🔴 注意 WorkItem **没有** `authors` 字段，作者信息放入 `description`，
 *    避免用 `as` 强转掩盖类型差异（强转会被 tsc 拒绝，也会骗过调用方）。
 */
function mapWork(item: TerraListItem): WorkItem {
  const authors = item.authors || []
  return {
    workId: item.cid,
    sourceId: TERRA_SOURCE_ID,
    kind: 'manga',
    title: item.title,
    cover: item.cover,
    description: authors.join(' / ') || undefined,
    genres: [],
    titleLang: 'zh',
    descLang: 'zh',
  }
}

/**
 * 章节排序：**升序**。
 *
 * 🔴 接口实测返回倒序（['03','02','01']），直接使用会导致阅读顺序颠倒。
 * 优先按 shortTitle 数字排序；无法解析时回退 displayTime 升序。
 */
export function sortEpisodesAsc(eps: TerraEpisode[]): TerraEpisode[] {
  return [...eps].sort((a, b) => {
    const na = Number(a.shortTitle)
    const nb = Number(b.shortTitle)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return (a.displayTime ?? 0) - (b.displayTime ?? 0)
  })
}

/**
 * 章节 → ChapterItem。
 *
 * 🔴 `getPages(chapterId)` 只收到一个字符串，但取签名 URL 需要
 *    `cid`（作品）与 `eid`（章节）两个值 ⇒ 用 `cid/eid` 复合格式。
 *    `readerPath()` 会对 chapterId 做 encodeURIComponent（`/` → `%2F`），
 *    路由格式无需改动。
 */
function mapChapter(ep: TerraEpisode, workId: string): ChapterItem {
  return {
    id: `${workId}/${ep.cid}`,
    sourceId: TERRA_SOURCE_ID,
    workId,
    title: ep.title || ep.shortTitle || '(无标题)',
    chapter: ep.shortTitle || '-',
    pages: 0, // 页数需另请求章节接口；此处不额外发请求
    translatedLanguage: 'zh',
  }
}

/** 解析 `cid/eid` 复合 chapterId */
export function parseChapterId(chapterId: string): { cid: string; eid: string } | null {
  const i = chapterId.indexOf('/')
  if (i <= 0 || i === chapterId.length - 1) return null
  const cid = chapterId.slice(0, i)
  const eid = chapterId.slice(i + 1)
  if (!cid || !eid) return null
  return { cid, eid }
}

/**
 * 有界并发映射。
 *
 * 🔴 并发上限固定，不随页数增长。
 *   实测 61 页 / 8 路 = 1.29 秒，服务端无限流。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/* ══════════════════════════════════════════════════════════════════════
 * 适配器
 * ══════════════════════════════════════════════════════════════════════ */

const terraHistoricus: SourceAdapter = {
  id: TERRA_SOURCE_ID,
  name: '泰拉记事社',

  /**
   * 搜索。
   *
   * 泰拉无搜索接口 ⇒ 拉两个主题的完整列表（28 部）后**本地过滤**。
   * 列表接口一次返回全部，无需分页。
   */
  async search(opts: SearchOptions): Promise<SearchResult> {
    const all = await loadAllWorks()
    const kw = opts.kw?.trim().toLowerCase()
    const items = kw
      ? all.filter(
          (w) =>
            w.title.toLowerCase().includes(kw) ||
            (w.description || '').toLowerCase().includes(kw),
        )
      : all
    return { items, hasNext: false }
  },

  async getDetail(_kind: Kind, workId: string): Promise<WorkDetail> {
    const d = await terraGet<TerraDetail>(`/api/comic/${encodeURIComponent(workId)}`)
    const chapters = sortEpisodesAsc(d.episodes || []).map((ep) => mapChapter(ep, workId))
    const authors = d.authors || []
    return {
      workId: d.cid,
      sourceId: TERRA_SOURCE_ID,
      kind: 'manga',
      title: d.title,
      cover: d.cover,
      description: d.introduction || authors.join(' / ') || undefined,
      genres: d.keywords || [],
      chapters: chapters.length,
      titleLang: 'zh',
      descLang: 'zh',
      studios: [],
      staff: authors.map((name) => ({ role: '作者', name })),
      siteUrl: `${BASE}/terra-historicus/comic/${d.cid}`,
    }
  },

  /**
   * 章节列表：升序返回。
   *
   * 泰拉一次返回全部章节，不支持游标；`limit`/`cursor` 仅做本地切片。
   */
  async getChapters(
    workId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{ chapters: ChapterItem[]; nextCursor?: string; hasNext: boolean }> {
    const d = await terraGet<TerraDetail>(`/api/comic/${encodeURIComponent(workId)}`)
    const all = sortEpisodesAsc(d.episodes || []).map((ep) => mapChapter(ep, workId))
    const offset = options?.cursor ? Number(options.cursor) || 0 : 0
    const limit = options?.limit ?? all.length
    const slice = all.slice(offset, offset + limit)
    const next = offset + slice.length
    return {
      chapters: slice,
      nextCursor: next < all.length ? String(next) : undefined,
      hasNext: next < all.length,
    }
  },

  /**
   * 章节图片。
   *
   * 🔴 两段式，且**必须实时**：
   *    1. `/api/comic/{cid}/episode/{eid}` → pageInfos（只有尺寸，无 URL）
   *    2. 每页 `/page?pageNum=N` → 签名 URL
   *
   * 签名 URL 有时效（实测 4 小时后 403，重取即 200），
   * 因此**绝不缓存 URL**。每次调用都重新取全部签名。
   *
   * @param options.refresh 契约要求：图片 403/404 时由调用方触发重取。
   *   本适配器无论 refresh 与否都实时取（因为不缓存），
   *   refresh 参数保留以符合接口契约。
   *
   * ⚠️ 已知缺口：基线 `useOnlineWindow.ts` 的 `retry()` 并不会调用本方法
   *    带 refresh，因此「单页 403 自动刷新」在真实链路中尚未接通。
   */
  async getPages(
    chapterId: string,
    _options?: { refresh?: boolean },
  ): Promise<PageItem[]> {
    const parsed = parseChapterId(chapterId)
    if (!parsed) return []
    const { cid, eid } = parsed

    // 第一步：取页面数量与尺寸
    const info = await terraGet<{ pageInfos?: TerraPageInfo[] }>(
      `/api/comic/${encodeURIComponent(cid)}/episode/${encodeURIComponent(eid)}`,
    )
    const infos = info.pageInfos || []
    if (infos.length === 0) return []

    // 第二步：有界并发取每页签名 URL
    const urls = await mapWithConcurrency(
      infos,
      PAGE_CONCURRENCY,
      async (_info, i): Promise<string> => {
        const r = await terraGet<{ url?: string }>(
          `/api/comic/${encodeURIComponent(cid)}/episode/${encodeURIComponent(eid)}/page?pageNum=${i + 1}`,
        )
        const url = r.url
        if (!url) throw new Error(`第 ${i + 1} 页无 URL`)
        return url
      },
    )

    return urls.map((url, index) => ({
      index,
      url,
      width: infos[index]?.width,
      height: infos[index]?.height,
    }))
  },

  /** 可用性检测：拉列表接口探活 */
  async status(): Promise<{ ok: boolean; message?: string }> {
    try {
      const d = await terraGet<TerraListItem[]>(
        `/api/comic?topicKey=${TOPIC_KEYS[0]}`,
      )
      return { ok: Array.isArray(d) }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  },
}

/**
 * 拉取两个主题的完整作品列表，按 cid 去重。
 *
 * 🔴 去重是必要的：两个主题理论上可能交叉收录同一作品。
 *    以 cid 为唯一键，先到先得。
 */
export async function loadAllWorks(): Promise<WorkItem[]> {
  const seen = new Set<string>()
  const out: WorkItem[] = []
  for (const tk of TOPIC_KEYS) {
    const list = await terraGet<TerraListItem[]>(`/api/comic?topicKey=${tk}`)
    for (const item of list || []) {
      if (!item?.cid || seen.has(item.cid)) continue
      seen.add(item.cid)
      out.push(mapWork(item))
    }
  }
  return out
}

/** 仅测试用：导出主题键与并发上限，供断言引用 */
export const __terraInternals = {
  TOPIC_KEYS,
  PAGE_CONCURRENCY,
  BASE,
} as const

export default terraHistoricus
