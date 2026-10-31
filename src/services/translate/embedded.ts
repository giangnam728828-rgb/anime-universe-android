/** 构建时注入的默认翻译密钥（见 build-apk.yml 的 Inject step）
 *  git 仓库里永远只有空串——真实 key 只存在 GitHub Secrets，不进代码不进历史。
 *  注意：key 会打进 APK，能拿到 APK 的人可提取（免费模型仅额度风险，无资金风险）。
 */
export const EMBEDDED_TRANS_KEY = ''
