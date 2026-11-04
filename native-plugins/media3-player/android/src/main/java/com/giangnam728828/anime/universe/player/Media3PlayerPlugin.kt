package com.giangnam728828.anime.universe.player

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import android.content.Intent
import android.util.Log

/**
 * 播放专项阶段1 —— Media3 原生播放器插件
 *
 * 职责隔离（用户架构裁定）：
 *  - 本插件只负责「把临时播放地址交给原生 Activity」并回传事件
 *  - 不关心视频来自哪个来源
 *  - 不持久化任何播放地址
 *
 * 设计约束：
 *  - 临时播放地址只在会话内有效
 *  - 不把 Cookie / Token / 签名 URL 写入日志
 */
@CapacitorPlugin(name = "Media3Player")
class Media3PlayerPlugin : Plugin() {

    companion object {
        private const val TAG = "Media3Player"
        /** 供 Activity 回传事件用（静态弱引用到当前插件实例） */
        @Volatile
        var instance: Media3PlayerPlugin? = null
            private set
    }

    override fun load() {
        instance = this
    }

    override fun handleOnDestroy() {
        if (instance === this) instance = null
    }

    /**
     * 打开原生全屏播放界面。
     *
     * ★ url 为临时地址，仅在本次会话内有效。
     * ★ v2：接收 uriKind 并做严格校验（不单纯信任前端字段）。
     */
    @PluginMethod
    fun open(call: PluginCall) {
        val url = call.getString("url")
        val episodeId = call.getString("episodeId") ?: ""
        val title = call.getString("title") ?: ""
        val uriKindRaw = call.getString("uriKind")

        // ★ v2 校验：空值 / uriKind 合法性 / scheme 白名单 /
        //    uriKind 与 scheme 一致性 / asset 路径防穿越
        val v = PlaybackUriValidator.validate(url, uriKindRaw)
        if (!v.ok) {
            call.reject("INVALID_MEDIA_URL", v.reason)
            emitError("INVALID_MEDIA_URL", v.reason)
            return
        }
        val scheme = v.scheme
        val uriKind = v.uriKind

        val act = activity
        if (act == null) {
            call.reject("ACTIVITY_LAUNCH_FAILED", "宿主 Activity 不可用")
            emitError("ACTIVITY_LAUNCH_FAILED", "宿主 Activity 不可用")
            return
        }

        try {
            val intent = PlayerActivity.newIntent(act, url!!, episodeId, title, uriKind)
            act.startActivity(intent)
            // ★ 不记录 url 到日志（只记录类型与 scheme）
            Log.i(TAG, "open(): episodeId=$episodeId uriKind=$uriKind scheme=$scheme")
            call.resolve(JSObject().put("opened", true))
        } catch (e: Exception) {
            // ★ 异常信息中可能含 url，只记录类型
            Log.e(TAG, "open() 启动失败: ${e.javaClass.simpleName}")
            call.reject("ACTIVITY_LAUNCH_FAILED", "无法启动播放界面: ${e.javaClass.simpleName}")
            emitError("ACTIVITY_LAUNCH_FAILED", "无法启动播放界面: ${e.javaClass.simpleName}")
        }
    }

    /** 请求停止并关闭播放器 */
    @PluginMethod
    fun stop(call: PluginCall) {
        PlayerActivity.requestStop()
        call.resolve()
    }

    /** 插件可用性探测（供 JS 侧降级判断） */
    @PluginMethod
    fun isAvailable(call: PluginCall) {
        call.resolve(JSObject().put("available", true))
    }

    // -----------------------------------------------------------------------
    // 供 PlayerActivity 回调（在主线程调用）
    // -----------------------------------------------------------------------

    fun emitState(state: String, positionMs: Long, durationMs: Long) {
        val o = JSObject().apply {
            put("state", state)
            put("positionMs", positionMs)
            put("durationMs", durationMs)
        }
        notifyListeners("playbackState", o)
    }

    fun emitError(code: String, message: String) {
        val o = JSObject().apply {
            put("errorCode", code)
            put("errorMessage", message)
            put("state", "error")
        }
        notifyListeners("playbackError", o)
    }

    fun emitClosed() {
        notifyListeners("playbackClosed", JSObject())
    }
}
