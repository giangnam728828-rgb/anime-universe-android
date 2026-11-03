package com.giangnam728828.anime.universe.player

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.util.Log

/**
 * 播放专项阶段1 —— 音频焦点管理
 *
 * 用户 P6 验收项：来电 / 其他 APP 播放时应正确暂停。
 */
class AudioFocusHelper(
    private val context: Context,
    private val onLoss: () -> Unit,
) {
    companion object {
        private const val TAG = "Media3AudioFocus"
    }

    private val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var hasFocus = false

    private val listener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                Log.i(TAG, "音频焦点丢失: $change")
                hasFocus = false
                onLoss()
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                Log.i(TAG, "音频焦点恢复（不自动播放，由用户手动）")
                hasFocus = true
            }
            else -> Unit
        }
    }

    init {
        request()
    }

    /** 请求音频焦点 */
    fun request() {
        val mgr = am ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build(),
                )
                .setOnAudioFocusChangeListener(listener)
                .setWillPauseWhenDucked(true)
                .build()
            focusRequest = req
            hasFocus = mgr.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            hasFocus = mgr.requestAudioFocus(
                listener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN,
            ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
        Log.i(TAG, "请求音频焦点: granted=$hasFocus")
    }

    /** 释放音频焦点 */
    fun abandon() {
        val mgr = am ?: return
        if (!hasFocus && focusRequest == null) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { mgr.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            mgr.abandonAudioFocus(listener)
        }
        focusRequest = null
        hasFocus = false
        Log.i(TAG, "已释放音频焦点")
    }
}
