import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { App as CapApp } from '@capacitor/app'

// Android 系统返回键/手势：APP 内逐级后退；已在首页(无历史)时才退出
// 不监听时 Capacitor 默认行为是直接 finish Activity → 表现为"返回直接回桌面"
CapApp.addListener('backButton', ({ canGoBack }) => {
  if (canGoBack) window.history.back()
  else CapApp.exitApp()
})

createRoot(document.getElementById('root')!).render(
  <App />
)
