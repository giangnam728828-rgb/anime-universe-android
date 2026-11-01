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
import { perf } from '../../services/perf'

const TTL = 10 * 60 * 1000

type Block = 'anime' | 'manga'

export interface BlockState {
  items: WorkItem[]
  loadedAt?: number
  runStartAt?: number
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
    if (!force && cur.items.length && cur.loadedAt && Date.now() - cur.loadedAt < TTL) {
      perf({ phase: 'hydrate', sourceId: block, status: 'cache-hit', detail: 'TTL内不重复请求' })
      return
    }

    const prom = (async () => {
      const runT0 = Date.now() // 阶段2计时：区块请求全程
      set({ [block]: { ...get()[block], runStartAt: runT0 } } as never)
      if (!cur.items.length) set({ [block]: { ...get()[block], loading: true } } as never)
      let firstBatchDone = false
      try {
        const { failed } = await searchAllStream(
          { kind: block === 'anime' ? 'anime' : 'manga', sort: block === 'anime' ? 'trending' : '热门' },
          (batch, sourceId) => {
            // 渐进补入：快源先到先画（与已有项合并去重）
            const merged = dedup([...get()[block].items, ...batch]).slice(0, 12)
            set({ [block]: { ...get()[block], items: merged } } as never)
            if (!firstBatchDone) { // 首批卡片出现时刻（每区块一次）
              firstBatchDone = true
              perf({ phase: 'first-batch', sourceId, status: 'ok', ms: Date.now() - runT0, detail: block })
              // O2: 首个来源成功 → 立即结束该区块首轮 loading；其余源后台继续、结果继续追加
              set({ [block]: { ...get()[block], loading: false } } as never)
            }
          },
          { skipUnhealthy: true }, // O1: 首页路径启用健康记忆（搜索/详情不受影响）
        )
        set({
          [block]: {
            items: get()[block].items,
            loadedAt: Date.now(),
            loading: false,
            failed,
          },
        } as never)
        perf({ phase: 'block-complete', sourceId: block, status: Object.keys(failed).length ? 'fail' : 'ok', ms: Date.now() - runT0, detail: `${get()[block].items.length}条` })
        // 首页主要模块全部完成（两区块都结束时打一次）
        const a = get().anime; const m = get().manga
        if (!a.loading && !m.loading && a.loadedAt && m.loadedAt) {
          const start = Math.min(a.runStartAt ?? runT0, m.runStartAt ?? runT0)
          perf({ phase: 'home-complete', status: 'ok', ms: Date.now() - start, detail: `动漫${a.items.length}+漫画${m.items.length}` })
        }
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
