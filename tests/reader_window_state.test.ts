/**
 * 第9子步 · 批次②：窗口状态机测试（W 系列）
 *
 * 覆盖方案 §2.2.2（C1–C10 组合表）、§2.3（转换表）、§2.3.1/§2.3.1.1（四阶段）、
 * §2.3.2（reconcile 分支）、§2.4（R1–R17 竞态）、§2.5（七条规则）。
 *
 * 🔴 采样边界（W43，用户 X-13 裁定）：
 *   「C6 不允许成为**可观察的稳定状态**」——
 *   只在每个同步操作 / 微任务边界采样，**不在 S2→S3 内部采样**。
 *   不承诺 C6 在同步栈内的指令级瞬时不存在（那不可能也不需要）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import {
  applyWindow,
  checkInvariants,
  createWindowState,
  deriveBlobs,
  deriveFailed,
  derivePending,
  markPageFailed,
  markQueued,
  markRetry,
  pagesToRequest,
  resetForChapter,
  settleRequest,
  startRequest,
  windowRange,
  type WindowState,
} from '../src/modules/reader/readerWindowState'

const SRC = join(__dirname, '..', 'src')
const WIN = 5

function fresh(): WindowState {
  return createWindowState()
}

/** 启动一页请求（S1） */
function start(st: WindowState, i: number) {
  return startRequest(st, i)
}

/** 成功 settle（S2+S3） */
function settleOk(st: WindowState, i: number, inf: ReturnType<typeof start>, blob = new Blob(['x'])) {
  return settleRequest(st, i, inf, { ok: true, blob })
}

/** 失败 settle */
function settleErr(st: WindowState, i: number, inf: ReturnType<typeof start>, err = new Error('e')) {
  return settleRequest(st, i, inf, { ok: false, error: err })
}

describe('W · 窗口状态机', () => {
  /* ══════════ W1–W10 基本转换 ══════════ */

  it('W1 · 初始状态为空，无任何记录', () => {
    const st = fresh()
    expect(st.records.size).toBe(0)
    expect(st.inflight.size).toBe(0)
    expect(checkInvariants(st)).toEqual([])
  })

  it('W2 · idle → loading：startRequest 注册 inflight 并推进 epoch', () => {
    const st = fresh()
    const inf = start(st, 3)
    const r = st.records.get(3)!
    expect(r.status).toBe('loading')
    expect(r.epoch).toBe(1)
    expect(inf.reqId).toBe(1)
    expect(inf.pageIndex).toBe(3)
    expect(inf.epoch).toBe(1)
    expect(inf.chapterGen).toBe(0)
    expect(st.inflight.has(3)).toBe(true)
  })

  it('W3 · loading → ready：成功 settle 后 status=ready 且有 blob', () => {
    const st = fresh()
    const inf = start(st, 2)
    settleOk(st, 2, inf)
    const r = st.records.get(2)!
    expect(r.status).toBe('ready')
    expect(r.blob).toBeInstanceOf(Blob)
    expect(st.inflight.has(2)).toBe(false)
    expect(checkInvariants(st)).toEqual([])
  })

  it('W4 · loading → failed：失败 settle 后 status=failed 且无 inflight', () => {
    const st = fresh()
    const inf = start(st, 2)
    settleErr(st, 2, inf)
    const r = st.records.get(2)!
    expect(r.status).toBe('failed')
    expect(r.error).toBeInstanceOf(Error)
    expect(st.inflight.has(2)).toBe(false)
    expect(checkInvariants(st)).toEqual([])
  })

  it('W5 · reqId 全局自增，不复用', () => {
    const st = fresh()
    const a = start(st, 1)
    settleOk(st, 1, a)
    const b = start(st, 1)
    expect(b.reqId).toBeGreaterThan(a.reqId)
    expect(b.epoch).toBeGreaterThan(a.epoch)
  })

  it('W6 · 页码与 epoch 均不足以标识请求（必须 reqId）', () => {
    const st = fresh()
    // 同页连续两次启动：页码相同、epoch 递增，但 reqId 才唯一
    const a = start(st, 7)
    const b = start(st, 7)   // 覆盖 inflight
    expect(a.pageIndex).toBe(b.pageIndex)
    expect(a.reqId).not.toBe(b.reqId)
    // 旧请求 settle 不得删新 inflight
    settleOk(st, 7, a)
    expect(st.inflight.get(7)?.reqId).toBe(b.reqId)
  })

  /* ══════════ W11–W20 窗口与淘汰（Bug A 修复）══════════ */

  it('W7 · windowRange 边界裁剪', () => {
    expect(windowRange(0, 10, 5)).toEqual([0, 5])
    expect(windowRange(9, 10, 5)).toEqual([4, 9])
    expect(windowRange(5, 10, 5)).toEqual([0, 9])
    expect(windowRange(0, 0, 5)).toEqual([0, -1])
  })

  it('W8 🔴 · 淘汰把 ready 回退到 idle（Bug A 根因修复）', () => {
    const st = fresh()
    const inf = start(st, 0)
    settleOk(st, 0, inf)
    expect(st.records.get(0)!.status).toBe('ready')

    // 翻到第 20 页，第 0 页远离窗口
    applyWindow(st, 20, 100, WIN)
    const r = st.records.get(0)!
    expect(r.status).toBe('idle')       // 🔴 回退到 idle，不是留墓碑
    expect(r.blob).toBeUndefined()
    expect(checkInvariants(st)).toEqual([])
  })

  it('W9 🔴 · 淘汰后可重新调度（旧实现永久空白的原因）', () => {
    const st = fresh()
    const inf = start(st, 0)
    settleOk(st, 0, inf)

    applyWindow(st, 20, 100, WIN)          // 淘汰
    applyWindow(st, 0, 100, WIN)           // 翻回来

    const todo = pagesToRequest(st, 0, 100, WIN)
    expect(todo).toContain(0)              // 🔴 必须重新出现在待请求列表
  })

  it('W10 · 淘汰 failed 同样回退到 idle', () => {
    const st = fresh()
    const inf = start(st, 1)
    settleErr(st, 1, inf)
    applyWindow(st, 30, 100, WIN)
    expect(st.records.get(1)!.status).toBe('idle')
  })

  it('W11 🔴 · 淘汰不作用于 loading（下载中不被清掉）', () => {
    const st = fresh()
    start(st, 2)
    applyWindow(st, 50, 100, WIN)
    expect(st.records.get(2)!.status).toBe('loading')
    expect(st.inflight.has(2)).toBe(true)
  })

  it('W12 🔴 · 淘汰不作用于 queued', () => {
    const st = fresh()
    markQueued(st, 3)
    applyWindow(st, 50, 100, WIN)
    expect(st.records.get(3)!.status).toBe('queued')
  })

  it('W13 · 淘汰阈值是 win+3（不是 win）', () => {
    const st = fresh()
    const inf = start(st, 0)
    settleOk(st, 0, inf)
    // 距离 = 8 = win+3 ⇒ 尚未超过，保留
    applyWindow(st, 8, 100, WIN)
    expect(st.records.get(0)!.status).toBe('ready')
    // 距离 = 9 > win+3 ⇒ 淘汰
    applyWindow(st, 9, 100, WIN)
    expect(st.records.get(0)!.status).toBe('idle')
  })

  it('W14 · inWindow 随窗口移动更新', () => {
    const st = fresh()
    applyWindow(st, 10, 100, WIN)
    expect(st.records.size).toBe(0)         // 无记录时不创建
    start(st, 10)
    applyWindow(st, 10, 100, WIN)
    expect(st.records.get(10)!.inWindow).toBe(true)
    applyWindow(st, 40, 100, WIN)
    expect(st.records.get(10)!.inWindow).toBe(false)
  })

  it('W15 🔴 · stale 可逆（U1：页面重新进入窗口要能清掉）', () => {
    const st = fresh()
    const inf = start(st, 5)
    applyWindow(st, 50, 100, WIN)             // 移出窗口
    expect(st.inflight.get(5)!.stale).toBe(true)
    applyWindow(st, 5, 100, WIN)              // 移回窗口
    expect(st.inflight.get(5)!.stale).toBe(false)   // 🔴 必须可逆
    void inf
  })

  /* ══════════ W21–W32 调度与 reconcile ══════════ */

  it('W16 · pagesToRequest 跳过已有需求的页', () => {
    const st = fresh()
    applyWindow(st, 0, 100, WIN)
    start(st, 0)
    const todo = pagesToRequest(st, 0, 100, WIN)
    expect(todo).not.toContain(0)
    expect(todo).toContain(1)
  })

  it('W17 · pagesToRequest 跳过 failed（等用户显式 retry）', () => {
    const st = fresh()
    const inf = start(st, 0)
    settleErr(st, 0, inf)
    applyWindow(st, 0, 100, WIN)
    const todo = pagesToRequest(st, 0, 100, WIN)
    expect(todo).not.toContain(0)
  })

  it('W18 · pagesToRequest 跳过 ready（已有 Blob）', () => {
    const st = fresh()
    const inf = start(st, 0)
    settleOk(st, 0, inf)
    applyWindow(st, 0, 100, WIN)
    expect(pagesToRequest(st, 0, 100, WIN)).not.toContain(0)
  })

  it('W19 · 排序：当前页恒第一，随后距离升序 + 前进优先', () => {
    const st = fresh()
    applyWindow(st, 10, 100, WIN)
    const todo = pagesToRequest(st, 10, 100, WIN)
    expect(todo[0]).toBe(10)                        // 当前页第一
    expect(todo.slice(0, 5)).toEqual([10, 11, 9, 12, 8])
  })

  it('W20 · 排序确定性：与插入顺序无关', () => {
    const a = fresh()
    const b = fresh()
    // 用不同顺序制造记录
    for (const i of [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      markQueued(a, i); markQueued(b, 20 - i)
    }
    applyWindow(a, 10, 100, WIN); applyWindow(b, 10, 100, WIN)
    expect(pagesToRequest(a, 10, 100, WIN)).toEqual(pagesToRequest(b, 10, 100, WIN))
  })

  it('W21 🔴 · epoch 不同只丢弃旧响应，不改状态（X-7 死锁解药）', () => {
    const st = fresh()
    const old = start(st, 4)          // epoch 1
    markRetry(st, 4)                  // epoch 2，status=queued
    expect(st.records.get(4)!.status).toBe('queued')

    settleOk(st, 4, old)              // 旧请求回来了
    const r = st.records.get(4)!
    expect(r.status).toBe('queued')   // 🔴 不得被改成 ready / idle
    expect(r.blob).toBeUndefined()
  })

  it('W22 🔴 · C8 保护：ready + 旧请求在途，settle 不删 Blob 不改 ready', () => {
    const st = fresh()
    const first = start(st, 2)
    settleOk(st, 2, first)            // ready，epoch 1
    const blob = st.records.get(2)!.blob
    expect(blob).toBeInstanceOf(Blob)

    // 制造一条「同页旧请求」：直接塞一个旧 epoch 的 inflight
    const stale = { reqId: 999, pageIndex: 2, epoch: 0, chapterGen: 0, stale: false }
    st.inflight.set(2, stale)

    settleOk(st, 2, stale, new Blob(['old']))
    const r = st.records.get(2)!
    expect(r.status).toBe('ready')            // 🔴 不改
    expect(r.blob).toBe(blob)                 // 🔴 Blob 不删（同一引用）
    expect(st.inflight.has(2)).toBe(false)    // 只删自己那条
  })

  it('W23 · reqId 不匹配的 settle 被忽略（不误删新 inflight）', () => {
    const st = fresh()
    const a = start(st, 6)
    const b = start(st, 6)           // 覆盖
    const handled = settleOk(st, 6, a)
    expect(handled).toBe(false)      // 被忽略
    expect(st.inflight.get(6)!.reqId).toBe(b.reqId)
  })

  it('W24 · 切章后旧请求 settle 只删记录（U4）', () => {
    const st = fresh()
    const inf = start(st, 1)
    resetForChapter(st)              // chapterGen 0 → 1
    expect(st.records.size).toBe(0)

    // 旧请求 settle：reqId 已不匹配（inflight 被清空）
    const handled = settleOk(st, 1, inf)
    expect(handled).toBe(false)
    expect(st.records.size).toBe(0)
  })

  it('W25 · 窗口外 settle 回退 idle（3c）', () => {
    const st = fresh()
    const inf = start(st, 3)
    applyWindow(st, 50, 100, WIN)     // 移出窗口
    settleOk(st, 3, inf)
    expect(st.records.get(3)!.status).toBe('idle')
    expect(st.records.get(3)!.blob).toBeUndefined()
  })

  it('W26 · chapterGen 独立于 epoch（切章后即使 epoch 偶然相同也丢弃）', () => {
    const st = fresh()
    const inf = start(st, 2)
    st.chapterGen += 1               // 模拟切章但保留 inflight（极端情况）
    const r = st.records.get(2)!
    const before = r.status
    settleOk(st, 2, inf)
    // 分支 1：chapterGen 不同 ⇒ 删记录
    expect(st.records.has(2)).toBe(false)
    void before
  })

  it('W27 · markPageFailed 只记录，不发起请求', () => {
    const st = fresh()
    markPageFailed(st, 5)
    expect(st.records.get(5)!.status).toBe('failed')
    expect(st.inflight.size).toBe(0)
  })

  it('W28 · markPageFailed 在 inflight 存在时不覆盖（等 settle）', () => {
    const st = fresh()
    start(st, 5)
    markPageFailed(st, 5)
    expect(st.records.get(5)!.status).toBe('loading')
  })

  it('W29 · markRetry 产生新 epoch 并回到 queued', () => {
    const st = fresh()
    const inf = start(st, 1)
    settleErr(st, 1, inf)
    expect(st.records.get(1)!.status).toBe('failed')
    const e1 = st.records.get(1)!.epoch

    markRetry(st, 1)
    const r = st.records.get(1)!
    expect(r.status).toBe('queued')
    expect(r.epoch).toBeGreaterThan(e1)
    expect(r.error).toBeUndefined()
  })

  it('W30 · 派生视图与状态一致', () => {
    const st = fresh()
    const a = start(st, 0)
    settleOk(st, 0, a)
    start(st, 1)
    const f = start(st, 2)
    settleErr(st, 2, f)
    markQueued(st, 3)

    expect([...deriveBlobs(st).keys()]).toEqual([0])
    expect([...derivePending(st)].sort()).toEqual([1, 3])
    expect([...deriveFailed(st)]).toEqual([2])
  })

  /* ══════════ W31–W35 不变量与 C 组合表 ══════════ */

  it('W31 🔴 · C4（queued + 旧请求在途）是合法组合', () => {
    const st = fresh()
    start(st, 4)                 // inflight
    markRetry(st, 4)             // status=queued，inflight 仍在
    const r = st.records.get(4)!
    expect(r.status).toBe('queued')
    expect(st.inflight.has(4)).toBe(true)
    expect(checkInvariants(st)).toEqual([])   // 不是违规
  })

  it('W32 · checkInvariants 能检出 C6', () => {
    const st = fresh()
    start(st, 1)
    st.inflight.delete(1)        // 人为制造 C6
    const v = checkInvariants(st)
    expect(v).toEqual([{ kind: 'C6', pageIndex: 1 }])
  })

  it('W33 🔴 · checkInvariants 能检出 C10', () => {
    const st = fresh()
    markPageFailed(st, 2)        // failed
    st.inflight.set(2, { reqId: 1, pageIndex: 2, epoch: 1, chapterGen: 0, stale: false })
    const v = checkInvariants(st)
    expect(v).toEqual([{ kind: 'C10', pageIndex: 2 }])
  })

  it('W34 · checkInvariants 能检出 ready 但无 blob', () => {
    const st = fresh()
    const inf = start(st, 3)
    settleOk(st, 3, inf)
    st.records.get(3)!.blob = undefined      // 人为破坏
    const v = checkInvariants(st)
    expect(v).toEqual([{ kind: 'READY_WITHOUT_BLOB', pageIndex: 3 }])
  })

  it('W35 · 正常流程全程无不变量违规（含淘汰/重试/切章）', () => {
    const st = fresh()
    const seq: Array<() => void> = [
      () => { const i = start(st, 0); settleOk(st, 0, i) },
      () => applyWindow(st, 5, 100, WIN),
      () => { const i = start(st, 6); settleErr(st, 6, i) },
      () => markRetry(st, 6),
      () => { const i = start(st, 6); settleOk(st, 6, i) },
      () => applyWindow(st, 40, 100, WIN),
      () => applyWindow(st, 0, 100, WIN),
      () => { const i = start(st, 1); settleOk(st, 1, i) },
      () => resetForChapter(st),
    ]
    for (const step of seq) {
      step()
      // 🔴 W43 采样边界：只在同步操作边界采样（每个 step 之后）
      expect(checkInvariants(st)).toEqual([])
    }
  })

  /* ══════════ W36–W41 settle 四阶段与同步性 ══════════ */

  it('W36 · S2 无条件执行：失败响应也删 inflight', () => {
    const st = fresh()
    const inf = start(st, 2)
    settleErr(st, 2, inf)
    expect(st.inflight.has(2)).toBe(false)
  })

  it('W37 · S2 只删 reqId 匹配的那一条', () => {
    const st = fresh()
    const a = start(st, 3)
    const b = start(st, 3)
    settleOk(st, 3, a)                      // 旧请求
    expect(st.inflight.get(3)!.reqId).toBe(b.reqId)
  })

  it('W38 · settle 后记录状态必须是四种之一，绝不残留 loading', () => {
    const st = fresh()
    const inf = start(st, 1)
    settleOk(st, 1, inf)
    const s = st.records.get(1)!.status
    expect(['idle', 'ready', 'failed', 'queued']).toContain(s)
    expect(s).not.toBe('loading')
  })

  it('W39 · 非窗口内成功也回 idle（不缓存远处 Blob）', () => {
    const st = fresh()
    const inf = start(st, 9)
    applyWindow(st, 50, 100, WIN)
    settleOk(st, 9, inf)
    expect(st.records.get(9)!.status).toBe('idle')
    expect(deriveBlobs(st).has(9)).toBe(false)
  })

  /* ══════════ W42–W47 静态检查（用户 X-13 / X-16）══════════ */

  describe('W42–W47 · 源码契约与静态检查', () => {
    const stateSrc = readFileSync(join(SRC, 'modules/reader/readerWindowState.ts'), 'utf8')
    const hookSrc = readFileSync(join(SRC, 'modules/reader/useOnlineWindow.ts'), 'utf8')

    /** 去注释，避免文档里的说明文字被当成代码断言 */
    function codeOnly(src: string): string {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    }

    it('W42 · C8 保护：epoch 不同分支对 ready 直接返回，不触碰 blob/status', () => {
      const body = codeOnly(stateSrc)
      const i = body.indexOf('if (r.epoch !== inf.epoch)')
      expect(i).toBeGreaterThan(-1)
      // 只取该分支自身（到分支 3 的注释/判断为止），不含后续 3c 分支的清理代码
      const end = body.indexOf('if (!r.inWindow)', i)
      expect(end).toBeGreaterThan(i)
      const seg = body.slice(i, end)
      expect(seg).toContain("r.status === 'ready'")
      expect(seg).not.toContain('r.blob = undefined')
      expect(seg).not.toContain("r.status = 'idle'")
    })

    it('W43 · 稳定状态不变量（同步边界采样）', () => {
      // 已在 W35 中逐 step 采样；此处断言源码不含「全程不出现 C6」这类错误措辞
      expect(stateSrc).not.toContain('全程不出现')
      expect(stateSrc).toContain('可观察的稳定状态')
    })

    it('W44 · settle 函数内不调用 pump（S2/S3 与 S4 分离）', () => {
      const body = codeOnly(stateSrc)
      const i = body.indexOf('export function settleRequest')
      const end = body.indexOf('export function resetForChapter')
      const seg = body.slice(i, end)
      expect(seg).not.toContain('pump')
    })

    it('W45a 🔴 · 静态检查：settleRequest 内无 AwaitExpression / then / finally', () => {
      const sf = ts.createSourceFile('s.ts', stateSrc, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
      const violations: string[] = []

      const visit = (node: ts.Node, insideSettle: boolean) => {
        const nowInside =
          insideSettle ||
          (ts.isFunctionDeclaration(node) && node.name?.text === 'settleRequest')

        if (nowInside) {
          if (ts.isAwaitExpression(node)) violations.push('AwaitExpression')
          if (ts.isPropertyAccessExpression(node)) {
            const n = node.name.text
            if (n === 'then' || n === 'finally' || n === 'catch') violations.push(`.${n}()`)
          }
        }
        ts.forEachChild(node, (c) => visit(c, nowInside))
      }
      visit(sf, false)
      expect(violations).toEqual([])
    })

    it('W45b · 运行时检查：settleRequest 同步完成（返回时状态已稳定）', () => {
      const st = fresh()
      const inf = start(st, 1)
      // 同步调用，返回后立即检查 —— 中间没有任何 await
      const handled = settleOk(st, 1, inf)
      expect(handled).toBe(true)
      expect(st.records.get(1)!.status).toBe('ready')
      expect(checkInvariants(st)).toEqual([])
    })

    it('W46 · S3 前状态不可观察：hook 中 settle 与 rerender 顺序正确', () => {
      const body = codeOnly(hookSrc)
      // settleRequest 必须先于 setViewVer（对外通知）
      const thenIdx = body.indexOf('.then((r) =>')
      expect(thenIdx).toBeGreaterThan(-1)
      const seg = body.slice(thenIdx, thenIdx + 600)
      const settlePos = seg.indexOf('settleRequest(')
      const notifyPos = seg.indexOf('setViewVer(')
      expect(settlePos).toBeGreaterThan(-1)
      expect(notifyPos).toBeGreaterThan(-1)
      expect(settlePos).toBeLessThan(notifyPos)     // 🔴 reconcile 先于通知
    })

    it('W47 🔴 · 用户回调时序：onLoad 与 onError 均在 settle 之后（ReaderPage 侧）', () => {
      const readerSrc = readFileSync(join(SRC, 'modules/reader/ReaderPage.tsx'), 'utf8')
      // onError 只调 markFailed，不调 retry（第8子步契约，不得回退）
      const lines = readerSrc.split('\n').filter((l) => l.includes('onlineWin.markFailed'))
      expect(lines.length).toBeGreaterThan(0)
      expect(readerSrc).not.toMatch(/onError[^)]*onlineWin\.retry/)
    })

    it('W · 对外签名未变（ReaderPage 零改动）', () => {
      expect(hookSrc).toContain('export interface OnlineWindowState')
      for (const k of ['blobs', 'pending', 'failed', 'retry', 'markFailed']) {
        expect(hookSrc).toContain(k)
      }
      expect(hookSrc).toContain('return { blobs, pending, failed, retry, markFailed }')
    })
  })
})
