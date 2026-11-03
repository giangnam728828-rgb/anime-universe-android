/** 内容来源注册表：每来源独立适配器，单源故障不影响其他来源 */
import type { WorkItem } from './types'
import { normalizeCover } from '../../utils/cover'
import { perf } from '../perf'
import { isHomeSkipped, recordHomeSuccess, recordHomeFailure } from './health'
import { SOURCE_ORDER, SOURCES, SOURCE_NAMES, getSource } from './registry'
import { isSourceEnabled } from './settings'

// 来源注册表已迁至 registry.ts（阶段 3 第 1 步）；此处转出保持既有 import 不变
export { SOURCE_ORDER, SOURCES, SOURCE_NAMES, getSource }
export { rank, UNKNOWN_RANK, enabledSources, isEnabled } from './registry'
export {
  isSourceEnabled,
  setSourceEnabled,
  setAllSourcesEnabled,
  getDisabledSources,
  resetSourceSettings,
} from './settings'

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
export interface StreamOptions {
  skipUnhealthy?: boolean
  /** 是否按用户开关过滤来源（首页路径传 true）；false/省略 = 不过滤（保持旧行为） */
  respectEnabled?: boolean
}

export async function searchAllStream(
  opts: { kw?: string; kind: WorkItem['kind']; genre?: string; sort?: string; page?: number },
  onBatch: (batch: WorkItem[], sourceId: string) => void,
  streamOpts?: StreamOptions,
): Promise<{ failed: Record<string, string> }> {
  const failed: Record<string, string> = {}
  // 开关过滤：被禁用的来源**完全不发起请求**（不进入 Promise.allSettled 的 map）
  const list = streamOpts?.respectEnabled ? SOURCES.filter((s) => isSourceEnabled(s.id)) : SOURCES
  await Promise.allSettled(
    list.map(async (s) => {
      // O1 健康记忆：仅首页路径（skipUnhealthy）生效——冷却中的来源直接跳过，不拖累首屏
      if (streamOpts?.skipUnhealthy && isHomeSkipped(s.id)) {
        perf({ phase: 'source-skip', sourceId: s.id, status: 'cache-hit', detail: '健康记忆跳过' })
        return
      }
      const t0 = Date.now() // 阶段2性能计时：每源独立（开始/结束/耗时/成败）
      try {
        const r = await withTimeout(s.search(opts), 8000)
        perf({ phase: 'source-request', sourceId: s.id, status: 'ok', ms: Date.now() - t0, detail: `${r.items.length}条` })
        if (streamOpts?.skipUnhealthy) recordHomeSuccess(s.id) // O1: 成功立即清零
        if (r.items.length) onBatch(finish(r.items), s.id)
      } catch (e) {
        const kind = classifyError(e)
        perf({ phase: 'source-request', sourceId: s.id, status: 'fail', ms: Date.now() - t0, detail: kind })
        if (streamOpts?.skipUnhealthy) recordHomeFailure(s.id, kind) // O1: 记录失败（取消不计——无取消路径即天然满足）
        failed[s.id] = kind
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
