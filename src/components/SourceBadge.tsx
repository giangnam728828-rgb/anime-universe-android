/**
 * 统一来源标签（P1 修复 2026-11-01）
 * 所有卡片/详情页的来源标识统一用此组件：固定高度/字号/内边距/圆角，
 * 长名称缩短或省略显示，绝不撑大标签或被标题挤压。
 */
import { SOURCE_NAMES } from '../services/sources'

/** 长名称缩短映射（其余用 SOURCE_NAMES，超宽由 CSS ellipsis 截断） */
const SHORT: Record<string, string> = {
  bilibili: 'B站',
  mangadex: 'MangaDex',
  anilist: 'AniList',
  jikan: 'MAL',
}

export default function SourceBadge({ sourceId }: { sourceId: string }) {
  const label = SHORT[sourceId] || SOURCE_NAMES[sourceId] || sourceId
  return <span className="src-badge">{label}</span>
}
