import { HashRouter, Routes, Route, NavLink } from 'react-router-dom'

const Home = () => <div style={{ padding: 16 }}>首页 · 综合内容门户（待开发）</div>
const Discovery = () => <div style={{ padding: 16 }}>发现 · 内容探索中心（待开发）</div>
const Search = () => <div style={{ padding: 16 }}>搜索 · 全局搜索中心（待开发）</div>
const Favorites = () => <div style={{ padding: 16 }}>收藏 · 个人内容中心（待开发）</div>
const Profile = () => <div style={{ padding: 16 }}>我的 · 个人设置与AI入口（待开发）</div>

export default function App() {
  return (
    <HashRouter>
      <div className="app-container">
        <main className="content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/discovery" element={<Discovery />} />
            <Route path="/search" element={<Search />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/profile" element={<Profile />} />
          </Routes>
        </main>
        <nav className="bottom-nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'isActive' : '')}>首页</NavLink>
          <NavLink to="/discovery" className={({ isActive }) => (isActive ? 'isActive' : '')}>发现</NavLink>
          <NavLink to="/search" className={({ isActive }) => (isActive ? 'isActive' : '')}>搜索</NavLink>
          <NavLink to="/favorites" className={({ isActive }) => (isActive ? 'isActive' : '')}>收藏</NavLink>
          <NavLink to="/profile" className={({ isActive }) => (isActive ? 'isActive' : '')}>我的</NavLink>
        </nav>
      </div>
    </HashRouter>
  )
}
