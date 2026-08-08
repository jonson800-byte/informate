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
}
