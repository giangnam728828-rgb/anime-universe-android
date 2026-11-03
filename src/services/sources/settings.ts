/**
 * 来源开关设置持久化（阶段 3 · 第 1 步）
 *
 * 存储：localStorage `au_source_settings`，v1。
 * 语义：
 *  - **默认全部启用**：新安装 / 存储缺失 / 结构损坏 → 所有来源启用
 *  - 只记录"被禁用"的 id（disabled 列表），未记录的来源一律视为启用
 *    → 未来新增来源自动启用，无需迁移旧数据
 *  - 写入失败（容量满）静默，不影响运行
 *  - 与 au_source_health 完全独立：开关不碰健康计数，健康机制不碰开关
 *
 * 注意：本模块只管"开关数据"，不负责 UI（设置页属于后续步骤）。
 */
const KEY = 'au_source_settings'
const VERSION = 1

interface SettingsData {
  v: number
  /** 被禁用的来源 id 列表 */
  disabled: string[]
}

/** 内存缓存（首次访问时从 localStorage 载入） */
let cache: SettingsData | null = null

function load(): SettingsData {
  if (cache) return cache
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (
      raw &&
      raw.v === VERSION &&
      Array.isArray(raw.disabled) &&
      raw.disabled.every((x: unknown) => typeof x === 'string')
    ) {
      cache = { v: VERSION, disabled: raw.disabled }
      return cache
    }
  } catch {
    /* 损坏/缺失 → 重置为"全启用" */
  }
  cache = { v: VERSION, disabled: [] }
  return cache
}

function save(): void {
  if (!cache) return
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    /* 容量满静默 */
  }
}

/** 某来源是否启用（未记录为禁用 = 启用） */
export function isSourceEnabled(sourceId: string): boolean {
  return !load().disabled.includes(sourceId)
}

/** 全部禁用列表（只读副本） */
export function getDisabledSources(): string[] {
  return [...load().disabled]
}

/** 设置某来源开关（enabled=true 表示启用） */
export function setSourceEnabled(sourceId: string, enabled: boolean): void {
  const d = load()
  const has = d.disabled.includes(sourceId)
  if (enabled && has) {
    d.disabled = d.disabled.filter((x) => x !== sourceId)
    save()
  } else if (!enabled && !has) {
    d.disabled = [...d.disabled, sourceId]
    save()
  }
}

/** 批量设置（设置页"全开/全关"用） */
export function setAllSourcesEnabled(sourceIds: string[], enabled: boolean): void {
  const d = load()
  d.disabled = enabled
    ? d.disabled.filter((x) => !sourceIds.includes(x))
    : [...new Set([...d.disabled, ...sourceIds])]
  save()
}

/** 重置为默认（全部启用） */
export function resetSourceSettings(): void {
  cache = { v: VERSION, disabled: [] }
  save()
}

/** 调试/诊断：当前快照 */
export function getSettingsSnapshot(): SettingsData {
  return { v: load().v, disabled: getDisabledSources() }
}

/** 仅供测试：清空内存缓存，强制下次从 localStorage 重新读取（模拟应用重启） */
export function __reloadForTest(): void {
  cache = null
}
