import { useEffect, useState, useCallback } from 'react'

export interface AsyncState<T> { loading: boolean; data?: T; error?: string }

/** 轻量异步 hook（替代 TanStack Query，缓存由 http 层负责） */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<AsyncState<T>>({ loading: true })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    setState((s) => ({ loading: true, data: s.data }))
    fn()
      .then((d) => { if (alive) setState({ loading: false, data: d }) })
      .catch((e) => { if (alive) setState({ loading: false, error: (e as Error)?.message || String(e) }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const retry = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, retry }
}
