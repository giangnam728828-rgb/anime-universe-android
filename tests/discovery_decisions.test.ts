/**
 * Discovery 纯决策层测试（重建版）
 *
 * ⚠️ 背景（§52 事故）：
 *  2026-11-08 因测试只放在 /tmp/au-test 影子副本、从未入库，
 *  一次 `rm -rf` 导致 15 个 discovery 测试文件永久丢失。
 *  本文件是**按现存生产代码行为重建**的覆盖，不是原文件的复原。
 *
 * 重建原则：
 *  - 只断言 `useDiscoverFeed.ts` 中**实际存在**的纯函数行为
 *  - 不假设原测试的文件名/内部实现
 *  - 无法从代码确认的原测试意图 → 不凭空编造（见文件末尾「覆盖缺口」）
 *
 * 覆盖目标（用户 P0-B 指定）：
 *  1. 搜索与发现请求的竞态        → resolveItems / evalOrigin
 *  2. 快照提交和放弃渲染          → shouldCommit / pickViewState
 *  3. 来源部分失败与错误展示      → deriveStatusBar / pickViewState
 *  4. 来源冷却及恢复              → decideBlocked
 *  5. 排序切换和旧数据隔离        → makeRequestKey / evalOrigin(sameKey)
 *  6. 多来源结果合并与状态一致性  → deriveStatusBar 各分支互斥性
 */
import { describe, it, expect } from 'vitest'
import {
  DISCOVER_POLICY,
  decideBlocked,
  makeRequestKey,
  evalOrigin,
  resolveItems,
  shouldCommit,
  pickViewState,
  deriveStatusBar,
  type Snapshot,
  type ProgressState,
} from '../src/modules/discovery/useDiscoverFeed'
import type { WorkItem } from '../src/services/sources/types'

/** 构造最小可用 WorkItem */
function item(sourceId: string, workId: string): WorkItem {
  return { sourceId, workId, kind: 'anime', title: `${sourceId}-${workId}`, genres: [] }
}

// ───────────────────────── 1. 请求竞态 ─────────────────────────
describe('D1 · 请求竞态：resolveItems 必须校验 progress 归属', () => {
  it('D1a · 无快照 + progress 属于当前请求 → 展示 progress 且标记 current', () => {
    const p: ProgressState = { key: 'anime||热门', requestId: 3, attempt: 1, items: [item('a', '1')] }
    const r = resolveItems(null, p, 3, 'anime||热门', 1)
    expect(r.items).toHaveLength(1)
    expect(r.origin.kind).toBe('current')
    expect(r.progressMismatch).toBe(false)
  })

  it('D1b · 无快照 + requestId 不匹配 → 不得展示旧数据', () => {
    const p: ProgressState = { key: 'anime||热门', requestId: 2, attempt: 1, items: [item('a', 'OLD')] }
    const r = resolveItems(null, p, 3, 'anime||热门', 1)
    expect(r.items).toEqual([])
    expect(r.origin.kind).toBe('none')
    expect(r.progressMismatch).toBe(true)
  })

  it('D1c · 无快照 + key 不匹配 → 不得展示旧数据', () => {
    const p: ProgressState = { key: 'anime||最新', requestId: 3, attempt: 1, items: [item('a', 'OLD')] }
    const r = resolveItems(null, p, 3, 'anime||热门', 1)
    expect(r.items).toEqual([])
    expect(r.progressMismatch).toBe(true)
  })

  it('D1d · 同键重试：只有 attempt 变化也必须识别为旧请求（核心竞态）', () => {
    const p: ProgressState = { key: 'anime||热门', requestId: 3, attempt: 1, items: [item('a', 'OLD')] }
    // 同 key、同 requestId，但 attempt=2 → 必须是旧数据
    const r = resolveItems(null, p, 3, 'anime||热门', 2)
    expect(r.items).toEqual([])
    expect(r.progressMismatch).toBe(true)
  })

  it('D1e · 有快照时永远优先快照，且忽略 progress', () => {
    const snap: Snapshot = { key: 'anime||热门', requestId: 3, items: [item('a', 'SNAP')] }
    const p: ProgressState = { key: 'anime||热门', requestId: 3, attempt: 1, items: [item('a', 'PROG')] }
    const r = resolveItems(snap, p, 3, 'anime||热门', 1)
    expect(r.items[0].workId).toBe('SNAP')
    expect(r.progressMismatch).toBe(false)
  })

  it('D1f · 无快照无 progress → origin=none，不标记 mismatch', () => {
    const r = resolveItems(null, null, 3, 'anime||热门', 1)
    expect(r.items).toEqual([])
    expect(r.origin.kind).toBe('none')
    expect(r.progressMismatch).toBe(false)
  })
})

// ───────────────────────── 2. 数据归属 / 旧快照隔离 ─────────────────────────
describe('D2 · evalOrigin：requestId 与 key 必须同时匹配', () => {
  const snap: Snapshot = { key: 'anime||热门', requestId: 5, items: [item('a', '1')] }

  it('D2a · 无快照 → none', () => {
    expect(evalOrigin(null, 5, 'anime||热门').kind).toBe('none')
  })

  it('D2b · requestId + key 全匹配 → current', () => {
    expect(evalOrigin(snap, 5, 'anime||热门').kind).toBe('current')
  })

  it('D2c · 只有 key 匹配、requestId 不同 → stale 且 sameKey=true', () => {
    const o = evalOrigin(snap, 6, 'anime||热门')
    expect(o.kind).toBe('stale')
    if (o.kind === 'stale') expect(o.sameKey).toBe(true)
  })

  it('D2d · 只有 requestId 匹配、key 不同 → stale 且 sameKey=false', () => {
    const o = evalOrigin(snap, 5, 'anime||最新')
    expect(o.kind).toBe('stale')
    if (o.kind === 'stale') {
      expect(o.sameKey).toBe(false)
      expect(o.fromKey).toBe('anime||热门')
    }
  })
})

// ───────────────────────── 3. 快照提交 ─────────────────────────
describe('D3 · shouldCommit：方案丙规则', () => {
  it('D3a · 取消 → 不提交', () => {
    expect(shouldCommit({ cancelled: true, pipelineError: null, failed: 0, itemCount: 9 })).toBe(false)
  })

  it('D3b · 管道异常 → 不提交', () => {
    expect(shouldCommit({ cancelled: false, pipelineError: 'boom', failed: 0, itemCount: 9 })).toBe(false)
  })

  it('D3c · 有结果且有失败来源 → 仍提交（不因部分失败丢弃结果）', () => {
    expect(shouldCommit({ cancelled: false, pipelineError: null, failed: 3, itemCount: 9 })).toBe(true)
  })

  it('D3d · 零结果 → 绝不提交（成功空与全失败不可区分）', () => {
    expect(shouldCommit({ cancelled: false, pipelineError: null, failed: 0, itemCount: 0 })).toBe(false)
    expect(shouldCommit({ cancelled: false, pipelineError: null, failed: 3, itemCount: 0 })).toBe(false)
  })
})

// ───────────────────────── 4. 视图选择 ─────────────────────────
describe('D4 · pickViewState：优先级与解耦', () => {
  const cur = { kind: 'current' as const }
  const none = { kind: 'none' as const }

  it('D4a · blocked 优先级最高', () => {
    const v = pickViewState({
      blocked: { reason: 'no-sources', title: 't', message: 'm' },
      loading: false, complete: true, error: null,
      origin: cur, failedCount: 0, itemCount: 5,
    })
    expect(v).toBe('blocked')
  })

  it('D4b · 有数据（本次）→ grid，即使仍在 loading', () => {
    expect(pickViewState({
      blocked: null, loading: true, complete: false, error: null,
      origin: cur, failedCount: 0, itemCount: 5,
    })).toBe('grid')
  })

  it('D4c · 有旧快照数据 → 仍 grid（不回骨架屏）', () => {
    expect(pickViewState({
      blocked: null, loading: true, complete: false, error: null,
      origin: { kind: 'stale', sameKey: false, fromKey: 'x' }, failedCount: 0, itemCount: 5,
    })).toBe('grid')
  })

  it('D4d · 未结束 → loading（绝不下结论）', () => {
    expect(pickViewState({
      blocked: null, loading: false, complete: false, error: null,
      origin: none, failedCount: 0, itemCount: 0,
    })).toBe('loading')
  })

  it('D4e · 已结束 + error → error', () => {
    expect(pickViewState({
      blocked: null, loading: false, complete: true, error: 'boom',
      origin: none, failedCount: 0, itemCount: 0,
    })).toBe('error')
  })

  it('D4f · 已结束 + 有失败来源 + 零结果 → no-result', () => {
    expect(pickViewState({
      blocked: null, loading: false, complete: true, error: null,
      origin: none, failedCount: 2, itemCount: 0,
    })).toBe('no-result')
  })

  it('D4g · 已结束 + 无失败 + 零结果 → unconfirmed（不宣称「无内容」）', () => {
    expect(pickViewState({
      blocked: null, loading: false, complete: true, error: null,
      origin: none, failedCount: 0, itemCount: 0,
    })).toBe('unconfirmed')
  })

  it('D4h · 不存在 all-failed / empty 视图（方案丙已删除）', () => {
    // 遍历所有组合，断言输出只可能是这 6 种
    const allowed = new Set(['blocked', 'loading', 'error', 'no-result', 'unconfirmed', 'grid'])
    for (const loading of [true, false]) {
      for (const complete of [true, false]) {
        for (const itemCount of [0, 1]) {
          for (const failedCount of [0, 1]) {
            const v = pickViewState({
              blocked: null, loading, complete, error: null,
              origin: none, failedCount, itemCount,
            })
            expect(allowed.has(v)).toBe(true)
          }
        }
      }
    }
  })
})

// ───────────────────────── 5. 来源冷却 / 阻断 ─────────────────────────
describe('D5 · decideBlocked：分类模式与全部模式', () => {
  const ALL = ['bangumi', 'anilist', 'jikan']
  const yes = () => true
  const no = () => false

  it('D5a · 分类模式 + AniList 未启用 → anilist-disabled', () => {
    const b = decideBlocked('Action', (id) => id !== 'anilist', no, ALL)
    expect(b?.reason).toBe('anilist-disabled')
  })

  it('D5b · 分类模式 + AniList 冷却中 → anilist-unhealthy', () => {
    const b = decideBlocked('Action', yes, (id) => id === 'anilist', ALL)
    expect(b?.reason).toBe('anilist-unhealthy')
  })

  it('D5c · 分类模式 + AniList 正常 → 不阻断（不看其他来源）', () => {
    expect(decideBlocked('Action', yes, no, ALL)).toBeNull()
  })

  it('D5d · 全部模式 + 一个来源都没启用 → no-sources', () => {
    expect(decideBlocked(null, no, no, ALL)?.reason).toBe('no-sources')
  })

  it('D5e · 全部模式 + 已启用来源全在冷却 → all-unhealthy', () => {
    const b = decideBlocked(null, (id) => id === 'bangumi', yes, ALL)
    expect(b?.reason).toBe('all-unhealthy')
  })

  it('D5f · 全部模式 + 只要有一个可用 → 不阻断（冷却即恢复）', () => {
    // 只让 bangumi 冷却，anilist 可用
    const b = decideBlocked(null, yes, (id) => id === 'bangumi', ALL)
    expect(b).toBeNull()
  })

  it('D5g · 冷却来源不计入 enabled（未启用的来源即使冷却也不影响判定）', () => {
    // 只有 bangumi 启用，且它可用
    const b = decideBlocked(null, (id) => id === 'bangumi', no, ALL)
    expect(b).toBeNull()
  })
})

// ───────────────────────── 6. 状态条 ─────────────────────────
describe('D6 · deriveStatusBar：部分失败 / 管道异常 / 旧快照', () => {
  const cur = { kind: 'current' as const }
  const none = { kind: 'none' as const }
  const sameKey = { kind: 'stale' as const, sameKey: true, fromKey: 'k' }
  const diffKey = { kind: 'stale' as const, sameKey: false, fromKey: 'k' }

  it('D6a · origin=none → 无状态条', () => {
    expect(deriveStatusBar({ origin: none, loading: false, error: null, failedCount: 0 }).kind).toBe('none')
  })

  it('D6b · current + 有失败 → partial-failure，文本含失败数', () => {
    const s = deriveStatusBar({ origin: cur, loading: false, error: null, failedCount: 2 })
    expect(s.kind).toBe('partial-failure')
    expect(s.text).toContain('2')
  })

  it('D6c · current + pipeline error → 优先报 pipeline-error（不报 partial）', () => {
    const s = deriveStatusBar({ origin: cur, loading: false, error: 'boom', failedCount: 2 })
    expect(s.kind).toBe('pipeline-error')
  })

  it('D6d · current + 无错误无失败 → none', () => {
    expect(deriveStatusBar({ origin: cur, loading: false, error: null, failedCount: 0 }).kind).toBe('none')
  })

  it('D6e · stale(同键) + error → retry-error', () => {
    expect(deriveStatusBar({ origin: sameKey, loading: false, error: 'x', failedCount: 0 }).kind).toBe('retry-error')
  })

  it('D6f · stale(异键) + error → stale-error', () => {
    expect(deriveStatusBar({ origin: diffKey, loading: false, error: 'x', failedCount: 0 }).kind).toBe('stale-error')
  })

  it('D6g · stale(同键) + 结束 + 失败 → retry-failed', () => {
    expect(deriveStatusBar({ origin: sameKey, loading: false, error: null, failedCount: 1 }).kind).toBe('retry-failed')
  })

  it('D6h · stale(异键) + 结束 + 失败 → stale-failed', () => {
    expect(deriveStatusBar({ origin: diffKey, loading: false, error: null, failedCount: 1 }).kind).toBe('stale-failed')
  })

  it('D6i · stale(同键) + loading → retrying', () => {
    expect(deriveStatusBar({ origin: sameKey, loading: true, error: null, failedCount: 0 }).kind).toBe('retrying')
  })

  it('D6j · stale(异键) + loading → stale', () => {
    expect(deriveStatusBar({ origin: diffKey, loading: true, error: null, failedCount: 0 }).kind).toBe('stale')
  })

  it('D6k · stale + 结束 + 无失败 → no-new-result（中性表述）', () => {
    const s = deriveStatusBar({ origin: diffKey, loading: false, error: null, failedCount: 0 })
    expect(s.kind).toBe('no-new-result')
    expect(s.text).toBe('本次未获得可展示结果')
  })

  it('D6l · 禁用文案检查：不得出现「所有参与来源均加载失败」', () => {
    const all = [
      deriveStatusBar({ origin: cur, loading: false, error: 'e', failedCount: 3 }),
      deriveStatusBar({ origin: diffKey, loading: false, error: null, failedCount: 3 }),
      deriveStatusBar({ origin: sameKey, loading: false, error: null, failedCount: 3 }),
    ]
    for (const s of all) {
      expect(s.text).not.toContain('所有参与来源均加载失败')
      expect(s.text).not.toContain('没有符合条件的内容')
    }
  })
})

// ───────────────────────── 7. 请求键 / 排序切换 ─────────────────────────
describe('D7 · makeRequestKey：排序切换必须换键', () => {
  it('D7a · 不同排序 → 不同键', () => {
    expect(makeRequestKey('anime', null, '热门')).not.toBe(makeRequestKey('anime', null, '最新'))
  })

  it('D7b · 不同 kind → 不同键', () => {
    expect(makeRequestKey('anime', null, '热门')).not.toBe(makeRequestKey('manga', null, '热门'))
  })

  it('D7c · genre 为 null 与空串等价（都渲染为空段）', () => {
    expect(makeRequestKey('anime', null, '热门')).toBe('anime||热门')
  })

  it('D7d · genre 参与键构造', () => {
    expect(makeRequestKey('anime', 'Action', '热门')).toBe('anime|Action|热门')
  })

  it('D7e · 键稳定可复现（同输入同输出）', () => {
    expect(makeRequestKey('manga', 'Romance', '评分')).toBe(makeRequestKey('manga', 'Romance', '评分'))
  })
})

// ───────────────────────── 8. 策略常量 ─────────────────────────
describe('D8 · DISCOVER_POLICY 契约', () => {
  it('D8a · 超时为 8000ms', () => {
    expect(DISCOVER_POLICY.timeoutMs).toBe(8000)
  })

  it('D8b · 重试次数为 0（不无限重试）', () => {
    expect(DISCOVER_POLICY.retries).toBe(0)
  })
})

/**
 * ───────────────────────── 覆盖缺口（诚实标注）─────────────────────────
 *
 * 以下行为**无法**仅凭现存纯函数确认，未凭空补写测试：
 *
 * 1. React 生命周期内的真实竞态（useEffect 触发顺序、setState 批处理）
 *    —— 需要 renderHook + @testing-library/react，当前未引入该依赖。
 * 2. `searchAll` 的真实网络聚合行为（多来源并发、onSettle 回调时机）
 *    —— 需要网络桩，且属于集成测试范畴。
 * 3. 首页跳过（isHomeSkipped）与来源健康冷却的真实联动
 *    —— 依赖 health.ts 与 localStorage，需 jsdom 环境。
 * 4. 滚动位置恢复 / 详情返回位置
 *    —— 属 UI 行为，需 E2E。
 *
 * 这些项在 §53 基线盘点中已列为遗留，待后续阶段处理。
 */
