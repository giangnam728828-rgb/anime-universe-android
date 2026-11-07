/**
 * 取消错误的统一识别（P1 第8子步）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 为什么必须单独抽一个判别函数
 * ══════════════════════════════════════════════════════════════════════
 * `binaryHttp.ts` 里的取消错误是 **`BinaryHttpAbortError`**，
 * 它的 `name` 是 `'BinaryHttpAbortError'`，**不是** 浏览器原生的 `'AbortError'`。
 *
 * 而 `useOnlineWindow.ts` 原先只判断：
 *     if (e?.name === 'AbortError') { 忽略 } else { 记为失败 }
 *
 * ⇒ 实际永远匹配不上 ⇒ **切章 / 卸载 / 取消下载都会被误记成「图片加载失败」**。
 *   这正是第8子步 F5 要求消除的误判。
 *
 * 判别口径（三重，任一命中即认定为取消）：
 *   1. `name === 'AbortError'`            —— DOM 原生 fetch 被 abort
 *   2. `name === 'BinaryHttpAbortError'`  —— 本项目的二进制下载层取消
 *   3. `stage === 'aborted'`              —— BinaryHttpError 的阶段字段（兜底）
 *
 * ⚠️ 本文件不改动 `binaryHttp.ts`（冻结区），只做「识别」，不做「包装」。
 */

/** 取消错误的最小结构（不依赖具体类，避免与 binaryHttp 产生类型耦合） */
interface AbortLike {
  name?: unknown
  stage?: unknown
}

/**
 * 判断一个异常是否属于「调用方主动取消」。
 *
 * 取消是**正常流程**（切章 / 关闭阅读器 / 卡片卸载），
 * 调用方必须把它与「真实失败」区分开：取消不得显示错误、不得计入失败集合。
 */
export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const x = e as AbortLike
  if (x.name === 'AbortError') return true
  if (x.name === 'BinaryHttpAbortError') return true
  if (x.stage === 'aborted') return true
  return false
}

/** 构造一个标准取消错误（供 raceAbort 等场景使用） */
export function makeAbortError(message = '请求已取消'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}
