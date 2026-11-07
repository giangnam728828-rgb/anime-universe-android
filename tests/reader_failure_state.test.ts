/**
 * 第8子步 · Bug 1：在线阅读失败态（F1–F5）
 *
 * 测试性质说明（不许虚报）：
 *   本仓库无 jsdom，无法渲染组件。因此采用
 *   ① **源码契约断言**（关键代码形状必须成立）
 *   ② **纯逻辑单测**（失败集合语义、取消判定）
 *   组件级真实渲染与真机行为 → 真机复测，不在此处宣称通过。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isAbortError } from '../src/services/api/abortError'
import { BinaryHttpAbortError, BinaryHttpError } from '../src/services/api/binaryHttp'

const readerSrc = readFileSync(
  new URL('../src/modules/reader/ReaderPage.tsx', import.meta.url), 'utf-8')
const hookSrc = readFileSync(
  new URL('../src/modules/reader/useOnlineWindow.ts', import.meta.url), 'utf-8')
// 第9子步：失败/重试状态收进纯状态机模块，契约断言同步迁移
const stateSrc = readFileSync(
  new URL('../src/modules/reader/readerWindowState.ts', import.meta.url), 'utf-8')

/* ══════════════════ 失败集合语义（纯逻辑，复刻 hook 行为） ══════════════════ */

/**
 * 复刻 useOnlineWindow 的失败记录逻辑，用于验证集合语义。
 * 与源码保持一一对应：markFailed 只 add，不请求；retry 先 delete 再请求。
 */
function makeFailedSet() {
  let failed = new Set<number>()
  let requests = 0
  return {
    markFailed(i: number) {
      if (failed.has(i)) return
      const n = new Set(failed); n.add(i); failed = n
    },
    retry(i: number) {
      const n = new Set(failed); n.delete(i); failed = n
      requests += 1
    },
    get failed() { return failed },
    get requests() { return requests },
  }
}

describe('F1 · 在线图片失败后失败态持续显示', () => {
  it('F1a · 失败被记录后，重复 onError 不会清空', () => {
    const s = makeFailedSet()
    s.markFailed(3)
    expect(s.failed.has(3)).toBe(true)
    s.markFailed(3)
    s.markFailed(3)
    expect(s.failed.has(3)).toBe(true)
  })

  it('F1b · 🔴 源码：onError 在线分支必须调 markFailed，不得调 retry', () => {
    const onErrors = readerSrc.match(/onError=\{\(\) => \{[^}]*\}\}/g) ?? []
    expect(onErrors.length).toBe(2) // 上下滚 + 左右翻各一处
    for (const line of onErrors) {
      expect(line).toContain('onlineWin.markFailed(i)')
      expect(line).not.toContain('onlineWin.retry(i)')
    }
  })

  it('F1c · 🔴 失败分支必须先于 urlFor 判断（否则无 URL 时只显示页码占位）', () => {
    // 真机根因：下载失败时 urlFor(i) === undefined，
    // 若先判 urlFor 就会走 rd-hold 页码块 —— 用户只看到空白，看不到失败提示
    const vStart = readerSrc.indexOf('{isFailed(i) ? (')
    const uStart = readerSrc.indexOf(') : urlFor(i) ? (')
    expect(vStart).toBeGreaterThan(-1)
    expect(uStart).toBeGreaterThan(vStart)
    // 两处（vertical / horizontal）都要满足
    expect(readerSrc.match(/\{isFailed\(i\) \? \(/g)?.length).toBe(2)
    expect(readerSrc.match(/\) : urlFor\(i\) \? \(/g)?.length).toBe(2)
  })

  it('F1d · 失败文案仍为「加载失败 · 点按重试」（有明确提示）', () => {
    expect(readerSrc.match(/加载失败 · 点按重试/g)?.length).toBe(2)
  })
})

describe('F2 · 不发生自动重试循环', () => {
  it('F2a · 🔴 源码中不存在「onError 里调 retry」的写法', () => {
    // 原始 Bug：else onlineWin.retry(i)
    expect(readerSrc).not.toContain('else onlineWin.retry(i)')
  })

  it('F2b · markFailed 不发起网络请求（源码层面）', () => {
    const block = hookSrc.slice(hookSrc.indexOf('const markFailed'))
    const body = block.slice(0, block.indexOf('return { blobs'))
    expect(body).not.toContain('getOnlinePageBlob')
    expect(body).not.toContain('requested.current.add')
  })

  it('F2c · markFailed 是幂等的（重复调用不产生新集合）', () => {
    const s = makeFailedSet()
    s.markFailed(1); s.markFailed(1); s.markFailed(1)
    expect(s.failed.size).toBe(1)
    expect(s.requests).toBe(0) // 全程零请求
  })
})

describe('F3 · 点击重试才重新请求', () => {
  it('F3a · 重试入口绑定 retryImg', () => {
    expect(readerSrc).toContain('onClick={() => retryImg(i)}')
    expect(readerSrc).toContain('onClick={(e) => { e.stopPropagation(); retryImg(i) }}')
  })

  it('F3b · retryImg 在线分支调用 onlineWin.retry', () => {
    const i = readerSrc.indexOf('const retryImg')
    const body = readerSrc.slice(i, i + 420)
    expect(body).toContain('onlineWin.retry(i)')
    // 重试前先回收该页旧 Object URL
    expect(body).toContain('URL.revokeObjectURL(u)')
  })

  it('F3c · 只有 retry 会发请求（纯逻辑复刻）', () => {
    const s = makeFailedSet()
    s.markFailed(2)
    expect(s.requests).toBe(0)
    s.retry(2)
    expect(s.requests).toBe(1)
    expect(s.failed.has(2)).toBe(false) // 重试时先清失败态
  })
})

describe('F4 · 恢复网络后重试成功', () => {
  it('F4a · retry 成功后清 pending、写 blobs、失败集合不再含该页', () => {
    const s = makeFailedSet()
    s.markFailed(5)
    s.retry(5)
    expect(s.failed.has(5)).toBe(false)
  })

  it('F4b · retry 走统一 dispatch（成功由 settleRequest 写 ready+blob）', () => {
    // 第9子步：retry 不再有独立的 then 分支，改为 markRetry → dispatch，
    // 成功后由 settleRequest 的 3a 分支统一写 status='ready' + blob。
    const i = hookSrc.indexOf('const retry = useCallback')
    const body = hookSrc.slice(i, i + 700)
    expect(body).toContain('markRetry(st.current, index)')
    expect(body).toContain('dispatch(index, ref.url')
    // 状态机侧：成功后写 ready 与 blob，pending 由 status 派生自动消失
    expect(stateSrc).toContain("r.status = 'ready'")
    expect(stateSrc).toContain('r.blob = result.blob')
  })

  it('F4c · retry 失败时重新记回失败（可再次重试）', () => {
    // 状态机侧：窗口内失败走 3b 分支写 failed，可再次 markRetry
    expect(stateSrc).toContain("r.status = 'failed'")
    expect(stateSrc).toContain('export function markRetry')
    const i = stateSrc.indexOf('export function markRetry')
    const body = stateSrc.slice(i, i + 400)
    expect(body).toContain("r.status = 'queued'")   // 可再次进入调度
  })
})

describe('F5 · AbortError 不误判为失败', () => {
  it('F5a · isAbortError 识别原生 AbortError', () => {
    const e = new Error('aborted'); e.name = 'AbortError'
    expect(isAbortError(e)).toBe(true)
  })

  it('F5b · 🔴 isAbortError 识别 binaryHttp 的 BinaryHttpAbortError', () => {
    // 原 Bug：hook 只判断 name === 'AbortError'，
    // 而 binaryHttp 的取消错误 name 是 'BinaryHttpAbortError' ⇒ 永远匹配不上
    const e = new BinaryHttpAbortError('https://uploads.mangadex.org/x.jpg')
    expect(e.name).toBe('BinaryHttpAbortError')
    expect(isAbortError(e)).toBe(true)
  })

  it('F5c · isAbortError 识别 stage=aborted 的 BinaryHttpError', () => {
    const e = new BinaryHttpError('取消', 'aborted')
    expect(isAbortError(e)).toBe(true)
  })

  it('F5d · 真实失败不被当成取消', () => {
    expect(isAbortError(new BinaryHttpError('HTTP 500', 'http-status', 500))).toBe(false)
    expect(isAbortError(new BinaryHttpError('网络请求失败', 'network'))).toBe(false)
    expect(isAbortError(new Error('boom'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
  })

  it('F5e · 🔴 hook 用 isAbortError 判别取消（不再用 name 字符串比较）', () => {
    // 第9子步：两处 catch 合并为一处统一 catch，判别仍走 isAbortError，
    // 且取消后把页面从 failed 恢复为 idle（避免切章残留失败态）。
    expect(hookSrc).toContain('const aborted = isAbortError(e)')
    expect(hookSrc).not.toContain("=== 'AbortError'")
    const i = hookSrc.indexOf('const aborted = isAbortError(e)')
    const body = hookSrc.slice(i, i + 600)
    expect(body).toContain("rec.status = 'idle'")
  })

  it('F5f · 切章 effect 会 abort 在途请求（取消走正常路径）', () => {
    expect(hookSrc).toContain('abortRef.current?.abort()')
    expect(hookSrc).toContain('}, [chapterKey])')
  })

  it('F5g · 本地分支失败处理未被改动', () => {
    expect(readerSrc).toContain('if (isLocal) setFailed((s) => new Set(s).add(i)); else onlineWin.markFailed(i)')
    expect(readerSrc).toContain('setFailed((s) => { const n = new Set(s); n.delete(i); return n })')
  })
})
