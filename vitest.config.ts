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
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const FALLBACK = '/tmp/au-test/node_modules'

/**
 * ⚠️ 用 `process.cwd()` 而不是 `__dirname`：
 * 本配置经 vite 转译为 ESM 后 `__dirname` 不可靠（会算错路径，
 * 导致回退判定失效、本地 8 个套件 Cannot find module）。
 * `scripts/run-tests.sh` 与 CI 都在仓库根目录执行，cwd 即仓库根。
 */
const repoRoot = process.cwd()

/**
 * 🔴 回退只在「仓库内没有 node_modules」且「影子副本存在」时启用。
 *
 * 2026-11-08 CI 事故（run 42425475422）：
 *  原实现无条件把 react / @capacitor/core / typescript 等别名指向
 *  `/tmp/au-test/node_modules`。本地（FAT32，无仓库内 node_modules）能跑，
 *  但 GitHub CI 上该目录不存在 ⇒ 8 个测试套件全部
 *  `Cannot find module 'react' / '@capacitor/core' / 'typescript'`。
 *
 * 正确行为：
 *  - CI / 正常 Linux 开发机：仓库内有 node_modules ⇒ **不设别名**，走原生解析
 *  - 本机 FAT32：仓库内无 node_modules ⇒ 若影子副本存在才回退
 *  - 两者都没有：不设别名，让错误如实暴露（而不是指向一个不存在的绝对路径）
 */
const repoModules = join(repoRoot, 'node_modules')

/**
 * 🔴 必须判断「关键依赖真实可用」，而不是「node_modules 目录存在」。
 *
 * 本机 FAT32 上 `npm install` 失败会留下一个**残缺的** `node_modules/`
 * （目录存在、里面有少量子目录，但缺 react / vitest / typescript）。
 * 仅用 `existsSync` 或 `readdirSync().length > 0` 都会误判为
 * 「仓库内有依赖」⇒ 不回退 ⇒ 8 个套件 Cannot find module。
 *
 * 因此逐个检查测试真正依赖的关键包。
 */
function hasUsableModules(dir: string): boolean {
  return ['react', 'typescript', '.bin/vitest'].every((p) => existsSync(join(dir, p)))
}

const useFallback = !hasUsableModules(repoModules) && hasUsableModules(FALLBACK)

const fallbackAliases = useFallback
  ? [
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
      // Q9 AST 守卫需要 TypeScript 编译器 API（devDependency，已在 package.json）
      { find: /^typescript$/, replacement: `${FALLBACK}/typescript` },
    ]
  : []

export default {
  resolve: {
    alias: fallbackAliases,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'android/**'],
    globals: false,
  },
}
