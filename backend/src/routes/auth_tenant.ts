import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { signToken } from '../middleware/auth'
import { Errors } from '../utils/errors'
import { newId } from '../utils/id'

/** 注册请求体：企业信息（FR-101 开户字段子集）+ 主账号凭证 */
interface RegisterBody {
  name: string                 // 企业名称
  industry: string             // 一级行业
  sub_industry?: string        // 二级行业
  contact_name?: string
  contact_phone?: string
  enterprise_scale?: string
  business_type?: string
  target_market?: string
  owner_account: string        // 主账号登录名
  owner_password: string       // 主账号密码（bcrypt 存储，NFR-09）
  owner_name?: string
}

interface LoginBody {
  account: string
  password: string
}

/**
 * 租户侧认证路由（T4：自注册 + 登录）
 * - POST /api/v1/auth/register：注册 = 创建 trial 租户 + owner 主账号（FR-101/FR-106 trial 可正常使用）
 * - POST /api/v1/auth/login：登录（owner/employee 同 user 表，admin 独立 admin 表，G3 定稿双通道）
 */
export function registerAuthTenantRoutes(app: FastifyInstance, jwtSecret: string, jwtExpiresIn: string): void {
  const db = app.db

  // ---------- 注册（公开）：创建 trial 租户 + owner ----------
  app.post<{ Body: RegisterBody }>('/api/v1/auth/register', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'industry', 'owner_account', 'owner_password'],
        properties: {
          name: { type: 'string', minLength: 1 },
          industry: { type: 'string', minLength: 1 },
          sub_industry: { type: 'string' },
          contact_name: { type: 'string' },
          contact_phone: { type: 'string' },
          enterprise_scale: { type: 'string' },
          business_type: { type: 'string' },
          target_market: { type: 'string' },
          owner_account: { type: 'string', minLength: 1 },
          owner_password: { type: 'string', minLength: 6 },
          owner_name: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { name, industry, sub_industry, contact_name, contact_phone, enterprise_scale, business_type, target_market, owner_account, owner_password, owner_name } = request.body

    // 登录名唯一性（登录按 user.name 全局匹配，重名会导致歧义）
    const exists = db.prepare('SELECT id FROM user WHERE name = ?').get(owner_account)
    if (exists) throw Errors.conflict('该登录账号已被注册')

    // 事务：租户 + owner 账号 + 审计一次落库
    const tx = db.transaction(() => {
      const tenantId = newId('t')
      const ownerId = newId('u')

      db.prepare(`INSERT INTO tenant (id, name, industry, sub_industry, status, plan, balance, trial_sessions_used, trial_session_limit,
                                      contact_name, contact_phone, enterprise_scale, business_type, target_market)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(tenantId, name, industry, sub_industry ?? null, 'trial', null, 0, 0, 20,
             contact_name ?? null, contact_phone ?? null, enterprise_scale ?? null, business_type ?? null, target_market ?? null)

      db.prepare(`INSERT INTO user (id, tenant_id, role, name, credentials_hash, status, credit_limit, guide_seen)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ownerId, tenantId, 'owner', owner_account, bcrypt.hashSync(owner_password, 10), 'active', null, 0)

      db.prepare('INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(tenantId, ownerId, 'register', 'tenant', tenantId, `租户自助注册（trial，行业=${industry}）`, request.ip)

      return { tenantId, ownerId }
    })
    const { tenantId, ownerId } = tx()

    // 注册即登录：签发 JWT
    const token = signToken({ sub: ownerId, role: 'owner', tenantId, type: 'user' }, jwtSecret, jwtExpiresIn)

    return reply.status(201).send({
      token,
      user: { id: ownerId, role: 'owner', name: owner_account },
      tenant: { id: tenantId, name, industry, status: 'trial', balance: 0, trial_remaining: 20 },
    })
  })

  // ---------- 登录（公开）：owner/employee 同 user 表，admin 独立 admin 表 ----------
  app.post<{ Body: LoginBody }>('/api/v1/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['account', 'password'],
        properties: {
          account: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { account, password } = request.body

    // 1) 租户侧账号（owner / employee）：user 表 + tenant 状态
    const userRow = db.prepare(`
      SELECT u.id, u.tenant_id, u.role, u.name, u.credentials_hash, u.status AS user_status,
             t.name AS tenant_name, t.industry, t.status AS tenant_status, t.balance,
             t.trial_sessions_used, t.trial_session_limit
      FROM user u JOIN tenant t ON t.id = u.tenant_id
      WHERE u.name = ?
    `).get(account) as Record<string, unknown> | undefined

    if (userRow) {
      if (userRow.user_status !== 'active') throw Errors.forbidden('账号已被停用')
      if (!bcrypt.compareSync(password, String(userRow.credentials_hash))) {
        throw Errors.unauthorized('账号或密码错误')
      }
      const userId = String(userRow.id)
      const tenantId = String(userRow.tenant_id)
      const role = userRow.role as 'owner' | 'employee'

      const token = signToken({ sub: userId, role, tenantId, type: 'user' }, jwtSecret, jwtExpiresIn)

      // 审计：登录
      db.prepare('INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip) VALUES (?,?,?,?,?,?,?)')
        .run(tenantId, userId, 'login', 'user', userId, `账号登录（${role}）`, request.ip)

      return reply.send({
        token,
        user: { id: userId, role, name: userRow.name },
        tenant: {
          id: tenantId,
          name: userRow.tenant_name,
          industry: userRow.industry,
          status: userRow.tenant_status,
          balance: userRow.balance,
          trial_sessions_used: Number(userRow.trial_sessions_used),
          trial_remaining: Math.max(0, Number(userRow.trial_session_limit) - Number(userRow.trial_sessions_used)),
        },
      })
    }

    // 2) 运营侧账号（admin）：admin 表独立通道（G3 定稿）
    const adminRow = db.prepare(`
      SELECT id, username, credentials_hash, name, status
      FROM admin WHERE username = ?
    `).get(account) as Record<string, unknown> | undefined

    if (adminRow) {
      if (adminRow.status !== 'active') throw Errors.forbidden('账号已被停用')
      if (!bcrypt.compareSync(password, String(adminRow.credentials_hash))) {
        throw Errors.unauthorized('账号或密码错误')
      }
      const adminId = String(adminRow.id)
      const token = signToken({ sub: adminId, role: 'admin', tenantId: null, type: 'admin' }, jwtSecret, jwtExpiresIn)

      db.prepare('UPDATE admin SET last_login_at = datetime(\'now\') WHERE id = ?').run(adminId)
      db.prepare('INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip) VALUES (?,?,?,?,?,?,?)')
        .run(null, adminId, 'login', 'admin', adminId, '运营账号登录', request.ip)

      return reply.send({
        token,
        user: { id: adminId, role: 'admin', name: adminRow.name },
        tenant: null,
      })
    }

    throw Errors.unauthorized('账号或密码错误')
  })
}
