package com.giangnam728828.anime.universe.player

import androidx.media3.common.PlaybackException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * 播放专项阶段1 —— T1-F：错误码映射真实 Kotlin 单元测试
 *
 * ★ 在 JVM 上真实执行 PlaybackErrorMapper（不是等价移植），
 *   CI 通过 `./gradlew :media3-player:testDebugUnitTest` 运行。
 *
 * 核心断言（用户 v2 裁定）：
 *  - 只有 ERROR_CODE_IO_FILE_NOT_FOUND 映射为 MEDIA_RESOURCE_NOT_FOUND
 *  - 其它 IO 错误**不得**冒充「资源不存在」
 *  - 容器/格式错误独立为 MEDIA_FORMAT_INVALID
 */
class PlaybackErrorMapperTest {

    private val detail = "AssetDataSourceException"

    private fun codeOf(err: Int) = PlaybackErrorMapper.map(err, detail).first

    // -----------------------------------------------------------------------
    // 1) ★ T1-F 核心：资源不存在
    // -----------------------------------------------------------------------

    @Test
    fun `io file not found maps to MEDIA_RESOURCE_NOT_FOUND`() {
        assertEquals(
            "ERROR_CODE_IO_FILE_NOT_FOUND 必须映射为 MEDIA_RESOURCE_NOT_FOUND",
            "MEDIA_RESOURCE_NOT_FOUND",
            codeOf(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND),
        )
    }

    @Test
    fun `resource not found message describes missing local resource`() {
        val (_, msg) = PlaybackErrorMapper.map(
            PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND, detail,
        )
        assertEquals("本地播放资源不存在: $detail", msg)
    }

    // -----------------------------------------------------------------------
    // 2) ★ 关键：其它 IO 错误不得归类为「资源不存在」
    // -----------------------------------------------------------------------

    @Test
    fun `io unspecified does NOT map to resource not found`() {
        val c = codeOf(PlaybackException.ERROR_CODE_IO_UNSPECIFIED)
        assertEquals("MEDIA_LOAD_FAILED", c)
        assertNotEquals(
            "其它 IO 错误不得冒充「资源不存在」",
            "MEDIA_RESOURCE_NOT_FOUND", c,
        )
    }

    @Test
    fun `io no permission does NOT map to resource not found`() {
        assertNotEquals(
            "MEDIA_RESOURCE_NOT_FOUND",
            codeOf(PlaybackException.ERROR_CODE_IO_NO_PERMISSION),
        )
    }

    @Test
    fun `io read position out of range does NOT map to resource not found`() {
        assertNotEquals(
            "MEDIA_RESOURCE_NOT_FOUND",
            codeOf(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE),
        )
    }

    @Test
    fun `network errors do NOT map to resource not found`() {
        val networkCodes = listOf(
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
            PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
        )
        networkCodes.forEach { err ->
            assertNotEquals(
                "网络错误不得映射为资源不存在",
                "MEDIA_RESOURCE_NOT_FOUND", codeOf(err),
            )
        }
    }

    // -----------------------------------------------------------------------
    // 3) 格式 / 容器错误
    // -----------------------------------------------------------------------

    @Test
    fun `container malformed maps to MEDIA_FORMAT_INVALID`() {
        assertEquals(
            "MEDIA_FORMAT_INVALID",
            codeOf(PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED),
        )
    }

    @Test
    fun `container unsupported maps to MEDIA_FORMAT_INVALID`() {
        assertEquals(
            "MEDIA_FORMAT_INVALID",
            codeOf(PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED),
        )
    }

    @Test
    fun `container errors do NOT map to resource not found`() {
        assertNotEquals(
            "MEDIA_RESOURCE_NOT_FOUND",
            codeOf(PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED),
        )
    }

    // -----------------------------------------------------------------------
    // 4) 解码错误
    // -----------------------------------------------------------------------

    @Test
    fun `decoder init failed maps to DECODER_FAILED`() {
        assertEquals(
            "DECODER_FAILED",
            codeOf(PlaybackException.ERROR_CODE_DECODER_INIT_FAILED),
        )
    }

    @Test
    fun `decoding failed maps to DECODER_FAILED`() {
        assertEquals(
            "DECODER_FAILED",
            codeOf(PlaybackException.ERROR_CODE_DECODING_FAILED),
        )
    }

    @Test
    fun `decoding format unsupported maps to DECODER_FAILED`() {
        assertEquals(
            "DECODER_FAILED",
            codeOf(PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED),
        )
    }

    // -----------------------------------------------------------------------
    // 5) 兜底：未知错误码不得伪装成「资源不存在」
    // -----------------------------------------------------------------------

    @Test
    fun `unknown error code falls back to MEDIA_LOAD_FAILED`() {
        val c = codeOf(PlaybackException.ERROR_CODE_UNSPECIFIED)
        assertEquals("MEDIA_LOAD_FAILED", c)
        assertNotEquals("MEDIA_RESOURCE_NOT_FOUND", c)
    }

    // -----------------------------------------------------------------------
    // 6) 说明文本不得泄漏 URL
    // -----------------------------------------------------------------------

    @Test
    fun `messages only carry detail not url`() {
        val (_, msg) = PlaybackErrorMapper.map(
            PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND, detail,
        )
        assertFalse("说明不得包含 URL 片段", msg.contains("http"))
        // ★ 注意：这里用 JUnit 的 assertEquals 断言包含关系，避免自定义同名 helper
        assertEquals(
            "说明应含异常类名便于排查",
            true, msg.contains(detail),
        )
    }
}
