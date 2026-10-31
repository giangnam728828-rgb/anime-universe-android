/** 内容来源注册表：每来源独立适配器，单源故障不影响其他来源 */
import type { SourceAdapter, WorkItem } from './types'
import anilist from './anilist'
import jikan from './jikan'
import bilibili from './bilibili'
import mangadex from './mangadex'

/** 聚合结果排序：中文优先（bilibili 中文动漫 → mangadex 中文别名漫画 → AniList → Jikan） */
export const SOURCE_ORDER: Record<string, number> = { bilibili: 0, mangadex: 1, anilist: 2, jikan: 3 }

export const SOURCES: SourceAdapter[] = [bilibili, mangadex, anilist, jikan]

export const SOURCE_NAMES: Record<string, string> = Object.fromEntries(SOURCES.map((s) => [s.id, s.name]))

export const getSource = (id: string): SourceAdapter => SOURCES.find((s) => s.id === id) ?? SOURCES[0]

/** 多来源去重：同源按 sourceId:workId；跨源按 归一化标题+类型 合并（保留优先来源） */
export function dedup(items: WorkItem[]): WorkItem[] {
  const seenKey = new Set<string>()
  const seenTitle = new Set<string>()
  const sorted = [...items].sort((a, b) => (SOURCE_ORDER[a.sourceId] ?? 9) - (SOURCE_ORDER[b.sourceId] ?? 9))
  return sorted.filter((i) => {
    const k = `${i.sourceId}:${i.workId}`
    if (seenKey.has(k)) return false
    seenKey.add(k)
    const t = (i.title || '').toLowerCase().replace(/[\s:：·・'\-]+/g, '')
    const tk = `${i.kind}:${t}`
    if (t && seenTitle.has(tk)) return false
    seenTitle.add(tk)
    return true
  })
}

/** 多来源聚合搜索：Promise.allSettled，单源失败不影响整体 */
export async function searchAll(opts: { kw?: string; kind: WorkItem['kind']; genre?: string; sort?: string; page?: number }): Promise<{ items: WorkItem[]; failed: string[] }> {
  const rs = await Promise.allSettled(SOURCES.map((s) => s.search(opts)))
  const items: WorkItem[] = []
  const failed: string[] = []
  rs.forEach((r, idx) => {
    if (r.status === 'fulfilled') items.push(...r.value.items)
    else failed.push(SOURCES[idx].name)
  })
  return { items: dedup(items), failed }
}

export type { WorkItem, WorkDetail, SearchOptions, SearchResult, Kind } from './types'
