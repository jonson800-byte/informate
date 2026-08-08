/**
 * Informate API 类型定义 —— 与 backend/src/routes/*.ts 实际契约逐字段对齐（batchD 验收要求：不凭空造端点/字段）
 * 端点清单（均挂 /api/v1，端口 8080，Vite proxy 转发）：
 *   POST   /auth/login                    登录（user 表 + admin 表双通道）
 *   GET    /auth/me                       当前用户 + 租户状态
 *   GET    /workspace                     工作台：余额/试用剩余/价格显示/active 场景
 *   GET    /scenarios                     场景列表（含 emoji / pricing 元数据）
 *   POST   /scenarios/deploy              开通部署（owner）
 *   POST   /chat/messages                 SSE 流式对话
 *   GET    /chat/messages?conversation_id= 历史消息
 *   POST   /credit/conversations          创建会话并冻结 10
 *   POST   /credit/conversations/:id/rounds 轮次结算（第 21 轮起 1 积分/轮）
 *   GET    /credit/balance                余额查询
 *   GET    /credit/txns                   积分流水（分页）
 *   POST   /credit/recharge               充值（100/500/2000 三档，owner）
 *   POST   /credit/image-tasks            生图任务冻结 15
 *   POST   /credit/tasks/:id/fail         任务失败退分
 *   POST   /image-tasks/:id/execute       生图任务入队执行
 *   GET    /image-tasks/:id               生图任务状态轮询
 *   GET    /artifacts/:id/download        图片下载（文件流）
 *   GET    /users                         员工列表（owner）
 *   POST   /users                         创建员工（owner）
 *   PATCH  /users/:id                     停用/启用 + 限额（owner）
 *   GET    /admin/tenants                 租户列表（admin）
 *   GET    /admin/overview                积分看板（admin）
 *   POST   /admin/adjust                  手动调账（admin）
 *   GET    /admin/export                  积分流水导出 CSV（admin）
 *   GET    /admin/price-config            单价配置查询（admin）
 *   PUT    /admin/price-config            单价配置修改（admin）
 */

// ---------- 认证 ----------
export type Role = 'owner' | 'employee' | 'admin'
export type TenantStatus = 'trial' | 'active' | 'paused' | 'expired'

export interface UserInfo {
  id: string
  role: Role
  name: string
}

export interface TenantInfo {
  id: string
  name: string
  industry: string
  status: TenantStatus
  balance: number
  trial_sessions_used?: number
  trial_remaining: number
}

export interface LoginResponse {
  token: string
  user: UserInfo
  tenant: TenantInfo | null
}

export interface MeResponse {
  user: UserInfo
  tenant: TenantInfo | null
}

// ---------- 工作台 / 场景 ----------
export interface ScenarioDeployment {
  id: string
  scenario_id: string
  scenario_version: string
  display_name: string
  industry_bank: string | null
  status: string
  deployed_at: string
  meta?: {
    name: string
    emoji: string
    pricing: { unit: 'session' | 'image'; deduct_points: number }
  }
}

export interface WorkspaceResponse {
  workspace: {
    tenant: {
      name: string
      industry: string
      status: TenantStatus
      balance: number
      trial_remaining: number
    }
    scenarios: ScenarioDeployment[]
    prices: Record<string, string>
  }
}

export interface ScenariosResponse {
  data: ScenarioDeployment[]
}

// ---------- Chat ----------
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  round_no: number | null
  credit_charged: number | null
  compliance_passed: number | null
  created_at: string
}

export interface ChatHistoryResponse {
  conversation_id: string
  messages: ChatMessage[]
}

export interface SseRoundHint {
  type: 'included_used' | 'extra_round'
  message: string
}

export interface SseRoundComplete {
  turns: number
  credit_charged: number
}

export interface SseErrorEvent {
  code: string
  message: string
}

/** SSE 事件联合 */
export type SseEvent =
  | { event: 'delta'; text: string }
  | { event: 'round_hint'; hint: SseRoundHint }
  | { event: 'round_complete'; complete: SseRoundComplete }
  | { event: 'error'; error: SseErrorEvent }

/** 后端错误响应（统一错误处理器：{code,message,details}） */
export interface ApiErrorBody {
  code?: string
  message?: string
  details?: Record<string, unknown>
}

// ---------- 积分 ----------
export interface ConversationRow {
  id: string
  tenant_id: string
  user_id: string
  scenario_id: string | null
  status: string
  turns: number
  billing_state: string
  frozen_credit: number
  settled_credit: number
  created_at?: string
}

export interface CreateConversationResponse {
  conversation: ConversationRow
  freeze: number
  balance: number
  replayed: boolean
}

export interface RoundSettleResponse {
  round_no: number
  charge: number
  replayed: boolean
  balance: number
  message: string
}

export interface BalanceResponse {
  balance: number
  status: TenantStatus
  min_freeze: number
}

export interface CreditTxn {
  id: string
  tenant_id: string
  user_id: string | null
  type: string
  amount: number
  balance_after: number | null
  scenario_id: string | null
  ref_type: string | null
  ref_id: string | null
  round_no: number | null
  idempotency_key: string | null
  operator: string | null
  note: string | null
  created_at: string
}

export interface TxnsResponse {
  data: CreditTxn[]
  pagination: { page: number; pageSize: number; total: number }
}

export interface RechargeResponse {
  txn: CreditTxn
  balance: number
  replayed: boolean
  message: string
}

export interface ImageTaskFreezeResponse {
  task_id: string
  freeze: number
  status: string
  balance: number
  replayed: boolean
  message: string
}

export interface ImageTaskStatusResponse {
  task_id: string
  status: 'pending' | 'processing' | 'success' | 'failed'
  url: string | null
  fail_reason: string | null
  prompt: string | null
  model: string | null
  mode: string | null
  created_at: string
  completed_at: string | null
  freeze: number
  settled: number
  refunded: number
}

export interface ImageTaskExecuteResponse {
  task_id: string
  status: 'pending' | 'processing' | 'success' | 'blocked' | 'failed'
  url?: string | null
  queued?: boolean
  reason?: string | null
  replayed: boolean
  message: string
}

// ---------- 员工（owner） ----------
export interface EmployeeUser {
  id: string
  name: string
  role: string
  status: 'active' | 'disabled'
  credit_limit: number | null
  credit_period: string
  guide_seen: number
  created_at: string
}

// ---------- 管理后台（admin） ----------
export interface AdminTenant {
  id: string
  name: string
  industry: string
  sub_industry: string | null
  status: TenantStatus
  plan: string | null
  balance: number
  trial_sessions_used: number
  trial_session_limit: number
  expires_at: string | null
  created_at: string
}

export interface AdminTenantsResponse {
  data: AdminTenant[]
  pagination: { page: number; pageSize: number; total: number }
}

export interface AdminOverview {
  overview: {
    tenant_count: number
    tenant_active: number
    tenant_paused: number
    total_balance: number
    total_revenue: number
    total_consumed: number
    frozen_outstanding: number
    adjust_net: number
    today_revenue: number
    today_consumed: number
    min_freeze: number
  }
}

export interface PriceConfigItem {
  key: string
  value: string
  source: 'price_config' | 'default'
  effective_at: string | null
  operator: string | null
  note: string | null
}

export interface PriceConfigResponse {
  data: PriceConfigItem[]
}

export interface PriceConfigUpdateResponse {
  key: string
  value: string
  effective_at: string
  message: string
}

export interface AdminAdjustResponse {
  tenant_id: string
  amount: number
  balance: number
  replayed: boolean
  message: string
}

/** 价格 key 常量（对齐 backend/src/services/credit.ts PRICE_KEYS） */
export const PRICE_KEYS = {
  session: 'credit.work_assistant.session',
  image: 'credit.image_task',
  roundExtra: 'credit.round_extra',
  roundLimit: 'credit.round_limit',
  minFreeze: 'credit.min_freeze',
  recharge: (yuan: number) => `recharge.${yuan}`,
} as const

/** 默认价格常量（对齐 backend DEFAULT_PRICES） */
export const DEFAULT_PRICES = {
  session: 10,
  roundExtra: 1,
  roundLimit: 50,
  image: 15,
  imageDisplay: 20, // 对外展示 20，实际执行 15
  minFreeze: 10,
  lowBalanceWarn: 30, // FR-605 预警阈值
  recharge: { 100: 1100, 500: 6000, 2000: 25000 },
} as const

/** 场景包目录（seed 预置，管理后台「场景部署」参考目录） */
export interface ScenarioPackageCatalog {
  id: string
  name: string
  emoji: string
  color: string
  unit: 'session' | 'image'
  deduct_points: number
  display_name_template: string
}
export const SCENARIO_PACKAGE_CATALOG: ScenarioPackageCatalog[] = [
  {
    id: 'industry_work_assistant',
    name: '行业工作助手',
    emoji: '🏥',
    color: '#00A0E9',
    unit: 'session',
    deduct_points: 10,
    display_name_template: '{industry}行业工作助手',
  },
  {
    id: 'generate_image',
    name: '生成图片',
    emoji: '🖼️',
    color: '#FF7F50',
    unit: 'image',
    deduct_points: 15,
    display_name_template: '{industry}营销生图',
  },
]
