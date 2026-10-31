import Icon from './Icon'
import { SOURCE_NAMES, type WorkItem } from '../services/sources'

export default function WorkCard({ w, onClick }: { w: WorkItem; onClick: () => void }) {
  return (
    <button className="work-card" onClick={onClick}>
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
