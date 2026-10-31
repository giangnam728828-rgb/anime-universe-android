import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Icon from '../../components/Icon'
import { EmptyState, Loading, Section, Modal } from '../../components/ui'
import { getLocalManga, importChapter, deleteLocalManga, type LocalManga } from '../../database/db'

export default function LocalDetailPage() {
  const nav = useNavigate()
  const { id = '' } = useParams()
  const [m, setM] = useState<LocalManga | null | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setM(await getLocalManga(id))
  }, [id])
  useEffect(() => { load() }, [load])

  if (m === undefined) return <div className="page"><Loading /></div>
  if (m === null) {
    return <div className="page">
      <EmptyState icon="info" title="漫画不存在" desc="可能已被删除"
        actionText="回书架" onAction={() => nav('/library')} />
    </div>
  }

  const doAdd = async () => {
    const files = fileRef.current?.files
    if (!files || files.length === 0) return
    setBusy(true)
    try {
      await importChapter(id, m.title, Array.from(files))
      setAdding(false)
      if (fileRef.current) fileRef.current.value = ''
      await load()
    } catch (e) { alert((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="page" style={{ paddingBottom: 90 }}>
      <button onClick={() => nav(-1)} style={{ display: 'flex', alignItems: 'center', gap: 2, color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
        <span style={{ display: 'flex', transform: 'rotate(180deg)' }}><Icon name="chevron" size={15} /></span>
        书架
      </button>

      <div className="detail-hero">
        <div className="dh-cover">
          {m.cover ? <img src={m.cover} alt="" /> : null}
        </div>
        <div className="dh-info">
          <div className="dh-title">{m.title}</div>
          <div className="dh-native">{m.chapters.length} 章 · 本地导入</div>
          <div className="dh-tags">
            <span className="dh-tag">存于本机</span>
            <span className="dh-tag">不上传</span>
          </div>
          <button className="fav-btn" onClick={() => fileRef.current?.click()}>
            <Icon name="book" size={16} /> 添加章节
          </button>
        </div>
      </div>

      <Section title="章节目录">
        {m.chapters.length === 0 ? (
          <EmptyState icon="book" title="暂无章节" desc="点上方「添加章节」导入图片。" />
        ) : (
          <div className="rows">
            {m.chapters.map((c) => (
              <button key={c.id} className="row-item" onClick={() => nav(`/reader/${m.id}/${c.id}`)}>
                <span className="ric"><Icon name="book" size={19} /></span>
                <span className="rmain">
                  <div className="rtitle">{c.title}</div>
                  <div className="rdesc">{c.count} 页 · {new Date(c.addedAt).toLocaleDateString('zh-CN')}</div>
                </span>
                <span className="rarr"><Icon name="chevron" size={15} /></span>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="管理">
        <button className="row-item" style={{ color: 'var(--danger)' }} onClick={() => setConfirmDel(true)}>
          <span className="ric" style={{ color: 'var(--danger)' }}><Icon name="x" size={19} /></span>
          <span className="rmain"><div className="rtitle">删除这本漫画</div></span>
        </button>
      </Section>

      <input ref={fileRef} type="file" accept="image/*" multiple hidden
        onChange={() => setAdding(true)} />

      <Modal open={adding && !!fileRef.current?.files?.length} onClose={() => { setAdding(false); if (fileRef.current) fileRef.current.value = '' }} title="添加章节">
        已选 <b>{fileRef.current?.files?.length || 0}</b> 张图片，作为「章节 {m.chapters.length + 1}」导入，按文件名排序为页序。
        <button className="mclose" disabled={busy} onClick={doAdd}>{busy ? '导入中…' : '确认导入'}</button>
      </Modal>

      <Modal open={confirmDel} onClose={() => setConfirmDel(false)} title="删除本地漫画">
        确定删除 <b>《{m.title}》</b> ？全部章节与进度将一并删除，不可恢复。
        <button className="mclose" onClick={async () => { await deleteLocalManga(m.id); nav('/library') }}>确认删除</button>
      </Modal>
    </div>
  )
}
