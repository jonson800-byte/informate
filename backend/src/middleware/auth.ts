import type { FastifyReply, FastifyRequest } from 'fastify'
import jwt from 'jsonwebtoken'
import { AppError, Errors } from '../utils/errors'

/** JWT payload：三角色 owner / employee / admin，租户上下文 tenantId */
export interface TokenPayload {
  /** 用户/管理员 ID */
  sub: string
  /** 角色：owner（主账号）/ employee（员工）/ admin（独立运营账号） */
  role: 'owner' | 'employee' | 'admin'
  /** 租户上下文：owner/employee 必带；admin 无租户（null） */
  tenantId: string | null
  /** 账号体系：user（租户侧）/ admin（运营侧） */
  type: 'user' | 'admin'
  iat?: number
  exp?: number
}

/** 签发 JWT */
export function signToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, secret: string, expiresIn: string): string {
  return jwt.sign(payload, secret, { expiresIn })
}

/**
 * 鉴权中间件（preHandler）：
 * - 未带 token / token 无效 → 401
 * - 校验通过 → 注入 req.userId / req.role / req.tenantId（租户上下文）
 */
export function authenticate(secret: string) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      throw Errors.unauthorized('未携带访问令牌（Authorization: Bearer <token>）')
    }
    const token = header.slice('Bearer '.length).trim()
    try {
      // H1 修复：固定 HS256 算法（防算法混淆攻击）
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as TokenPayload
      // M6 修复（Codex 批次 B）：停用账号 token 即时失效——按 sub+type 查状态
      if (payload.type === 'admin') {
        const row = (request.server as unknown as { db: { prepare(s: string): { get(...a: unknown[]): { status: string } | undefined } } }).db
          .prepare('SELECT status FROM admin WHERE id = ?').get(payload.sub)
        if (!row || row.status !== 'active') {
          throw Errors.unauthorized('账号已停用或不存在')
        }
      } else {
        const row = (request.server as unknown as { db: { prepare(s: string): { get(...a: unknown[]): { status: string } | undefined } } }).db
          .prepare('SELECT status FROM user WHERE id = ?').get(payload.sub)
        if (!row || row.status !== 'active') {
          throw Errors.unauthorized('账号已停用或不存在')
        }
      }
      request.userId = payload.sub
      request.role = payload.role
      request.tenantId = payload.tenantId ?? null
    } catch (err) {
      if (err instanceof AppError) throw err
      throw Errors.unauthorized('令牌无效或已过期')
    }
  }
}

/**
 * 角色守卫中间件（preHandler）：
 * - 当前角色不在允许列表 → 403（NFR-07 越权访问返回 403）
 * - 用法：requireRole('admin') / requireRole('owner', 'employee')
 */
export function requireRole(...roles: TokenPayload['role'][]) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.role || !roles.includes(request.role)) {
      throw Errors.forbidden(`需要 ${roles.join(' / ')} 权限`)
    }
  }
}
