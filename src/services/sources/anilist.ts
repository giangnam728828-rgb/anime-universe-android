/** AniList 适配器：GraphQL，免费无 Key，CORS 开放（资料源 ≠ 播放源） */
import { cachedPost } from '../api/http'
import type { SourceAdapter, WorkItem, WorkDetail, SearchOptions, SearchResult, Kind, StaffRole } from './types'

const ENDPOINT = 'https://graphql.anilist.co'

/** AniList 英文分类 → 中文展示 */
export const GENRE_MAP: Record<string, string> = {
  Action: '热血', Adventure: '冒险', Comedy: '搞笑', Drama: '剧情', Fantasy: '奇幻',
  Horror: '恐怖', Mystery: '悬疑', Psychological: '心理', Romance: '恋爱', 'Sci-Fi': '科幻',
  'Slice of Life': '日常', Sports: '运动', Supernatural: '超自然', Thriller: '惊悚',
  Music: '音乐', Mecha: '机甲',
}

export const STATUS_MAP: Record<string, string> = {
  FINISHED: '已完结', RELEASING: '放送/连载中', NOT_YET_RELEASED: '未开播',
  CANCELLED: '已取消', HIATUS: '休载/停更',
}

export const FORMAT_MAP: Record<string, string> = {
  TV: 'TV 动画', TV_SHORT: 'TV 短篇', MOVIE: '剧场版', OVA: 'OVA', ONA: 'ONA',
  SPECIAL: '特别篇', MANGA: '漫画', NOVEL: '轻小说', ONE_SHOT: '短篇',
}

export function stripHtml(s?: string | null): string | undefined {
  if (!s) return undefined
  return s.replace(/<[^>]*>/g, '').replace(/&(#?\w+);/g, ' ').replace(/\s+/g, ' ').trim() || undefined
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapMedia(m: any): WorkItem {
  return {
    sourceId: 'anilist',
    workId: String(m.id),
    kind: m.type === 'MANGA' ? 'manga' : 'anime',
    title: m.title?.english || m.title?.romaji || m.title?.native || '未命名',
    titleNative: m.title?.native || undefined,
    cover: m.coverImage?.large || m.coverImage?.extraLarge || undefined,
    coverColor: m.coverImage?.color || undefined,
    description: stripHtml(m.description),
    score: m.averageScore ?? undefined,
    year: m.seasonYear ?? undefined,
    genres: (m.genres || []).map((g: string) => GENRE_MAP[g] || g),
    statusCn: STATUS_MAP[m.status] || m.status,
    formatCn: FORMAT_MAP[m.format] || m.format,
    episodes: m.episodes ?? undefined,
    chapters: m.chapters ?? undefined,
    favorites: m.favourites ?? undefined,
  }
}

const MEDIA_FIELDS = `
  id type
  title { romaji english native }
  coverImage { extraLarge large color }
  description(asHtml: false)
  episodes chapters volumes genres
  averageScore seasonYear format status favourites duration siteUrl
`

const SEARCH_Q = `query($page:Int,$perPage:Int,$search:String,$type:MediaType,$sort:[MediaSort],$genres:[String]){
  Page(page:$page,perPage:$perPage){
    pageInfo{ hasNextPage }
    media(search:$search,type:$type,sort:$sort,genre_in:$genres,isAdult:false){ ${MEDIA_FIELDS} }
  }
}`

const DETAIL_Q = `query($id:Int,$type:MediaType){
  Media(id:$id,type:$type){
    ${MEDIA_FIELDS}
    studios(isMain:true){ nodes{ name } }
    staff(perPage:4,sort:RELEVANCE){ edges{ role node{ name{ full } } } }
  }
}`

function sortToAnilist(sort?: string, hasKw?: boolean): string[] {
  if (hasKw) return ['SEARCH_MATCH']
  switch (sort) {
    case '最新': return ['START_DATE_DESC']
    case '评分': return ['SCORE_DESC']
    case 'trending': return ['TRENDING_DESC']
    default: return ['POPULARITY_DESC']
  }
}

const anilist: SourceAdapter = {
  id: 'anilist',
  name: 'AniList',

  async search(opts: SearchOptions): Promise<SearchResult> {
    const variables: Record<string, unknown> = {
      page: opts.page ?? 1,
      perPage: 18,
      search: opts.kw?.trim() || null,
      type: opts.kind === 'manga' ? 'MANGA' : 'ANIME',
      sort: sortToAnilist(opts.sort, !!opts.kw?.trim()),
      genres: opts.genre ? [opts.genre] : null,
    }
    const json = await cachedPost(ENDPOINT, { query: SEARCH_Q, variables }) as any
    if (json?.errors?.length) throw new Error(json.errors[0].message || 'AniList 返回错误')
    const page = json?.data?.Page
    return {
      items: (page?.media || []).map(mapMedia),
      hasNext: !!page?.pageInfo?.hasNextPage,
    }
  },

  async getDetail(kind: Kind, workId: string): Promise<WorkDetail> {
    const json = await cachedPost(ENDPOINT, {
      query: DETAIL_Q,
      variables: { id: Number(workId), type: kind === 'manga' ? 'MANGA' : 'ANIME' },
    }) as any
    if (json?.errors?.length) throw new Error(json.errors[0].message || 'AniList 返回错误')
    const m = json?.data?.Media
    if (!m) throw new Error('作品不存在')
    const base = mapMedia(m)
    const staff: StaffRole[] = (m.staff?.edges || [])
      .filter((e: any) => e?.node?.name?.full)
      .map((e: any) => ({ role: e.role || 'Staff', name: e.node.name.full as string }))
    return {
      ...base,
      studios: (m.studios?.nodes || []).map((s: any) => s.name).filter(Boolean),
      staff,
      volumes: m.volumes ?? undefined,
      duration: m.duration ?? undefined,
      siteUrl: m.siteUrl || undefined,
    }
  },
}

export default anilist
