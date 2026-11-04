package com.giangnam728828.anime.universe.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 播放专项阶段1 —— T1-G：Scheme 白名单真实 Kotlin 单元测试
 *
 * ★ 本测试在 JVM 上真实执行 PlaybackUriValidator（不是等价移植），
 *   CI 通过 `./gradlew :media3-player:testDebugUnitTest` 运行。
 *
 * 覆盖用户 v2 裁定的全部规则：
 *  - uriKind 与 scheme 必须一致（不信任前端字段）
 *  - 未知 scheme 一律拒绝，绝不回退网络加载
 *  - asset 路径非空、防路径穿越（含编码穿越）
 *  - 不设 auto
 */
class PlaybackUriValidatorTest {

    // -----------------------------------------------------------------------
    // 1) 正常路径
    // -----------------------------------------------------------------------

    @Test
    fun `asset uri with asset kind is accepted`() {
        val r = PlaybackUriValidator.validate("asset:///test.mp4", "asset")
        assertTrue("asset:///test.mp4 + asset 应通过", r.ok)
        assertEquals("asset", r.uriKind)
        assertEquals("asset", r.scheme)
    }

    @Test
    fun `asset uri in subdirectory is accepted`() {
        val r = PlaybackUriValidator.validate("asset:///public/player-test/test.mp4", "asset")
        assertTrue("子目录 asset 应通过（不硬编码 test.mp4）", r.ok)
    }

    @Test
    fun `network uri with network kind is accepted`() {
        val r = PlaybackUriValidator.validate("https://example.com/a.mp4", "network")
        assertTrue(r.ok)
        assertEquals("https", r.scheme)
    }

    @Test
    fun `missing uriKind defaults to network`() {
        val r = PlaybackUriValidator.validate("https://example.com/a.mp4", null)
        assertTrue("不传 uriKind 应按 network 兼容旧调用", r.ok)
        assertEquals("network", r.uriKind)
    }

    // -----------------------------------------------------------------------
    // 2) ★ 核心：uriKind 与 scheme 不一致 → 拒绝（不信任前端字段）
    // -----------------------------------------------------------------------

    @Test
    fun `asset uri declared as network is rejected`() {
        val r = PlaybackUriValidator.validate("asset:///test.mp4", "network")
        assertFalse("asset:/// 声明为 network 必须拒绝", r.ok)
        assertEquals("资源类型与地址不匹配", r.reason)
    }

    @Test
    fun `network uri declared as asset is rejected`() {
        val r = PlaybackUriValidator.validate("https://example.com/a.mp4", "asset")
        assertFalse("网络地址声明为 asset 必须拒绝（防止伪装成 APK 资源）", r.ok)
        assertEquals("资源类型与地址不匹配", r.reason)
    }

    @Test
    fun `file uri declared as asset is rejected`() {
        val r = PlaybackUriValidator.validate("file:///etc/passwd", "asset")
        assertFalse("file:// 声明为 asset 必须拒绝", r.ok)
    }

    @Test
    fun `content uri declared as asset is rejected`() {
        val r = PlaybackUriValidator.validate("content://media/x.mp4", "asset")
        assertFalse(r.ok)
    }

    // -----------------------------------------------------------------------
    // 3) ★ 未知 / 危险 scheme 一律拒绝（绝不回退网络加载）
    // -----------------------------------------------------------------------

    @Test
    fun `unknown scheme is rejected`() {
        assertFalse(PlaybackUriValidator.validate("ftp://x/y.mp4", "network").ok)
    }

    @Test
    fun `javascript scheme is rejected`() {
        assertFalse(PlaybackUriValidator.validate("javascript:alert(1)", "network").ok)
    }

    @Test
    fun `custom scheme is rejected`() {
        assertFalse(PlaybackUriValidator.validate("myapp://evil/path", "network").ok)
    }

    @Test
    fun `data uri is rejected`() {
        assertFalse(PlaybackUriValidator.validate("data:text/html,<script>", "network").ok)
    }

    // -----------------------------------------------------------------------
    // 4) ★ asset 路径防穿越（T1-G 安全边界）
    // -----------------------------------------------------------------------

    @Test
    fun `dotdot traversal in asset path is rejected`() {
        val r = PlaybackUriValidator.validate("asset:///../etc/passwd", "asset")
        assertFalse("路径穿越 .. 必须拒绝", r.ok)
        assertEquals("资源路径非法", r.reason)
    }

    @Test
    fun `encoded dotdot traversal is rejected`() {
        val r = PlaybackUriValidator.validate("asset:///%2e%2e/etc/passwd", "asset")
        assertFalse("编码穿越 %2e%2e 必须拒绝", r.ok)
    }

    @Test
    fun `uppercase encoded traversal is rejected`() {
        assertFalse(
            "大写编码穿越 %2E%2E 必须拒绝",
            PlaybackUriValidator.validate("asset:///a/%2E%2E/b", "asset").ok,
        )
    }

    @Test
    fun `backslash traversal is rejected`() {
        assertFalse(PlaybackUriValidator.validate("asset:///..\\etc", "asset").ok)
    }

    @Test
    fun `nested dotdot is rejected`() {
        assertFalse(
            PlaybackUriValidator.validate("asset:///a/b/../../../etc/passwd", "asset").ok,
        )
    }

    // -----------------------------------------------------------------------
    // 5) 空路径 / 空地址
    // -----------------------------------------------------------------------

    @Test
    fun `empty asset path is rejected`() {
        assertFalse(PlaybackUriValidator.validate("asset:///", "asset").ok)
    }

    @Test
    fun `asset with no path is rejected`() {
        assertFalse(PlaybackUriValidator.validate("asset://", "asset").ok)
    }

    @Test
    fun `blank url is rejected`() {
        assertFalse(PlaybackUriValidator.validate("", "asset").ok)
        assertFalse(PlaybackUriValidator.validate("   ", "asset").ok)
    }

    @Test
    fun `null url is rejected`() {
        val r = PlaybackUriValidator.validate(null, "asset")
        assertFalse(r.ok)
        assertEquals("播放地址为空", r.reason)
    }

    // -----------------------------------------------------------------------
    // 6) 非法 uriKind（不设 auto）
    // -----------------------------------------------------------------------

    @Test
    fun `auto uriKind is rejected`() {
        assertFalse(
            "不设 auto，避免同一 URI 因隐式判断产生不同结果",
            PlaybackUriValidator.validate("asset:///test.mp4", "auto").ok,
        )
    }

    @Test
    fun `unknown uriKind value is rejected`() {
        assertFalse(PlaybackUriValidator.validate("asset:///test.mp4", "local").ok)
        assertFalse(PlaybackUriValidator.validate("asset:///test.mp4", "ASSET").ok)
    }

    // -----------------------------------------------------------------------
    // 7) 合法但非穿越的路径应被接受
    // -----------------------------------------------------------------------

    @Test
    fun `single dot path is accepted`() {
        assertTrue(PlaybackUriValidator.validate("asset:///a/./b.mp4", "asset").ok)
    }

    @Test
    fun `root level asset is accepted`() {
        assertTrue(PlaybackUriValidator.validate("asset:///a.mp4", "asset").ok)
    }

    @Test
    fun `http localhost is still valid network uri`() {
        // ★ 回归保护：即使旧的 https://localhost 写法，也只算「合法网络地址」，
        //   绝不会被当成 asset（这正是上一轮的根因所在）
        val r = PlaybackUriValidator.validate("https://localhost/test.mp4", "network")
        assertTrue(r.ok)
        assertEquals("network", r.uriKind)
        assertFalse(
            "https://localhost 绝不能通过 asset 校验",
            PlaybackUriValidator.validate("https://localhost/test.mp4", "asset").ok,
        )
    }

    // -----------------------------------------------------------------------
    // 8) 错误信息不得泄漏完整 URL
    // -----------------------------------------------------------------------

    @Test
    fun `reject reason never contains the url`() {
        val url = "https://secret.example.com/path?token=abc123"
        val r = PlaybackUriValidator.validate(url, "asset")
        assertFalse(r.ok)
        assertFalse("拒绝原因不得回显 URL", r.reason.contains("token"))
        assertFalse("拒绝原因不得回显 URL", r.reason.contains("secret"))
    }
}
