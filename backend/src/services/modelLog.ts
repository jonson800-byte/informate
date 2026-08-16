import type Database from 'better-sqlite3'

/**
 * 模型适配层（P0-1 外部评估优化，2026-08-16）
 *
 * 统一模型调用日志 + 错误分类：
 * - 每次真实模型调用（Hermes/Seedream）落 model_call_log（供应商/模型版本/请求ID/延迟/错误分类），
 *   供成本核算、SLO 监控与审计（日志不保存密钥与完整敏感提示词）
 * - classifyModelError：把供应商错误归一为 7 类，业务层据此决定重试/降级/退款
 * - retryWithBackoff：只对可安全重放的请求使用（生图任务可重放；SSE 流不重放）
 */

export type ModelProvider = 'hermes' | 'seedream'
export type ModelErrorClass =
  | 'rate_limited'   // 429 限流（可重试）
  | 'timeout'        // 首包/空闲/总超时（可重试，需幂等）
  | 'server'         // 5xx / 供应商内部错误（可重试）
  | 'network'        // 连接失败（可重试）
  | 'auth'           // 401/403 密钥问题（不可重试）
  | 'bad_request'    // 400 参数/内容问题（不可重试）
  | 'unknown'        // 未分类（保守不可重试）

/** model_call_log 行 */
export interface ModelCallRow {
  id: string
  provider: ModelProvider
  model: string
  request_id: string | null
  kind: 'chat' | 'image' | 'video'
  latency_ms: number | null
  status: 'success' | 'error'
  error_class: ModelErrorClass | null
  error_msg: string | null
  tokens_in: number | null
  tokens_out: number | null
  cost_yuan: number | null
  meta: string | null
  created_at: string
}

/** 归一化错误：业务层统一消费（不再直接依赖供应商错误结构） */
export class ModelError extends Error {
  constructor(
    message: string,
    public readonly cls: ModelErrorClass,
    public readonly provider: ModelProvider,
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'ModelError'
  }
}

/** 把任意错误归一化为 ModelError（HTTP 状态优先，其次按消息特征） */
export function classifyModelError(
  err: unknown,
  provider: ModelProvider,
  httpStatus?: number,
): ModelError {
  const msg = err instanceof Error ? err.message : String(err)
  if (httpStatus) {
    if (httpStatus === 429) return new ModelError(msg, 'rate_limited', provider, true, httpStatus)
    if (httpStatus === 401 || httpStatus === 403) return new ModelError(msg, 'auth', provider, false, httpStatus)
    if (httpStatus >= 500) return new ModelError(msg, 'server', provider, true, httpStatus)
    if (httpStatus === 400 || httpStatus === 422) return new ModelError(msg, 'bad_request', provider, false, httpStatus)
    return new ModelError(msg, 'unknown', provider, false, httpStatus)
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('限流')) {
    return new ModelError(msg, 'rate_limited', provider, true)
  }
  if (msg.includes('timeout') || msg.includes('超时')) {
    return new ModelError(msg, 'timeout', provider, true)
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed') || msg.includes('ECONNRESET')) {
    return new ModelError(msg, 'network', provider, true)
  }
  if (/HTTP 5\d\d/.test(msg) || msg.includes('5xx')) {
    return new ModelError(msg, 'server', provider, true)
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('密钥')) {
    return new ModelError(msg, 'auth', provider, false)
  }
  return new ModelError(msg, 'unknown', provider, false)
}

/** 带退避的重试封装：仅用于可安全重放的操作（生图任务等） */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseMs?: number; onRetry?: (attempt: number, err: ModelError) => void } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2
  const baseMs = opts.baseMs ?? 800
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const me = err instanceof ModelError ? err : classifyModelError(err, 'seedream')
      if (!me.retryable || attempt >= maxRetries) throw me
      const delay = baseMs * 2 ** attempt + Math.random() * 200
      opts.onRetry?.(attempt + 1, me)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}

/** 记录模型调用（落 model_call_log 表 + 控制台摘要；不记录敏感提示词） */
export function logModelCall(
  db: Database.Database,
  call: {
    provider: ModelProvider
    model: string
    requestId?: string | null
    kind: 'chat' | 'image' | 'video'
    latencyMs?: number | null
    status: 'success' | 'error'
    errorClass?: ModelErrorClass | string | null
    errorMsg?: string | null
    tokensIn?: number | null
    tokensOut?: number | null
    costYuan?: number | null
    meta?: Record<string, unknown> | null
  },
): void {
  try {
    const metaStr = call.meta ? JSON.stringify(call.meta) : null
    db.prepare(
      `INSERT INTO model_call_log (id, provider, model, request_id, kind, latency_ms, status, error_class, error_msg, tokens_in, tokens_out, cost_yuan, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      call.provider + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      call.provider,
      call.model,
      call.requestId ?? null,
      call.kind,
      call.latencyMs ?? null,
      call.status,
      call.errorClass ?? null,
      call.errorMsg ? call.errorMsg.slice(0, 500) : null,
      call.tokensIn ?? null,
      call.tokensOut ?? null,
      call.costYuan ?? null,
      metaStr,
    )
  } catch (err) {
    // 日志失败不影响主链路
    console.error('[modelLog] 写入失败:', (err as Error).message)
  }
}
