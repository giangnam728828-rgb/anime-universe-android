/**
 * Vitest 配置（入库版）
 *
 * 背景（§52 事故）：
 *  2026-11-08 因测试只存在于 /tmp/au-test 影子副本，
 *  一次 `rm -rf` 导致 15 个 discovery 测试文件永久丢失。
 *  本文件让测试配置与测试文件一起纳入版本控制，
 *  即便影子副本再次消失，`tests/` 仍完整保存在仓库里。
 *
 * 为什么需要 resolve.alias 回退：
 *  本仓库位于 /sdcard（FAT32），**不支持符号链接**。
 *  `npm install` 必须为 `media3-player: file:./native-plugins/media3-player`
 *  建 symlink → FAT32 上必然 EACCES → 仓库内没有 node_modules。
 *  而 src/ 下的模块会 import 'react'、'@capacitor/core' 等裸模块名。
 *
 * 回退目录仅在「仓库内无 node_modules」时被用到；
 * 正常 Linux 开发机与 GitHub CI 走原生解析，不受影响。
 *
 * 重要约束：
 *  - tsconfig.json 的 include 只有 ["src"]，
 *    本文件与 tests/ 不会被 `tsc --noEmit` 纳入生产构建。
 */
const FALLBACK = '/tmp/au-test/node_modules'

export default {
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${FALLBACK}/react` },
      { find: /^react\/jsx-runtime$/, replacement: `${FALLBACK}/react/jsx-runtime` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${FALLBACK}/react/jsx-dev-runtime` },
      { find: /^react-dom$/, replacement: `${FALLBACK}/react-dom` },
      { find: /^react-dom\/client$/, replacement: `${FALLBACK}/react-dom/client` },
      { find: /^react-router-dom$/, replacement: `${FALLBACK}/react-router-dom` },
      { find: /^zustand$/, replacement: `${FALLBACK}/zustand` },
      { find: /^@capacitor\/core$/, replacement: `${FALLBACK}/@capacitor/core` },
      { find: /^@capacitor\/app$/, replacement: `${FALLBACK}/@capacitor/app` },
      { find: /^@capacitor\/browser$/, replacement: `${FALLBACK}/@capacitor/browser` },
      { find: /^@capacitor\/filesystem$/, replacement: `${FALLBACK}/@capacitor/filesystem` },
      { find: /^@capacitor\/share$/, replacement: `${FALLBACK}/@capacitor/share` },
      // Q9 AST 守卫需要 TypeScript 编译器 API（devDependency，已在 package.json）。
      // 仓库内无 node_modules 时同样回退到影子副本。
      { find: /^typescript$/, replacement: `${FALLBACK}/typescript` },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'android/**'],
    globals: false,
  },
}
