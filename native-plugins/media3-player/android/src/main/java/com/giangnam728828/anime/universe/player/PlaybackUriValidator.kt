package com.giangnam728828.anime.universe.player

import java.net.URI
import java.net.URLDecoder

/**
 * 播放专项阶段1 —— URI 校验（v2 方案裁定）
 *
 * 设计目标（用户 v2 裁定）：
 *  - 显式区分资源类型，不依赖 URL 猜测
 *  - 原生侧必须校验 uriKind 与 scheme 是否一致，不单纯信任前端字段
 *  - 未知 scheme 一律拒绝，不允许自动回退到网络加载
 *  - asset 路径：允许前缀 + 防路径穿越（不硬编码单一文件名）
 *
 * 安全约束：
 *  - 本对象只做校验，不记录、不回显完整 URL
 */
object PlaybackUriValidator {

    /** uriKind 取值（与 TS 侧 UriKind 对齐） */
    const val KIND_ASSET = "asset"
    const val KIND_NETWORK = "network"

    /** 未传 uriKind 时的默认类型（兼容旧调用） */
    const val DEFAULT_KIND = KIND_NETWORK

    /** 允许的 scheme 白名单（阶段1：asset + 网络 + 本地文件 + ContentProvider） */
    private val ALLOWED_SCHEMES = setOf("asset", "http", "https", "file", "content")

    /** 结果：成功时携带规范化后的 uriKind 与 scheme */
    data class Result(
        val ok: Boolean,
        val uriKind: String = "",
        val scheme: String = "",
        /** 拒绝原因（**不含 URL 内容**，可安全回传/记录） */
        val reason: String = "",
    )

    /**
     * 校验播放地址。
     *
     * @param url      待校验地址
     * @param uriKindRaw 前端声明的资源类型（可为 null）
     */
    fun validate(url: String?, uriKindRaw: String?): Result {
        // 1) 非空
        if (url.isNullOrBlank()) {
            return Result(false, reason = "播放地址为空")
        }

        // 2) uriKind 合法性与默认值（不设 auto）
        val uriKind = when {
            uriKindRaw == null -> DEFAULT_KIND
            uriKindRaw == KIND_ASSET || uriKindRaw == KIND_NETWORK -> uriKindRaw
            else -> return Result(false, reason = "不支持的资源类型")
        }

        // 3) 解析 scheme（失败即拒绝，不猜测）
        val scheme = runCatching { URI(url).scheme?.lowercase() }.getOrNull()
            ?: return Result(false, reason = "播放地址格式无效")

        // 4) scheme 白名单：未知 scheme 一律拒绝，绝不回退网络加载
        if (scheme !in ALLOWED_SCHEMES) {
            return Result(false, reason = "不支持的播放地址类型")
        }

        // 5) ★ 关键：uriKind 与 scheme 必须一致（不信任前端字段）
        when (uriKind) {
            KIND_ASSET -> {
                if (scheme != "asset") {
                    return Result(false, reason = "资源类型与地址不匹配")
                }
                val pathCheck = validateAssetPath(url)
                if (!pathCheck.ok) return pathCheck
            }
            KIND_NETWORK -> {
                if (scheme != "http" && scheme != "https") {
                    return Result(false, reason = "资源类型与地址不匹配")
                }
            }
        }

        return Result(true, uriKind = uriKind, scheme = scheme)
    }

    /**
     * asset:/// 路径校验：允许前缀 + 防穿越（不硬编码 test.mp4）。
     *
     * 规则：
     *  - 路径必须非空、且以 "/" 开头
     *  - 拒绝空路径、仅 "/"、仅空白
     *  - 拒绝 ".."（原始与解码后都要查）
     *  - 拒绝 "%2e%2e" 等编码穿越（解码后再查一次）
     *  - 拒绝反斜杠（Windows 风格穿越）
     *  - 不允许访问 APK 之外的文件
     */
    fun validateAssetPath(url: String): Result {
        val rawPath = runCatching { URI(url).path }.getOrNull()
            ?: return Result(false, reason = "播放地址格式无效")

        if (rawPath.isBlank()) {
            return Result(false, reason = "资源路径为空")
        }
        if (!rawPath.startsWith("/")) {
            return Result(false, reason = "资源路径格式无效")
        }
        // 仅 "/" 视为空路径
        if (rawPath.trim('/').isBlank()) {
            return Result(false, reason = "资源路径为空")
        }

        // 原始形态检查
        if (rawPath.contains("..")) {
            return Result(false, reason = "资源路径非法")
        }
        if (rawPath.contains('\\')) {
            return Result(false, reason = "资源路径非法")
        }

        // ★ 解码后再检查一次（防 %2e%2e / %2f / %5c 等编码穿越）
        val decoded = runCatching { URLDecoder.decode(rawPath, "UTF-8") }.getOrNull()
            ?: return Result(false, reason = "资源路径编码非法")

        if (decoded.contains("..")) {
            return Result(false, reason = "资源路径非法")
        }
        if (decoded.contains('\\')) {
            return Result(false, reason = "资源路径非法")
        }
        // 解码后仍须以 / 开头且非空
        if (!decoded.startsWith("/") || decoded.trim('/').isBlank()) {
            return Result(false, reason = "资源路径非法")
        }
        // 解码后再解码一次，防止双重编码绕过
        val twice = runCatching { URLDecoder.decode(decoded, "UTF-8") }.getOrNull()
        if (twice != null && twice.contains("..")) {
            return Result(false, reason = "资源路径非法")
        }

        return Result(
            true,
            uriKind = KIND_ASSET,
            scheme = "asset",
        )
    }

    /**
     * asset URI → AssetManager 路径（供 Media3 AssetDataSource 使用不做转换，
     * 此处仅用于测试断言与日志脱敏场景）。
     *
     * asset:///test.mp4  → test.mp4
     */
    fun assetPathOf(url: String): String? {
        val p = runCatching { URI(url).path }.getOrNull() ?: return null
        return p.trimStart('/').ifBlank { null }
    }
}
