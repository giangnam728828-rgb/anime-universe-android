import { Routes, Route, NavLink } from 'react-router-dom'

const Home = () => <div>首页</div>
const Discovery = () => <div>发现</div>
const Search = () => <div>搜索</div>
const Favorites = () => <div>收藏</div>
const Profile = () => <div>我的</div>

export default function App() {
  return (
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
        <NavLink to="/">首页</NavLink>
        <NavLink to="/discovery">发现</NavLink>
        <NavLink to="/search">搜索</NavLink>
        <NavLink to="/favorites">收藏</NavLink>
        <NavLink to="/profile">我的</NavLink>
      </nav>
    </div>
  )
}
