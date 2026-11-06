/**
 * 总方案·阶段3·第2步·2d：导出专项测试
 *
 * 覆盖（用户裁定 2026-11-06）：
 *   - T10   导出 JSON 无敏感字段
 *   - D1~D5 输入层：脱敏链六类凭据哨兵（v6.10 L1251-1259 原始定义）
 *   - D6-a/b/c/d/d2/e/f 输出层：导出字段边界（七子项独立计数）
 *   - T57-e 导出不含 host / query / hash
 *   - 关闭时序专项：关闭后在途请求终结不得回写 records
 *
 * 🔴 D1~D5 不得用 D6 子项代替；D6 七子项独立计数。
 */
import { describe, it, expect } from 'vitest'
/* ★ 迁移说明：原文件首行 import '../../services/diagnostics/__tests__/setup'
   用于 afterEach 复位 DEP 测试替身。该 setup.ts 从未进入仓库（仅存在于本地
   影子测试环境），且本文件全程未使用 __setTestDep / __resetTestDep，
   故此处移除该裸导入；20 项断言与测试逻辑完全不变。 */
import {
  setDiagEnabled,
  beginRequest,
  markHttpDone,
  markParsing,
  markParsed,
  markDone,
  finalizeInternal,
  clearDiagRecords,
  readExportRecords,
  isDiagEnabled,
  maskSnippet,
} from '../src/services/diagnostics'
import { __diagSnapshot } from '../src/services/diagnostics/internal'
import {
  EXPORT_FIELDS,
  toExportRecord,
  buildExportJson,
  buildExportPayload,
  buildExportFileName,
  EXPORT_FILE_PREFIX,
} from '../src/modules/diagnostics/export'
import type { EvidenceRecord } from '../src/services/diagnostics/types'

const mkctx = (rid: string, att = 1) =>
  ({ sourceId: 'src', requestType: 'other', attempt: att, requestId: rid, attemptId: `${rid}:${att}` } as any)

/** 完整走一遍生命周期，产出一条已完成记录（path 用于 T57-e 路径脱敏验证） */
function makeRecord(rid: string, path?: string): void {
  const ctx = mkctx(rid)
  if (path !== undefined) ctx.path = path  // ★ 传给 beginRequest，走 safePath 链
  beginRequest(ctx)
  markHttpDone(ctx.attemptId, { status: 200, ms: 12 }, 'ok', 'application/json')
  markParsing(ctx.attemptId!)
  markParsed(ctx.attemptId!)
  markDone(ctx.attemptId!)
  finalizeInternal(ctx.attemptId, 'success')
}

/** 在开启状态下隔离执行，结束后关闭并清空 */
function withDiag(fn: () => void): void {
  setDiagEnabled(true)
  try {
    fn()
  } finally {
    setDiagEnabled(false)
    clearDiagRecords()
  }
}

/* ══════════════════════════════════════════════════════════════
 * D6 输出层：导出字段边界（七子项）
 * ══════════════════════════════════════════════════════════════ */
describe('D6 导出白名单边界（七子项独立验收）', () => {
  it('D6-a 白名单字段全部存在（恰 16 项）', () => {
    withDiag(() => {
      makeRecord('d6a')
      const rec = readExportRecords()[0]
      const out = toExportRecord(rec as EvidenceRecord)
      expect(EXPORT_FIELDS.length).toBe(16)
      for (const k of EXPORT_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(true)
      }
      expect(Object.keys(out).length).toBe(16)
    })
  })

  it('D6-b rawText 不存在', () => {
    withDiag(() => {
      makeRecord('d6b')
      const json = buildExportJson(readExportRecords())
      expect(json).not.toContain('rawText')
    })
  })

  it('D6-c PendingRecord 结构不会被导出', () => {
    withDiag(() => {
      const ctx = mkctx('d6c')
      beginRequest(ctx) // 故意不终结 → pending 中存在
      expect(__diagSnapshot().pending.length).toBeGreaterThan(0)
      const json = buildExportJson(readExportRecords())
      // PendingRecord 独有字段不得出现在导出结果中
      for (const k of ['businessCheckMarked', 'parseStarted', 'parsedReached', 'commitState', 'createdAt', '_tmpHeaders']) {
        expect(json).not.toContain(`"${k}"`)
      }
      finalizeInternal(ctx.attemptId, 'failure', new Error('cleanup'))
    })
  })

  it('D6-d 未授权字段不会进入 JSON', () => {
    withDiag(() => {
      makeRecord('d6d')
      const rec = readExportRecords()[0] as EvidenceRecord
      const polluted = { ...rec, unauthorizedField: 'SHOULD_NOT_APPEAR' } as EvidenceRecord
      const out = toExportRecord(polluted)
      expect(JSON.stringify(out)).not.toContain('SHOULD_NOT_APPEAR')
      expect(Object.keys(out).length).toBe(16)
    })
  })

  it('D6-d2 新增内部字段不会自动进入导出（parseSuccess 亦被排除）', () => {
    withDiag(() => {
      makeRecord('d6d2')
      const rec = readExportRecords()[0] as EvidenceRecord
      // 模拟「未来新增字段」与「已存在但故意不导出」的字段
      const withFuture = {
        ...rec,
        newFieldIn2027: 'LEAK_NEW',
        nested: { deep: 'LEAK_NESTED' },
        rawText: 'LEAK_RAW',
        _tmpHeaders: { a: 'LEAK_HDR' },
      } as EvidenceRecord
      const out = toExportRecord(withFuture)
      const s = JSON.stringify(out)

      expect(s).not.toContain('LEAK_NEW')
      expect(s).not.toContain('LEAK_NESTED')
      expect(s).not.toContain('LEAK_RAW')
      expect(s).not.toContain('LEAK_HDR')
      // ★ parseSuccess 合法存在于 EvidenceRecord，但必须被排除（D6-d2 现成反例）
      expect(Object.prototype.hasOwnProperty.call(rec, 'parseSuccess')).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(out, 'parseSuccess')).toBe(false)
      expect(s).not.toContain('parseSuccess')
      // 字段数恰为 16
      expect(Object.keys(out).length).toBe(16)
    })
  })

  it('D6-e 敏感信息不因导出路径绕过脱敏', () => {
    withDiag(() => {
      const S = 'REAL_SECRET_TOKEN_9f3a'
      // 直接经脱敏链产出的片段不得含哨兵
      const masked = maskSnippet(`{"access_token":"${S}"}`)!
      expect(masked).not.toContain(S)
      makeRecord('d6e')
      const json = buildExportJson(readExportRecords())
      expect(json).not.toContain(S)
      expect(json).not.toContain('***@***')  // 不误报：无邮箱输入
    })
  })

  it('D6-f 导出内容是有效 JSON', () => {
    withDiag(() => {
      makeRecord('d6f')
      const json = buildExportJson(readExportRecords(), 1700000000000)
      const parsed = JSON.parse(json)
      expect(parsed.version).toBe(1)
      expect(parsed.exportedAt).toBe(1700000000000)
      expect(Array.isArray(parsed.records)).toBe(true)
      expect(parsed.records.length).toBe(1)
      expect(Object.keys(parsed.records[0]).length).toBe(16)
    })
  })
})

/* ══════════════════════════════════════════════════════════════
 * D1~D5 输入层：脱敏链（v6.10 L1251-1259 原始定义，逐项映射）
 * ══════════════════════════════════════════════════════════════ */
describe('D1~D5 脱敏链（输入层，v6.10 原始用例）', () => {
  it('D1 Authorization: Bearer <S1> → S1 被掩码且不出现在导出', () => {
    withDiag(() => {
      const S1 = 'S1TOKENabcdef123456'
      const masked = maskSnippet(`Authorization: Bearer ${S1}`)!
      expect(masked).not.toContain(S1)
      // ③ 非敏感字段保留：同一条输入里的普通文本不应被吞掉
      const mixed = maskSnippet(`Authorization: Bearer ${S1} method=GET`)!
      expect(mixed).toContain('method=GET')
      makeRecord('d1')
      expect(buildExportJson(readExportRecords())).not.toContain(S1)
    })
  })

  it('D2 Cookie: sessionid=<S2>; other=<S3> → 两段哨兵都不出现', () => {
    withDiag(() => {
      const S2 = 'S2SESSIONv4lue'
      const S3 = 'S3OTHERv4lue'
      const masked = maskSnippet(`Cookie: sessionid=${S2}; other=${S3}`)!
      expect(masked).not.toContain(S2)
      expect(masked).not.toContain(S3)
      makeRecord('d2')
      const json = buildExportJson(readExportRecords())
      expect(json).not.toContain(S2)
      expect(json).not.toContain(S3)
    })
  })

  it('D3 {"access_token":"<S4>"}（短值）→ 短值也掩码', () => {
    withDiag(() => {
      const S4 = 'S4ab'
      const masked = maskSnippet(`{"access_token":"${S4}"}`)!
      expect(masked).not.toContain(S4)
      makeRecord('d3')
      expect(buildExportJson(readExportRecords())).not.toContain(S4)
    })
  })

  it('D4 ?refresh_token=<S5> → 值被掩码', () => {
    withDiag(() => {
      const S5 = 'S5refreshValue'
      const masked = maskSnippet(`/api/x?refresh_token=${S5}`)!
      expect(masked).not.toContain(S5)
      makeRecord('d4')
      expect(buildExportJson(readExportRecords())).not.toContain(S5)
    })
  })

  it('D5 {"Access_Token":"<S6>"} 大小写混合 → 照样掩码', () => {
    withDiag(() => {
      const S6 = 'S6MixedCaseValue'
      const masked = maskSnippet(`{"Access_Token":"${S6}"}`)!
      expect(masked).not.toContain(S6)
      makeRecord('d5')
      expect(buildExportJson(readExportRecords())).not.toContain(S6)
    })
  })
})

/* ══════════════════════════════════════════════════════════════
 * T10 导出 JSON 无敏感字段；T57-e 无 host / query / hash
 * ══════════════════════════════════════════════════════════════ */
describe('T10 / T57-e', () => {
  it('T10 导出的 JSON 不含任何敏感字段', () => {
    withDiag(() => {
      makeRecord('t10')
      const json = buildExportJson(readExportRecords())
      for (const k of ['rawText', '_tmpHeaders', 'cookie', 'authorization', 'token', 'password']) {
        expect(json.toLowerCase()).not.toContain(`"${k.toLowerCase()}":`)
      }
    })
  })

  it('T57-e 导出不含原始 URL / query / hash', () => {
    withDiag(() => {
      makeRecord('t57e', 'https://api.example.com/path/seg?token=abc#frag')
      const rec = readExportRecords()[0]
      const s = JSON.stringify(toExportRecord(rec as EvidenceRecord))
      expect(s).not.toContain('api.example.com')
      expect(s).not.toContain('example.com')
      expect(s).not.toContain('token=')
      expect(s).not.toContain('frag')
      expect(s).not.toContain('#')
      expect(s).not.toContain('?')
    })
  })
})

/* ══════════════════════════════════════════════════════════════
 * 关闭时序专项（用户裁定纳入本轮）
 * ══════════════════════════════════════════════════════════════ */
describe('关闭诊断时序：在途请求终结不得回写 records', () => {
  it('关闭并清空后，在途请求继续终结仍不产生记录；pending 生命周期不受影响', () => {
    setDiagEnabled(true)
    try {
      // ① 一条已完成记录
      makeRecord('seq-done')
      expect(readExportRecords().length).toBe(1)

      // ② 一条在途请求（已登记、未终结）
      const inflight = mkctx('seq-inflight')
      beginRequest(inflight)
      expect(__diagSnapshot().pending.some((p) => p.attemptId === inflight.attemptId)).toBe(true)

      // ③ 关闭开关 + 清空缓冲（同一同步块，无 await）
      setDiagEnabled(false)
      const cleared = clearDiagRecords()
      expect(cleared).toBe(1)
      expect(readExportRecords().length).toBe(0)
      expect(isDiagEnabled()).toBe(false)

      // ④ 让在途请求继续走终结流程
      markDone(inflight.attemptId)
      finalizeInternal(inflight.attemptId, 'success')

      // ⑤ 断言：records 仍为空
      expect(readExportRecords().length).toBe(0)

      // ⑥ 再次 finalize 仍为 0（幂等，不回写）
      finalizeInternal(inflight.attemptId, 'success')
      expect(readExportRecords().length).toBe(0)
    } finally {
      setDiagEnabled(false)
      clearDiagRecords()
      // 清理遗留 pending
      for (const p of __diagSnapshot().pending) {
        finalizeInternal(p.attemptId, 'failure', new Error('cleanup'))
      }
    }
  })

  it('清空只作用于 records，不清 pending', () => {
    setDiagEnabled(true)
    try {
      makeRecord('clr-done')
      const ctx = mkctx('clr-pend')
      beginRequest(ctx)
      const before = __diagSnapshot().pending.length
      expect(before).toBeGreaterThan(0)

      const n = clearDiagRecords()
      expect(n).toBe(1)
      // pending 未被清空
      expect(__diagSnapshot().pending.length).toBe(before)
      expect(readExportRecords().length).toBe(0)
    } finally {
      setDiagEnabled(false)
      clearDiagRecords()
      for (const p of __diagSnapshot().pending) {
        finalizeInternal(p.attemptId, 'failure', new Error('cleanup'))
      }
    }
  })
})

/* ══════════════════════════════════════════════════════════════
 * 新增 API 与稳定性
 * ══════════════════════════════════════════════════════════════ */
describe('2d 新增 API 稳定性', () => {
  it('readExportRecords 返回深拷贝，修改快照不污染内部 records', () => {
    withDiag(() => {
      makeRecord('deep')
      const snap = readExportRecords() as EvidenceRecord[]
      expect(snap.length).toBe(1)
      // 篡改快照
      snap[0].sourceId = 'HACKED'
      snap.length = 0
      // 内部不受影响
      const again = readExportRecords()
      expect(again.length).toBe(1)
      expect(again[0].sourceId).toBe('src')
    })
  })

  it('isDiagEnabled 反映真实状态', () => {
    setDiagEnabled(false)
    expect(isDiagEnabled()).toBe(false)
    setDiagEnabled(true)
    expect(isDiagEnabled()).toBe(true)
    setDiagEnabled(false)
    expect(isDiagEnabled()).toBe(false)
  })

  it('导出文件名带时间戳且匹配前缀', () => {
    const name = buildExportFileName(new Date(2026, 10, 6, 18, 30, 5))
    expect(name).toBe('anime-universe-diag-20261106-183005.json')
    expect(name.startsWith(EXPORT_FILE_PREFIX)).toBe(true)
  })

  it('buildExportPayload 保持 version/exportedAt 契约', () => {
    withDiag(() => {
      makeRecord('payload')
      const p = buildExportPayload(readExportRecords(), 1234567890)
      expect(p.version).toBe(1)
      expect(p.exportedAt).toBe(1234567890)
      expect(p.records.length).toBe(1)
    })
  })
})
