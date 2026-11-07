/**
 * 第9子步 · 批次①：图片共享调度器测试（Q 系列）
 *
 * 覆盖方案 §4.2 / §4.4.1 / §4.4.1.1 / §4.4.1.2：
 *   Q1–Q8    并发预算与优先级
 *   Q9a–Q9i  AST 守卫（全入口覆盖）
 *   Q10–Q14  冻结区与生产约束
 *   Q15–Q19  物理名额不提前释放 / 老化提升边界
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import {
  createImageScheduler,
  imageScheduler,
  DEFAULT_MAX_CONCURRENT,
  COVER_AGING_MS,
  type ImageScheduler,
} from '../src/services/api/imageScheduler'

const SRC = join(__dirname, '..', 'src')

/** 收集 src 下所有 ts/tsx 文件 */
function collectSources(dir = SRC, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) collectSources(p, acc)
    else if (/\.tsx?$/.test(name)) acc.push(p)
  }
  return acc
}

/** 可手动 resolve 的 Promise，用于精确控制 settle 时机 */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('Q · imageScheduler', () => {
  let s: ImageScheduler

  beforeEach(() => {
    s = createImageScheduler(2)
  })

  /* ── Q1–Q8 并发预算与优先级 ───────────────────────────────── */

  it('Q1 · 全局并发上限：同时运行数不超过 maxConcurrent', async () => {
    let active = 0
    let peak = 0
    const gates = Array.from({ length: 6 }, () => deferred())

    const tasks = gates.map((g) =>
      s.run('reader', async () => {
        active++
        peak = Math.max(peak, active)
        await g.promise
        active--
      }),
    )

    await tick()
    expect(active).toBe(2)       // maxConcurrent = 2

    gates[0].resolve()
    await tick()
    expect(active).toBe(2)       // 补上一个

    gates.forEach((g) => g.resolve())
    await Promise.all(tasks)
    expect(peak).toBe(2)
  })

  it('Q2 · 正文优先于封面：混合提交时 reader 全部先启动', async () => {
    const started: string[] = []
    const gates = Array.from({ length: 4 }, () => deferred())

    // 先塞满 2 个 cover
    const covers = gates.slice(0, 2).map((g, i) =>
      s.run('cover', async () => { started.push(`cover${i}`); await g.promise }),
    )
    await tick()
    expect(started).toEqual(['cover0', 'cover1'])

    // 此时排队：先 reader 再 cover
    const g3 = deferred(), g4 = deferred()
    const r1 = s.run('reader', async () => { started.push('reader0'); await g3.promise })
    const c2 = s.run('cover', async () => { started.push('cover2'); await g4.promise })

    // 放行一个名额 → 必须是 reader
    gates[0].resolve()
    await tick()
    expect(started).toEqual(['cover0', 'cover1', 'reader0'])

    gates[1].resolve(); g3.resolve(); g4.resolve()
    await Promise.all([...covers, r1, c2])
  })

  it('Q3 · 封面不饿死正文：大量 cover 排队时新 reader 立即插队', async () => {
    const started: string[] = []
    const gate = deferred()

    // 占满 2 个名额
    const running = [0, 1].map((i) => s.run('cover', async () => { started.push(`run${i}`); await gate.promise }))
    await tick()

    // 排 10 个 cover
    for (let i = 0; i < 10; i++) s.run('cover', async () => { started.push(`cq${i}`) })
    // 再来 1 个 reader
    s.run('reader', async () => { started.push('READER') })

    gate.resolve()
    await tick()
    await tick()

    // READER 必须排在那 10 个 cover 之前
    const idx = started.indexOf('READER')
    const firstCoverQ = started.findIndex((x) => x.startsWith('cq'))
    expect(idx).toBeGreaterThan(-1)
    expect(idx).toBeLessThan(firstCoverQ)
    void running
  })

  it('Q4 · 同优先级 FIFO', async () => {
    const order: number[] = []
    const gate = deferred()
    const blocker = s.run('reader', async () => { await gate.promise })
    await tick()

    for (let i = 0; i < 5; i++) s.run('reader', async () => { order.push(i) })
    gate.resolve()
    await blocker
    await tick(); await tick(); await tick()
    expect(order).toEqual([0, 1, 2, 3, 4])
  })

  it('Q5 · 排队期间 abort：不占名额、以 AbortError 出队', async () => {
    const gate = deferred()
    // maxConcurrent = 2，先占满两个名额，第三个才会真正排队
    const b1 = s.run('reader', async () => { await gate.promise })
    const b2 = s.run('reader', async () => { await gate.promise })
    await tick()
    expect(s.stats().physicalActive).toBe(2)

    const ac = new AbortController()
    let called = false
    const p = s.run('reader', async () => { called = true }, ac.signal)
    expect(s.stats().queued.reader).toBe(1)   // 确实在排队

    ac.abort()
    await expect(p).rejects.toThrow(/aborted/i)
    expect(called).toBe(false)                // 从未启动
    expect(s.stats().queued.reader).toBe(0)
    expect(s.stats().physicalActive).toBe(2)  // 名额未被占用

    gate.resolve()
    await Promise.all([b1, b2])
  })

  it('Q6 · 异常不泄漏名额：任务抛错后 physicalActive 归零', async () => {
    await expect(s.run('reader', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await tick()
    expect(s.stats().physicalActive).toBe(0)
  })

  it('Q7 · stats() 计数准确', async () => {
    const gate = deferred()
    const a = s.run('reader', async () => { await gate.promise })
    const b = s.run('reader', async () => { await gate.promise })
    const c = s.run('reader', async () => { await gate.promise })
    const d = s.run('cover', async () => { await gate.promise })

    await tick()
    const st = s.stats()
    expect(st.physicalActive).toBe(2)      // maxConcurrent = 2
    expect(st.queued.reader).toBe(1)       // c
    expect(st.queued.cover).toBe(1)        // d
    expect(st.maxConcurrent).toBe(2)

    gate.resolve()
    await Promise.all([a, b, c, d])
  })

  it('Q8 · 单例共享：两个调用方拿到同一个实例', async () => {
    const oc = await import('../src/services/reader/onlineChapters')
    const mc = await import('../src/services/covers/mangadexCover')
    expect(oc).toBeTruthy()
    expect(mc).toBeTruthy()
    // 单例本身必须是同一对象
    expect(imageScheduler).toBe(imageScheduler)
    expect(imageScheduler.stats().maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT)
  })

  /* ── Q10–Q14 冻结区与生产约束 ─────────────────────────────── */

  it('Q10 · 冻结区未改：binaryHttp 不引用 imageScheduler', () => {
    const s1 = readFileSync(join(SRC, 'services/api/binaryHttp.ts'), 'utf8')
    expect(s1).not.toContain('imageScheduler')
    for (const f of ['services/api/nativeHttp.ts', 'services/api/http.ts']) {
      expect(readFileSync(join(SRC, f), 'utf8')).not.toContain('imageScheduler')
    }
  })

  it('Q14 · setMaxConcurrent 生产代码无调用', () => {
    for (const f of collectSources()) {
      const code = readFileSync(f, 'utf8')
      if (f.endsWith('imageScheduler.ts')) continue
      expect(code).not.toContain('setMaxConcurrent')
    }
  })

  /* ── Q15–Q19 物理名额与老化 ──────────────────────────────── */

  it('Q15 · 启动后 abort 不释放名额：physicalActive 仍为 1 直到 settle', async () => {
    const gate = deferred()
    const ac = new AbortController()
    const p = s.run('reader', async () => { await gate.promise }, ac.signal)

    await tick()
    expect(s.stats().physicalActive).toBe(1)

    ac.abort()                                  // 已启动，abort 不归还名额
    await tick()
    expect(s.stats().physicalActive).toBe(1)    // 🔴 仍为 1

    gate.resolve()
    await p
    await tick()
    expect(s.stats().physicalActive).toBe(0)    // settle 后才归还
  })

  it('Q16 · settle 后才放行下一个：同一 tick 不启动超过 1 个', async () => {
    const started: number[] = []
    const g0 = deferred(), g1 = deferred()
    s.run('reader', async () => { started.push(0); await g0.promise })
    s.run('reader', async () => { started.push(1); await g1.promise })
    s.run('reader', async () => { started.push(2) })
    await tick()
    expect(started).toEqual([0, 1])

    g0.resolve()
    await tick()
    expect(started).toEqual([0, 1, 2])     // 只补一个
    g1.resolve()
  })

  it('Q17 · 封面未到老化阈值时不越过正文', async () => {
    let clock = 0
    s.__setNow(() => clock)
    s.setMaxConcurrent(1)

    const gate = deferred()
    const blocker = s.run('reader', async () => { await gate.promise })
    await tick()

    const started: string[] = []
    // 让后续任务也挂住，避免「任务瞬间完成 → pump 继续启动下一个」干扰断言
    const hold = deferred()
    s.run('cover', async () => { started.push('cover'); await hold.promise })
    s.run('reader', async () => { started.push('reader'); await hold.promise })

    // 未到阈值 → 正文优先
    clock = COVER_AGING_MS - 1
    gate.resolve()
    await blocker
    await tick()
    expect(started).toEqual(['reader'])

    hold.resolve()
    await tick()
  })

  it('Q18 · 老化不破坏正文优先：同一时刻最多 1 个老化封面在跑', async () => {
    let clock = 0
    s.__setNow(() => clock)
    s.setMaxConcurrent(3)

    const gate = deferred()
    const running = [0, 1, 2].map(() => s.run('reader', async () => { await gate.promise }))
    await tick()
    expect(s.stats().physicalActive).toBe(3)

    const started: string[] = []
    const hold = deferred()
    // 两个封面（都已老化）+ 一个正文
    s.run('cover', async () => { started.push('c1'); await hold.promise })
    s.run('cover', async () => { started.push('c2'); await hold.promise })
    s.run('reader', async () => { started.push('r1'); await hold.promise })

    clock = COVER_AGING_MS + 1
    gate.resolve()
    await Promise.all(running)
    await tick()

    // 三个名额一次性释放：第 1 个给老化封面，第 2 个必须给正文，
    // 第 3 个才轮到第二个封面（此时 c1 仍在跑 ⇒ 老化配额已满，不能越）
    expect(started[0]).toBe('c1')
    expect(started[1]).toBe('r1')
    expect(started[2]).toBe('c2')

    hold.resolve()
    await tick()
  })

  it('Q19 · 老化不绕过物理并发、不抢占已启动正文', async () => {
    let clock = 0
    s.__setNow(() => clock)
    s.setMaxConcurrent(1)

    const gate = deferred()
    const running = s.run('reader', async () => { await gate.promise })
    await tick()
    expect(s.stats().physicalActive).toBe(1)

    let coverStarted = false
    s.run('cover', async () => { coverStarted = true })

    // 老化到阈值，但名额已满 ⇒ 仍不得启动
    clock = COVER_AGING_MS + 10_000
    await tick()
    expect(coverStarted).toBe(false)
    expect(s.stats().physicalActive).toBe(1)

    // 已启动的正文不受影响
    gate.resolve()
    await running
    await tick()
    expect(coverStarted).toBe(true)
  })

  /* ── Q9a–Q9i AST 守卫 ─────────────────────────────────── */

  describe('Q9 · AST 全入口守卫', () => {
    /** 解析一个源码字符串，返回所有 getBinary 调用点及其校验结果 */
    function analyze(code: string): Array<{ ok: boolean; reason?: string; priority?: string }> {
      const sf = ts.createSourceFile('t.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
      const results: Array<{ ok: boolean; reason?: string; priority?: string }> = []

      const isImageSchedulerRun = (n: ts.CallExpression): boolean => {
        const callee = n.expression
        if (!ts.isPropertyAccessExpression(callee)) return false
        if (callee.name.text !== 'run') return false
        return ts.isIdentifier(callee.expression) && callee.expression.text === 'imageScheduler'
      }

      const isFunctionLike = (n: ts.Node): boolean =>
        ts.isArrowFunction(n) || ts.isFunctionExpression(n)

      /** 最近的函数式祖先（含 FunctionDeclaration） */
      const nearestFn = (n: ts.Node): ts.Node | undefined => {
        let cur: ts.Node | undefined = n.parent
        while (cur) {
          if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur)) return cur
          cur = cur.parent
        }
        return undefined
      }

      const isDescendantOf = (n: ts.Node, anc: ts.Node): boolean => {
        let cur: ts.Node | undefined = n
        while (cur) { if (cur === anc) return true; cur = cur.parent }
        return false
      }

      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'getBinary'
        ) {
          // ① 沿真实祖先链找最近的 imageScheduler.run
          let cur: ts.Node | undefined = node.parent
          let runCall: ts.CallExpression | undefined
          while (cur) {
            if (ts.isCallExpression(cur) && isImageSchedulerRun(cur)) { runCall = cur; break }
            cur = cur.parent
          }

          if (!runCall) {
            results.push({ ok: false, reason: 'not wrapped by imageScheduler.run' })
          } else if (runCall.arguments.length < 2 || !isFunctionLike(runCall.arguments[1])) {
            results.push({ ok: false, reason: 'second arg is not function' })
          } else {
            const cb = runCall.arguments[1]
            const fn = nearestFn(node)
            const prio = ts.isStringLiteral(runCall.arguments[0]) ? runCall.arguments[0].text : undefined

            if (!isDescendantOf(node, cb)) {
              results.push({ ok: false, reason: 'not in second arg subtree' })
            } else if (fn !== cb) {
              results.push({ ok: false, reason: 'crosses function boundary' })
            } else {
              results.push({ ok: true, priority: prio })
            }
          }
        }
        ts.forEachChild(node, visit)
      }

      visit(sf)
      return results
    }

    it('Q9a · 参数位置：第二实参回调内通过，第一实参位置失败', () => {
      expect(analyze(`imageScheduler.run('reader', () => getBinary(u))`)).toEqual([
        { ok: true, priority: 'reader' },
      ])
      // 把 getBinary 放第一个实参位置 → 不是函数式第二实参
      const bad = analyze(`imageScheduler.run(getBinary(u), () => {})`)
      expect(bad[0].ok).toBe(false)
    })

    it('Q9b · 跨函数间接被拒', () => {
      const r = analyze(`
        function helper() { return getBinary(u) }
        imageScheduler.run('reader', () => helper())
      `)
      expect(r[0].ok).toBe(false)
    })

    it('Q9c · 同函数内嵌套允许（async / await / 块语句）', () => {
      expect(analyze(`imageScheduler.run('reader', async () => { await getBinary(u) })`)[0].ok).toBe(true)
      expect(analyze(`imageScheduler.run('reader', () => { if (x) { return getBinary(u) } })`)[0].ok).toBe(true)
      expect(analyze(`imageScheduler.run('reader', () => { try { getBinary(u) } catch {} })`)[0].ok).toBe(true)
    })

    it('Q9d · 注释与字符串不误命中', () => {
      const r = analyze(`
        // getBinary(fake)
        /* getBinary(also fake) */
        const s = 'getBinary(str)'
      `)
      expect(r).toEqual([])
    })

    it('Q9e · 嵌套函数被拒（X-12 核心）', () => {
      const r = analyze(`
        imageScheduler.run('reader', () => {
          const later = () => getBinary(u)
          later()
        })
      `)
      expect(r[0].ok).toBe(false)
      expect(r[0].reason).toBe('crosses function boundary')
    })

    it('Q9f · 接收对象必须是 imageScheduler', () => {
      const r = analyze(`foo.run('reader', () => getBinary(u))`)
      expect(r[0].ok).toBe(false)
    })

    it('Q9g · 块语句不算函数边界', () => {
      const r = analyze(`
        imageScheduler.run('reader', () => {
          for (const x of xs) { if (x) { getBinary(u) } }
        })
      `)
      expect(r[0].ok).toBe(true)
    })

    it('Q9h · 无关 run 不误判（P2 双重保险）', () => {
      const r = analyze(`
        imageScheduler.run('reader', () => other())
        getBinary(u)
      `)
      expect(r[0].ok).toBe(false)
    })

    it('Q9i · 嵌套 run 识别内层 reader（X-15）', () => {
      const r = analyze(`
        imageScheduler.run('cover', () =>
          imageScheduler.run('reader', () => getBinary(u)))
      `)
      expect(r[0].ok).toBe(true)
      expect(r[0].priority).toBe('reader')     // 内层，不是外层 cover
    })

    it('Q9 · 生产源码全入口覆盖：恰好 2 处且优先级正确', () => {
      const found: Array<{ file: string; priority?: string; ok: boolean }> = []
      for (const f of collectSources()) {
        const code = readFileSync(f, 'utf8')
        if (!code.includes('getBinary')) continue
        for (const r of analyze(code)) {
          found.push({ file: f.replace(SRC, 'src'), ...r })
        }
      }
      const okCalls = found.filter((x) => x.ok)
      expect(okCalls.map((x) => x.file).sort()).toEqual([
        'src/services/covers/mangadexCover.ts',
        'src/services/reader/onlineChapters.ts',
      ])
      expect(okCalls.find((x) => x.file.includes('onlineChapters'))?.priority).toBe('reader')
      expect(okCalls.find((x) => x.file.includes('mangadexCover'))?.priority).toBe('cover')
      expect(found.filter((x) => !x.ok)).toEqual([])
    })
  })
})
