import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { localReaderPath } from '../reader/readerRoute'
import Icon from '../../components/Icon'
import { EmptyState, Section, Loading, Modal } from '../../components/ui'
import { getLocalMangas, importChapter, deleteLocalManga, getReadingProgress, type LocalManga, type ReadingHistoryItem } from '../../database/db'

export default function LibraryPage() {
  const nav = useNavigate()
  const location = useLocation()
  const [list, setList] = useState<LocalManga[]>([])
  const [prog, setProg] = useState<Record<string, ReadingHistoryItem>>({})
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [confirmDel, setConfirmDel] = useState<LocalManga | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const ms = await getLocalMangas()
    const ps: Record<string, ReadingHistoryItem> = {}
    await Promise.all(ms.map(async (m) => {
      const h = await getReadingProgress(`local-${m.id}`)
      if (h) ps[m.id] = h
    }))
    setList(ms); setProg(ps); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const doImport = async () => {
    const files = fileRef.current?.files
    if (!files || files.length === 0) return
    setBusy(true)
    try {
      await importChapter(null, newTitle, Array.from(files))
      setImporting(false); setNewTitle('')
      if (fileRef.current) fileRef.current.value = ''
      await load()
    } catch (e) { alert((e as Error).message) } finally { setBusy(false) }
  }

  const doDelete = async () => {
    if (!confirmDel) return
    await deleteLocalManga(confirmDel.id)
    setConfirmDel(null); load()
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>书架</h1>
        <p>本地漫画 · 数据只保存在本机</p>
      </header>

      <input ref={fileRef} type="file" accept="image/*" multiple hidden
        onChange={() => setImporting(true)} />

      <button className="lib-import" onClick={() => { setNewTitle(''); fileRef.current?.click() }}>
        <Icon name="book" size={18} /> 导入漫画（选图 → 第 1 章）
      </button>

      {loading ? <Loading /> : list.length === 0 ? (
        <Section title="我的书架">
          <EmptyState icon="book" title="还没有本地漫画"
            desc={'点上方「导入漫画」，从手机相册/文件选择漫画图片。\n图片保存在本机数据库，不上传任何服务器。'} />
        </Section>
      ) : (
        <div className="lib-list">
          {list.map((m) => {
            const h = prog[m.id]
            return (
              <div key={m.id} className="lib-card" onClick={() => nav(`/local/${m.id}`)}>
                <div className="lib-cover">
                  {m.cover ? <img src={m.cover} alt="" /> : <Icon name="book" size={26} />}
                </div>
                <div className="lib-info">
                  <div className="lib-title">{m.title}</div>
                  <div className="lib-meta">{m.chapters.length} 章 · {new Date(m.createdAt).toLocaleDateString('zh-CN')}</div>
                  {h && (
                    <>
                      <div className="lib-prog"><span style={{ width: `${Math.round(h.position * 100)}%` }} /></div>
                      <button className="lib-continue" onClick={(e) => {
                        e.stopPropagation()
                        if (h.chapterId) nav(localReaderPath(m.id, h.chapterId, h.pageIndex), { state: { from: location.pathname } })
                      }}>
                        继续阅读 {h.chapter} · {Math.round(h.position * 100)}%
                      </button>
                    </>
                  )}
                </div>
                <span className="lib-del" onClick={(e) => { e.stopPropagation(); setConfirmDel(m) }}>
                  <Icon name="x" size={16} />
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* 导入弹窗：标题 + 已选文件确认 */}
      <Modal open={importing && !!fileRef.current?.files?.length} onClose={() => { setImporting(false); if (fileRef.current) fileRef.current.value = '' }} title="导入为漫画">
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>漫画名（可留空自动命名）</div>
          <input className="lib-input" value={newTitle} placeholder="例如：葬送的芙莉莲"
            onChange={(e) => setNewTitle(e.target.value)} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          已选 <b style={{ color: 'var(--text)' }}>{fileRef.current?.files?.length || 0}</b> 张图片，按文件名排序为页序，作为「章节 1」导入。
        </div>
        <button className="mclose" disabled={busy} onClick={doImport}>{busy ? '导入中…' : '确认导入'}</button>
      </Modal>

      {/* 删除确认 */}
      <Modal open={!!confirmDel} onClose={() => setConfirmDel(null)} title="删除本地漫画">
        确定删除 <b>《{confirmDel?.title}》</b> ？<br />
        其全部章节图片与阅读进度将一并删除，不可恢复。
        <button className="mclose" onClick={doDelete}>确认删除</button>
      </Modal>
    </div>
  )
}
