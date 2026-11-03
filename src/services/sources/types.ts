/** 统一数据格式 —— 所有内容来源适配为该格式（规划书 4.4/六） */
export type Kind = 'anime' | 'manga'

export interface WorkItem {
  sourceId: string
  workId: string
  kind: Kind
  title: string
  titleNative?: string
  cover?: string
  coverColor?: string
  description?: string
  score?: number
  year?: number
  genres: string[]
  statusCn?: string
  formatCn?: string
  /** 标题/简介语言标注（来源无中文字段时提示用户，如 'ja'/'en'/'zh-hans'） */
  titleLang?: string
  descLang?: string
  episodes?: number
  chapters?: number
  favorites?: number
}

export interface StaffRole { role: string; name: string }

export interface WorkDetail extends WorkItem {
  studios: string[]
  staff: StaffRole[]
  volumes?: number
  duration?: number
  siteUrl?: string
}

/**
 * 适配器级请求策略（阶段3第6步）。
 * 只有调用方**显式**传入时才覆盖 HTTP 层默认值；不传 = 完全维持原行为。
 * 作用域仅限 `search()`，**不作用于 `getDetail()`**。
 */
export interface SourceRequestPolicy {
  /** 底层单次请求超时（毫秒）。省略 = HTTP 层默认 10000 */
  timeoutMs?: number
  /** 底层重试次数。省略 = HTTP 层默认 1 */
  retries?: number
}

export interface SearchOptions {
  kw?: string
  kind: Kind
  genre?: string
  sort?: string
  page?: number
  /** 阶段3第6步：发现页专用请求策略；其他调用方不传 → 行为逐字不变 */
  reqPolicy?: SourceRequestPolicy
}

export interface SearchResult { items: WorkItem[]; hasNext: boolean }

/** 章节条目：sourceId+workId+id 唯一定位（架构 6.4.2.1 验收通过） */
export interface ChapterItem {
  id: string
  sourceId: string
  workId: string
  title: string
  chapter: string
  volume?: string
  pages: number
  translatedLanguage: string
  group?: string
  externalUrl?: string
}

/** 章节图片：由对应适配器返回，无需每图携带来源 ID */
export interface PageItem {
  index: number
  url: string
  width?: number
  height?: number
}

/** 来源可用性检测结果 */
export interface SourceStatus { ok: boolean; message?: string }

export interface SourceAdapter {
  id: string
  name: string
  search(o: SearchOptions): Promise<SearchResult>
  getDetail(kind: Kind, workId: string): Promise<WorkDetail>

  // --- 漫画阅读链路（可选实现；架构 6.4.2.1 通过） ---
  /**
   * 章节列表：支持分页（limit/offset 游标），返回汉化组与语言标识。
   * 适配器内部需处理语言可用性（如部分语言码服务端 400 时降级为客户端排序）。
   */
  getChapters?(workId: string, options?: { limit?: number; cursor?: string }): Promise<{
    chapters: ChapterItem[]
    nextCursor?: string
    hasNext: boolean
  }>
  /** 章节图片：getPages 每次返回最新服务器地址；调用方加载 403/404 可带 refresh 强制刷新重试一次 */
  getPages?(chapterId: string, options?: { refresh?: boolean }): Promise<PageItem[]>
  /** 来源可用性检测（如 /ping） */
  status?(): Promise<SourceStatus>
}
