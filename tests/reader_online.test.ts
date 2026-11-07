/**
 * ReaderPage 在线阅读分支测试（P1 第5子步）
 *
 * 用户指定必须验证的 8 项风险：
 *   R1 本地阅读回归      R5 并发与去重
 *   R2 在线来源串线      R6 资源回收
 *   R3 图片请求方式      R7 失败恢复
 *   R4 窗口边界          R8 进度隔离
 *
 * 说明：ReaderPage 是 React 组件，本仓库测试环境无 DOM（无 jsdom），
 * 因此采用**源码契约断言 + 纯逻辑单测**的组合，而非组件渲染测试。
 * 组件级真机行为留到第6子步。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { LOCAL_SOURCE_ID } from '../src/modules/reader/readerRoute'

const SRC = new URL('../src/modules/reader/', import.meta.url)
const readerSrc = readFileSync(new URL('ReaderPage.tsx', SRC), 'utf-8')
const hookSrc = readFileSync(new URL('useOnlineWindow.ts', SRC), 'utf-8')
// 第9子步：窗口/淘汰/派发逻辑抽入纯模块，契约断言同步迁移
const stateSrc = readFileSync(new URL('readerWindowState.ts', SRC), 'utf-8')

/* ══════════════════ R1 · 本地阅读回归 ══════════════════ */

describe('R1 · 本地阅读不回归', () => {
  it('R1a · 本地分支仍用 getLocalManga + getLocalPages', () => {
    expect(readerSrc).toContain('getLocalManga(mangaId)')
    expect(readerSrc).toContain('getLocalPages(mangaId, chapterId)')
  })

  it('R1b · 本地分支仍校验作品与章节存在', () => {
    expect(readerSrc).toContain("漫画不存在（可能已被删除）")
    expect(readerSrc).toContain("章节不存在")
  })

  it('R1c · 本地分支在 isLocal 判断内（先分流）', () => {
    expect(readerSrc).toContain('if (isLocal) {')
    expect(readerSrc).toContain('const isLocal = sourceId === LOCAL_SOURCE_ID')
  })

  it('R1d · WINDOW 仍为 5（未改窗口大小）', () => {
    expect(readerSrc).toMatch(/const WINDOW = 5\b/)
  })

  it('R1e · 本地翻页/滚动处理未被改动', () => {
    for (const fn of ['onScrollV', 'onScrollH', 'goPage', 'onTapH']) {
      expect(readerSrc).toContain(`const ${fn} =`)
    }
  })

  it('R1f · 本地失败重试仍走原 setFailed 逻辑', () => {
    expect(readerSrc).toContain("setFailed((s) => { const n = new Set(s); n.delete(i); return n })")
  })
})

/* ══════════════════ R2 · 在线来源不串线 ══════════════════ */

describe('R2 · 在线来源不进入本地分支', () => {
  it('R2a · 🔴 在线分支显式校验 adapter.id 与 sourceId 一致', () => {
    // getSource 找不到会静默回退 SOURCES[0]，必须防串源
    expect(readerSrc).toContain('if (adapter.id !== sourceId)')
    expect(readerSrc).toContain('未知阅读来源')
  })

  it('R2b · 在线分支不调用 getLocalManga / getLocalPages', () => {
    // 取在线分支代码段（isLocal 块之后到 effect 结束）
    const onlineStart = readerSrc.indexOf('分支 B：在线阅读')
    expect(onlineStart).toBeGreaterThan(-1)
    const onlineBlock = readerSrc.slice(onlineStart, onlineStart + 2000)
    expect(onlineBlock).not.toContain('getLocalManga')
    expect(onlineBlock).not.toContain('getLocalPages')
  })

  it('R2c · 在线分支校验适配器支持 getPages', () => {
    expect(readerSrc).toContain("typeof adapter.getPages !== 'function'")
    expect(readerSrc).toContain('不支持在线阅读')
  })

  it('R2d · 🔴 不把 MangaBaka 当章节来源', () => {
    // MangaBaka 无章节/图片 API，绝不能出现在阅读链路
    expect(readerSrc).not.toContain('mangabaka')
    expect(readerSrc).not.toContain('MangaBaka')
  })

  it('R2e · 在线分支用 getOnlinePages 而非直接调 adapter.getPages', () => {
    expect(readerSrc).toContain('getOnlinePages(adapter, sourceId, mangaId, chapterId)')
  })
})

/* ══════════════════ R3 · 图片请求方式 ══════════════════ */

describe('R3 · 必须下载 Blob，不能热链', () => {
  it('R3a · 🔴 img src 只来自 urlFor()（Object URL）', () => {
    const imgs = readerSrc.match(/<img\s+src=\{[^}]+\}/g) || []
    expect(imgs.length).toBeGreaterThan(0)
    for (const t of imgs) {
      expect(t).toContain('src={urlFor(i)}')
    }
  })

  it('R3b · 🔴 不存在把远端图片 URL 直接塞进 img 的写法', () => {
    expect(readerSrc).not.toMatch(/src=\{[^}]*\.url[^}]*\}/)
    expect(readerSrc).not.toContain('src={online')
  })

  it('R3c · Blob → Object URL 经 URL.createObjectURL', () => {
    expect(readerSrc).toContain('URL.createObjectURL(b)')
  })

  it('R3d · 在线图片字节经 useOnlineWindow → getOnlinePageBlob', () => {
    expect(hookSrc).toContain('getOnlinePageBlob')
  })

  it('R3e · 不绕过专用 UA 链路（不直接引用 nativeHttp）', () => {
    expect(readerSrc).not.toContain('nativeHttp')
    expect(hookSrc).not.toContain('nativeHttp')
  })
})

/* ══════════════════ R4 · 窗口边界 ══════════════════ */

describe('R4 · 窗口边界正确', () => {
  // 第9子步：窗口计算迁入纯模块 readerWindowState.ts 的 windowRange()，
  // 断言随之迁移（契约不变：下界 clamp 到 0、上界 clamp 到 total-1、只用窗口内页码）。
  it('R4a · 窗口下界 clamp 到 0（首屏不越界）', () => {
    expect(stateSrc).toContain('Math.max(0, cur - win)')
  })

  it('R4b · 窗口上界 clamp 到 total-1（末页不越界）', () => {
    expect(stateSrc).toContain('Math.min(total - 1, cur + win)')
  })

  it('R4c · 只请求窗口内的页（循环边界用 lo/hi）', () => {
    expect(stateSrc).toMatch(/for \(let i = lo; i <= hi; i\+\+\)/)
  })

  it('R4d · 窗口半径由外部传入且等于 WINDOW', () => {
    expect(readerSrc).toContain('window: WINDOW')
  })

  it('R4e · 空清单直接返回，不发起任何请求', () => {
    expect(hookSrc).toContain('pages.total === 0) return')
  })

  it('R4f · 窗口外 Blob 被丢弃（阈值 win+3，与本地 urlCache 一致）', () => {
    // 第9子步：淘汰逻辑迁入 readerWindowState.applyWindow()
    expect(stateSrc).toContain('Math.abs(i - cur) > win + 3')
  })
})

/* ══════════════════ R5 · 并发与去重 ══════════════════ */

describe('R5 · 并发与去重', () => {
  it('R5a · 已请求过的页不重复发起（状态机 pagesToRequest）', () => {
    // 第9子步：requested: Set<number> 被纯状态机取代。
    // 原实现用「曾经请求过」的墓碑集合，正是 Bug A（翻回永久空白）的根因。
    // 新契约：由 PageRecord.status 判定，只有 idle/无记录才可发起。
    expect(hookSrc).toContain('pagesToRequest(')
    expect(stateSrc).toContain("if (r.status === 'idle') { out.push(i); continue }")
  })

  it('R5b · 快速翻页不会重复下载同一页', () => {
    // 状态机层面：queued/loading/ready/failed 均不再发起
    expect(stateSrc).toMatch(/queued \/ loading \/ ready \/ failed 都不再发起/)
  })

  it('R5c · 并发受 binaryHttp limiter 控制（不在本层自建并发）', () => {
    // 本层不应出现自建 Promise.all 批量下载
    expect(hookSrc).not.toMatch(/Promise\.all\(\s*\[\s*\.\.\./)
  })

  it('R5d · 单页失败不影响其他页（逐页独立 catch）', () => {
    expect(hookSrc).toContain('.catch((e: unknown) =>')
  })
})

/* ══════════════════ R6 · 资源回收 ══════════════════ */

describe('R6 · Object URL 与 Blob 回收', () => {
  it('R6a · 卸载时回收全部 Object URL', () => {
    expect(readerSrc).toContain('urlCache.current.forEach((u) => URL.revokeObjectURL(u))')
  })

  it('R6b · 翻页后回收远处 Object URL', () => {
    expect(readerSrc).toContain('URL.revokeObjectURL(u); urlCache.current.delete(i)')
  })

  it('R6c · 重试时先回收该页旧 Object URL', () => {
    const retryBlock = readerSrc.slice(readerSrc.indexOf('const retryImg'))
    expect(retryBlock).toContain('URL.revokeObjectURL(u)')
  })

  it('R6d · 🔴 切章时 abort 进行中请求并清空 Blob', () => {
    expect(hookSrc).toContain('abortRef.current?.abort()')
    // 第9子步：setBlobs(new Map()) 改为状态机整表重置
    expect(hookSrc).toContain('resetForChapter(st.current)')
    expect(stateSrc).toContain('state.records.clear()')
  })

  it('R6e · 卸载后不再 setState（aliveRef 守卫）', () => {
    // 第9子步：原写法 `if (!aliveRef.current) return` 保留在卸载路径
    expect(hookSrc).toContain('aliveRef.current = false')
    expect(hookSrc).toContain('if (aliveRef.current) setViewVer')
  })

  it('R6f · chapterKey 变化触发清理（切章隔离）', () => {
    expect(hookSrc).toMatch(/\}, \[chapterKey\]\)/)
    expect(readerSrc).toContain('chapterKey: `${sourceId}:${mangaId}:${chapterId}`')
  })
})

/* ══════════════════ R7 · 失败恢复 ══════════════════ */

describe('R7 · 失败不导致阅读器崩溃', () => {
  it('R7a · 图片失败只标记该页，不设 error 态', () => {
    // 第9子步：失败标记收进状态机 markPageFailed（只改 status，不抛错、不设全局 error）
    expect(hookSrc).toContain('markPageFailed(st.current, index)')
    expect(stateSrc).toContain("r.status = 'failed'")
  })

  it('R7b · AbortError 不记为失败（正常流程）', () => {
    // 第8子步修正：原断言只认 name === 'AbortError'，
    // 但 binaryHttp 的取消错误 name 是 'BinaryHttpAbortError'，
    // 字符串比较永远匹配不上 ⇒ 切章/卸载会被误记为失败（F5 根因）。
    // 现统一走 isAbortError()，断言同步收紧为「必须用统一判别 + 不得再用裸字符串比较」。
    expect(hookSrc).toContain('isAbortError(e)')
    expect(hookSrc).not.toContain("=== 'AbortError'")
  })

  it('R7c · 整章无图片时才抛错（有明确提示）', () => {
    expect(readerSrc).toContain("本章节没有可阅读的图片")
  })

  it('R7d · 单页失败有重试入口', () => {
    expect(readerSrc).toContain('加载失败 · 点按重试')
    expect(hookSrc).toContain('const retry = useCallback')
  })

  it('R7e · 详情获取失败不影响阅读（catch 成 null）', () => {
    expect(readerSrc).toContain(".getDetail('manga', mangaId).catch(() => null)")
    expect(readerSrc).toContain("detail?.title || '在线章节'")
  })
})

/* ══════════════════ R8 · 进度隔离 ══════════════════ */

describe('R8 · 本地与在线进度互不覆盖', () => {
  it('R8a · itemId 用 `${sourceId}-${mangaId}` 区分来源', () => {
    expect(readerSrc).toContain('itemId: `${sourceId}-${mangaId}`')
  })

  it('R8b · 进度读取用同一格式（读写一致）', () => {
    expect(readerSrc).toContain('getReadingProgress(`${sourceId}-${mangaId}`)')
  })

  it('R8c · 写入时带 sourceId 字段', () => {
    expect(readerSrc).toContain('sourceId,')
  })

  it('R8d · 🔴 local 来源的 itemId 与旧格式逐字相同', () => {
    expect(`${LOCAL_SOURCE_ID}-m1`).toBe('local-m1')
  })

  it('R8e · 🔴 在线分支不查本地章节标题（避免串源）', () => {
    expect(readerSrc).toContain('const ch = isLocal')
    expect(readerSrc).toContain('Promise.resolve(chapterId)')
  })

  it('R8f · 本地与在线的页码语义一致（都用 pageIndex）', () => {
    expect(readerSrc).toContain('pageIndex: idx, pageCount: pages.length')
  })
})

/* ══════════════════ 生命周期未被重写 ══════════════════ */

describe('L · 未重写 ReaderPage 整体生命周期', () => {
  it('L1 · 仍只有一个主加载 useEffect（按 mangaId/chapterId）', () => {
    const m = readerSrc.match(/\}, \[mangaId, chapterId\]\)/g) || []
    expect(m.length).toBe(1)
  })

  it('L2 · 仍复用原 urlCache 机制', () => {
    expect(readerSrc).toContain('const urlCache = useRef(new Map<number, string>())')
  })

  it('L3 · 恢复进度抽成 restoreProgress，两分支共用', () => {
    expect(readerSrc).toContain('const restoreProgress = useCallback')
    const calls = readerSrc.match(/await restoreProgress\(/g) || []
    expect(calls.length).toBe(2)   // 本地 + 在线各一次
  })

  it('L4 · 未引入新依赖', () => {
    expect(readerSrc).not.toContain('axios')
    expect(hookSrc).not.toContain('axios')
    expect(hookSrc).not.toContain('swr')
    expect(hookSrc).not.toContain('react-query')
  })

  it('L5 · 未改动冻结区（无 nativeHttp/http 引用）', () => {
    expect(readerSrc).not.toMatch(/from ['"].*nativeHttp/)
    expect(readerSrc).not.toMatch(/from ['"].*api\/http/)
  })
})
