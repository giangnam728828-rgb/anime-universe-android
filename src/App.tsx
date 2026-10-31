import { useEffect } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import MainLayout from './layouts/MainLayout'
import HomePage from './modules/home/HomePage'
import DiscoveryPage from './modules/discovery/DiscoveryPage'
import SearchPage from './modules/search/SearchPage'
import FavoritesPage from './modules/favorites/FavoritesPage'
import ProfilePage from './modules/profile/ProfilePage'
import DetailPage from './modules/detail/DetailPage'
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
      </Routes>
    </HashRouter>
  )
}
