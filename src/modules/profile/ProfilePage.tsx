import { useState } from 'react'
import Icon from '../../components/Icon'
import { Row, Modal, Section } from '../../components/ui'
import { useSettings, type ThemeMode, type ReaderMode, type ReaderBg, READER_BG_CSS } from '../../stores/settings'
import { useNavigate } from 'react-router-dom'
import {
  setDiagEnabled,
  isDiagEnabled,
  readExportRecords,
  clearDiagRecords,
} from '../../services/diagnostics'
import {
  buildExportJson,
  buildExportFileName,
  EXPORT_FILE_PREFIX,
} from '../diagnostics/export'

export default function ProfilePage() {
  const nav = useNavigate()
  const { theme, setTheme, readerMode, setReaderMode, readerBg, setReaderBg } = useSettings()
  const [about, setAbout] = useState(false)
  const [reading, setReading] = useState(false)

  // ── ★ 2d：来源诊断（调试）Modal 状态 ──
  // 仅在打开时从诊断核心读取真实值，不用本地副本「假装」开关状态
  const [diag, setDiag] = useState(false)
  const [diagOn, setDiagOn] = useState(false)
  const [diagCount, setDiagCount] = useState(0)
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagMsg, setDiagMsg] = useState('')

  /** 从诊断核心同步真实状态（不写入任何持久化） */
  const syncDiag = () => {
    setDiagOn(isDiagEnabled())
    setDiagCount(readExportRecords().length)
  }

  const openDiag = () => {
    syncDiag() // ★ 打开只读状态，【绝不】自动开启诊断
    setDiagMsg('')
    setDiag(true)
  }

  /**
   * 切换诊断总开关。
   * ★ 关闭顺序为唯一正确顺序：setDiagEnabled(false) → clearDiagRecords()，
   *   两者在同一同步块内，中间不插入 await。
   */
  const toggleDiag = () => {
    if (diagOn) {
      setDiagEnabled(false)
      const n = clearDiagRecords() // 紧接着清空缓冲，中间无 await
      setDiagMsg(`已关闭诊断，清空 ${n} 条记录`)
    } else {
      setDiagEnabled(true)
      setDiagMsg('已开启诊断')
    }
    syncDiag()
  }

  /** 导出：白名单构造 → 写入 Cache → 系统分享 */
  const doExport = async () => {
    const recs = readExportRecords()
    if (recs.length === 0) {
      setDiagMsg('暂无记录可导出')
      return
    }
    setDiagBusy(true)
    setDiagMsg('')
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
      const { Share } = await import('@capacitor/share')

      const json = buildExportJson(recs)
      const name = buildExportFileName()

      // 先清理同前缀旧文件（只删本应用前缀）
      try {
        const listing = await Filesystem.readdir({ path: '', directory: Directory.Cache })
        for (const f of listing.files) {
          if (f.name.startsWith(EXPORT_FILE_PREFIX) && f.name !== name) {
            try {
              await Filesystem.deleteFile({ path: f.name, directory: Directory.Cache })
            } catch { /* 单个删除失败不影响导出 */ }
          }
        }
      } catch { /* 列目录失败不阻断导出 */ }

      await Filesystem.writeFile({
        path: name,
        data: json,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      })

      const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache })
      setDiagMsg(`已导出 ${recs.length} 条记录`)
      try {
        await Share.share({ title: '动漫宇宙 诊断导出', url: uri })
      } catch {
        // 用户取消分享 ≠ 导出失败，静默
      }
    } catch (e) {
      setDiagMsg('导出失败，请重试')
      console.warn('[diag] export failed', e)
    } finally {
      setDiagBusy(false)
      syncDiag()
    }
  }

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
          <Row icon="tool" title="性能日志（调试）" desc="首页加载各环节计时数据" onClick={() => nav('/perf')} />
          {/* ★ 2d：来源诊断（调试）—— 与播放器自检并列，不覆盖、不迁移旧入口 */}
          <Row
            icon="tool"
            title="来源诊断（调试）"
            desc="诊断记录查看与 JSON 导出（阶段3）"
            onClick={openDiag}
          />
          {/* A1：Internet Archive 独立内容集合入口（经权利核查的公共领域动画） */}
          <Row
            icon="film"
            title="公共领域动画"
            desc="Internet Archive · 仅收录经权利核查的作品"
            onClick={() => nav('/ia-library')}
          />
          {/* 播放专项阶段1：临时自检入口，仅用于原生播放器验收（阶段2 移除） */}
          <Row
            icon="film"
            title="播放器自检（调试）"
            desc="播放专项阶段1 · 原生播放器基础模块"
            onClick={() => nav('/player/selftest/selftest/1')}
          />
        </div>
      </Section>

      <Section title="其他">
        <div className="rows">
          <Row icon="info" title="关于动漫宇宙" desc="版本 0.1.0 · 阶段 0 已完成" onClick={() => setAbout(true)} />
        </div>
      </Section>

      {/* ★ 2d：来源诊断 Modal
          ⚠️ 关闭 Modal 只关 UI，【不】改变诊断开关、【不】清理记录。
             只有用户明确操作总开关时才清空缓冲。 */}
      <Modal open={diag} onClose={() => setDiag(false)} title="来源诊断（调试）">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>诊断总开关</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              当前：{diagOn ? '已开启' : '已关闭'} · 记录 {diagCount} 条
            </div>
          </div>
          <button className={'btn' + (diagOn ? ' on' : '')} onClick={toggleDiag}>
            {diagOn ? '关闭' : '开启'}
          </button>
        </div>

        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.6 }}>
          · 默认关闭，不会因打开本页面而自动开启<br />
          · 关闭总开关会同步清空内存缓冲<br />
          · 导出仅含 16 个白名单字段，不上传任何数据
        </div>

        <button className="btn" disabled={diagBusy || diagCount === 0} onClick={doExport}>
          {diagBusy ? '导出中…' : `导出 JSON（${diagCount} 条）`}
        </button>

        {diagMsg && (
          <div style={{ fontSize: 12, marginTop: 10, color: 'var(--hl)' }}>{diagMsg}</div>
        )}
      </Modal>

      <Modal open={about} onClose={() => setAbout(false)} title="关于动漫宇宙">
        <b>动漫宇宙 Anime Universe</b><br />
        版本：0.3.x（run 号递增）<br />
        阶段：0 初始化 ✅ / 1 基础 UI ✅ / 2 本地数据 ✅ / 3 真实数据 ✅ / 4 阅读器 ✅<br /><br />
        集动漫、漫画、资讯、资源搜索、AI 助手与实用工具于一体的综合内容平台。<br />
        本地优先架构，个人数据仅保存在本机。<br /><br />
        技术栈：React 18 · TypeScript · Vite · Capacitor 6
        <br /><br />
        {/* MangaBaka 数据署名：CC BY-NC-SA 4.0 强制要求署名 + 许可链接 */}
        <b>漫画数据来源</b><br />
        本站部分漫画元数据来自 MangaBaka，遵循{' '}
        <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener noreferrer">
          CC BY-NC-SA 4.0
        </a>{' '}
        许可。<br />
        来源网站：{' '}
        <a href="https://mangabaka.org" target="_blank" rel="noopener noreferrer">
          https://mangabaka.org
        </a><br />
        数据可能经过应用展示所需的格式整理。
      </Modal>

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
    </>
  )
}
