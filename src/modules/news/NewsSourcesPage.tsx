import { useCallback, useEffect, useState } from 'react'
import Icon from '../../components/Icon'
import { Section } from '../../components/ui'
import { FEEDS, getSourceStatuses, setSourceEnabled, testSource, type SourceStatus } from '../../services/news'

/** 资讯来源管理：名称/语言/分类/启用/最近测试/HTTP码/耗时/失败原因/单独测试 */
export default function NewsSourcesPage() {
  const [statuses, setStatuses] = useState<Record<string, SourceStatus>>({})
  const [testing, setTesting] = useState<string | null>(null)

  const load = useCallback(() => setStatuses(getSourceStatuses()), [])
  useEffect(() => { load() }, [load])

  const doTest = async (id: string) => {
    setTesting(id)
    await testSource(id)
    load()
    setTesting(null)
  }

  const fmtT = (t?: number) => (t ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—')

  return (
    <div className="page">
      <header className="page-head">
        <h1>资讯来源管理</h1>
        <p>真实请求状态 · 失败来源自动冷却 10 分钟</p>
      </header>

      <Section title="来源（含真实请求日志）">
        <div className="rows">
          {FEEDS.map((f) => {
            const s = statuses[f.id] || { enabled: true }
            const cooling = s.cooldownUntil && s.cooldownUntil > Date.now()
            return (
              <div key={f.id} className="row-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 10 }}>
                  <span className="ric"><Icon name="news" size={19} /></span>
                  <span className="rmain">
                    <div className="rtitle">{f.name} <span className="badge">{f.lang === 'zh' ? '中文' : '英文'}</span></div>
                    <div className="rdesc">{f.category}{f.note ? ` · ${f.note}` : ''}</div>
                  </span>
                  <button className={'seg-mini' + (s.enabled !== false ? ' on' : '')}
                    onClick={() => { setSourceEnabled(f.id, !(s.enabled !== false)); load() }}>
                    {s.enabled !== false ? '启用' : '停用'}
                  </button>
                </div>
                <div className="src-log">
                  <span>最近测试 {fmtT(s.lastTestAt)}</span>
                  <span>HTTP {s.lastStatus ?? '—'}</span>
                  <span>{s.lastMs != null ? `${s.lastMs}ms` : '—'}</span>
                  <span className={s.ok ? 'ok' : 'bad'}>{s.ok === undefined ? '未测试' : s.ok ? '正常' : cooling ? '冷却中' : '失败'}</span>
                </div>
                {s.lastError && <div className="src-err">失败原因：{s.lastError}</div>}
                <button className="src-test" onClick={() => doTest(f.id)} disabled={testing === f.id}>
                  {testing === f.id ? '测试中…' : '单独测试'}
                </button>
              </div>
            )
          })}
        </div>
      </Section>

      {testing && <div className="loading"><span className="spinner" /><span>正在真实请求该来源…</span></div>}
      <div className="news-foot">测试即真实请求并记录状态 · 遵守各站 RSS 条款，仅展示摘要与原文链接</div>
    </div>
  )
}
