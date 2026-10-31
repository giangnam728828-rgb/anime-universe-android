/** 内容来源注册表：每来源独立适配器，单源故障不影响其他来源（阶段5扩展多来源） */
import type { SourceAdapter, WorkItem } from './types'
import anilist from './anilist'

export const SOURCES: SourceAdapter[] = [anilist]

export const SOURCE_NAMES: Record<string, string> = Object.fromEntries(SOURCES.map((s) => [s.id, s.name]))

export const getSource = (id: string): SourceAdapter => SOURCES.find((s) => s.id === id) ?? SOURCES[0]

/** 多来源结果去重（sourceId:workId 唯一键，阶段5多来源时生效） */
export function dedup(items: WorkItem[]): WorkItem[] {
  const seen = new Set<string>()
  return items.filter((i) => {
    const k = `${i.sourceId}:${i.workId}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export type { WorkItem, WorkDetail, SearchOptions, SearchResult, Kind } from './types'
