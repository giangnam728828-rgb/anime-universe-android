import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'

/** 资讯图片：独立加载状态（超时 8s / 失败占位 / 点按重试一次），不阻塞文字 */
export default function NewsImage({ src, className }: { src?: string; className?: string }) {
  const [state, setState] = useState<'loading' | 'ok' | 'fail'>(src ? 'loading' : 'fail')
  const [tried, setTried] = useState(0) // 已重试次数
  const [bust, setBust] = useState(0)   // 重载 key
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!src || state !== 'loading') return
    timer.current = setTimeout(() => setState('fail'), 8000) // 独立超时
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [src, state, bust])

  if (!src || state === 'fail') {
    return (
      <button className={'news-imgph ' + (className || '')}
        onClick={() => { if (tried < 2) { setTried((t) => t + 1); setBust((b) => b + 1); setState('loading') } }}>
        <Icon name="news" size={20} />
        <span>{src ? (tried < 2 ? '图片加载失败 · 点按重试' : '图片不可用') : '无配图'}</span>
      </button>
    )
  }
  return (
    <div className={'news-imgwrap ' + (className || '')}>
      {state === 'loading' && <div className="news-imgspin"><span className="spinner" /></div>}
      <img src={bust ? `${src}${src.includes('?') ? '&' : '?'}r=${bust}` : src}
        referrerPolicy="no-referrer" loading="lazy" alt=""
        onLoad={() => { if (timer.current) clearTimeout(timer.current); setState('ok') }}
        onError={() => { if (timer.current) clearTimeout(timer.current); setState('fail') }}
        style={{ opacity: state === 'ok' ? 1 : 0 }} />
    </div>
  )
}
