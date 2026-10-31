/** 本地数据层：IndexedDB（Capacitor WebView 与浏览器通用，Local-first）
 *  stores:
 *   - favorites       收藏      { id, kind, title, cover?, note?, addedAt }
 *   - search_history  搜索历史  { kw(主键), at }
 *   - reading_history 阅读历史  { itemId(主键), title, chapter, position, at }  ← 阶段4使用
 */
const DB_NAME = 'au_db'
const DB_VERSION = 1

export type StoreName = 'favorites' | 'search_history' | 'reading_history'

export interface FavoriteItem {
  id: string
  kind: 'anime' | 'manga'
  title: string
  cover?: string
  note?: string
  addedAt: number
}

export interface SearchHistoryItem { kw: string; at: number }
export interface ReadingHistoryItem { itemId: string; title: string; chapter: string; position: number; at: number }

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('favorites')) db.createObjectStore('favorites', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('search_history')) db.createObjectStore('search_history', { keyPath: 'kw' })
      if (!db.objectStoreNames.contains('reading_history')) db.createObjectStore('reading_history', { keyPath: 'itemId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export const dbPut = <T>(store: StoreName, value: T) => tx(store, 'readwrite', (s) => s.put(value as never))
export const dbDelete = (store: StoreName, key: IDBValidKey) => tx(store, 'readwrite', (s) => s.delete(key))
export const dbClear = (store: StoreName) => tx(store, 'readwrite', (s) => s.clear())
export const dbGetAll = <T>(store: StoreName) => tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)
export const dbGet = <T>(store: StoreName, key: IDBValidKey) => tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)

/* ---- 收藏便捷方法 ---- */
export const isFavorited = (id: string) => dbGet<FavoriteItem>('favorites', id).then((v) => !!v)
export const toggleFavorite = async (item: Omit<FavoriteItem, 'addedAt'>): Promise<boolean> => {
  const exists = await isFavorited(item.id)
  if (exists) await dbDelete('favorites', item.id)
  else await dbPut('favorites', { ...item, addedAt: Date.now() })
  return !exists
}

/* ---- 搜索历史便捷方法 ---- */
export const getSearchHistory = async (): Promise<SearchHistoryItem[]> =>
  (await dbGetAll<SearchHistoryItem>('search_history')).sort((a, b) => b.at - a.at).slice(0, 8)
export const addSearchHistory = async (kw: string) => { if (kw.trim()) await dbPut('search_history', { kw: kw.trim(), at: Date.now() }) }
