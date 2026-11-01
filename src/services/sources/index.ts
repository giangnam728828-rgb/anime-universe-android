/** 内容来源注册表：每来源独立适配器，单源故障不影响其他来源 */
import type { SourceAdapter, WorkItem } from './types'
import { normalizeCover } from '../../utils/cover'
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

/** 单源超时：源卡住时快速放弃（Kazumi 式体验——快源先出，慢源不拖整页） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('源超时')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/** 错误分类（P0：失败原因可观测，不笼统报"失败"） */
export function classifyError(e: unknown): 'timeout' | 'network_error' | 'http_error' | 'parse_error' | 'unavailable' {
  const msg = ((e as Error)?.message || String(e) || '').toLowerCase()
  if (msg.includes('源超时') || msg.includes('timeout') || msg.includes('abort')) return 'timeout'
  if (msg.includes('http 4') || msg.includes('http 5') || msg.includes('403') || msg.includes('429')) return 'http_error'
  if (msg.includes('json') || msg.includes('parse') || msg.includes('unexpected')) return 'parse_error'
  if (msg.includes('network') || msg.includes('ssl') || msg.includes('unreachable') || msg.includes('failed to fetch')) return 'network_error'
  return 'unavailable'
}

/** 统一出口规范化：封面 https 升级 + 去重（流式/聚合共用） */
function finish(items: WorkItem[]): WorkItem[] {
  return dedup(items.map((i) => (i.cover ? { ...i, cover: normalizeCover(i.cover) } : i)))
}

/**
 * 流式多来源聚合（P0 新增）：每源独立 8s 超时，**某源完成即回调 onBatch**，
 * 首页快源（AniList/B站 1~2s）先渲染，慢源（MangaDex）后到渐进补入，互不阻塞。
 * 返回各源失败原因（sourceId → 分类）。
 */
export async function searchAllStream(
  opts: { kw?: string; kind: WorkItem['kind']; genre?: string; sort?: string; page?: number },
  onBatch: (batch: WorkItem[], sourceId: string) => void,
): Promise<{ failed: Record<string, string> }> {
  const failed: Record<string, string> = {}
  await Promise.allSettled(
    SOURCES.map(async (s) => {
      try {
        const r = await withTimeout(s.search(opts), 8000)
        if (r.items.length) onBatch(finish(r.items), s.id)
      } catch (e) {
        failed[s.id] = classifyError(e)
      }
    }),
  )
  return { failed }
}

/** 多来源聚合搜索（一次性）：基于流式实现，兼容搜索页现有用法 */
export async function searchAll(opts: { kw?: string; kind: WorkItem['kind']; genre?: string; sort?: string; page?: number }): Promise<{ items: WorkItem[]; failed: string[] }> {
  const items: WorkItem[] = []
  const { failed } = await searchAllStream(opts, (batch) => items.push(...batch))
  return { items: finish(items), failed: Object.keys(failed).map((id) => SOURCE_NAMES[id] || id) }
}

export type { WorkItem, WorkDetail, SearchOptions, SearchResult, Kind } from './types'
