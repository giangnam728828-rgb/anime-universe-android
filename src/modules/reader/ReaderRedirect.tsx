/**
 * 旧三段式阅读路由的兼容重定向（P1 第4子步）
 *
 * `/reader/:mangaId/:chapterId` → `/reader/local/:mangaId/:chapterId`
 *
 * 用户裁定的细节：
 *  - 只映射到 `local`，不猜测成 MangaDex 或其他在线来源
 *  - **必须保留查询参数**（如 `?p=12`），否则丢失阅读页码
 *  - 使用 `replace`，避免浏览器历史留下无意义的中间层
 *
 * 为什么用 <Navigate> 而不是 useEffect + nav()：
 *   Navigate 在渲染期同步完成重定向，无首帧闪烁、无额外渲染、无竞态。
 */
import { Navigate, useLocation, useParams } from 'react-router-dom'
import { legacyReaderRedirectUrl } from './readerRoute'

export default function ReaderRedirect() {
  const { mangaId = '', chapterId = '' } = useParams()
  const location = useLocation()

  // location.search 形如 '?p=12'（HashRouter 下同样可靠）
  const target = legacyReaderRedirectUrl(mangaId, chapterId, location.search)

  return <Navigate to={target} replace />
}
