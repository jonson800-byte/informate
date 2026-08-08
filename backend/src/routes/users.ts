import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { authenticate, requireRole } from '../middleware/auth'
import { Errors } from '../utils/errors'
import { newId } from '../utils/id'

/** 创建员工请求体 */
interface CreateUserBody {
  name: string                       // 员工登录名
  password: string
  credit_limit?: number | null       // FR-105：员工限额
  credit_period?: string             // 限额周期（默认 day）
}

/** 更新员工请求体（停用/启用 + 调整限额，FR-105/706） */
interface PatchUserBody {
  status?: 'active' | 'disabled'
  credit_limit?: number | null
}

interface UserParams {
  id: string
}

/**
 * 员工管理路由（FR-105：主账号可在工作台创建/停用员工子账号；owner 专属）
 * - GET   /api/v1/users：员工列表
 * - POST  /api/v1/users：创建员工子账号
 * - PATCH /api/v1/users/:id：停用/启用 + 调整限额
 * 仅 owner 可访问；employee 访问 → 403（NFR-07 越权）
 */
export function registerUserRoutes(app: FastifyInstance, jwtSecret: string): void {
  const db = app.db

  // ---------- 员工列表（owner 专属） ----------
  app.get('/api/v1/users', {
    preHandler: [authenticate(jwtSecret), requireRole('owner')],
  }, async (request) => {
    const tenantId = request.tenantId as string

    const users = db.prepare(`
      SELECT id, name, role, status, credit_limit, credit_period, guide_seen, created_at
      FROM user
      WHERE tenant_id = ? AND role = 'employee'
      ORDER BY created_at ASC
    `).all(tenantId)

    return { data: users }
  })

  // ---------- 创建员工（owner 专属） ----------
  app.post<{ Body: CreateUserBody }>('/api/v1/users', {
    preHandler: [authenticate(jwtSecret), requireRole('owner')],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'password'],
        properties: {
          name: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 6 },
          credit_limit: { type: ['integer', 'null'], minimum: 0 },
          credit_period: { type: 'string', enum: ['day', 'week', 'month', 'total'] },
        },
      },
    },
  }, async (request, reply) => {
    const { name, password, credit_limit, credit_period } = request.body
    const tenantId = request.tenantId as string

    // 登录名唯一（登录按 user.name 全局匹配）
    const exists = db.prepare('SELECT id FROM user WHERE name = ?').get(name)
    if (exists) throw Errors.conflict('该登录账号已被注册')

    const userId = newId('u')
    db.prepare(`INSERT INTO user (id, tenant_id, role, name, credentials_hash, status, credit_limit, credit_period)
                VALUES (?, ?, 'employee', ?, ?, 'active', ?, ?)`)
      .run(userId, tenantId, name, bcrypt.hashSync(password, 10), credit_limit ?? null, credit_period ?? 'day')

    // 审计：创建员工
    db.prepare('INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tenantId, request.userId, 'create_user', 'user', userId, `创建员工子账号 ${name}`, request.ip)

    return reply.status(201).send({
      user: {
        id: userId,
        name,
        role: 'employee',
        status: 'active',
        credit_limit: credit_limit ?? null,
        credit_period: credit_period ?? 'day',
      },
    })
  })

  // ---------- 停用/启用 + 调整限额（owner 专属） ----------
  app.patch<{ Params: UserParams; Body: PatchUserBody }>('/api/v1/users/:id', {
    preHandler: [authenticate(jwtSecret), requireRole('owner')],
    schema: {
      body: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'disabled'] },
          credit_limit: { type: ['integer', 'null'], minimum: 0 },
        },
        minProperties: 1,
      },
    },
  }, async (request) => {
    const { id } = request.params
    const tenantId = request.tenantId as string

    // 仅可操作本租户员工（owner 自身不可停用）
    const target = db.prepare(`
      SELECT id, name, role, status, credit_limit, credit_period
      FROM user WHERE id = ? AND tenant_id = ? AND role = 'employee'
    `).get(id, tenantId) as Record<string, unknown> | undefined
    if (!target) throw Errors.notFound('员工不存在')

    const { status, credit_limit } = request.body
    const sets: string[] = []
    const params: unknown[] = []
    if (status !== undefined) { sets.push('status = ?'); params.push(status) }
    if (credit_limit !== undefined) { sets.push('credit_limit = ?'); params.push(credit_limit) }
    if (sets.length === 0) throw Errors.badRequest('无可更新字段')

    db.prepare(`UPDATE user SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)

    // 审计：更新员工
    db.prepare('INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tenantId, request.userId, 'update_user', 'user', id,
           `更新员工 ${target.name}: ${sets.join(', ')}`, request.ip)

    return {
      user: {
        id,
        name: target.name,
        role: 'employee',
        status: status ?? target.status,
        credit_limit: credit_limit !== undefined ? credit_limit : target.credit_limit,
        credit_period: target.credit_period,
      },
    }
  })
}
