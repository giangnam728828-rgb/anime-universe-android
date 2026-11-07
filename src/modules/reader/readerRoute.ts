/**
 * 阅读路由与返回恢复（P1 第4子步）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件
 * ══════════════════════════════════════════════════════════════════════
 * 改造前存在三个问题（第4子步核查确认）：
 *   1. 路由只有 `/reader/:mangaId/:chapterId`，无法区分来源
 *   2. 三个入口**完全不传 state**，返回靠 `nav(-1)` 猜浏览器历史
 *   3. `nav(-1)` 在直接打开深链 / 刷新后不可靠
 *
 * 本文件集中定义：四段式路径构造、旧路由解析、返回目标校验。
 * **纯函数为主**，便于单测，不依赖 React 运行时。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 路由契约（用户裁定）
 * ══════════════════════════════════════════════════════════════════════
 *   新（四段）: /reader/:sourceId/:mangaId/:chapterId
 *   旧（三段）: /reader/:mangaId/:chapterId  → 重定向到 sourceId = 'local'
 *
 *   旧路由**只**映射到 `local`，绝不猜测成 mangadex 或其他在线来源。
 *   重定向必须保留查询参数（`?p=12`），并使用 `replace`。
 */

/** 本地导入漫画的来源标识 */
export const LOCAL_SOURCE_ID = 'local'

/** 返回 fallback：无有效来源时统一去书架页 */
export const READER_FALLBACK_PATH = '/library'

/* ══════════════════════════════════════════════════════════════════════
 * 路径构造
 * ══════════════════════════════════════════════════════════════════════ */

export interface ReaderPathArgs {
  sourceId: string
  mangaId: string
  chapterId: string
  /** 起始页码（0 基）。>0 时附加 `?p=` */
  page?: number
}

/**
 * 构造四段式阅读路径。
 *
 * 所有新入口**必须**用它，不再手拼旧格式。
 * 参数做 `encodeURIComponent`，避免 UUID 之外的字符（如 `/`）破坏路由。
 */
export function readerPath({ sourceId, mangaId, chapterId, page }: ReaderPathArgs): string {
  const base = `/reader/${encodeURIComponent(sourceId)}/${encodeURIComponent(mangaId)}/${encodeURIComponent(chapterId)}`
  return typeof page === 'number' && page > 0 ? `${base}?p=${page}` : base
}

/** 构造本地阅读路径（旧入口统一走这里） */
export function localReaderPath(mangaId: string, chapterId: string, page?: number): string {
  return readerPath({ sourceId: LOCAL_SOURCE_ID, mangaId, chapterId, page })
}

/* ══════════════════════════════════════════════════════════════════════
 * 旧路由解析（供 ReaderRedirect 使用）
 * ══════════════════════════════════════════════════════════════════════ */

export interface LegacyReaderTarget {
  sourceId: string
  mangaId: string
  chapterId: string
  /** 查询串（含前导 `?`），无参数时为空串 */
  search: string
}

/**
 * 把旧三段式参数转换为四段式目标。
 *
 * 🔴 只映射到 `local`。这是兼容层，不承担来源猜测职责。
 */
export function legacyReaderTarget(
  mangaId: string,
  chapterId: string,
  search = '',
): LegacyReaderTarget {
  return {
    sourceId: LOCAL_SOURCE_ID,
    mangaId,
    chapterId,
    search: search || '',
  }
}

/** 旧路由重定向的完整 URL（含保留的查询串） */
export function legacyReaderRedirectUrl(
  mangaId: string,
  chapterId: string,
  search = '',
): string {
  const t = legacyReaderTarget(mangaId, chapterId, search)
  const base = `/reader/${encodeURIComponent(t.sourceId)}/${encodeURIComponent(t.mangaId)}/${encodeURIComponent(t.chapterId)}`
  if (!t.search) return base
  // search 可能带或不带前导 '?'，统一补
  return t.search.startsWith('?') ? `${base}${t.search}` : `${base}?${t.search}`
}

/* ══════════════════════════════════════════════════════════════════════
 * 返回目标（state.from）校验
 * ══════════════════════════════════════════════════════════════════════ */

/** 允许作为返回目标的应用内路径前缀（白名单） */
const ALLOWED_FROM_PREFIXES = [
  '/favorites',
  '/library',
  '/local/',
  '/search',
  '/discovery',
  '/detail/',
  '/news',
  '/newsview/',
  '/news-sources',
  '/profile',
  '/perf',
  '/player/',
  '/',
] as const

/**
 * 校验 `state.from` 是否可作为返回目标。
 *
 * 🔴 安全边界（用户明确要求）：
 *   - 只接受**应用内路径**（以 `/` 开头）
 *   - 拒绝任何外部 URL（`http://`、`https://`、`//host`）
 *   - 拒绝 `javascript:` / `data:` 等危险协议
 *   - 拒绝回到阅读器自身（否则返回后仍在阅读器，形成死循环观感）
 *
 * @returns 可安全使用的路径；不合法时返回 null
 */
export function sanitizeFromPath(from: unknown): string | null {
  if (typeof from !== 'string' || !from) return null

  const v = from.trim()
  if (!v) return null

  // 必须是单斜杠开头的站内路径；`//` 是协议相对 URL，必须拒绝
  if (!v.startsWith('/') || v.startsWith('//')) return null

  // 拒绝任何含协议的字符串（防 `javascript:`、`data:`、`http:` 等）
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return null

  // 不允许回到阅读器自身（避免"返回"后仍在阅读器）
  const pathOnly = v.split('?')[0].split('#')[0]
  if (pathOnly === '/reader' || pathOnly.startsWith('/reader/')) return null

  // 白名单校验：去掉查询串后，必须命中已知页面前缀
  const hit = ALLOWED_FROM_PREFIXES.some((p) =>
    p === '/' ? pathOnly === '/' : (pathOnly === p.replace(/\/$/, '') || pathOnly.startsWith(p)),
  )
  if (!hit) return null

  return v
}

export type ReaderBackTarget =
  | { kind: 'from'; path: string }
  | { kind: 'fallback'; path: string }

/**
 * 决定返回目标。
 *
 * 用户裁定的规则表：
 *   从 FavoritesPage 进入   → 返回 FavoritesPage 原路径
 *   从 LibraryPage 进入     → 返回 LibraryPage 原路径
 *   从 LocalDetailPage 进入 → 返回原作品详情页
 *   直接打开 / 刷新         → fallback 到 /library
 *   state.from 无效         → fallback 到 /library
 *
 * 🔴 不依据浏览器历史长度猜测。
 */
export function resolveBackTarget(state: unknown): ReaderBackTarget {
  const from = (state as { from?: unknown } | null | undefined)?.from
  const safe = sanitizeFromPath(from)
  if (safe) return { kind: 'from', path: safe }
  return { kind: 'fallback', path: READER_FALLBACK_PATH }
}

/* ══════════════════════════════════════════════════════════════════════
 * 来源判定（阅读历史）
 * ══════════════════════════════════════════════════════════════════════ */

export type HistorySourceKind = 'local' | 'online' | 'unknown'

/**
 * 判定一条阅读历史的来源类型。
 *
 * 优先用新增的 `sourceId` 字段；
 * 旧记录（该字段为 undefined）回退到 `itemId` 前缀判断。
 *
 * 🔴 用户裁定：不迁移旧数据，旧记录必须继续可读。
 */
export function resolveHistorySource(item: {
  sourceId?: string
  itemId?: string
}): { kind: HistorySourceKind; sourceId?: string } {
  // 新记录：字段优先
  if (item.sourceId) {
    const s = item.sourceId
    if (s === LOCAL_SOURCE_ID) return { kind: 'local', sourceId: s }
    if (s === 'mangadex') return { kind: 'online', sourceId: s }
    // 其他来源（未来扩展）：按在线处理，但要能取出 sourceId
    return { kind: 'online', sourceId: s }
  }

  // 旧记录：前缀回退
  const id = item.itemId || ''
  if (id.startsWith('local-')) return { kind: 'local', sourceId: LOCAL_SOURCE_ID }
  if (id.startsWith('mangadex-')) return { kind: 'online', sourceId: 'mangadex' }

  return { kind: 'unknown' }
}

/**
 * 从历史记录取出 mangaId（去掉命名空间前缀）。
 *
 * - `local-abc`    → `abc`
 * - `mangadex-abc` → `abc`
 */
export function historyMangaId(itemId: string, sourceId?: string): string {
  const src = sourceId || (itemId.startsWith('local-') ? LOCAL_SOURCE_ID : '')
  if (src === LOCAL_SOURCE_ID && itemId.startsWith('local-')) return itemId.slice('local-'.length)
  if (src && itemId.startsWith(`${src}-`)) return itemId.slice(src.length + 1)
  if (itemId.startsWith('local-')) return itemId.slice('local-'.length)
  if (itemId.startsWith('mangadex-')) return itemId.slice('mangadex-'.length)
  return itemId
}

/**
 * 为一条阅读历史构造「继续阅读」路径。
 *
 * @returns 无法构造时返回 null（例如旧记录缺少 chapterId）
 */
export function historyReaderPath(h: {
  sourceId?: string
  itemId?: string
  chapterId?: string
  pageIndex?: number
}): string | null {
  if (!h.chapterId) return null
  const { kind, sourceId } = resolveHistorySource(h)
  if (kind === 'unknown') return null
  const mid = historyMangaId(h.itemId || '', sourceId)
  if (!mid) return null
  return readerPath({
    sourceId: sourceId || LOCAL_SOURCE_ID,
    mangaId: mid,
    chapterId: h.chapterId,
    page: h.pageIndex,
  })
}
