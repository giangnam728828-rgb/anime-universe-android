/**
 * 首页数据 store（P0 修复 2026-11-01）
 * 问题：底部导航切换会让 HomePage 组件卸载→useAsync 重新请求，用户返回首页时看到完整加载过程。
 * 方案：
 *  - 首页数据缓存于此（zustand，非 localStorage——避免把图片二进制/大数据塞进持久化）
 *  - 组件重挂载时立即可读 `data` → 立即显示旧内容；再后台静默刷新（stale-while-revalidate）
 *  - 动漫/漫画各区块独立 loading/error，单接口失败不阻塞另一块
 *  - 请求去重：同 key 并发只执行一次（inFlight 计数）
 *  - 滚动位置：记录首页滚动位移，返回时恢复
 */
import { create } from 'zustand'
import { searchAll, type WorkItem } from '../../services/sources'

const TTL = 10 * 60 * 1000 // 首页数据 10 分钟有效，过期后进入后台刷新

type Block = 'anime' | 'manga'

interface BlockState {
  items: WorkItem[]
  loadedAt?: number
  loading: boolean
  error?: string
}

interface HomeState {
  anime: BlockState
  manga: BlockState
  scrollY: number
  /** 请求去重：进行中的 key -> Promise */
  inflight: Record<string, Promise<void> | undefined>
  /** 设置滚动位置（路由离开时记录） */
  setScrollY: (y: number) => void
  /** 首页挂载时调用：有缓存立即用，过期或失败后台刷新 */
  hydrate: () => void
  /** 手动重试某区块（或全部） */
  retryBlock: (block?: Block) => void
  _run: (block: Block, force?: boolean) => Promise<void>
}

const EMPTY: BlockState = { items: [], loading: false }

export const useHomeStore = create<HomeState>((set, get) => ({
  anime: { ...EMPTY, loading: true },
  manga: { ...EMPTY, loading: true },
  scrollY: 0,
  inflight: {},

  setScrollY: (y) => set({ scrollY: y }),

  _run: async (block, force) => {
    const key = block
    // 请求去重：同一区块已有进行中请求则复用
    if (get().inflight[key]) return get().inflight[key]!
    const cur = get()[block]
    // 有效缓存且非强制刷新 → 不重复请求
    if (!force && cur.items.length && cur.loadedAt && Date.now() - cur.loadedAt < TTL) return

    const prom = (async () => {
      // 保留旧数据先显示（后台刷新时不再置空）；仅初始 loading
      if (!cur.items.length) set({ [block]: { ...get()[block], loading: true } })
      try {
        const r = await searchAll({ kind: block === 'anime' ? 'anime' : 'manga', sort: block === 'anime' ? 'trending' : '热门' })
        set({
          [block]: {
            items: r.items.slice(0, 12),
            loadedAt: Date.now(),
            loading: false,
            error: undefined,
          },
        })
      } catch (e) {
        // 保留旧数据；记录错误
        set({
          [block]: {
            ...get()[block],
            loading: false,
            error: (e as Error)?.message || String(e),
          },
        })
      } finally {
        set((s) => ({ inflight: { ...s.inflight, [key]: undefined } }))
      }
    })()
    set((s) => ({ inflight: { ...s.inflight, [key]: prom } }))
    return prom
  },

  hydrate: () => {
    // 首页挂载：两区块并行，有缓存立即用、过期后台刷新
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
