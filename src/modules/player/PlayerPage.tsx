/**
 * 播放专项阶段1 —— 播放页（React 侧）
 *
 * 职责（用户 P5 裁定）：
 *  - 负责进入播放流程、传递作品与剧集信息
 *  - 原生 Activity 负责视频呈现与播放控制
 *
 * 🔒 路由只承载稳定 ID（sourceId / workId / episodeId），
 *    不放 URL / Cookie / Token / 签名参数。
 *
 * 阶段1 范围：不接任何第三方播放源，仅验证原生播放器链路。
 */

import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  isNativePlayerAvailable,
  onNativePlaybackEvent,
  openNativePlayer,
  stopNativePlayer,
} from '../../services/playback/nativeBridge'
import { clearSession, setPlaybackState } from '../../services/playback/PlaybackService'
import type { PlaybackErrorCode, PlaybackState } from '../../services/playback/types'

/** 阶段1 自检素材：随插件源码入库的自制测试视频（见 native-plugins/media3-player/android/src/main/assets） */
const SELF_TEST_ASSET = 'test.mp4'

/**
 * ★ v2 裁定：APK 内置素材必须使用 `asset:///` URI（Media3 AssetDataSource）。
 *
 * 禁止使用 `window.location.origin`：
 *   本项目 capacitor.config.ts 设 androidScheme='https'，
 *   window.location.origin === 'https://localhost'，
 *   该地址只在 WebView 内部可达，**原生进程无法访问**，
 *   会使 Media3 走 DefaultHttpDataSource 发起真实网络请求并失败
 *   （这正是上一轮 MEDIA_LOAD_FAILED「网络加载失败」的根因）。
 *
 * APK 内路径 assets/test.mp4 ↔ URI asset:///test.mp4
 */
const SELF_TEST_ASSET_URI = `asset:///${SELF_TEST_ASSET}`

export function PlayerPage() {
  const { sourceId, workId, episodeId } = useParams<{
    sourceId: string
    workId: string
    episodeId: string
  }>()
  const nav = useNavigate()

  const [state, setState] = useState<PlaybackState>('idle')
  const [errorCode, setErrorCode] = useState<PlaybackErrorCode | null>(null)
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [nativeOk] = useState<boolean>(() => isNativePlayerAvailable())

  // 订阅原生事件
  useEffect(() => {
    let offState: (() => void) | undefined
    let offErr: (() => void) | undefined
    let offClosed: (() => void) | undefined
    let alive = true

    void (async () => {
      offState = await onNativePlaybackEvent('playbackState', (d) => {
        if (!alive) return
        const s = (d.state ?? 'idle') as PlaybackState
        setState(s)
        setPlaybackState(s)
      })
      offErr = await onNativePlaybackEvent('playbackError', (d) => {
        if (!alive) return
        setErrorCode((d.errorCode ?? 'UNKNOWN') as PlaybackErrorCode)
        setErrorMsg(d.errorMessage ?? '')
        setState('error')
        setPlaybackState('error')
      })
      offClosed = await onNativePlaybackEvent('playbackClosed', () => {
        if (!alive) return
        setState('idle')
        setPlaybackState('idle')
      })
    })()

    return () => {
      alive = false
      offState?.()
      offErr?.()
      offClosed?.()
    }
  }, [])

  // 页面卸载时清理会话（丢弃临时地址）
  useEffect(() => {
    return () => {
      clearSession()
    }
  }, [])

  /** 阶段1 自检：用随包素材验证原生播放链路 */
  const handleSelfTest = useCallback(async () => {
    setErrorCode(null)
    setErrorMsg('')
    try {
      await openNativePlayer({
        sourceId: sourceId ?? 'selftest',
        workId: workId ?? 'selftest',
        episodeId: episodeId ?? '1',
        // ★ v2：显式声明为 APK 内置资源，使用 asset:/// scheme
        url: SELF_TEST_ASSET_URI,
        uriKind: 'asset',
        title: '阶段1 自检素材',
      })
    } catch (e) {
      setErrorCode('ACTIVITY_LAUNCH_FAILED')
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }, [sourceId, workId, episodeId])

  const handleStop = useCallback(async () => {
    await stopNativePlayer()
  }, [])

  return (
    <div style={{ padding: 24, color: '#E8E8F0', maxWidth: 720, margin: '0 auto' }}>
      <button
        onClick={() => nav(-1)}
        style={{
          background: 'transparent',
          border: '1px solid #333',
          color: '#E8E8F0',
          borderRadius: 8,
          padding: '8px 16px',
          marginBottom: 24,
          cursor: 'pointer',
        }}
      >
        ← 返回
      </button>

      <h2 style={{ margin: '0 0 8px' }}>原生播放器</h2>
      <p style={{ color: '#8A8A99', fontSize: 13, margin: '0 0 24px' }}>
        播放专项阶段1 · 链路自检（不接入任何第三方播放源）
      </p>

      <div
        style={{
          background: '#14141C',
          border: '1px solid #26262F',
          borderRadius: 12,
          padding: 16,
          marginBottom: 16,
          fontSize: 13,
          lineHeight: 1.9,
        }}
      >
        <Row label="sourceId" value={sourceId ?? '—'} />
        <Row label="workId" value={workId ?? '—'} />
        <Row label="episodeId" value={episodeId ?? '—'} />
        <Row label="原生插件" value={nativeOk ? '可用' : '不可用（Web 预览）'} />
        <Row label="播放状态" value={state} />
        {errorCode && <Row label="错误码" value={errorCode} danger />}
        {errorMsg && <Row label="错误信息" value={errorMsg} danger />}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={handleSelfTest} disabled={!nativeOk} style={btnPrimary(nativeOk)}>
          播放自检素材
        </button>
        <button onClick={handleStop} disabled={!nativeOk} style={btnGhost(nativeOk)}>
          停止播放
        </button>
      </div>

      <p style={{ color: '#5A5A68', fontSize: 12, marginTop: 24, lineHeight: 1.8 }}>
        阶段1 只验收：Activity 开关 · 本地 MP4 · 播放暂停 · 进度拖动 · 横屏全屏 · 音频焦点 ·
        资源释放 · 错误回传。
        <br />
        HLS、字幕、音轨、竖屏预览、多线路切换不在本阶段范围。
      </p>
    </div>
  )
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ color: '#5A5A68' }}>{label}</span>
      <span
        style={{
          color: danger ? '#FF6B6B' : '#C8C8D8',
          textAlign: 'right',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </span>
    </div>
  )
}

function btnPrimary(enabled: boolean): React.CSSProperties {
  return {
    background: enabled ? '#6C5CE7' : '#2A2A35',
    border: 'none',
    color: enabled ? '#fff' : '#5A5A68',
    borderRadius: 8,
    padding: '10px 20px',
    fontSize: 14,
    cursor: enabled ? 'pointer' : 'not-allowed',
  }
}

function btnGhost(enabled: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid #333',
    color: enabled ? '#C8C8D8' : '#5A5A68',
    borderRadius: 8,
    padding: '10px 20px',
    fontSize: 14,
    cursor: enabled ? 'pointer' : 'not-allowed',
  }
}

export default PlayerPage
