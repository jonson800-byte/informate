import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth'

/**
 * 工作台路由（技术方案 §四 4.1）
 * - GET /api/v1/workspace：场景列表 + 余额 + 试用剩余 + 价格显示（全部租户侧角色）
 * 租户数据按 req.tenantId 过滤（NFR-07 越权校验）
 */
export function registerWorkspaceRoutes(app: FastifyInstance, jwtSecret: string): void {
  const db = app.db

  app.get('/api/v1/workspace', {
    preHandler: [authenticate(jwtSecret), requireRole('owner', 'employee')],
  }, async (request) => {
    const tenantId = request.tenantId as string

    // 场景部署列表（仅 active，FR-103：未部署/暂停场景不出现）
    const deployments = db.prepare(`
      SELECT id, scenario_id, scenario_version, display_name, industry_bank, status, deployed_at
      FROM scenario_deployment
      WHERE tenant_id = ? AND status = 'active'
      ORDER BY deployed_at ASC
    `).all(tenantId)

    // 租户余额 / 试用剩余
    const tenant = db.prepare(`
      SELECT name, industry, status, balance, trial_sessions_used, trial_session_limit
      FROM tenant WHERE id = ?
    `).get(tenantId) as Record<string, unknown> | undefined

    // 价格显示（后台可配变量，FR-704）
    const prices = db.prepare(`
      SELECT key, value FROM price_config
      WHERE effective_at <= datetime('now')
      ORDER BY effective_at DESC
    `).all() as { key: string; value: string }[]
    const priceMap: Record<string, string> = {}
    for (const p of prices) {
      if (!(p.key in priceMap)) priceMap[p.key] = p.value // 取每个 key 最新生效版本
    }

    return {
      workspace: {
        tenant: {
          name: tenant?.name,
          industry: tenant?.industry,
          status: tenant?.status,
          balance: tenant?.balance ?? 0,
          trial_remaining: tenant
            ? Math.max(0, Number(tenant.trial_session_limit) - Number(tenant.trial_sessions_used))
            : 0,
        },
        scenarios: deployments,
        prices: priceMap,
      },
    }
  })
}
