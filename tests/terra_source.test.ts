/**
 * 泰拉记事社 适配器测试（TR1–TR10）
 *
 * 阶段3·第4步
 *
 * 🔴 核心约束：
 *  1. 两个 topicKey 都要取（只取一个会漏 6 部）
 *  2. 合并后必须按 cid 去重
 *  3. episodes 是**倒序**返回，必须升序（否则阅读顺序颠倒）
 *  4. chapterId 用 `cid/eid` 复合格式，能被路由 encodeURIComponent
 *  5. 签名 URL **绝不缓存**，每次实时取
 *  6. 并发上限固定为 8
 *  7. 接口失败返回空，不伪造
 *  8. 不持久化
 *  9. 🔴 不得宣称「403 自动刷新」与「阅读方向/跨页」已完成
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TERRA_SOURCE_ID,
  TERRA_USER_AGENT,
  __terraInternals,
  parseChapterId,
  sortEpisodesAsc,
} from '../src/services/sources/terraHistoricus'
import { SOURCES, SOURCE_ORDER, UNKNOWN_RANK, rank } from '../src/services/sources/registry'

const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf-8')
const src = read('services/sources/terraHistoricus.ts')

/** 去掉注释行，避免「注释里提到」被误判为实现 */
function stripComments(s: string): string {
  return s
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    .join('\n')
}
const code = stripComments(src)

/* ══════════════════════════════════════════════════════════════════════
 * TR1 契约
 * ══════════════════════════════════════════════════════════════════════ */

describe('TR1 适配器契约', () => {
  it('TR1a 实现全部必需方法', () => {
    for (const m of ['search', 'getDetail', 'getChapters', 'getPages', 'status']) {
      expect(code).toContain(m)
    }
  })

  it('TR1b id 与 SOURCE_ORDER 键一致', () => {
    expect(TERRA_SOURCE_ID).toBe('terra-historicus')
    expect(Object.prototype.hasOwnProperty.call(SOURCE_ORDER, TERRA_SOURCE_ID)).toBe(true)
  })

  it('TR1c 名称正确', () => {
    expect(src).toContain('泰拉记事社')
  })

  it('TR1d 🔴 不使用 as 强转掩盖类型差异', () => {
    // 教训：初版用 `as WorkItem` / `as WorkDetail` 绕过类型检查，
    // 被 tsc 拒绝（缺 workId/genres）。强转会让调用方拿到错误字段。
    expect(code).not.toMatch(/\bas\s+WorkItem\b/)
    expect(code).not.toMatch(/\bas\s+WorkDetail\b/)
  })

  it('TR1e WorkItem 必填字段齐备（workId / genres）', () => {
    const fn = code.slice(code.indexOf('function mapWork'), code.indexOf('function sortEpisodesAsc'))
    expect(fn).toContain('workId:')
    expect(fn).toContain('genres:')
  })

  it('TR1f 🔴 不把自定义 authors 字段塞进 WorkItem', () => {
    const fn = code.slice(code.indexOf('function mapWork'), code.indexOf('function sortEpisodesAsc'))
    expect(fn).not.toMatch(/^\s*authors:/m)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * TR2 两个 topicKey（坑 2）
 * ══════════════════════════════════════════════════════════════════════ */

describe('TR2 两个 topicKey 必须都取', () => {
  it('TR2a 🔴 主题键有两个', () => {
    expect(__terraInternals.TOPIC_KEYS).toHaveLength(2)
    expect([...__terraInternals.TOPIC_KEYS].sort()).toEqual([
      'talos-ii-historicus',
      'terra-historicus',
    ])
  })

  it('TR2b loadAllWorks 遍历全部主题（不是只取第一个）', () => {
    const fn = code.slice(code.indexOf('export async function loadAllWorks'))
    expect(fn).toContain('for (const tk of TOPIC_KEYS)')
    expect(fn).not.toMatch(/TOPIC_KEYS\[0\]/)
  })

  it('TR2c 🔴 必须按 cid 去重', () => {
    const fn = code.slice(code.indexOf('export async function loadAllWorks'))
    expect(fn).toContain('seen.has(item.cid)')
    expect(fn).toContain('seen.add(item.cid)')
  })

  it('TR2d 变异防护：若只取一个主题，本组应失败', () => {
    // 反证：TOPIC_KEYS 长度必须 > 1
    expect(__terraInternals.TOPIC_KEYS.length).toBeGreaterThan(1)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * TR3 章节倒序修正（坑 1）
 * ══════════════════════════════════════════════════════════════════════ */

describe('TR3 episodes 倒序必须修正为升序', () => {
  const ep = (shortTitle: string, displayTime = 0) => ({
    cid: `c${shortTitle}`,
    type: 1,
    shortTitle,
    title: `T${shortTitle}`,
    displayTime,
  })

  it('TR3a 🔴 接口原始倒序 [03,02,01] → 升序 [01,02,03]', () => {
    const out = sortEpisodesAsc([ep('03'), ep('02'), ep('01')])
    expect(out.map((e) => e.shortTitle)).toEqual(['01', '02', '03'])
  })

  it('TR3b 实测 cid=3114 的 [02,01] → [01,02]', () => {
    const out = sortEpisodesAsc([ep('02', 1793376000), ep('01', 1793289600)])
    expect(out.map((e) => e.shortTitle)).toEqual(['01', '02'])
  })

  it('TR3c 数字排序而非字符串排序（10 不能排在 2 前面）', () => {
    const out = sortEpisodesAsc([ep('10'), ep('2'), ep('1')])
    expect(out.map((e) => e.shortTitle)).toEqual(['1', '2', '10'])
  })

  it('TR3d 不修改原数组（纯函数）', () => {
    const input = [ep('02'), ep('01')]
    const copy = [...input]
    sortEpisodesAsc(input)
    expect(input).toEqual(copy)
  })

  it('TR3e shortTitle 非数字时回退 displayTime', () => {
    const out = sortEpisodesAsc([ep('下', 200), ep('上', 100)])
    expect(out[0].shortTitle).toBe('上')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * TR4 chapterId 复合格式
 * ══════════════════════════════════════════════════════════════════════ */

describe('TR4 cid/eid 复合 chapterId', () => {
  it('TR4a 解析正确', () => {
    expect(parseChapterId('3114/6303')).toEqual({ cid: '3114', eid: '6303' })
  })

  it('TR4b 无分隔符 ⇒ null', () => {
    expect(parseChapterId('31146303')).toBeNull()
  })

  it('TR4c 空段 ⇒ null', () => {
    expect(parseChapterId('/6303')).toBeNull()
    expect(parseChapterId('3114/')).toBeNull()
    expect(parseChapterId('')).toBeNull()
  })

  it('TR4d 章节 id 由 workId 与 eid 拼成', () => {
    expect(code).toContain('`${workId}/${ep.cid}`')
  })

  it('TR4e 🔴 路由会对 chapterId 编码，`/` 不会破坏路由', () => {
    const route = read('modules/reader/readerRoute.ts')
    expect(route).toContain('encodeURIComponent(chapterId)')
    // 反证：编码后确实不含裸斜杠
    expect(encodeURIComponent('3114/6303')).toBe('3114%2F6303')
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * TR5 签名 URL 实时性（坑 3）
 * ══════════════════════════════════════════════════════════════════════ */

describe('TR5 签名 URL 绝不缓存', () => {
  it('TR5a 源码无签名 URL 缓存', () => {
    expect(code).not.toMatch(/serverCache/)
    expect(code).not.toMatch(/urlCache/)
    expect(code).not.toMatch(/signCache/)
  })

  it('TR5b terraGet 明确不缓存', () => {
    const fn = code.slice(code.indexOf('async function terraGet'), code.indexOf('function mapWork'))
    expect(fn).not.toContain('memCache')
    expect(fn).not.toMatch(/cache/i)
  })

  it('TR5c getPages 每次调用都重新请求 /page', () => {
    const fn = code.slice(code.indexOf('async getPages'), code.indexOf('async status'))
    expect(fn).toContain('/page?pageNum=')
    // 不应因为 refresh 缺省就跳过请求
    expect(fn).not.toMatch(/if\s*\(\s*!\s*_?options\?\.refresh\s*\)\s*return/)
  })

  it('TR5d 🔴 不持久化', () => {
    expect(code).not.toMatch(/localStorage/)
    expect(code).not.toMatch(/sessionStorage/)
    expect(code).not.toMatch(/indexedDB/i)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * TR6 并发上限
 * ══════════════════════════════════════════════════════════════════════ */

describe('TR6 有界并发', () => {
  it('TR6a 并发上限为 8', () => {
    expect(__terraInternals.PAGE_CONCURRENCY).toBe(8)
  })

  it('TR6b getPages 使用有界并发而非 Promise.all 全开', () => {
    const fn = code.slice(code.indexOf('async getPages'), code.indexOf('async status'))
    expect(fn).toContain('mapWithConcurrency')
    expect(fn).toContain('PAGE_CONCURRENCY')
  })

  it('TR6c mapWithConcurrency 限制 worker 数量', () => {
    const fn = code.slice(code.indexOf('async function mapWithConcurrency'))
    expect(fn).toContain('Math.min(limit, items.length)')
  })

  it('TR6d 并发数不随页数增长', () => {
    const fn = code.slice(code.indexOf('async function mapWithConcurrency'))
    expect(fn).not.toMatch(/length\s*\)\s*,\s*async/)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * TR7 错误处理
 * ══════════════════════════════════════════════════════════════════════ */

describe('TR7 错误处理不伪造', () => {
  it('TR7a 非法 chapterId ⇒ 空数组', () => {
    const fn = code.slice(code.indexOf('async getPages'), code.indexOf('async status'))
    expect(fn).toMatch(/if\s*\(!parsed\)\s*return\s*\[\]/)
  })

  it('TR7b 无页信息 ⇒ 空数组', () => {
    expect(code).toMatch(/infos\.length\s*===\s*0\)\s*return\s*\[\]/)
  })

  it('TR7c HTTP 非 200 抛错（不返回假数据）', () => {
    expect(code).toContain('HTTP ${r.status}')
  })

  it('TR7d code 非 0 抛错', () => {
    expect(code).toContain('json.code !== 0')
  })

  it('TR7e 不重试（避免加重服务端负担）', () => {
    expect(code).not.toMatch(/for\s*\(let\s+i\s*=\s*0;\s*i\s*<\s*[2-9]/)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * TR8 注册表
 * ══════════════════════════════════════════════════════════════════════ */

describe('TR8 注册表', () => {
  it('TR8a 已注册', () => {
    expect(SOURCES.map((s) => s.id)).toContain('terra-historicus')
  })

  it('TR8b 排名为 6，旧来源未重排', () => {
    expect(SOURCE_ORDER['terra-historicus']).toBe(6)
    expect(SOURCE_ORDER.bangumi).toBe(0)
    expect(SOURCE_ORDER.bilibili).toBe(1)
    expect(SOURCE_ORDER.mangadex).toBe(2)
    expect(SOURCE_ORDER.anilist).toBe(3)
    expect(SOURCE_ORDER.jikan).toBe(4)
    expect(SOURCE_ORDER.mangabaka).toBe(5)
  })

  it('TR8c UNKNOWN_RANK 动态变为 7', () => {
    expect(UNKNOWN_RANK).toBe(7)
    expect(rank('terra-historicus')).toBe(6)
    expect(rank('nonexistent')).toBe(7)
  })

  it('TR8d 来源总数为 7', () => {
    expect(SOURCES).toHaveLength(7)
  })

  it('TR8e 排名唯一', () => {
    const vals = Object.values(SOURCE_ORDER)
    expect(new Set(vals).size).toBe(vals.length)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * TR9 未接通能力不得宣称完成
 * ══════════════════════════════════════════════════════════════════════ */

describe('TR9 🔴 未接通能力必须如实标注', () => {
  it('TR9a 源码明确标注「403 自动刷新未接通」', () => {
    expect(src).toMatch(/未.*接通|尚未接通/)
    expect(src).toContain('useOnlineWindow')
  })

  it('TR9b 源码明确标注「阅读方向/跨页暂不传递」', () => {
    expect(src).toMatch(/阅读方向|跨页/)
  })

  it('TR9c 🔴 不把 direction/doublePage 传给类型系统（避免类型欺骗）', () => {
    const fn = code.slice(code.indexOf('async getPages'), code.indexOf('async status'))
    expect(fn).not.toContain('doublePage')
    // PageItem 只映射 index/url/width/height
    expect(fn).toMatch(/return urls\.map/)
  })

  it('TR9d 基线阅读器确实未调用 getPages({refresh})（缺口为真）', () => {
    const win = read('modules/reader/useOnlineWindow.ts')
    // retry 重新下载原 URL
    expect(win).toMatch(/dispatch\(index,\s*ref\.url/)
    // 且未出现 refresh 调用
    expect(win).not.toContain('refresh: true')
  })

  it('TR9e 不改冻结文件', () => {
    for (const f of [
      'services/sources/types.ts',
      'modules/reader/ReaderPage.tsx',
      'modules/reader/useOnlineWindow.ts',
      'modules/reader/readerRoute.ts',
    ]) {
      const s = read(f)
      expect(s).not.toContain('terraHistoricus')
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * TR10 请求头与来源
 * ══════════════════════════════════════════════════════════════════════ */

describe('TR10 请求规范', () => {
  it('TR10a 使用如实描述自身的 UA', () => {
    expect(TERRA_USER_AGENT).toBe('AnimeUniverse/0.6 (manga reader)')
    expect(TERRA_USER_AGENT).not.toContain('Mozilla')
  })

  it('TR10b 所有请求走 terraHeaders', () => {
    expect(code).toContain('terraHeaders()')
  })

  it('TR10c base 为官方域名', () => {
    expect(__terraInternals.BASE).toBe('https://comic.hypergryph.com')
  })

  it('TR10d 不使用代理相关头', () => {
    expect(code).not.toMatch(/['"]Via['"]/)
    expect(code).not.toMatch(/proxy/i)
  })
})
