import { useNavigate } from 'react-router-dom'
import { EmptyState, Section } from '../../components/ui'

export default function FavoritesPage() {
  const nav = useNavigate()
  return (
    <>
      <header className="page-head">
        <h1>收藏</h1>
        <p>收藏 · 历史 · 进度 —— 全部保存在本机</p>
      </header>

      <Section title="我的收藏">
        <EmptyState icon="heart" title="暂无收藏"
          desc="收藏、阅读历史与进度将在阶段 2 接入本地数据库（SQLite / IndexedDB），重启后依然保留。"
          actionText="去发现页看看" onAction={() => nav('/discovery')} />
      </Section>
    </>
  )
}
