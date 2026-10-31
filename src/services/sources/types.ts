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

export interface SearchOptions {
  kw?: string
  kind: Kind
  genre?: string
  sort?: string
  page?: number
}

export interface SearchResult { items: WorkItem[]; hasNext: boolean }

export interface SourceAdapter {
  id: string
  name: string
  search(o: SearchOptions): Promise<SearchResult>
  getDetail(kind: Kind, workId: string): Promise<WorkDetail>
}
