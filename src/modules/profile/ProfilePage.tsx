import { useState } from 'react'
import Icon from '../../components/Icon'
import { Row, Modal, Section } from '../../components/ui'
import { useSettings, type ThemeMode, type ReaderMode, type ReaderBg, READER_BG_CSS } from '../../stores/settings'

export default function ProfilePage() {
  const { theme, setTheme, readerMode, setReaderMode, readerBg, setReaderBg } = useSettings()
  const [about, setAbout] = useState(false)
  const [reading, setReading] = useState(false)

  return (
    <>
      <header className="page-head">
        <h1>我的</h1>
        <p>设置与个人功能入口</p>
      </header>

      <Section title="外观设置">
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--hl)', display: 'flex' }}>
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={20} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 500 }}>主题模式</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>当前：{theme === 'dark' ? '深色' : '浅色'}</div>
          </div>
          <div className="seg">
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark' as ThemeMode)}>深色</button>
            <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light' as ThemeMode)}>浅色</button>
          </div>
        </div>
      </Section>

      <Section title="功能">
        <div className="rows">
          <Row icon="sparkle" title="AI 助手" desc="自定义 API 地址 / 密钥 / 模型，流式对话" wip />
          <Row icon="book" title="阅读设置" desc="默认阅读方向与页面背景色" onClick={() => setReading(true)} />
        </div>
      </Section>

      <Section title="数据">
        <div className="rows">
          <Row icon="settings" title="数据管理" desc="备份 / 恢复本机数据（阶段 2）" wip />
          <Row icon="tool" title="缓存管理" desc="清理图片与请求缓存（阶段 4）" wip />
        </div>
      </Section>

      <Section title="其他">
        <div className="rows">
          <Row icon="info" title="关于动漫宇宙" desc="版本 0.1.0 · 阶段 0 已完成" onClick={() => setAbout(true)} />
        </div>
      </Section>

      <Modal open={about} onClose={() => setAbout(false)} title="关于动漫宇宙">
        <b>动漫宇宙 Anime Universe</b><br />
        版本：0.3.x（run 号递增）<br />
        阶段：0 初始化 ✅ / 1 基础 UI ✅ / 2 本地数据 ✅<br /><br />
        集动漫、漫画、资讯、资源搜索、AI 助手与实用工具于一体的综合内容平台。<br />
        本地优先架构，个人数据仅保存在本机。<br /><br />
        技术栈：React 18 · TypeScript · Vite · Capacitor 6
      </Modal>
    </>
  )
}

      <Modal open={reading} onClose={() => setReading(false)} title="阅读设置">
        <div style={{ marginBottom: 10 }}>
          <div style={{ marginBottom: 6 }}>默认阅读方向</div>
          <div className="seg" style={{ display: 'inline-flex' }}>
            {(['vertical', 'horizontal'] as ReaderMode[]).map((m) => (
              <button key={m} className={readerMode === m ? 'on' : ''} onClick={() => setReaderMode(m)}>
                {m === 'vertical' ? '上下滚动' : '左右翻页'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ marginBottom: 6 }}>页面背景色</div>
          <div style={{ display: 'flex', gap: 10 }}>
            {(['black', 'gray', 'white', 'green'] as ReaderBg[]).map((b) => (
              <button key={b} onClick={() => setReaderBg(b)}
                style={{ width: 30, height: 30, borderRadius: '50%', background: READER_BG_CSS[b],
                  border: readerBg === b ? '2px solid var(--primary)' : '1px solid var(--line)' }} />
            ))}
          </div>
        </div>
      </Modal>
