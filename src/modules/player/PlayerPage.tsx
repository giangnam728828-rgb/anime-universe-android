/**
 * 播放专项阶段1 → 阶段3第2步批次③ —— 播放页（React 侧）
 *
 * 职责（用户 P5 裁定 + 批次③ 授权）：
 *  - 负责进入播放流程、传递作品与剧集信息
 *  - 原生 Activity 负责视频呈现与播放控制
 *  - **不解析播放源**：解析、会话、候选全部经 `playerFlow.ts`
 *
 * 🔒 路由只承载稳定 ID（sourceId / workId / episodeId），
 *    不放 URL / Cookie / Token / 签名参数。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 批次③ 新增：两种模式严格隔离
 * ══════════════════════════════════════════════════════════════════════
 *   real     真实播放：enabledResolvers → 聚合 → 会话 → 当前候选 URL
 *   selftest 自检：APK 内置 asset:///test.mp4
 *
 * 🔴 真实播放失败**绝不**回退自检素材
 *    —— 避免把播放源故障伪装成播放成功（用户批次③ 硬约束）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  isNativePlayerAvailable,
  onNativePlaybackEvent,
  openNativePlayer,
  stopNativePlayer,
} from '../../services/playback/nativeBridge'
import { clearSession, setPlaybackState } from '../../services/playback/PlaybackService'
import type { PlaybackErrorCode, PlaybackState } from '../../services/playback/types'
import {
  listCandidateOptions,
  prepareRealPlayback,
  prepareSelfTestPlayback,
  switchCandidate,
  type CandidateOption,
  type NativePlaybackParams,
  type PlayerMode,
} from './playerFlow'

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

  /** 当前模式；未播放过时为 null（不预设，避免误显示） */
  const [mode, setMode] = useState<PlayerMode | null>(null)
  /** 真实解析中 */
  const [resolving, setResolving] = useState(false)
  /** 解析失败文案（不含 URL） */
  const [resolveError, setResolveError] = useState<string>('')
  /** 可切换候选（不含 URL） */
  const [options, setOptions] = useState<CandidateOption[]>([])

  /** 页面存活标记：解析期间卸载则丢弃迟到结果 */
  const aliveRef = useRef(true)

  const wId = workId ?? 'unknown'
  const eId = episodeId ?? 'unknown'

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
        // 🔴 真实播放失败：只显示错误，绝不回退自检素材
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

  // 页面卸载：清理会话（丢弃临时地址）+ 标记失效
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      clearSession()
    }
  }, [])

  /** 清空错误状态 */
  const resetErrors = useCallback(() => {
    setErrorCode(null)
    setErrorMsg('')
    setResolveError('')
  }, [])

  /** 把参数交给原生播放器 */
  const openWith = useCallback(async (params: NativePlaybackParams) => {
    await openNativePlayer({
      sourceId: params.sourceId,
      workId: params.workId,
      episodeId: params.episodeId,
      url: params.url,
      uriKind: params.uriKind,
      headers: params.headers,
      title: params.title,
    })
  }, [])

  /**
   * 真实播放。
   *
   * 🔴 失败路径不含任何 `prepareSelfTestPlayback` 调用。
   */
  const handleRealPlay = useCallback(async () => {
    resetErrors()
    setMode('real')
    setResolving(true)
    setOptions([])
    try {
      const r = await prepareRealPlayback(wId, eId)

      // 🔴 解析期间页面已卸载 ⇒ 丢弃迟到结果，不建立新会话
      if (!aliveRef.current) return

      if (!r.ok) {
        setResolveError(r.message)
        setState('error')
        return
      }

      setOptions(listCandidateOptions())
      await openWith(r.params)
    } catch (e) {
      if (!aliveRef.current) return
      setErrorCode('ACTIVITY_LAUNCH_FAILED')
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setState('error')
    } finally {
      if (aliveRef.current) setResolving(false)
    }
  }, [wId, eId, resetErrors, openWith])

  /**
   * 自检播放。
   *
   * 🔴 与 real 完全隔离：不解析、不建会话、不发网络请求。
   */
  const handleSelfTest = useCallback(async () => {
    resetErrors()
    setMode('selftest')
    setOptions([])
    try {
      await openWith(prepareSelfTestPlayback(wId, eId))
    } catch (e) {
      setErrorCode('ACTIVITY_LAUNCH_FAILED')
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }, [wId, eId, resetErrors, openWith])

  /** 切换线路 */
  const handleSwitch = useCallback(
    async (candidateId: string) => {
      resetErrors()
      const r = switchCandidate(candidateId, wId, eId)
      if (!r.ok) {
        setResolveError(r.message)
        return
      }
      setOptions(listCandidateOptions())
      try {
        await openWith(r.params)
      } catch (e) {
        setErrorCode('ACTIVITY_LAUNCH_FAILED')
        setErrorMsg(e instanceof Error ? e.message : String(e))
      }
    },
    [wId, eId, resetErrors, openWith],
  )

  const handleStop = useCallback(async () => {
    await stopNativePlayer()
    clearSession()
    setOptions([])
  }, [])

  const canSwitch = options.length > 1

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
        真实播放经多源解析与会话选择；自检素材仅用于验证原生链路
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
        {/* 路由参数里的 sourceId 是「内容来源」，不是播放来源 */}
        <Row label="内容来源 sourceId" value={sourceId ?? '—'} />
        <Row label="workId" value={workId ?? '—'} />
        <Row label="episodeId" value={episodeId ?? '—'} />
        <Row label="播放模式" value={mode ?? '未开始'} />
        <Row label="原生插件" value={nativeOk ? '可用' : '不可用（Web 预览）'} />
        <Row label="播放状态" value={resolving ? '解析中…' : state} />
        {canSwitch && <Row label="可用线路" value={`${options.length} 条`} />}
        {resolveError && <Row label="解析结果" value={resolveError} danger />}
        {errorCode && <Row label="错误码" value={errorCode} danger />}
        {errorMsg && <Row label="错误信息" value={errorMsg} danger />}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button
          onClick={handleRealPlay}
          disabled={!nativeOk || resolving}
          style={btnPrimary(nativeOk && !resolving)}
        >
          {resolving ? '解析中…' : '播放本集'}
        </button>
        <button onClick={handleSelfTest} disabled={!nativeOk} style={btnGhost(nativeOk)}>
          播放自检素材
        </button>
        <button onClick={handleStop} disabled={!nativeOk} style={btnGhost(nativeOk)}>
          停止播放
        </button>
      </div>

      {/* 多线路切换：仅在真实播放且有多条候选时显示 */}
      {canSwitch && (
        <div style={{ marginTop: 20 }}>
          <p style={{ color: '#8A8A99', fontSize: 13, margin: '0 0 8px' }}>切换线路</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {options.map((o) => (
              <button
                key={o.candidateId}
                onClick={() => handleSwitch(o.candidateId)}
                style={o.selected ? btnPrimary(true) : btnGhost(true)}
              >
                {o.sourceName}
                {o.protocol === 'hls' ? ' · HLS' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      <p style={{ color: '#5A5A68', fontSize: 12, marginTop: 24, lineHeight: 1.8 }}>
        真实播放失败时只显示错误，不会自动改用自检素材。
        <br />
        播放地址仅存在于内存会话，不写入任何持久化存储。
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
