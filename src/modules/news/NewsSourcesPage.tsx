import { useCallback, useEffect, useState } from 'react'
import Icon from '../../components/Icon'
import { Section } from '../../components/ui'
import { FEEDS, getSourceStatuses, setSourceEnabled, testSource, type SourceStatus } from '../../services/news'
import { clearTransCache, getTransCfg, PRESETS, setTransCfg, type TransCfg } from '../../services/translate'

/** 资讯来源管理：名称/语言/分类/启用/最近测试/HTTP码/耗时/失败原因/单独测试 + 日文翻译设置 */
export default function NewsSourcesPage() {
  const [statuses, setStatuses] = useState<Record<string, SourceStatus>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [cfg, setCfg] = useState<TransCfg>(() => getTransCfg())

  const load = useCallback(() => setStatuses(getSourceStatuses()), [])
  useEffect(() => { load() }, [load])

  const doTest = async (id: string) => {
    setTesting(id)
    await testSource(id)
    load()
    setTesting(null)
  }

  const upd = (p: Partial<TransCfg>) => {
    const next = { ...cfg, ...p }
    setCfg(next)
    setTransCfg(p)
  }

  const fmtT = (t?: number) => (t ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—')
  const LANG_LABEL: Record<string, string> = { zh: '中文', ja: '日文', en: '英文' }

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
                    <div className="rtitle">{f.name} <span className="badge">{LANG_LABEL[f.lang] || f.lang}</span></div>
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
                  {s.itemsCount != null && <span>{s.itemsCount} 条</span>}
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

      <Section title="日文资讯自动翻译（可选，默认关闭）">
        <div className="rows">
          <div className="row-item" style={{ justifyContent: 'space-between' }}>
            <span className="rmain">
              <div className="rtitle">启用机器翻译</div>
              <div className="rdesc">日文标题/摘要 → 中文；未开启时日文以原文显示</div>
            </span>
            <button className={'seg-mini' + (cfg.enabled ? ' on' : '')}
              onClick={() => upd({ enabled: !cfg.enabled })}>
              {cfg.enabled ? '已开启' : '已关闭'}
            </button>
          </div>
          <div className="row-item" style={{ justifyContent: 'space-between' }}>
            <span className="rmain">
              <div className="rtitle">目标语言</div>
              <div className="rdesc">{cfg.provider === 'deepl' ? 'DeepL 免费版仅支持简体中文' : '翻译输出简体或繁体中文'}</div>
            </span>
            <button className="seg-mini" disabled={cfg.provider === 'deepl'}
              onClick={() => upd({ target: cfg.target === 'zh-CN' ? 'zh-TW' : 'zh-CN' })}
              style={cfg.provider === 'deepl' ? { opacity: 0.5 } : undefined}>
              {cfg.target === 'zh-CN' ? '简体中文' : '繁體中文'}
            </button>
          </div>
          <div className="row-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div className="rtitle">翻译引擎（前两个免费，实测国内直连可用）</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {PRESETS.map((p) => (
                <button key={p.id} className={'seg-mini' + (cfg.baseUrl === p.baseUrl ? ' on' : '')}
                  onClick={() => upd({ provider: p.provider, baseUrl: p.baseUrl, model: p.model })}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="rdesc">
              {PRESETS.find((p) => p.baseUrl === cfg.baseUrl)?.desc || ''}
              {' · 注册：'}{PRESETS.find((p) => p.baseUrl === cfg.baseUrl)?.signup}
            </div>
          </div>
          <div className="row-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div className="rtitle">密钥配置（仅保存在手机本地，不上传）</div>
            {cfg.baseUrl !== PRESETS[2].baseUrl && (
              <input className="txt" placeholder="接口地址（选预设后自动填好，可改）"
                value={cfg.baseUrl} onChange={(e) => upd({ baseUrl: e.target.value })} />
            )}
            <input className="txt" placeholder={cfg.provider === 'deepl' ? 'DeepL API Key（Free 版以 :fx 结尾）' : 'API Key（如智谱/硅基流动控制台创建）'} type="password"
              value={cfg.apiKey} onChange={(e) => upd({ apiKey: e.target.value })} />
            {cfg.provider === 'openai' && (
              <input className="txt" placeholder="模型名（预设自动填好，可改）"
                value={cfg.model} onChange={(e) => upd({ model: e.target.value })} />
            )}
            <div className="rdesc">
              费用说明：智谱 glm-4-flash 完全免费；硅基流动免费模型档免费；
              DeepL 免费版每月 50 万字符；其他自定义接口按所选服务商计费。
              本应用不承诺免费无限翻译。翻译结果按文章缓存，刷新不重复计费。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="src-test" onClick={() => clearTransCache()}>清除翻译缓存</button>
            </div>
          </div>
        </div>
      </Section>

      {testing && <div className="loading"><span className="spinner" /><span>正在真实请求该来源…</span></div>}
      <div className="news-foot">测试即真实请求并记录状态 · 遵守各站 RSS 条款，仅展示摘要与原文链接</div>
    </div>
  )
}
