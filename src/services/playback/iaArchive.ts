/**
 * Internet Archive 播放源 Resolver（阶段3·第3步·第2步）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 授权范围（用户 A1 裁定，严格限定）
 * ══════════════════════════════════════════════════════════════════════
 *  - 只接入 **3 部**经逐条权利核查的作品
 *  - 不接入 IA 全库搜索、不接入待核作品（Émile Cohl / Betty Boop）
 *  - 不接入淘汰作品（Superman / Popeye / Bugs Bunny / TinSoldier）
 *  - 每部作品只有 1 集（IA item 内只有 1 个 mp4 derivative）
 *  - 不做多候选伪造 ⇒ D7 明确延期
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 权利依据（这是准入的核心，不是 IA 的版权背书）
 * ══════════════════════════════════════════════════════════════════════
 * IA **不提供任何版权裁定字段**（实测 `possible-copyright-status` 全库 0 条），
 * `licenseurl` 只是上传者自填。因此本清单的权利依据**独立于 IA**：
 *
 *   美国版权法：1929 年及以前出版的作品，版权已全部过期。
 *   2026 年时，1930 年前出版作品均进入公有领域。
 *
 * 三部作品年份分别为 1916 / 1919 / 1923，均在安全线内。
 *
 * ⚠️ 这**不是**「IA 全库准入」，只是 3 部作品逐条核查结论。
 *    未列入 APPROVED_WORKS 的 identifier **不可能**出现在剧集列表。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 已知产品限制（用户裁定为非阻塞）
 * ══════════════════════════════════════════════════════════════════════
 *  - 画质：IA 只有 `_512kb.mp4` derivative，上限约 240p。**UI 不得宣传高清**
 *  - 结构：每部作品仅 1 集，无多集列表
 *  - 候选：每集仅 1 个候选，D7 多候选切换无法验证
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 网络约束
 * ══════════════════════════════════════════════════════════════════════
 *  - 用 `httpGetText`（支持自定义 header，原生走 CapacitorHttp 绕过 CORS）
 *  - 带可识别 User-Agent（IA 官方要求）
 *  - **不自动重试**（IA 要求尊重 429，但重试会加重限流）
 *  - 429 明确标记为限流状态，**不伪装成「无剧集」**
 */
import type { PlaybackSourceResolver } from './PlaybackService'
import type { PlaybackCandidate, PlaybackEpisode } from './types'
import { httpGetText } from '../api/nativeHttp'

/** 播放源 id（不得与内容源 id 冲突） */
export const IA_SOURCE_ID = 'ia-archive'
export const IA_SOURCE_NAME = 'Internet Archive'

/** 元数据请求超时 */
const META_TIMEOUT_MS = 10000

/** 最小可接受文件大小（字节）。低于此值视为异常容器 */
const MIN_FILE_BYTES = 100 * 1024

/** IA 追加 UA（在 httpGetText 默认 UA 之外补充可识别信息） */
const IA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14) AnimeUniverse/0.5 (RSS reader) AnimeUniverse-IA/1.0',
  Accept: 'application/json',
}

/**
 * 经权利核查批准的作品。
 *
 * 🔴 三条硬约束（用户裁定）：
 *  1. fileName 必须与实测值**逐字匹配**，不规范化大小写/下划线/扩展名
 *  2. 清单是硬编码常量，**不在运行时从搜索生成**
 *  3. 未列入本清单的 identifier 不可能出现在剧集列表
 */
export interface IAApprovedWork {
  /** 本应用内作品 id（路由用） */
  workId: string
  /** IA identifier（精确） */
  identifier: string
  /** 展示标题 */
  title: string
  /** 🔴 实测的文件名，逐字匹配 */
  fileName: string
  /** 首播年份 */
  year: number
  /** 制作方 */
  creator: string
  /** 音轨状态（no-audio 必须明确标记，避免用户误以为音频故障） */
  audioStatus: 'with-audio' | 'no-audio'
  /** 权利审核状态 */
  rightsStatus: 'approved'
  /** 🔴 权利依据（独立于 IA，可审计） */
  rightsEvidence: readonly string[]
}

/**
 * 批准清单：**只有这 3 部**。
 *
 * 任何新增都必须先完成逐条权利核查，不得直接复制格式。
 */
export const APPROVED_WORKS: readonly IAApprovedWork[] = Object.freeze([
  {
    workId: 'ia-krazy-kat-1916',
    identifier: 'Krazy_kat_goesA-wooing_1916',
    title: 'Krazy Kat Goes A-Wooing',
    fileName: 'Krazy_Kat_goes_a-wooing_1916_512kb.mp4',
    year: 1916,
    creator: 'International Film Service',
    audioStatus: 'with-audio',
    rightsStatus: 'approved',
    rightsEvidence: [
      '1916 年美国出版作品',
      '美国版权法：1929 年及以前出版作品版权已全部过期',
      '2026 年时 1930 年前作品均进入公有领域',
      'IA licenseurl 为上传者声明，不作为准入依据',
    ],
  },
  {
    workId: 'ia-tantalizing-fly-1919',
    identifier: 'The_Tantalizing_Fly_1919',
    title: 'Out of the Inkwell: The Tantalizing Fly',
    fileName: 'The_Tantalizing_Fly_1919_512kb.mp4',
    year: 1919,
    creator: 'Max Fleischer',
    audioStatus: 'with-audio',
    rightsStatus: 'approved',
    rightsEvidence: [
      '1919 年美国出版作品',
      '美国版权法：1929 年及以前出版作品版权已全部过期',
      '2026 年时 1930 年前作品均进入公有领域',
      'IA licenseurl 为上传者声明，不作为准入依据',
    ],
  },
  {
    workId: 'ia-felix-hollywood-1923',
    identifier: 'Felix_inHollywood_NoAudio',
    title: 'Felix in Hollywood',
    fileName: 'Felix_inHollywood_NoAudio_512kb.mp4',
    year: 1923,
    creator: 'M.J. Winkler',
    // 🔴 无音轨：必须在标题与数据中双重标记
    audioStatus: 'no-audio',
    rightsStatus: 'approved',
    rightsEvidence: [
      '1923 年美国出版作品',
      '美国版权法：1929 年及以前出版作品版权已全部过期',
      '2026 年时 1930 年前作品均进入公有领域',
      'IA licenseurl 为上传者声明，不作为准入依据',
    ],
  },
] as const)

/** 按 workId 查找批准作品 */
export function findApprovedWork(workId: string): IAApprovedWork | undefined {
  return APPROVED_WORKS.find((w) => w.workId === workId)
}

/** 按 identifier 查找批准作品 */
export function findApprovedByIdentifier(identifier: string): IAApprovedWork | undefined {
  return APPROVED_WORKS.find((w) => w.identifier === identifier)
}

/**
 * 解析 `episodeId`。
 *
 * 格式：`${identifier}#${fileName}`
 * 🔴 identifier 与 fileName 都可能含 `#`？实测不含，但用首个 `#` 分割，
 *    并要求两段都非空且 identifier 精确匹配清单。
 */
export function parseEpisodeId(
  episodeId: string,
): { identifier: string; fileName: string } | null {
  const i = episodeId.indexOf('#')
  if (i <= 0 || i === episodeId.length - 1) return null
  const identifier = episodeId.slice(0, i)
  const fileName = episodeId.slice(i + 1)
  if (!identifier || !fileName) return null
  return { identifier, fileName }
}

/** IA Metadata API 的文件记录（只取需要的字段） */
interface IAFile {
  name?: string
  format?: string
  size?: string | number
  source?: string
}

/** 元数据获取结果：区分「限流」与「其他失败」 */
export type MetaResult =
  | { ok: true; files: IAFile[] }
  | { ok: false; reason: 'rate-limited' | 'not-found' | 'server-error' | 'network' | 'bad-json' }

/**
 * 获取 IA item 元数据。
 *
 * 🔴 不重试：429 直接返回 `rate-limited`，由调用方明确展示限流状态，
 *    不能伪装成「无剧集」。
 */
export async function fetchMetadata(identifier: string): Promise<MetaResult> {
  const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}`
  try {
    const r = await httpGetText(url, META_TIMEOUT_MS, IA_HEADERS)
    if (r.status === 429) return { ok: false, reason: 'rate-limited' }
    if (r.status === 404) return { ok: false, reason: 'not-found' }
    if (r.status >= 500) return { ok: false, reason: 'server-error' }
    if (r.status !== 200) return { ok: false, reason: 'server-error' }
    let parsed: unknown
    try {
      parsed = JSON.parse(r.text)
    } catch {
      return { ok: false, reason: 'bad-json' }
    }
    const files = (parsed as { files?: IAFile[] })?.files
    if (!Array.isArray(files)) return { ok: false, reason: 'bad-json' }
    return { ok: true, files }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

/** 构造播放地址（永久入口，Media3 自动跟随 302） */
export function buildMediaUrl(identifier: string, fileName: string): string {
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(fileName)}`
}

/**
 * IA 播放源 Resolver。
 *
 * 🔴 不接触播放器，只产出候选。
 */
export class IAArchiveResolver implements PlaybackSourceResolver {
  readonly sourceId = IA_SOURCE_ID
  readonly sourceName = IA_SOURCE_NAME

  /**
   * 剧集列表：**不发网络请求**，直接由审核清单生成。
   *
   * 🔴 未过审 workId 返回空数组，不报错、不伪造。
   */
  async getEpisodes(workId: string): Promise<PlaybackEpisode[]> {
    const w = findApprovedWork(workId)
    if (!w) return []
    return [
      {
        // 🔴 episodeId 含实测 fileName，与清单逐字一致
        id: `${w.identifier}#${w.fileName}`,
        title: w.audioStatus === 'no-audio' ? `${w.title}（无音轨）` : w.title,
        episodeNumber: 1,
      },
    ]
  }

  /**
   * 播放候选。
   *
   * 🔴 三重校验（用户裁定）：episodeId、identifier、fileName 必须一致。
   * 🔴 任一不符 ⇒ 返回 `[]`，**不回退到其他文件**。
   */
  async getCandidates(workId: string, episodeId: string): Promise<PlaybackCandidate[]> {
    const w = findApprovedWork(workId)
    if (!w) return []

    // 校验 1：episodeId 结构
    const parsed = parseEpisodeId(episodeId)
    if (!parsed) return []

    // 校验 2：identifier 必须与 workId 对应的清单项一致
    if (parsed.identifier !== w.identifier) return []

    // 校验 3：fileName 必须与清单**逐字**一致（不规范化）
    if (parsed.fileName !== w.fileName) return []

    // 取元数据
    const meta = await fetchMetadata(w.identifier)
    if (!meta.ok) return [] // 限流/失败：返回空，不伪造

    // 校验 4：文件必须真实存在且名字逐字匹配
    const target = meta.files.find((f) => f.name === w.fileName)
    if (!target) return [] // 🔴 不回退到其他文件

    // 校验 5：格式必须是 mp4
    if (!/\.mp4$/i.test(target.name ?? '')) return []

    // 校验 6：大小合理
    const size = Number(target.size ?? 0)
    if (!Number.isFinite(size) || size < MIN_FILE_BYTES) return []

    return [
      {
        // 聚合层会用单源索引重算，此处填占位值
        candidateId: `${IA_SOURCE_ID}#0`,
        sourceId: IA_SOURCE_ID,
        sourceName: IA_SOURCE_NAME,
        url: buildMediaUrl(w.identifier, w.fileName),
        // IA 提供的是 MP4 直链，属 progressive
        protocol: 'progressive',
      },
    ]
  }
}

/** 单例（注册表用） */
export const iaArchiveResolver = new IAArchiveResolver()
