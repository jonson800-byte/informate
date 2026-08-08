import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth'

interface ListTenantsQuery {
  status?: string
  industry?: string
  page?: string
  pageSize?: string
}

/**
 * 管理后台路由（技术方案 §四 4.2，admin 角色专用）
 * - GET /api/v1/admin/tenants：租户列表（分页/筛选）
 * 仅 admin 可访问；owner/employee 访问 → 403
 */
export function registerAdminRoutes(app: FastifyInstance, jwtSecret: string): void {
  const db = app.db

  app.get<{ Querystring: ListTenantsQuery }>('/api/v1/admin/tenants', {
    preHandler: [authenticate(jwtSecret), requireRole('admin')],
  }, async (request) => {
    const { status, industry } = request.query
    const page = Math.max(1, Number(request.query.page ?? 1) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20) || 20))

    const conditions: string[] = []
    const params: unknown[] = []
    if (status) { conditions.push('status = ?'); params.push(status) }
    if (industry) { conditions.push('industry = ?'); params.push(industry) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const total = (db.prepare(`SELECT COUNT(*) AS c FROM tenant ${where}`).get(...params) as { c: number }).c
    const tenants = db.prepare(`
      SELECT id, name, industry, sub_industry, status, plan, balance,
             trial_sessions_used, trial_session_limit, expires_at, created_at
      FROM tenant ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize)

    return { data: tenants, pagination: { page, pageSize, total } }
  })
}
