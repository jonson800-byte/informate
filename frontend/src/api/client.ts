/**
 * API 客户端：统一 token 注入 / 错误归一化（后端错误格式 {code,message,details}）
 * 所有路径为相对路径，Vite dev proxy 转发到 http://localhost:8080
 */
import type {
  ApiErrorBody,
  AdminAdjustResponse,
  AdminOverview,
  AdminTenantsResponse,
  BalanceResponse,
  ChatHistoryResponse,
  CreateConversationResponse,
  ImageTaskExecuteResponse,
  ImageTaskFreezeResponse,
  ImageTaskStatusResponse,
  LoginResponse,
  MeResponse,
  PriceConfigResponse,
  PriceConfigUpdateResponse,
  RechargeResponse,
  RegisterResponse,
  RoundSettleResponse,
  ScenariosResponse,
  SseEvent,
  TenantInfo,
  TxnsResponse,
  UserInfo,
  WorkspaceResponse,
  ConversationListItem,
  ArtifactListItem,
  Paged,
} from './types'

const TOKEN_KEY = 'informate_token'
const USER_KEY = 'informate_user'
const TENANT_KEY = 'informate_tenant'

// ---------- token / 会话存储 ----------
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setAuth(token: string, user: UserInfo, tenant: TenantInfo | null): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
  if (tenant) localStorage.setItem(TENANT_KEY, JSON.stringify(tenant))
  else localStorage.removeItem(TENANT_KEY)
}
export function getCachedUser(): UserInfo | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as UserInfo) : null
  } catch {
    return null
  }
}
export function getCachedTenant(): TenantInfo | null {
  try {
    const raw = localStorage.getItem(TENANT_KEY)
    return raw ? (JSON.parse(raw) as TenantInfo) : null
  } catch {
    return null
  }
}
export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(TENANT_KEY)
}

/** 业务错误（携带后端 code） */
export class ApiError extends Error {
  code: string
  details?: Record<string, unknown>
  status: number
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let body: ApiErrorBody = {}
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      // 非 JSON 错误（如网关）
    }
    throw new ApiError(res.status, body.code ?? 'HTTP_ERROR', body.message ?? `请求失败（HTTP ${res.status}）`, body.details)
  }
  if (res.status === 204) return undefined as T
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return (await res.json()) as T
  return (await res.text()) as T
}

// ---------- 认证 ----------
const qs = (p?: Record<string, unknown>) => {
  if (!p) return ''
  const parts = Object.entries(p).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return parts.length ? '?' + parts.join('&') : ''
}

export const api = {
  login: (account: string, password: string) =>
    request<LoginResponse>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ account, password }) }),

  me: () => request<MeResponse>('/api/v1/auth/me'),

  // ---------- 工作台 ----------
  workspace: () => request<WorkspaceResponse>('/api/v1/workspace'),
  scenarios: () => request<ScenariosResponse>('/api/v1/scenarios'),

  // ---------- Chat ----------
  chatHistory: (conversationId: string) =>
    request<ChatHistoryResponse>(`/api/v1/chat/messages?conversation_id=${encodeURIComponent(conversationId)}`),

  /** SSE 流式对话：返回 ReadableStream（按 \n\n 切分解析 SSE 事件） */
  async chatStream(conversationId: string, content: string, onEvent: (ev: SseEvent) => void): Promise<void> {
    const res = await fetch('/api/v1/chat/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken() ?? ''}`,
      },
      body: JSON.stringify({ conversation_id: conversationId, content }),
    })
    if (!res.ok) {
      // 输入侧拦截等业务错误（400 COMPLIANCE_BLOCKED / 429 ROUND_LIMIT_EXCEEDED / 402 余额不足 …）
      let body: ApiErrorBody = {}
      try {
        body = (await res.json()) as ApiErrorBody
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body.code ?? 'HTTP_ERROR', body.message ?? `请求失败（HTTP ${res.status}）`, body.details)
    }
    if (!res.body) throw new ApiError(500, 'NO_STREAM', '浏览器不支持流式响应')
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const ev = parseSseBlock(raw)
        if (ev) onEvent(ev)
      }
    }
  },

  // ---------- 积分 ----------
  createConversation: (body: { scenario_id?: string; conversation_id?: string; idempotency_key?: string }) =>
    request<CreateConversationResponse>('/api/v1/credit/conversations', { method: 'POST', body: JSON.stringify(body) }),

  settleRound: (conversationId: string, roundNo: number) =>
    request<RoundSettleResponse>(`/api/v1/credit/conversations/${encodeURIComponent(conversationId)}/rounds`, {
      method: 'POST',
      body: JSON.stringify({ round_no: roundNo }),
    }),

  balance: () => request<BalanceResponse>('/api/v1/credit/balance'),

  txns: (page = 1, pageSize = 20, type?: string) =>
    request<TxnsResponse>(`/api/v1/credit/txns?page=${page}&pageSize=${pageSize}${type ? `&type=${encodeURIComponent(type)}` : ''}`),

  // ---------- 会话/产出物列表（P1-1 服务端持久化） ----------
  conversations: (params?: { scenario_id?: string; page?: number; pageSize?: number }) =>
    request<Paged<ConversationListItem>>(
      `/api/v1/chat/conversations${qs(params)}`,
    ),

  artifacts: (params?: { scenario_id?: string; type?: string; page?: number; pageSize?: number }) =>
    request<Paged<ArtifactListItem>>(
      `/api/v1/artifacts${qs(params)}`,
    ),

  recharge: (tier: number, idempotencyKey: string) =>
    request<RechargeResponse>('/api/v1/credit/recharge', {
      method: 'POST',
      body: JSON.stringify({ tier, idempotency_key: idempotencyKey }),
    }),

  freezeImageTask: (body: { task_id: string; scenario_id?: string; idempotency_key?: string }) =>
    request<ImageTaskFreezeResponse>('/api/v1/credit/image-tasks', { method: 'POST', body: JSON.stringify(body) }),

  failImageTask: (taskId: string, reason?: string) =>
    request<{ task_id: string; refunded: number; replayed: boolean; balance: number; message: string }>(
      `/api/v1/credit/tasks/${encodeURIComponent(taskId)}/fail`,
      { method: 'POST', body: JSON.stringify(reason != null ? { reason } : {}) },
    ),

  executeImageTask: (taskId: string, prompt?: string) =>
    request<ImageTaskExecuteResponse>(`/api/v1/image-tasks/${encodeURIComponent(taskId)}/execute`, {
      method: 'POST',
      body: JSON.stringify(prompt != null ? { prompt } : {}),
    }),

  imageTaskStatus: (taskId: string) =>
    request<ImageTaskStatusResponse>(`/api/v1/image-tasks/${encodeURIComponent(taskId)}`),

  /** 下载产物：走浏览器直接下载（带 token 的流式请求） */
  downloadUrl: (artifactId: string) => `/api/v1/artifacts/${encodeURIComponent(artifactId)}/download`,

  // ---------- 员工（owner） ----------
  users: () => request<{ data: import('./types').EmployeeUser[] }>('/api/v1/users'),
  createUser: (body: { name: string; password: string; credit_limit?: number | null; credit_period?: string }) =>
    request<{ user: import('./types').EmployeeUser }>('/api/v1/users', { method: 'POST', body: JSON.stringify(body) }),
  patchUser: (id: string, body: { status?: 'active' | 'disabled'; credit_limit?: number | null }) =>
    request<{ user: import('./types').EmployeeUser }>(`/api/v1/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // ---------- 管理后台（admin） ----------
  /** 开户（T4：租户+主账号创建，admin/owner 均可调用；FR-101） */
  register: (body: {
    name: string
    industry: string
    sub_industry?: string
    owner_account: string
    owner_password: string
    owner_name?: string
    contact_name?: string
    contact_phone?: string
  }) =>
    request<RegisterResponse>('/api/v1/auth/register', { method: 'POST', body: JSON.stringify(body) }),

  adminTenants: (params: { status?: string; industry?: string; page?: number; pageSize?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.industry) qs.set('industry', params.industry)
    qs.set('page', String(params.page ?? 1))
    qs.set('pageSize', String(params.pageSize ?? 20))
    return request<AdminTenantsResponse>(`/api/v1/admin/tenants?${qs.toString()}`)
  },

  adminOverview: () => request<AdminOverview>('/api/v1/admin/overview'),

  adminAdjust: (body: { tenant_id: string; amount: number; note?: string }) =>
    request<AdminAdjustResponse>('/api/v1/admin/adjust', { method: 'POST', body: JSON.stringify(body) }),

  /** 导出 CSV（带 token；返回文本，前端可解析渲染或触发下载） */
  adminExport: (params: { tenant_id?: string; type?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.tenant_id) qs.set('tenant_id', params.tenant_id)
    if (params.type) qs.set('type', params.type)
    return request<string>(`/api/v1/admin/export?${qs.toString()}`)
  },

  adminPriceConfig: () => request<PriceConfigResponse>('/api/v1/admin/price-config'),

  adminUpdatePrice: (key: string, value: string, note?: string) =>
    request<PriceConfigUpdateResponse>('/api/v1/admin/price-config', {
      method: 'PUT',
      body: JSON.stringify({ key, value, note }),
    }),

  // ---------- 场景部署（owner） ----------
  deployScenario: (scenarioId: string) =>
    request<{ deployment: Record<string, unknown>; deploy_fee: { points: number; waived: boolean } }>(
      '/api/v1/scenarios/deploy',
      { method: 'POST', body: JSON.stringify({ scenario_id: scenarioId }) },
    ),
}

/** 解析单个 SSE block（event: X\ndata: {...}） */
function parseSseBlock(raw: string): SseEvent | null {
  let event = ''
  let data = ''
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(data) as Record<string, unknown>
  } catch {
    return null
  }
  switch (event) {
    case 'delta':
      return { event: 'delta', text: String(parsed.text ?? '') }
    case 'round_hint':
      return {
        event: 'round_hint',
        hint: { type: parsed.type === 'extra_round' ? 'extra_round' : 'included_used', message: String(parsed.message ?? '') },
      }
    case 'round_complete':
      return {
        event: 'round_complete',
        complete: { turns: Number(parsed.turns ?? 0), credit_charged: Number(parsed.credit_charged ?? 0) },
      }
    case 'error':
      return { event: 'error', error: { code: String(parsed.code ?? 'UNKNOWN'), message: String(parsed.message ?? '未知错误') } }
    default:
      return null
  }
}

/** 通用 CSV 解析（处理引号/逗号/换行） */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuotes = false
      } else cell += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') {
      cell += ch
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** 触发浏览器下载（带 token：先 fetch 再 blob） */
export async function downloadWithAuth(url: string, filename?: string): Promise<void> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', `下载失败（HTTP ${res.status}）`)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename ?? url.split('/').pop() ?? 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)
}

/** 带 token 拉取并生成可预览的 blob URL（img src 无法携带 Authorization，产物下载接口需鉴权） */
export async function previewWithAuth(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
  if (!res.ok) throw new ApiError(res.status, 'PREVIEW_FAILED', `预览加载失败（HTTP ${res.status}）`)
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}
