import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth'
import { Errors } from '../utils/errors'
import { createCreditService, DEFAULT_PRICES, PRICE_KEYS } from '../services/credit'

/**
 * 管理后台积分路由（T5，admin 角色专属）
 * - GET  /api/v1/admin/overview       积分看板：租户数 / 收入 / 消耗 / 在途冻结
 * - POST /api/v1/admin/adjust         手动调账（赠送/扣回，留审计，FR-703）
 * - GET  /api/v1/admin/export         积分流水导出（CSV）
 * - GET  /api/v1/admin/price-config   单价配置查询（最新生效版本）
 * - PUT  /api/v1/admin/price-config   单价配置修改（FR-704，写入 price_config 新版本）
 * 仅 admin 可访问；owner/employee → 403（NFR-07）
 */

/** 允许通过后台修改的单价 key（白名单） */
const CONFIGURABLE_KEYS = new Set([
  PRICE_KEYS.session,
  PRICE_KEYS.image,
  PRICE_KEYS.roundExtra,
  PRICE_KEYS.roundLimit,
  PRICE_KEYS.minFreeze,
  PRICE_KEYS.rechargeTier(100),
  PRICE_KEYS.rechargeTier(500),
  PRICE_KEYS.rechargeTier(2000),
])

export function registerAdminCreditRoutes(app: FastifyInstance, jwtSecret: string): void {
  const db = app.db
  const credit = createCreditService(db)
  const adminGuard = requireRole('admin')

  // ---------- 积分看板 ----------
  app.get('/api/v1/admin/overview', {
    preHandler: [authenticate(jwtSecret), adminGuard],
  }, async () => {
    const one = (sql: string, ...params: unknown[]) =>
      (db.prepare(sql).get(...params) as { v: number }).v

    const tenantCount = one('SELECT COUNT(*) AS v FROM tenant')
    const activeCount = one("SELECT COUNT(*) AS v FROM tenant WHERE status = 'active'")
    const pausedCount = one("SELECT COUNT(*) AS v FROM tenant WHERE status = 'paused'")
    const totalBalance = one('SELECT COALESCE(SUM(balance), 0) AS v FROM tenant')
    const totalRevenue = one("SELECT COALESCE(SUM(amount), 0) AS v FROM credit_txn WHERE type = 'recharge'")
    const totalConsumed = one("SELECT COALESCE(SUM(amount), 0) AS v FROM credit_txn WHERE type = 'settle'")
    // 在途冻结 = 冻结总额 - 已解冻 - 已结算（尚未终结的 hold）
    const frozenNet = one(
      `SELECT COALESCE(SUM(CASE WHEN type='freeze' THEN amount
                               WHEN type='unfreeze' THEN -amount
                               WHEN type='settle' THEN -amount
                               ELSE 0 END), 0) AS v FROM credit_txn`,
    )
    const adjustNet = one("SELECT COALESCE(SUM(amount), 0) AS v FROM credit_txn WHERE type = 'adjust'")
    const todayRevenue = one(
      `SELECT COALESCE(SUM(amount), 0) AS v FROM credit_txn
       WHERE type = 'recharge' AND date(created_at) = date('now')`,
    )
    const todayConsumed = one(
      `SELECT COALESCE(SUM(amount), 0) AS v FROM credit_txn
       WHERE type = 'settle' AND date(created_at) = date('now')`,
    )

    return {
      overview: {
        tenant_count: tenantCount,
        tenant_active: activeCount,
        tenant_paused: pausedCount,
        total_balance: totalBalance,
        total_revenue: totalRevenue,
        total_consumed: totalConsumed,
        frozen_outstanding: frozenNet,
        adjust_net: adjustNet,
        today_revenue: todayRevenue,
        today_consumed: todayConsumed,
        min_freeze: credit.getPrice(PRICE_KEYS.minFreeze, DEFAULT_PRICES.minFreeze),
      },
    }
  })

  // ---------- 手动调账（赠送/扣回） ----------
  app.post<{ Body: { tenant_id: string; amount: number; note?: string; idempotency_key?: string } }>(
    '/api/v1/admin/adjust',
    {
      preHandler: [authenticate(jwtSecret), adminGuard],
      schema: {
        body: {
          type: 'object',
          required: ['tenant_id', 'amount'],
          properties: {
            tenant_id: { type: 'string', minLength: 1 },
            amount: { type: 'integer' },
            note: { type: 'string', maxLength: 200 },
            idempotency_key: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenant_id: tenantId, amount, note, idempotency_key: idempotencyKey } = request.body
      const operator = request.userId as string

      const tenant = db.prepare('SELECT id, name FROM tenant WHERE id = ?').get(tenantId) as
        | { id: string; name: string }
        | undefined
      if (!tenant) throw Errors.notFound('租户不存在')

      const r = credit.adjust({ tenantId, operator, amount, note, idempotencyKey })

      // 审计：调账必须留痕（FR-703）
      db.prepare(`INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(tenantId, operator, 'credit.adjust', 'tenant', tenantId,
          `管理员调账 ${amount > 0 ? '+' : ''}${amount} 积分（${note ?? '无备注'}），余额 ${r.balance}`, request.ip)

      return reply.send({
        tenant_id: tenantId,
        amount: r.txn.amount,
        balance: r.balance,
        replayed: r.replayed,
        message: r.replayed ? '重复请求已幂等处理' : `调账成功，${tenant.name} 当前余额 ${r.balance} 积分`,
      })
    },
  )

  // ---------- 流水导出（CSV） ----------
  app.get<{ Querystring: { tenant_id?: string; type?: string } }>('/api/v1/admin/export', {
    preHandler: [authenticate(jwtSecret), adminGuard],
  }, async (request, reply) => {
    const { tenant_id: tenantId, type } = request.query
    const where: string[] = []
    const params: unknown[] = []
    if (tenantId) { where.push('tenant_id = ?'); params.push(tenantId) }
    if (type) { where.push('type = ?'); params.push(type) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const rows = db.prepare(
      `SELECT t.id, t.tenant_id, ten.name AS tenant_name, t.type, t.amount, t.balance_after,
              t.scenario_id, t.ref_type, t.ref_id, t.round_no, t.operator, t.note, t.created_at
       FROM credit_txn t LEFT JOIN tenant ten ON ten.id = t.tenant_id
       ${whereSql}
       ORDER BY t.created_at DESC, t.id DESC`,
    ).all(...params) as Record<string, unknown>[]

    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = ['流水ID', '租户ID', '租户名称', '类型', '积分', '余额', '场景ID', '引用类型', '引用ID', '轮次', '操作人', '备注', '时间']
    const lines = [header.join(','), ...rows.map((r) => [
      r.id, r.tenant_id, r.tenant_name, r.type, r.amount, r.balance_after,
      r.scenario_id, r.ref_type, r.ref_id, r.round_no, r.operator, r.note, r.created_at,
    ].map(esc).join(','))]
    // BOM：保证 Excel 打开中文不乱码
    const csv = '\uFEFF' + lines.join('\n')

    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="credit_txns_${new Date().toISOString().slice(0, 10)}.csv"`)
    return reply.send(csv)
  })

  // ---------- 单价配置查询（最新生效版本） ----------
  app.get('/api/v1/admin/price-config', {
    preHandler: [authenticate(jwtSecret), adminGuard],
  }, async () => {
    // 取每个 key 最新生效版本（与 workspace 展示口径一致）
    const rows = db.prepare(
      `SELECT pc.* FROM price_config pc
       JOIN (SELECT key, MAX(effective_at) AS max_ea FROM price_config WHERE effective_at <= datetime('now') GROUP BY key) m
         ON m.key = pc.key AND m.max_ea = pc.effective_at
       ORDER BY pc.key`,
    ).all() as { key: string; value: string; effective_at: string; operator: string; note: string | null }[]

    // 合并默认常量，未配置的也展示出来（便于后台知道可配项）
    const defaults: [string, number][] = [
      [PRICE_KEYS.session, DEFAULT_PRICES.session],
      [PRICE_KEYS.image, DEFAULT_PRICES.image],
      [PRICE_KEYS.roundExtra, DEFAULT_PRICES.roundExtra],
      [PRICE_KEYS.roundLimit, DEFAULT_PRICES.roundLimit],
      [PRICE_KEYS.minFreeze, DEFAULT_PRICES.minFreeze],
      [PRICE_KEYS.rechargeTier(100), DEFAULT_PRICES.recharge[100]],
      [PRICE_KEYS.rechargeTier(500), DEFAULT_PRICES.recharge[500]],
      [PRICE_KEYS.rechargeTier(2000), DEFAULT_PRICES.recharge[2000]],
    ]
    const configured = new Map(rows.map((r) => [r.key, r]))
    const data = defaults.map(([key, fallback]) => {
      const row = configured.get(key)
      return {
        key,
        value: row ? row.value : String(fallback),
        source: row ? 'price_config' : 'default',
        effective_at: row?.effective_at ?? null,
        operator: row?.operator ?? null,
        note: row?.note ?? null,
      }
    })
    // 补充库中已配置但不在默认清单里的 key
    for (const r of rows) {
      if (!defaults.some(([k]) => k === r.key)) {
        data.push({ key: r.key, value: r.value, source: 'price_config', effective_at: r.effective_at, operator: r.operator, note: r.note })
      }
    }
    return { data }
  })

  // ---------- 单价配置修改（写入新版本，不覆盖历史） ----------
  app.put<{ Body: { key: string; value: string | number; note?: string } }>('/api/v1/admin/price-config', {
    preHandler: [authenticate(jwtSecret), adminGuard],
    schema: {
      body: {
        type: 'object',
        required: ['key', 'value'],
        properties: {
          key: { type: 'string', minLength: 1 },
          value: { type: 'string' },
          note: { type: 'string', maxLength: 200 },
        },
      },
    },
  }, async (request, reply) => {
    const { key, value, note } = request.body
    if (!CONFIGURABLE_KEYS.has(key)) {
      throw Errors.badRequest(`该 key 不在可配置白名单内：${key}`)
    }
    const num = Number(value)
    if (!Number.isInteger(num) || num <= 0) {
      throw Errors.badRequest('单价必须为正整数（积分）')
    }
    const operator = request.userId as string
    // effective_at 用 SQLite 兼容格式（datetime('now') 为 'YYYY-MM-DD HH:MM:SS'）：
    // 若写 ISO 毫秒格式（T 分隔），与 SQLite 字符串比较永远失败（'T' > ' '），新价查不到
    const effectiveAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
    try {
      db.prepare(
        `INSERT INTO price_config (id, key, value, effective_at, operator, note) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(crypto.randomUUID(), key, String(num), effectiveAt, operator, note ?? null)
    } catch (e) {
      // M7 修复（Codex 批次 B）：同秒同 key 撞 UNIQUE(key, effective_at) → 409 而非 500
      if (String((e as Error).message).includes('UNIQUE')) {
        throw Errors.conflict(`单价 ${key} 在同一秒内已被更新，请稍后重试`)
      }
      throw e
    }

    // 审计：单价变更留痕（FR-704）
    db.prepare(`INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip)
                VALUES (?,?,?,?,?,?,?)`)
      .run(null, operator, 'price_config.update', 'price_config', key, `单价 ${key} 调整为 ${num}`, request.ip)

    return reply.send({
      key,
      value: String(num),
      effective_at: effectiveAt,
      message: `单价 ${key} 已更新为 ${num} 积分（新版本即刻生效）`,
    })
  })
}
