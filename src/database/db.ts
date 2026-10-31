/** 本地数据层：IndexedDB（Capacitor WebView 与浏览器通用，Local-first）
 *  v2 stores:
 *   - favorites       收藏      { id, kind, title, cover?, note?, addedAt }
 *   - search_history  搜索历史  { kw(主键), at }
 *   - reading_history 阅读历史  { itemId(主键), title, chapter, position, at, ... }
 *   - local_manga     本地漫画  { id, title, cover?, chapters[], createdAt }
 *   - local_pages     本地漫画页 { key: 'm::c::idx', blob }
 */
const DB_NAME = 'au_db'
const DB_VERSION = 2

export type StoreName =
  | 'favorites' | 'search_history' | 'reading_history'
  | 'local_manga' | 'local_pages'

export interface FavoriteItem {
  id: string; kind: 'anime' | 'manga'; title: string
  cover?: string; note?: string; addedAt: number
}

export interface SearchHistoryItem { kw: string; at: number }

export interface ReadingHistoryItem {
  itemId: string; title: string; chapter: string
  position: number; at: number
  chapterId?: string; pageIndex?: number; pageCount?: number
}

export interface LocalChapter { id: string; title: string; count: number; addedAt: number }
export interface LocalManga { id: string; title: string; cover?: string; chapters: LocalChapter[]; createdAt: number }
export interface LocalPage { key: string; blob: Blob }

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
      if (!db.objectStoreNames.contains('local_manga')) db.createObjectStore('local_manga', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('local_pages')) db.createObjectStore('local_pages', { keyPath: 'key' })
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

/** 删除某 store 中所有以 prefix 开头的 key */
export async function dbDeleteByPrefix(store: StoreName, prefix: string): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    const req = t.objectStore(store).openCursor()
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) return
      if (String(cur.key).startsWith(prefix)) cur.delete()
      cur.continue()
    }
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

/* ---- 收藏 ---- */
export const isFavorited = (id: string) => dbGet<FavoriteItem>('favorites', id).then((v) => !!v)
export const toggleFavorite = async (item: Omit<FavoriteItem, 'addedAt'>): Promise<boolean> => {
  const exists = await isFavorited(item.id)
  if (exists) await dbDelete('favorites', item.id)
  else await dbPut('favorites', { ...item, addedAt: Date.now() })
  return !exists
}

/* ---- 搜索历史 ---- */
export const getSearchHistory = async (): Promise<SearchHistoryItem[]> =>
  (await dbGetAll<SearchHistoryItem>('search_history')).sort((a, b) => b.at - a.at).slice(0, 8)
export const addSearchHistory = async (kw: string) => { if (kw.trim()) await dbPut('search_history', { kw: kw.trim(), at: Date.now() }) }

/* ---- 阅读历史 ---- */
export const getReadingHistory = async (): Promise<ReadingHistoryItem[]> =>
  (await dbGetAll<ReadingHistoryItem>('reading_history')).sort((a, b) => b.at - a.at)
export const getReadingProgress = (itemId: string) => dbGet<ReadingHistoryItem>('reading_history', itemId)

/* ---- 本地漫画 ---- */
const pageKey = (m: string, c: string, i: number) => `${m}::${c}::${String(i).padStart(5, '0')}`

const naturalSort = (a: File, b: File) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })

async function fileToCover(blob: Blob): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(blob)
    const w = 300
    const h = Math.max(1, Math.round((bmp.height * w) / bmp.width))
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
    bmp.close?.()
    return c.toDataURL('image/jpeg', 0.75)
  } catch { return undefined }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

/** 导入一批图片作为一个章节；mangaId 为空则新建漫画（封面取首页缩略） */
export async function importChapter(mangaId: string | null, mangaTitle: string, files: File[]): Promise<{ mangaId: string; chapterId: string }> {
  const imgs = files.filter((f) => f.type.startsWith('image/')).sort(naturalSort)
  if (imgs.length === 0) throw new Error('没有可选入的图片文件')

  let m: LocalManga | undefined
  if (mangaId) m = await dbGet<LocalManga>('local_manga', mangaId)
  const isNew = !m
  const mid = m?.id ?? uid()
  const cid = uid()
  const now = Date.now()

  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('local_pages', 'readwrite')
    const os = t.objectStore('local_pages')
    imgs.forEach((f, i) => os.put({ key: pageKey(mid, cid, i), blob: f } satisfies LocalPage))
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })

  if (m) {
    m.chapters.push({ id: cid, title: `章节 ${m.chapters.length + 1}`, count: imgs.length, addedAt: now })
  } else {
    const cover = await fileToCover(imgs[0])
    m = {
      id: mid,
      title: mangaTitle.trim() || `本地漫画 ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      cover,
      chapters: [{ id: cid, title: '章节 1', count: imgs.length, addedAt: now }],
      createdAt: now,
    }
  }
  await dbPut('local_manga', m)
  void isNew
  return { mangaId: mid, chapterId: cid }
}

export const getLocalMangas = async (): Promise<LocalManga[]> =>
  (await dbGetAll<LocalManga>('local_manga')).sort((a, b) => b.createdAt - a.createdAt)
export const getLocalManga = (id: string) => dbGet<LocalManga>('local_manga', id)

export const getLocalPages = async (mangaId: string, chapterId: string): Promise<{ blob: Blob }[]> => {
  const prefix = `${mangaId}::${chapterId}::`
  return (await dbGetAll<LocalPage>('local_pages'))
    .filter((p) => p.key.startsWith(prefix))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((p) => ({ blob: p.blob }))
}

export async function deleteLocalManga(id: string): Promise<void> {
  await dbDeleteByPrefix('local_pages', `${id}::`)
  await dbDelete('local_manga', id)
  await dbDelete('reading_history', `local-${id}`).catch(() => {})
}
