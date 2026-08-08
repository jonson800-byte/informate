/**
 * 记忆读写层（T6 / Q30 定案：Node.js 后端直管 Hindsight REST API）
 *
 * 背景：Hermes Hindsight provider 的 bank 配置读取存在隐蔽时序问题（gateway 进程无 HERMES_HOME，
 * 全部写入默认 hermes bank，bank_id_template 不生效），因此 Informate 的记忆读写不由 Hermes 管理，
 * 由后端直接调 Hindsight（默认 http://localhost:9177）：
 * - 写入：POST /v1/default/banks/{bank_id}/memories    body {"items":[{content,context,tags}]}
 * - 检索：POST /v1/default/banks/{bank_id}/memories/recall  body {"query","limit"}
 *
 * bank 路由（Q30 定稿）：
 * - 租户私有（可写）：informate-tenant-{tenant}-{scenario}（租户 × 场景隔离，FR-207）
 * - 行业只读：informate-industry_{industry}（如 informate-industry_医美）
 *
 * 检索优先级（FR-203，P1-P4 硬编码）：
 *   P1 租户私有 bank（recallMemory）→ P2 行业 bank 中 sub_industry 命中 → P3 行业 bank 通用条目。
 *   本层实现 P2/P3：industryRecall 对结果按 sub_industry 标记排序（命中优先，通用条目兜底）。
 *
 * 坑：中文 bank_id（如 informate-industry_医美）在 URL 路径必须 encodeURIComponent，
 * 否则 Node fetch 的 URL 编码会直接报错。
 */

export interface MemoryOptions {
  baseUrl?: string
  /** false 时调用直接抛错（路由层捕获后跳过记忆注入），默认 true */
  enabled?: boolean
  timeoutMs?: number
}

export interface MemoryHit {
  text: string
  entities?: string[]
  tags?: string[]
  scores?: number[]
}

/** 调用记录（观测/测试用：验证记忆写入与检索是否真的发生） */
export interface MemoryCallRecord {
  method: string
  path: string
  body: unknown
}

export interface MemoryWriteOptions {
  context?: string
  tags?: string[]
}

export interface MemoryService {
  /** 写入租户私有 bank：informate-tenant-{tenant}-{scenario} */
  writeMemory(
    tenantId: string,
    scenario: string,
    content: string,
    opts?: MemoryWriteOptions,
  ): Promise<{ success: boolean; bankId: string }>
  /** 检索租户私有 bank（P1，优先级最高） */
  recallMemory(tenantId: string, scenario: string, query: string, limit?: number): Promise<MemoryHit[]>
  /** 检索行业 bank（只读）：informate-industry_{industry}，sub_industry 命中优先（P2）→ 通用兜底（P3） */
  industryRecall(industry: string, query: string, subIndustry?: string | null, limit?: number): Promise<MemoryHit[]>
  /** 返回全部调用记录（方法/路径/body） */
  getCallLog(): MemoryCallRecord[]
}

/** 租户私有 bank id（FR-207 连字符版定稿） */
export const tenantBankId = (tenantId: string, scenario: string): string =>
  `informate-tenant-${tenantId}-${scenario}`

/** 行业 bank id（行业为中文名，如 医美 → informate-industry_医美） */
export const industryBankId = (industry: string): string => `informate-industry_${industry}`

export function createMemoryService(opts: MemoryOptions = {}): MemoryService {
  const baseUrl = opts.baseUrl ?? process.env.HINDSIGHT_API_BASE ?? 'http://localhost:9177'
  const enabled = opts.enabled ?? true
  const timeoutMs = opts.timeoutMs ?? 5000
  const callLog: MemoryCallRecord[] = []

  /** 统一请求：记录调用 → fetch → 非 2xx 抛错 */
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    callLog.push({ method, path, body })
    if (!enabled) throw new Error('记忆服务已禁用（enabled=false）')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Hindsight ${method} ${path} 失败：HTTP ${res.status} ${detail.slice(0, 200)}`)
      }
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async writeMemory(tenantId, scenario, content, writeOpts) {
      const bankId = tenantBankId(tenantId, scenario)
      const items = [
        {
          content,
          context: writeOpts?.context ?? 'informate-chat',
          tags: writeOpts?.tags ?? ['informate', scenario, 'chat'],
        },
      ]
      const r = await request<{ success: boolean; bank_id: string; items_count: number }>(
        'POST',
        `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
        { items },
      )
      return { success: r.success, bankId: r.bank_id }
    },

    async recallMemory(tenantId, scenario, query, limit = 5) {
      const bankId = tenantBankId(tenantId, scenario)
      const r = await request<{ results?: MemoryHit[] }>(
        'POST',
        `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
        { query, limit },
      )
      return r.results ?? []
    },

    async industryRecall(industry, query, subIndustry = null, limit = 8) {
      const bankId = industryBankId(industry)
      const r = await request<{ results?: MemoryHit[] }>(
        'POST',
        `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
        { query, limit },
      )
      const hits = r.results ?? []
      // P2/P3 硬编码优先级：带 sub_industry:{二级行业} 标记的条目排前，通用条目兜底（FR-203）
      if (subIndustry) {
        const tag = `sub_industry:${subIndustry}`
        return [
          ...hits.filter((h) => h.tags?.includes(tag)),
          ...hits.filter((h) => !h.tags?.includes(tag)),
        ]
      }
      return hits
    },

    getCallLog() {
      return callLog
    },
  }
}
