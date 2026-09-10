import type { FastifyInstance } from 'fastify'

/**
 * Fastify 类型扩展：鉴权中间件注入的请求上下文
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** 当前用户 ID（user.id 或 admin.id） */
    userId?: string
    /** 当前角色：owner / employee / admin */
    role?: 'owner' | 'employee' | 'admin'
    /** 租户上下文（admin 为 null） */
    tenantId?: string | null
  }
}

/** 健康检查：GET /health → { status: 'ok', db: true } */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => {
    // 真实执行一次 DB 查询验证连通性
    const row = app.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined
    return { status: 'ok', db: row?.ok === 1 }
  })

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, boolean> = { db: false, compliance: false, memory: false, providers: false }
    try {
      checks.db = (app.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined)?.ok === 1
    } catch { checks.db = false }

    async function probe(url: string): Promise<boolean> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      try { return (await fetch(url, { signal: controller.signal })).ok } catch { return false } finally { clearTimeout(timer) }
    }
    ;[checks.compliance, checks.memory] = await Promise.all([
      probe(`${(process.env.COMPLIANCE_BASE_URL ?? 'http://127.0.0.1:9100').replace(/\/$/, '')}/health`),
      probe(`${(process.env.HINDSIGHT_API_BASE ?? 'http://127.0.0.1:9177').replace(/\/$/, '')}/health`),
    ])
    const chatProvider = process.env.CHAT_PROVIDER ?? process.env.HERMES_MODE ?? 'mock'
    checks.providers = process.env.NODE_ENV !== 'production' ||
      (chatProvider === 'deepseek' && !!process.env.DEEPSEEK_API_KEY && process.env.SEEDREAM_MODE === 'real' && !!process.env.VOLC_ARK_API_KEY) ||
      ((chatProvider === 'hermes' || chatProvider === 'real') && !!process.env.HERMES_API_KEY && process.env.SEEDREAM_MODE === 'real' && !!process.env.VOLC_ARK_API_KEY)
    const ready = Object.values(checks).every(Boolean)
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks })
  })
}
