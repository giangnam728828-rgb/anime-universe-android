package com.giangnam728828.anime.universe.player

import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.media.AudioManager
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

/**
 * 播放专项阶段1 —— 原生全屏播放 Activity
 *
 * 范围（用户 P6 裁定）：首版只做全屏播放。
 *  - 不含 HLS / 字幕 / 音轨 / 竖屏预览 / 多线路
 *
 * 生命周期（用户裁定）：
 *  - onPause   暂停 + 释放音频焦点
 *  - onResume  不自动恢复（用户手动）
 *  - onDestroy player.release() 防泄漏 + 回传 Closed
 */
class PlayerActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "Media3PlayerAct"
        private const val EXTRA_URL = "url"
        private const val EXTRA_EPISODE = "episodeId"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_URI_KIND = "uriKind"

        /** 静态停止信号：插件 stop() 调用 */
        @Volatile
        private var stopRequested = false

        fun newIntent(
            ctx: Context,
            url: String,
            episodeId: String,
            title: String,
            uriKind: String,
        ): Intent =
            Intent(ctx, PlayerActivity::class.java).apply {
                putExtra(EXTRA_URL, url)
                putExtra(EXTRA_EPISODE, episodeId)
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_URI_KIND, uriKind)
            }

        fun requestStop() {
            stopRequested = true
        }
    }

    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null
    private var audioFocusHelper: AudioFocusHelper? = null
    private var released = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1) 横屏全屏
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        // 2) 取参数（★ 不写日志、不回显 url）
        val url = intent.getStringExtra(EXTRA_URL)
        val episodeId = intent.getStringExtra(EXTRA_EPISODE) ?: ""
        val uriKindRaw = intent.getStringExtra(EXTRA_URI_KIND)

        // ★ v2：Activity 侧再次校验（不信任上游，双保险）
        val v = PlaybackUriValidator.validate(url, uriKindRaw)
        if (!v.ok) {
            emitError("INVALID_MEDIA_URL", v.reason)
            finish()
            return
        }
        val uriKind = v.uriKind
        // 校验通过后 url 必非空，此处固化为非空类型供后续使用
        val mediaUrl: String = url ?: run {
            emitError("INVALID_MEDIA_URL", "播放地址为空")
            finish()
            return
        }

        // 3) 初始化播放器
        val p = try {
            ExoPlayer.Builder(this).build()
        } catch (e: Exception) {
            Log.e(TAG, "ExoPlayer 初始化失败: ${e.javaClass.simpleName}")
            emitError("PLAYER_INIT_FAILED", "初始化失败: ${e.javaClass.simpleName}")
            finish()
            return
        }
        player = p

        val view = PlayerView(this).apply {
            this.player = p
            useController = true
        }
        playerView = view
        setContentView(view)

        // 4) 音频焦点
        audioFocusHelper = AudioFocusHelper(this, onLoss = {
            p.pause()
            emitState("paused", p.currentPosition, p.duration.coerceAtLeast(0))
        })

        // 5) 事件监听
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                val s = when (state) {
                    Player.STATE_IDLE -> "idle"
                    Player.STATE_BUFFERING -> "buffering"
                    Player.STATE_READY -> if (p.playWhenReady) "playing" else "ready"
                    Player.STATE_ENDED -> "ended"
                    else -> "idle"
                }
                emitState(s, p.currentPosition, p.duration.coerceAtLeast(0))
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                emitState(
                    if (isPlaying) "playing" else "paused",
                    p.currentPosition,
                    p.duration.coerceAtLeast(0),
                )
            }

            override fun onPlayerError(error: PlaybackException) {
                val (code, msg) = mapError(error)
                // ★ 记录原始 Media3 错误码名（不含 url / 签名参数，便于以后排查）
                Log.e(TAG, "播放错误 $code (raw=${error.errorCodeName})")
                emitError(code, msg)
            }
        })

        // 6) 设置媒体源并播放
        try {
            p.setMediaItem(MediaItem.fromUri(mediaUrl))
            p.prepare()
            p.playWhenReady = true
            Log.i(TAG, "开始播放 episodeId=$episodeId uriKind=$uriKind")
        } catch (e: Exception) {
            Log.e(TAG, "媒体加载失败: ${e.javaClass.simpleName}")
            emitError("MEDIA_LOAD_FAILED", "媒体加载失败: ${e.javaClass.simpleName}")
        }
    }

    override fun onResume() {
        super.onResume()
        // 处理插件发起的 stop()
        if (stopRequested) {
            stopRequested = false
            finish()
        }
    }

    override fun onPause() {
        super.onPause()
        // 后台暂停 + 释放音频焦点（不自动恢复由用户手动点击）
        player?.let {
            if (it.isPlaying) it.pause()
            emitState("paused", it.currentPosition, it.duration.coerceAtLeast(0))
        }
        audioFocusHelper?.abandon()
    }

    override fun onDestroy() {
        super.onDestroy()
        releasePlayer()
    }

    /** 释放播放器与视图，防止内存泄漏 */
    private fun releasePlayer() {
        if (released) return
        released = true
        try {
            playerView?.player = null
            playerView = null
            player?.release()
            player = null
            audioFocusHelper?.abandon()
            audioFocusHelper = null
            emitClosed()
            Log.i(TAG, "播放器已释放")
        } catch (e: Exception) {
            Log.e(TAG, "释放失败: ${e.javaClass.simpleName}")
            emitError("PLAYER_RELEASE_FAILED", "释放失败: ${e.javaClass.simpleName}")
        }
    }

    /**
     * 错误码映射（用户 A5 裁定 + v2 修订）
     *
     * ★ 实现已抽取到 PlaybackErrorMapper（纯 JVM 对象），
     *   以便 T1-F 可做真实 Kotlin 单元测试。
     *   映射规则与 v2 完全一致，此处仅做委托。
     */
    private fun mapError(e: PlaybackException): Pair<String, String> =
        PlaybackErrorMapper.map(e.errorCode, e.javaClass.simpleName)

    // ---- 事件回传（仅主线程） ----
    private fun emitState(state: String, pos: Long, dur: Long) {
        runOnUiThread { Media3PlayerPlugin.instance?.emitState(state, pos, dur) }
    }

    private fun emitError(code: String, msg: String) {
        runOnUiThread { Media3PlayerPlugin.instance?.emitError(code, msg) }
    }

    private fun emitClosed() {
        runOnUiThread { Media3PlayerPlugin.instance?.emitClosed() }
    }
}
