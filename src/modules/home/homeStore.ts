/**
 * 首页数据 store（P0 修复 2026-11-01 v2）
 * v0.6.29 教训：图片破图真因是 B站图床对 localhost Referer 403（数据层 https 升级只解决一半），
 * 且整块 Promise.all 让慢源拖住首屏。本版：
 *  - 流式渐进：快源（AniList/B站 1~2s）完成即渲染，慢源后到补入（searchAllStream）
 *  - 缓存跨路由：zustand 模块级，底部导航切换不销毁；返回首页立即显示缓存（10min 内不重复请求）
 *  - 请求去重：inflight 记录进行中 Promise，同区块并发只跑一次
 *  - 失败隔离：动漫/漫画独立 loading/error；每源失败原因分类记录（timeout/http_error/…）
 *  - 滚动位置保留；图片不写 localStorage
 */
import { create } from 'zustand'
import { searchAllStream, dedup, type WorkItem } from '../../services/sources'

const TTL = 10 * 60 * 1000

type Block = 'anime' | 'manga'

export interface BlockState {
  items: WorkItem[]
  loadedAt?: number
  loading: boolean
  /** 每源失败原因（sourceId → 分类），空对象=全部成功 */
  failed: Record<string, string>
}

interface HomeState {
  anime: BlockState
  manga: BlockState
  scrollY: number
  inflight: Record<string, Promise<void> | undefined>
  setScrollY: (y: number) => void
  hydrate: () => void
  retryBlock: (block?: Block) => void
  _run: (block: Block, force?: boolean) => Promise<void>
}

const EMPTY: BlockState = { items: [], loading: false, failed: {} }

export const useHomeStore = create<HomeState>((set, get) => ({
  anime: { ...EMPTY, loading: true },
  manga: { ...EMPTY, loading: true },
  scrollY: 0,
  inflight: {},

  setScrollY: (y) => set({ scrollY: y }),

  _run: async (block, force) => {
    if (get().inflight[block]) return get().inflight[block]
    const cur = get()[block]
    if (!force && cur.items.length && cur.loadedAt && Date.now() - cur.loadedAt < TTL) return

    const prom = (async () => {
      if (!cur.items.length) set({ [block]: { ...get()[block], loading: true } } as never)
      try {
        const { failed } = await searchAllStream(
          { kind: block === 'anime' ? 'anime' : 'manga', sort: block === 'anime' ? 'trending' : '热门' },
          (batch) => {
            // 渐进补入：快源先到先画（与已有项合并去重）
            const merged = dedup([...get()[block].items, ...batch]).slice(0, 12)
            set({ [block]: { ...get()[block], items: merged } } as never)
          },
        )
        set({
          [block]: {
            items: get()[block].items,
            loadedAt: Date.now(),
            loading: false,
            failed,
          },
        } as never)
      } catch (e) {
        set({
          [block]: {
            ...get()[block],
            loading: false,
            failed: { all: (e as Error)?.message || 'unknown' },
          },
        } as never)
      } finally {
        set((s) => ({ inflight: { ...s.inflight, [block]: undefined } }))
      }
    })()
    set((s) => ({ inflight: { ...s.inflight, [block]: prom } }))
    return prom
  },

  hydrate: () => {
    void get()._run('anime')
    void get()._run('manga')
  },

  retryBlock: (block) => {
    if (block) void get()._run(block, true)
    else {
      void get()._run('anime', true)
      void get()._run('manga', true)
    }
  },
}))
