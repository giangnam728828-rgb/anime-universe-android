import { Outlet } from 'react-router-dom'
import NavBar from '../components/NavBar'

export default function MainLayout() {
  return (
    <div className="app-shell">
      <main className="page"><Outlet /></main>
      <NavBar />
    </div>
  )
}
