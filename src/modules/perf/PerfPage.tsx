/**
 * 性能日志页（阶段 2 调试入口）——独立路由 /perf，不影响首页布局
 * 显示内存环形缓冲中的计时条目：时间/阶段/来源/耗时/状态/备注
 */
import { useState } from 'react'
import { NavBarlessLayout } from './Navless'
import { getPerfLog, clearPerf, type PerfEntry } from '../../services/perf'
import { Section, EmptyState } from '../../components/ui'

/** 复制全部计时条目为 CSV（真机采集通道：剪贴板 → DSHA /app/clip 读取） */
function buildCsv(entries: PerfEntry[]): string {
  const rows = entries.map((e) =>
    [e.t, e.phase, e.sourceId || '', e.status || '', e.ms ?? '', (e.detail || '').replace(/[,\n]/g, ' ')].join(','),
  )
  return 'ts,phase,sourceId,status,ms,detail\n' + rows.join('\n')
}

const PHASE_CN: Record<string, string> = {
  'home-mount': '首页挂载',
  'home-restore': '返回首页(缓存恢复)',
  'restore-painted': '缓存恢复首帧',
  'mount-painted': '全新挂载首帧',
  'hydrate': '缓存读取',
  'source-request': '来源请求',
  'first-batch': '首批卡片出现',
  'block-complete': '区块完成',
  'home-complete': '首页全部完成',
  'img-load': '封面图片',
}

function fmt(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

export default function PerfPage() {
  const [log, setLog] = useState<PerfEntry[]>(getPerfLog())
  const [copied, setCopied] = useState(false)

  const copyAll = async () => {
    const text = buildCsv(getPerfLog()) // 时间正序
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 降级：临时 textarea + execCommand（WebView 手势内可用）
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  return (
    <NavBarlessLayout title="性能日志">
      <Section title={`计时条目（${log.length}）`} extra={
        <span style={{ display: 'flex', gap: 10 }}>
          <button onClick={copyAll} style={{ color: 'var(--accent)', fontSize: 11.5 }}>{copied ? '✅ 已复制' : '复制全部'}</button>
          <button onClick={() => { clearPerf(); setLog([]) }} style={{ color: 'var(--muted)', fontSize: 11.5 }}>清空</button>
        </span>
      }>
        {log.length === 0 ? (
          <EmptyState icon="tool" title="暂无计时数据" desc="回到首页触发一次加载后再来查看。" />
        ) : (
          <div className="perf-list">
            {log.map((e, i) => (
              <div key={i} className="perf-row">
                <div className="perf-t">{fmt(e.t)}</div>
                <div className="perf-main">
                  <span className="perf-phase">{PHASE_CN[e.phase] || e.phase}</span>
                  {e.sourceId && <span className="perf-src">{e.sourceId}</span>}
                  {e.ms != null && <span className={e.status === 'fail' ? 'perf-ms fail' : 'perf-ms'}>{e.ms}ms</span>}
                  {e.status === 'cache-hit' && <span className="perf-ms cache">缓存命中</span>}
                  {e.status === 'fail' && <span className="perf-ms fail">失败</span>}
                </div>
                {e.detail && <div className="perf-detail">{e.detail}</div>}
              </div>
            ))}
          </div>
        )}
      </Section>
    </NavBarlessLayout>
  )
}
