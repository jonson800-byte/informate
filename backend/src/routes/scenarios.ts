import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth'
import { Errors } from '../utils/errors'
import { newId } from '../utils/id'
import { renderDisplayName } from '../utils/display'

/** 场景部署费：¥500/场景/一次性（决策记录 2026-08-06；1 元 = 10 积分 → 5000 积分） */
const DEPLOY_FEE_POINTS = 5000

interface DeployBody {
  scenario_id: string
  industry_bank?: string       // 行业知识叠加层 bank（Q28，可选覆盖）
}

/**
 * 场景路由（技术方案 §四 4.1）
 * - GET  /api/v1/scenarios：场景列表（从 scenario_deployment 按租户查，仅 active，FR-103）
 * - POST /api/v1/scenarios/deploy：开通部署（校验场景包 schema 存在性，pending→active，
 *                                   FR-107 部署费免收首单；display_name 按 {industry} 行业渲染）
 */
export function registerScenarioRoutes(app: FastifyInstance, jwtSecret: string): void {
  const db = app.db

  // ---------- 场景列表（owner/employee，仅 active，FR-103） ----------
  app.get('/api/v1/scenarios', {
    preHandler: [authenticate(jwtSecret), requireRole('owner', 'employee')],
  }, async (request) => {
    const tenantId = request.tenantId as string

    const deployments = db.prepare(`
      SELECT d.id, d.scenario_id, d.scenario_version, d.display_name, d.industry_bank,
             d.status, d.deployed_at,
             p.name AS package_name, p.emoji, p.pricing_unit, p.deduct_points
      FROM scenario_deployment d
      LEFT JOIN scenario_package p ON p.id = d.scenario_id
      WHERE d.tenant_id = ? AND d.status = 'active'
      ORDER BY d.deployed_at ASC
    `).all(tenantId)

    // 归一化响应：场景元数据 + 计费信息（pricing.unit 区分 session/image，G2）
    return {
      data: deployments.map((d) => ({
        id: d.id,
        scenario_id: d.scenario_id,
        scenario_version: d.scenario_version,
        display_name: d.display_name,
        industry_bank: d.industry_bank,
        status: d.status,
        deployed_at: d.deployed_at,
        meta: {
          name: d.package_name,
          emoji: d.emoji,
          pricing: { unit: d.pricing_unit, deduct_points: d.deduct_points },
        },
      })),
    }
  })

  // ---------- 开通部署（owner 专属；pending→active；首单免部署费 FR-107） ----------
  app.post<{ Body: DeployBody }>('/api/v1/scenarios/deploy', {
    preHandler: [authenticate(jwtSecret), requireRole('owner')],
    schema: {
      body: {
        type: 'object',
        required: ['scenario_id'],
        properties: {
          scenario_id: { type: 'string', minLength: 1 },
          industry_bank: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { scenario_id, industry_bank } = request.body
    const tenantId = request.tenantId as string
    const operator = request.userId as string

    // 1) 校验场景包 schema 存在性（seed 预置目录；不存在视为未上架）
    const pkg = db.prepare(`
      SELECT id, name, display_name_template, version, pricing_unit, deduct_points
      FROM scenario_package WHERE id = ?
    `).get(scenario_id) as Record<string, unknown> | undefined
    if (!pkg) throw Errors.notFound(`场景包不存在（${scenario_id} 未上架）`)

    // 2) 租户状态校验（trial/active 可开通；paused/expired 冻结，FR-106）
    const tenant = db.prepare('SELECT id, name, industry, status, balance FROM tenant WHERE id = ?').get(tenantId) as
      Record<string, unknown> | undefined
    if (!tenant) throw Errors.notFound('租户不存在')
    if (tenant.status !== 'trial' && tenant.status !== 'active') {
      throw Errors.forbidden('当前租户状态不可开通场景（冻结中）')
    }

    // 3) 重复部署校验（UNIQUE(tenant_id, scenario_id)）
    const existing = db.prepare('SELECT id FROM scenario_deployment WHERE tenant_id = ? AND scenario_id = ?')
      .get(tenantId, scenario_id)
    if (existing) throw Errors.conflict('该场景已开通，无需重复部署')

    // 4) 部署费判定：首单免收（FR-107 / D3 引流），非首单 ¥500 = 5000 积分
    const deployedCount = (db.prepare('SELECT COUNT(*) AS c FROM scenario_deployment WHERE tenant_id = ?')
      .get(tenantId) as { c: number }).c
    const firstDeploy = deployedCount === 0
    const fee = firstDeploy ? 0 : DEPLOY_FEE_POINTS

    // 5) display_name 行业渲染：{industry} → 租户一级行业（如 医美→"医美行业工作助手"）
    const displayName = renderDisplayName(String(pkg.display_name_template), String(tenant.industry))

    // 6) 事务：写入部署（pending→active）+ 部署费扣减（非首单）+ 审计
    const tx = db.transaction(() => {
      const deploymentId = newId('d')
      db.prepare(`INSERT INTO scenario_deployment (id, tenant_id, scenario_id, scenario_version, display_name, industry_bank, status)
                  VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
        .run(deploymentId, tenantId, scenario_id, String(pkg.version), displayName, industry_bank ?? null)

      db.prepare('INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(tenantId, operator, 'deploy_pending', 'scenario_deployment', deploymentId, `开通场景 ${scenario_id}（pending）`, request.ip)

      // 部署费：非首单从租户余额扣减并记积分流水（type=adjust，负向）
      if (fee > 0) {
        if (Number(tenant.balance) < fee) {
          throw Errors.badRequest(`余额不足：部署费需 ${fee} 积分（¥${fee / 10}），当前余额 ${tenant.balance}`)
        }
        const balanceAfter = Number(tenant.balance) - fee
        db.prepare('UPDATE tenant SET balance = balance - ? WHERE id = ?').run(fee, tenantId)
        db.prepare(`INSERT INTO credit_txn (id, tenant_id, user_id, type, amount, balance_after, scenario_id, ref_type, ref_id, operator, note)
                    VALUES (?, ?, ?, 'adjust', ?, ?, ?, 'scenario_deployment', ?, ?, ?)`)
          .run(newId('txn'), tenantId, operator, -fee, balanceAfter, scenario_id, deploymentId, operator,
               `场景部署费 ¥${fee / 10}（${scenario_id}）`)
      }

      // pending → active（开通即生效）
      db.prepare("UPDATE scenario_deployment SET status = 'active' WHERE id = ?").run(deploymentId)

      db.prepare('INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(tenantId, operator, 'deploy_active', 'scenario_deployment', deploymentId,
             firstDeploy ? '场景开通（首单免部署费）' : `场景开通（部署费 ¥${fee / 10}）`, request.ip)

      return deploymentId
    })
    const deploymentId = tx()

    return reply.status(201).send({
      deployment: {
        id: deploymentId,
        scenario_id,
        scenario_version: pkg.version,
        display_name: displayName,
        status: 'active',
        industry_bank: industry_bank ?? null,
        pricing: { unit: pkg.pricing_unit, deduct_points: pkg.deduct_points },
      },
      deploy_fee: { points: fee, waived: firstDeploy },
    })
  })
}
