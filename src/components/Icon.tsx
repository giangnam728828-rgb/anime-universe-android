import type { ReactElement } from 'react'

export type IconName =
  | 'home' | 'compass' | 'search' | 'heart' | 'user'
  | 'sparkle' | 'tool' | 'settings' | 'moon' | 'sun'
  | 'info' | 'chevron' | 'film' | 'book' | 'news' | 'x'

const paths: Record<IconName, ReactElement> = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h5v-6h4v6h5V9.5" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  heart: <path d="M12 20.5s-7.5-4.7-9.3-9.2C1.5 8.2 3.5 5 6.8 5c2 0 3.6 1.1 4.4 2.7L12 9l.8-1.3C13.6 6.1 15.2 5 17.2 5c3.3 0 5.3 3.2 4.1 6.3-1.8 4.5-9.3 9.2-9.3 9.2Z" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20c1.2-3.4 4-5 7.5-5s6.3 1.6 7.5 5" /></>,
  sparkle: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="m6 6 2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></>,
  tool: <path d="M14.5 6.5a4 4 0 0 1 5-5l-2.7 2.7 2.9 2.9L22.4 4.4a4 4 0 0 1-5 5L9 17.8a2 2 0 1 1-2.8-2.8Z" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6A7 7 0 0 0 19 12Z" /></>,
  moon: <path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5Z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M12 11v5" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  film: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 5v14M17 5v14M3 10h4M3 14h4M17 10h4M17 14h4" /></>,
  book: <path d="M4 19V5a2 2 0 0 1 2-2h13.5v16H6.5A2.5 2.5 0 0 0 4 21.5V19Zm0 0a2.5 2.5 0 0 1 2.5-2.5H19.5" />,
  news: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 9h6M7 13h6M7 17h10M17 9v4h-2" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
}

export default function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}
