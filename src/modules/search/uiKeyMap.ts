/**
 * 会话级 UI Key 映射（阶段 3 · 第 3 步）
 *
 * 目的：为聚合组分配**跨批次稳定**的 React key。
 *
 * 为什么不能直接用 aggId 或 entries[0]：
 *  - aggId 每次 aggregate() 都新建 allocator，批次间可能重排（#2/#3 后缀重分配）。
 *  - entries[0] 也会变：新来源加入后，按 SOURCE_ORDER+byFixedKey 排序的首条目可能换人。
 * 两者都会导致 React 卸载重挂（卡片闪烁）。
 *
 * 本模块保存**上一轮完整的组快照**，按「条目集合交集」做
 * **确定性全局贪心一对一匹配**，保证：
 *  - 一个旧 key 最多分配给一个新组
 *  - 一个新组最多继承一个旧 key
 *  - 结果与 groups 遍历顺序无关
 *
 * 依赖前提（改动下列任一都会使 key 稳定性失效）：
 *  - aggregate() 对相同输入输出顺序固定（内部 groups.sort(byFixedKey)，全序）
 *  - byFixedKey 是全序（rank → compareRecord 18 字段）
 *  - 同一会话内 EntryId 全局唯一（dedupWithinSource 按 sourceId+kind+workId 分桶）
 */
import type { AggregatedWork, SourceEntry } from '../../services/sources/aggregate'
import { strCompare } from '../../services/sources/aggregate'

/** 条目稳定标识 */
export type EntryId = string

export interface PreviousGroup {
  uiKey: string
  entryIds: Set<EntryId>
  /** 上一轮组内排序首条（aggregate 输出序下的 entries[0]） */
  anchorEntryId: EntryId
  /** 上一轮在 aggregate() 输出中的下标，用于平局裁决 */
  previousOrder: number
}

export interface KeyedGroup {
  group: AggregatedWork
  uiKey: string
}

interface Candidate {
  oldIdx: number
  curIdx: number
  size: number
  oldOrder: number
  curOrder: number
  identity: string
}

function entryIdOf(e: SourceEntry): EntryId {
  return `${e.sourceId}\u0000${e.kind}\u0000${e.workId}`
}

function entryIdSet(g: AggregatedWork): Set<EntryId> {
  return new Set(g.entries.map(entryIdOf))
}

function anchorOf(g: AggregatedWork): EntryId {
  return g.entries.length > 0 ? entryIdOf(g.entries[0]) : ''
}

function intersectSize(a: Set<EntryId>, b: Set<EntryId>): number {
  let n = 0
  for (const id of a) if (b.has(id)) n++
  return n
}

export interface UiKeyMapper {
  /** 为一批聚合结果分配稳定 UI key */
  assign(groups: AggregatedWork[]): KeyedGroup[]
  /** 新搜索会话开始时调用（**不得**在每批次前调用） */
  reset(): void
  /** 调试快照 */
  snapshot(): PreviousGroup[]
}

export function createUiKeyMapper(): UiKeyMapper {
  let prev: PreviousGroup[] = []
  let counter = 0

  return {
    assign(groups: AggregatedWork[]): KeyedGroup[] {
      const cur = groups.map((g, i) => ({
        idx: i,
        ids: entryIdSet(g),
        order: i,
      }))

      const keyOfCur = new Map<number, string>()
      const keyTaken = new Set<string>() // 一个旧 key 最多给一个新组
      const curTaken = new Set<number>() // 一个新组最多拿一个旧 key

      // ---- Step 2：锚点候选收集 + 确定性全局贪心一对一裁决 ----
      const anchorCands: Candidate[] = []
      for (let oi = 0; oi < prev.length; oi++) {
        const a = prev[oi].anchorEntryId
        if (!a) continue
        for (const c of cur) {
          if (!c.ids.has(a)) continue
          anchorCands.push({
            oldIdx: oi,
            curIdx: c.idx,
            size: intersectSize(prev[oi].entryIds, c.ids),
            oldOrder: prev[oi].previousOrder,
            curOrder: c.order,
            identity: a,
          })
        }
      }
      // 四级排序：交集降序 → 新组序升序 → 旧组序升序 → 稳定身份码元序
      // 全序唯一，因此结果与数组遍历顺序无关
      anchorCands.sort(
        (x, y) =>
          y.size - x.size ||
          x.curOrder - y.curOrder ||
          x.oldOrder - y.oldOrder ||
          strCompare(x.identity, y.identity),
      )
      for (const cand of anchorCands) {
        if (curTaken.has(cand.curIdx)) continue
        const key = prev[cand.oldIdx].uiKey
        if (keyTaken.has(key)) continue
        keyOfCur.set(cand.curIdx, key)
        keyTaken.add(key)
        curTaken.add(cand.curIdx)
      }

      // ---- Step 3：剩余旧组 × 剩余新组，复用同一对集合 ----
      const remainingOldIndices = prev
        .map((g, i) => ({ g, i }))
        .filter(({ g }) => !keyTaken.has(g.uiKey))
        .map(({ i }) => i)
      const remainingCur = cur.filter((c) => !curTaken.has(c.idx))

      const cands: Candidate[] = []
      for (const oi of remainingOldIndices) {
        for (const c of remainingCur) {
          const size = intersectSize(prev[oi].entryIds, c.ids)
          if (size === 0) continue
          cands.push({
            oldIdx: oi,
            curIdx: c.idx,
            size,
            oldOrder: prev[oi].previousOrder,
            curOrder: c.order,
            identity: prev[oi].anchorEntryId || '',
          })
        }
      }
      cands.sort(
        (x, y) =>
          y.size - x.size ||
          x.curOrder - y.curOrder ||
          x.oldOrder - y.oldOrder ||
          strCompare(x.identity, y.identity),
      )
      for (const cand of cands) {
        if (curTaken.has(cand.curIdx)) continue
        const key = prev[cand.oldIdx].uiKey
        if (keyTaken.has(key)) continue
        keyOfCur.set(cand.curIdx, key)
        keyTaken.add(key)
        curTaken.add(cand.curIdx)
      }

      // ---- Step 4：无匹配的新组签发新 key ----
      for (const c of cur) {
        if (!keyOfCur.has(c.idx)) {
          counter += 1
          keyOfCur.set(c.idx, `ui-${counter}`)
        }
      }

      // ---- 保存本轮完整快照，作为下一轮匹配依据 ----
      prev = groups.map((g, i) => ({
        uiKey: keyOfCur.get(i) as string,
        entryIds: entryIdSet(g),
        anchorEntryId: anchorOf(g),
        previousOrder: i,
      }))

      return groups.map((g, i) => ({ group: g, uiKey: keyOfCur.get(i) as string }))
    },

    reset(): void {
      prev = []
      counter = 0
    },

    snapshot(): PreviousGroup[] {
      return prev.map((p) => ({ ...p, entryIds: new Set(p.entryIds) }))
    },
  }
}
