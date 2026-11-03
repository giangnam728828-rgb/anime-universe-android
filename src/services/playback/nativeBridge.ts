/**
 * 播放专项阶段1 —— TS ↔ Kotlin 原生桥
 *
 * 职责：
 *  - 封装 Capacitor 插件调用
 *  - 在非原生环境（Web 开发预览）下安全降级
 *  - 🔒 不持久化任何播放地址
 */

import { registerPlugin, Capacitor } from '@capacitor/core'
import type {
  Media3PlayerOpenOptions,
  Media3PlayerOpenResult,
  PlaybackEventPayload,
} from 'media3-player'

interface NativeMedia3 {
  open(o: Media3PlayerOpenOptions): Promise<Media3PlayerOpenResult>
  stop(): Promise<void>
  isAvailable(): Promise<{ available: boolean }>
  addListener(
    eventName: string,
    cb: (d: PlaybackEventPayload) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

/** Capacitor 插件代理（未安装插件时调用会抛错，由下方 wrapper 捕获） */
let native: NativeMedia3 | null = null
try {
  native = registerPlugin<NativeMedia3>('Media3Player')
} catch {
  native = null
}

/** 原生播放器是否可用（非 Android 环境 / 插件未注册时为 false） */
export function isNativePlayerAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && native !== null
}

/**
 * 打开原生全屏播放器。
 * ★ url 为临时地址，调用方必须在会话结束后丢弃，不得持久化。
 */
export async function openNativePlayer(
  opts: Media3PlayerOpenOptions,
): Promise<Media3PlayerOpenResult> {
  if (!isNativePlayerAvailable() || !native) {
    throw new Error('ACTIVITY_LAUNCH_FAILED: 原生播放器不可用')
  }
  return native.open(opts)
}

/** 停止并关闭原生播放器 */
export async function stopNativePlayer(): Promise<void> {
  if (!isNativePlayerAvailable() || !native) return
  try {
    await native.stop()
  } catch {
    // 忽略：Activity 可能已自行退出
  }
}

/** 订阅原生播放事件；返回取消订阅函数 */
export async function onNativePlaybackEvent(
  eventName: 'playbackState' | 'playbackError' | 'playbackClosed',
  cb: (d: PlaybackEventPayload) => void,
): Promise<() => void> {
  if (!isNativePlayerAvailable() || !native) return () => {}
  const handle = await native.addListener(eventName, cb)
  return () => {
    void handle.remove()
  }
}
