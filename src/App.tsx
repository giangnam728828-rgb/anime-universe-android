import { useEffect } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import MainLayout from './layouts/MainLayout'
import HomePage from './modules/home/HomePage'
import DiscoveryPage from './modules/discovery/DiscoveryPage'
import SearchPage from './modules/search/SearchPage'
import FavoritesPage from './modules/favorites/FavoritesPage'
import ProfilePage from './modules/profile/ProfilePage'
import DetailPage from './modules/detail/DetailPage'
import LibraryPage from './modules/library/LibraryPage'
import LocalDetailPage from './modules/library/LocalDetailPage'
import ReaderPage from './modules/reader/ReaderPage'
import ReaderRedirect from './modules/reader/ReaderRedirect'
import PerfPage from './modules/perf/PerfPage'
import NewsPage from './modules/news/NewsPage'
import NewsViewPage from './modules/news/NewsViewPage'
import NewsSourcesPage from './modules/news/NewsSourcesPage'
// 播放专项阶段1：原生播放器（独立模块，不耦合详情页/搜索模块）
import PlayerPage from './modules/player/PlayerPage'
import { useSettings } from './stores/settings'

export default function App() {
  const theme = useSettings((s) => s.theme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <HashRouter>
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/discovery" element={<DiscoveryPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/detail/:sourceId/:kind/:workId" element={<DetailPage />} />
          <Route path="*" element={<HomePage />} />
        </Route>
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/local/:id" element={<LocalDetailPage />} />
        {/*
          P1 第4子步：四段式阅读路由，显式携带来源标识。
          - sourceId 用真实来源 ID（local / mangadex），不用显示名称
          - 旧三段式路由保留，统一重定向到 local（见 ReaderRedirect）
        */}
        <Route path="/reader/:sourceId/:mangaId/:chapterId" element={<ReaderPage />} />
        <Route path="/reader/:mangaId/:chapterId" element={<ReaderRedirect />} />
        <Route path="/perf" element={<PerfPage />} />
        <Route path="/news" element={<NewsPage />} />
        <Route path="/newsview/:eid" element={<NewsViewPage />} />
        <Route path="/news-sources" element={<NewsSourcesPage />} />
        {/* 播放专项阶段1：只承载稳定 ID，不放 URL / Token / 签名参数 */}
        <Route path="/player/:sourceId/:workId/:episodeId" element={<PlayerPage />} />
      </Routes>
    </HashRouter>
  )
}
