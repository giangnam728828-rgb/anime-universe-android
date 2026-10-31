import Icon from './Icon'
import { SOURCE_NAMES, getSource, type WorkItem } from '../services/sources'

/** 点击即预取详情（fire-and-forget），详情页 useAsync 命中内存缓存秒开 */
function prefetch(w: WorkItem) {
  void getSource(w.sourceId).getDetail(w.kind, w.workId).catch(() => {})
}

export default function WorkCard({ w, onClick }: { w: WorkItem; onClick: () => void }) {
  return (
    <button className="work-card" onClick={() => { prefetch(w); onClick() }}>
      <div className="wc-cover" style={w.coverColor ? { background: w.coverColor } : undefined}>
        {w.cover ? <img src={w.cover} loading="lazy" alt="" /> : <Icon name="film" size={26} />}
      </div>
      <div className="wc-title">{w.title}</div>
      <div className="wc-meta">
        {w.score != null && <span className="wc-score">★ {w.score}</span>}
        {w.year && <span>{w.year}</span>}
        <span className="wc-src">{SOURCE_NAMES[w.sourceId] || w.sourceId}</span>
      </div>
    </button>
  )
}
