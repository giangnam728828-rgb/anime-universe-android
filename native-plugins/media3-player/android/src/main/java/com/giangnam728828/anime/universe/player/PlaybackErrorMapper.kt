package com.giangnam728828.anime.universe.player

import androidx.media3.common.PlaybackException

/**
 * 播放专项阶段1 —— T1-F：Media3 错误码 → 应用错误码映射
 *
 * ★ 为什么单独成类：
 *   原实现位于 PlayerActivity 的 private fun mapError()，
 *   依赖 Android Context 无法做 JVM 单元测试。
 *   本类为**纯函数**（只读 PlaybackException.errorCode），
 *   可在 JVM 上真实执行测试，同时被 PlayerActivity 复用。
 *
 * 🔒 行为与 v2 方案完全一致，仅移动代码位置，不改变映射规则。
 *
 * 用户批准的映射表：
 *   ERROR_CODE_IO_FILE_NOT_FOUND             → MEDIA_RESOURCE_NOT_FOUND
 *   ERROR_CODE_PARSING_CONTAINER_MALFORMED   → MEDIA_FORMAT_INVALID
 *   ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED → MEDIA_FORMAT_INVALID
 *   ERROR_CODE_DECODER_INIT_FAILED           → DECODER_FAILED
 *   ERROR_CODE_DECODING_FAILED               → DECODER_FAILED
 *   ERROR_CODE_DECODING_FORMAT_UNSUPPORTED   → DECODER_FAILED
 *   其它 IO 错误                              → MEDIA_LOAD_FAILED（不冒充「资源不存在」）
 */
object PlaybackErrorMapper {

    /** 应用错误码常量（与 TS 侧 PlaybackErrorCode 对齐） */
    const val CODE_INVALID_MEDIA_URL = "INVALID_MEDIA_URL"
    const val CODE_MEDIA_LOAD_FAILED = "MEDIA_LOAD_FAILED"
    const val CODE_MEDIA_RESOURCE_NOT_FOUND = "MEDIA_RESOURCE_NOT_FOUND"
    const val CODE_MEDIA_FORMAT_INVALID = "MEDIA_FORMAT_INVALID"
    const val CODE_DECODER_FAILED = "DECODER_FAILED"

    /**
     * 映射 Media3 原始 errorCode。
     *
     * @param errorCode PlaybackException.errorCode
     * @param detail    异常类名（**不含 URL / 签名参数**）
     * @return Pair(应用错误码, 说明)
     */
    fun map(errorCode: Int, detail: String): Pair<String, String> = when (errorCode) {
        // ★ 资源不存在（APK 内素材缺失等）
        PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND ->
            CODE_MEDIA_RESOURCE_NOT_FOUND to "本地播放资源不存在: $detail"

        // ★ 容器 / 清单格式无法解析
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
        PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
        PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED ->
            CODE_MEDIA_FORMAT_INVALID to "媒体文件格式异常: $detail"

        // ★ 解码失败
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES ->
            CODE_DECODER_FAILED to "视频解码失败: $detail"

        // 网络类（阶段2/3 用；本阶段 asset 不会走到）
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ->
            CODE_MEDIA_LOAD_FAILED to "网络加载失败: $detail"

        // ★ 其它 IO 错误：保持 MEDIA_LOAD_FAILED，不冒充「资源不存在」
        PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
        PlaybackException.ERROR_CODE_IO_NO_PERMISSION,
        PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE ->
            CODE_MEDIA_LOAD_FAILED to "本地资源读取失败: $detail"

        else -> CODE_MEDIA_LOAD_FAILED to "播放失败: $detail"
    }
}
