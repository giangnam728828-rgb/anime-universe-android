/**
 * 第9子步 · 批次③：P2 优先级调度测试（S 系列）
 *
 * 覆盖方案 §3.1–§3.4.1：
 *   S1–S4   排序确定性与当前页优先
 *   S5–S8   延迟提交与窗口移动
 *   S9–S12  物理名额与逻辑取消分离
 *
 * 🔴 核心断言（用户重点质询项）：
 *   物理名额只在 Promise settle 后释放；stale 不影响名额占用。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyWindow,
  cancelQueued,
  cancellableQueued,
  createWindowState,
  markQueued,
  pagesToRequest,
  startRequest,
  type WindowState,
} from '../src/modules/reader/readerWindowState'
import { createImageScheduler } from '../src/services/api/imageScheduler'

const WIN = 5
const SRC = join(__dirname, '..', 'src')

function fresh(): WindowState {
  return createWindowState()
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('S · P2 优先级调度', () => {
  /* ══════════ S1–S4 排序 ══════════ */

  it('S1 · 排序确定性：全序无并列，与插入顺序无关', () => {
    const a = fresh()
    const b = fresh()
    const set = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    for (const i of set) markQueued(a, i)
    for (const i of [...set].reverse()) markQueued(b, i)
    applyWindow(a, 8, 100, WIN)
    applyWindow(b, 8, 100, WIN)
    expect(pagesToRequest(a, 8, 100, WIN)).toEqual(pagesToRequest(b, 8, 100, WIN))
  })

  it('S2 · 当前页恒第一', () => {
    for (const cur of [0, 3, 10, 50, 99]) {
      const st = fresh()
      applyWindow(st, cur, 100, WIN)
      const todo = pagesToRequest(st, cur, 100, WIN)
      expect(todo[0]).toBe(cur)
    }
  })

  it('S3 · 距离升序 + 前进方向优先', () => {
    const st = fresh()
    applyWindow(st, 10, 100, WIN)
    const todo = pagesToRequest(st, 10, 100, WIN)
    expect(todo).toEqual([10, 11, 9, 12, 8, 13, 7, 14, 6, 15, 5])
  })

  it('S4 · 排序键是全序：[距离, 方向, 页码]', () => {
    const st = fresh()
    applyWindow(st, 10, 100, WIN)
    const todo = pagesToRequest(st, 10, 100, WIN)
    const key = (i: number): [number, number, number] => [Math.abs(i - 10), i < 10 ? 1 : 0, i]
    for (let k = 1; k < todo.length; k++) {
      const a = key(todo[k - 1])
      const b = key(todo[k])
      const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
      expect(cmp).toBeLessThan(0)     // 严格递增，无并列
    }
  })

  /* ══════════ S5–S8 窗口移动与 T4 取消 ══════════ */

  it('S5 🔴 · T4：离窗的 queued 被取消，回退 idle', () => {
    const st = fresh()
    // 在 cur=10 的窗口内排队
    for (const i of [10, 11, 12]) markQueued(st, i)
    applyWindow(st, 10, 100, WIN)
    expect(st.records.get(10)!.status).toBe('queued')

    // 跳到 cur=50，10/11/12 全部离窗
    applyWindow(st, 50, 100, WIN)
    const c = cancellableQueued(st, 50, 100, WIN)
    expect(c.sort()).toEqual([10, 11, 12])
    for (const i of c) cancelQueued(st, i)
    expect(st.records.get(10)!.status).toBe('idle')
  })

  it('S6 🔴 · T4 不取消 loading（保护物理名额）', () => {
    const st = fresh()
    startRequest(st, 10)              // loading
    applyWindow(st, 50, 100, WIN)     // 离窗
    const c = cancellableQueued(st, 50, 100, WIN)
    expect(c).not.toContain(10)       // 🔴 不得取消
    expect(st.records.get(10)!.status).toBe('loading')
    expect(st.inflight.has(10)).toBe(true)
  })

  it('S7 · cancelQueued 对 loading 是无效操作', () => {
    const st = fresh()
    startRequest(st, 3)
    expect(cancelQueued(st, 3)).toBe(false)
    expect(st.records.get(3)!.status).toBe('loading')
  })

  it('S8 · 取消后的页可重新调度（回到 idle）', () => {
    const st = fresh()
    markQueued(st, 10)
    applyWindow(st, 10, 100, WIN)
    applyWindow(st, 50, 100, WIN)
    cancelQueued(st, 10)
    applyWindow(st, 10, 100, WIN)          // 翻回来
    expect(pagesToRequest(st, 10, 100, WIN)).toContain(10)
  })

  /* ══════════ S9–S12 物理名额与逻辑取消分离 ══════════ */

  it('S9 🔴 · 物理名额只在 settle 后释放（abort 不提前归还）', async () => {
    const s = createImageScheduler(2)
    const gate = deferred()
    const ac = new AbortController()

    const p = s.run('reader', async () => { await gate.promise }, ac.signal)
    await tick()
    expect(s.stats().physicalActive).toBe(1)

    ac.abort()                                  // 逻辑取消
    await tick()
    expect(s.stats().physicalActive).toBe(1)    // 🔴 物理名额仍在

    gate.resolve()
    await p
    await tick()
    expect(s.stats().physicalActive).toBe(0)    // settle 后才归还
  })

  it('S10 🔴 · 逻辑取消不击穿并发上限', async () => {
    const s = createImageScheduler(3)
    const gates = [deferred(), deferred(), deferred()]
    const acs = gates.map(() => new AbortController())

    const ps = gates.map((g, i) =>
      s.run('reader', async () => { await g.promise }, acs[i].signal),
    )
    await tick()
    expect(s.stats().physicalActive).toBe(3)

    // 全部逻辑取消（模拟快速翻页离窗）
    acs.forEach((a) => a.abort())
    await tick()
    expect(s.stats().physicalActive).toBe(3)    // 🔴 仍为 3，未归零

    // 新窗口请求进来：必须排队，不能立刻启动（否则物理并发 = 6）
    let started = 0
    const np = s.run('reader', async () => { started++ })
    await tick()
    expect(started).toBe(0)                     // 🔴 排队中
    expect(s.stats().physicalActive).toBe(3)    // 上限未被击穿

    gates[0].resolve()
    await tick()
    expect(started).toBe(1)                     // 一个 settle 才补一个

    gates.slice(1).forEach((g) => g.resolve())
    await Promise.all([...ps, np])
  })

  it('S11 · queued 取消零成本（未占名额）', async () => {
    const s = createImageScheduler(1)
    const gate = deferred()
    const blocker = s.run('reader', async () => { await gate.promise })
    await tick()
    expect(s.stats().physicalActive).toBe(1)

    const ac = new AbortController()
    const p = s.run('reader', async () => {}, ac.signal)
    expect(s.stats().queued.reader).toBe(1)

    ac.abort()
    await expect(p).rejects.toThrow(/aborted/i)
    expect(s.stats().queued.reader).toBe(0)
    expect(s.stats().physicalActive).toBe(1)    // 未变化

    gate.resolve()
    await blocker
  })

  it('S12 · 正文优先于封面（并发 1 时）', async () => {
    const s = createImageScheduler(1)
    const gate = deferred()
    const blocker = s.run('cover', async () => { await gate.promise })
    await tick()

    const order: string[] = []
    const hold = deferred()
    s.run('cover', async () => { order.push('cover'); await hold.promise })
    s.run('reader', async () => { order.push('reader'); await hold.promise })

    gate.resolve()
    await blocker
    await tick()
    expect(order).toEqual(['reader'])           // 正文插队

    hold.resolve()
    await tick()
  })

  /* ══════════ 源码契约 ══════════ */

  it('S · hook 使用 per-page abort（不是单一章节级 signal）', () => {
    const hookSrc = readFileSync(join(SRC, 'modules/reader/useOnlineWindow.ts'), 'utf8')
    expect(hookSrc).toContain('pageAborts')
    expect(hookSrc).toContain('new AbortController()')
    // 窗口 effect 里必须做 T4 取消
    expect(hookSrc).toContain('cancellableQueued(')
    expect(hookSrc).toContain('cancelQueued(')
  })

  it('S · 取消只作用于 queued，不作用于 loading（源码断言）', () => {
    const stateSrc = readFileSync(join(SRC, 'modules/reader/readerWindowState.ts'), 'utf8')
    const i = stateSrc.indexOf('export function cancellableQueued')
    const end = stateSrc.indexOf('export function cancelQueued')
    const seg = stateSrc.slice(i, end)
    expect(seg).toContain("r.status !== 'queued'")
    expect(seg).not.toContain("'loading'")
  })

  it('S · WINDOW 仍为 5（未改窗口大小）', () => {
    const readerSrc = readFileSync(join(SRC, 'modules/reader/ReaderPage.tsx'), 'utf8')
    expect(readerSrc).toMatch(/const WINDOW = 5\b/)
  })
})
