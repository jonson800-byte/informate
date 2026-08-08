import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth'
import { Errors } from '../utils/errors'

/**
 * 认证路由（当前用户信息）
 * - GET /api/v1/auth/me：当前用户 + 租户状态（全部角色）
 * 说明：登录（POST /auth/login）与注册（POST /auth/register）已迁移至 auth_tenant.ts（T4）
 */
export function registerAuthRoutes(app: FastifyInstance, jwtSecret: string): void {
  const db = app.db

  // ---------- 当前用户信息（受保护：全部角色） ----------
  app.get('/api/v1/auth/me', { preHandler: [authenticate(jwtSecret)] }, async (request) => {
    const { userId, role } = request

    if (role === 'admin') {
      const admin = db.prepare('SELECT id, username, name, status FROM admin WHERE id = ?').get(userId)
      if (!admin) throw Errors.unauthorized('账号不存在')
      return { user: admin, tenant: null }
    }

    const row = db.prepare(`
      SELECT u.id, u.tenant_id, u.role, u.name, u.status AS user_status,
             t.name AS tenant_name, t.industry, t.status AS tenant_status, t.balance,
             t.trial_sessions_used, t.trial_session_limit
      FROM user u JOIN tenant t ON t.id = u.tenant_id
      WHERE u.id = ?
    `).get(userId)
    if (!row) throw Errors.unauthorized('账号不存在')

    return {
      user: { id: row.id, tenant_id: row.tenant_id, role: row.role, name: row.name, status: row.user_status },
      tenant: {
        id: row.tenant_id,
        name: row.tenant_name,
        industry: row.industry,
        status: row.tenant_status,
        balance: row.balance,
        trial_sessions_used: Number(row.trial_sessions_used),
        trial_remaining: Math.max(0, Number(row.trial_session_limit) - Number(row.trial_sessions_used)),
      },
    }
  })
}
