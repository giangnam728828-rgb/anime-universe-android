import { NavLink } from 'react-router-dom'
import Icon, { type IconName } from './Icon'

const tabs: { to: string; icon: IconName; label: string; end?: boolean }[] = [
  { to: '/', icon: 'home', label: '首页', end: true },
  { to: '/discovery', icon: 'compass', label: '发现' },
  { to: '/search', icon: 'search', label: '搜索' },
  { to: '/favorites', icon: 'heart', label: '收藏' },
  { to: '/profile', icon: 'user', label: '我的' },
]

export default function NavBar() {
  return (
    <nav className="bottom-nav">
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end}
          className={({ isActive }) => 'nav-item' + (isActive ? ' isActive' : '')}>
          <Icon name={t.icon} size={21} />
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
