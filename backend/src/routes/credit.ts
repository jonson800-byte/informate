import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { authenticate, requireRole } from '../middleware/auth'
import { AppError, Errors } from '../utils/errors'
import { createCreditService, DEFAULT_PRICES, PRICE_KEYS, type TxnRow } from '../services/credit'

/**
 * 积分管线租户侧路由（T5）
 * - POST   /api/v1/credit/recharge            充值（阶梯 100=1100 / 500=6000 / 2000=25000，AC-601；owner）
 * - GET    /api/v1/credit/balance             余额查询
 * - GET    /api/v1/credit/txns                积分流水（分页/类型筛选）
 * - POST   /api/v1/credit/conversations       创建会话并冻结 10（unit=session）
 * - POST   /api/v1/credit/conversations/:id/rounds  轮次结算（超轮续扣 1/轮；第 51 轮 429 拦截）
 * - POST   /api/v1/credit/image-tasks         生图任务冻结 15（unit=image，不冻会话费）
 * - POST   /api/v1/credit/tasks/:id/fail      任务失败原子退分
 *
 * 计费口径（PRD §4.2/§4.3）：冻结先扣余额（hold），结算不改余额（冻结时已扣），失败/超时原子解冻。
 */
export function registerCreditRoutes(app: FastifyInstance, jwtSecret: string): void {
  const db = app.db
  const credit = createCreditService(db)

  const tenantGuard = requireRole('owner', 'employee')

  // ---------- 充值（主账号，owner） ----------
  app.post<{ Body: { tier: number; idempotency_key?: string } }>('/api/v1/credit/recharge', {
    preHandler: [authenticate(jwtSecret), requireRole('owner')],
    schema: {
      body: {
        type: 'object',
        required: ['tier'],
        properties: {
          tier: { type: 'integer', enum: [100, 500, 2000] },
          idempotency_key: { type: 'string', maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.tenantId as string
    const { tier, idempotency_key: idempotencyKey } = request.body
    const r = credit.recharge({
      tenantId,
      userId: request.userId as string,
      tier,
      idempotencyKey,
    })
    // 审计：充值记录（FR-703 充值记录留痕）
    db.prepare(`INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip)
                VALUES (?,?,?,?,?,?,?)`)
      .run(tenantId, request.userId, 'recharge', 'tenant', tenantId, `充值 ${tier} 元，到账 ${r.txn.amount} 积分`, request.ip)
    return reply.send({
      txn: r.txn,
      balance: r.balance,
      replayed: r.replayed,
      message: r.replayed ? '重复请求已幂等处理，未重复到账' : `充值成功，到账 ${r.txn.amount} 积分`,
    })
  })

  // ---------- 余额 ----------
  app.get('/api/v1/credit/balance', {
    preHandler: [authenticate(jwtSecret), tenantGuard],
  }, async (request) => {
    const tenantId = request.tenantId as string
    const tenant = db.prepare('SELECT balance, status FROM tenant WHERE id = ?').get(tenantId) as
      | { balance: number; status: string }
      | undefined
    if (!tenant) throw Errors.notFound('租户不存在')
    return {
      balance: tenant.balance,
      status: tenant.status,
      min_freeze: credit.getPrice(PRICE_KEYS.minFreeze, DEFAULT_PRICES.minFreeze),
    }
  })

  // ---------- 积分流水 ----------
  app.get<{ Querystring: { page?: string; pageSize?: string; type?: string } }>('/api/v1/credit/txns', {
    preHandler: [authenticate(jwtSecret), tenantGuard],
  }, async (request) => {
    const tenantId = request.tenantId as string
    const page = Math.max(1, Number(request.query.page ?? 1) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20) || 20))
    return credit.listTxns(tenantId, { page, pageSize, type: request.query.type })
  })

  // ---------- 创建会话 + 冻结 10（unit=session） ----------
  app.post<{ Body: { scenario_id?: string; conversation_id?: string; idempotency_key?: string } }>(
    '/api/v1/credit/conversations',
    {
      preHandler: [authenticate(jwtSecret), tenantGuard],
      schema: {
        body: {
          type: 'object',
          properties: {
            scenario_id: { type: 'string', maxLength: 64 },
            conversation_id: { type: 'string', maxLength: 64 },
            idempotency_key: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenantId as string
      const userId = request.userId as string
      const { scenario_id: scenarioId, conversation_id: conversationId, idempotency_key: idempotencyKey } = request.body ?? {}

      // 创建会话 + 冻结在同一事务内（better-sqlite3 嵌套事务走 savepoint，保证原子性）
      const r = db.transaction(() => {
        // 幂等：conversation_id 已存在 → 直接返回既有会话（不重复冻结）
        if (conversationId) {
          const existing = db.prepare('SELECT * FROM conversation WHERE id = ?').get(conversationId) as
            | (Record<string, unknown> & { tenant_id: string })
            | undefined
          if (existing) {
            if (existing.tenant_id !== tenantId) throw Errors.forbidden('无权操作该会话')
            return { conv: existing, freezeTxn: null, replayed: true }
          }
        }
        const convId = conversationId ?? randomUUID()
        const tenant = db.prepare('SELECT status, trial_sessions_used, trial_session_limit FROM tenant WHERE id = ?').get(tenantId) as
          | { status: string; trial_sessions_used: number; trial_session_limit: number }
          | undefined
        if (!tenant) throw Errors.notFound('租户不存在')
        // M1 修复（Codex 批次 B / G2）：按场景包 pricing_unit 判定是否冻结会话费（unit=image 不冻结）
        const pkg = db.prepare('SELECT pricing_unit FROM scenario_package WHERE id = ?').get(scenarioId ?? '') as
          | { pricing_unit: string }
          | undefined
        const price = credit.getPrice(PRICE_KEYS.session, DEFAULT_PRICES.session)
        const freezeAmount = pkg && pkg.pricing_unit === 'image' ? 0 : price
        // M2 修复（Codex 批次 B / FR-208）：trial 走 20 次试用额度（不扣积分），active 查余额
        if (tenant.status === 'trial') {
          if (tenant.trial_sessions_used >= tenant.trial_session_limit) {
            throw new AppError(402, 'TRIAL_LIMIT_EXCEEDED', `试用次数已用完（${tenant.trial_session_limit} 次），请充值转正式`)
          }
          db.prepare('UPDATE tenant SET trial_sessions_used = trial_sessions_used + 1 WHERE id = ?').run(tenantId)
          db.prepare(
            `INSERT INTO conversation (id, tenant_id, user_id, scenario_id, status, turns, billing_state, frozen_credit, settled_credit)
             VALUES (?, ?, ?, ?, 'active', 0, 'trial', 0, 0)`,
          ).run(convId, tenantId, userId, scenarioId ?? 'industry-worker')
          return { conv: db.prepare('SELECT * FROM conversation WHERE id = ?').get(convId), freezeTxn: null, replayed: false, trial: true }
        }
        db.prepare(
          `INSERT INTO conversation (id, tenant_id, user_id, scenario_id, status, turns, billing_state, frozen_credit, settled_credit)
           VALUES (?, ?, ?, ?, 'active', 0, 'frozen', ?, 0)`,
        ).run(convId, tenantId, userId, scenarioId ?? 'industry-worker', freezeAmount)
        const f = freezeAmount > 0
          ? credit.createFreeze({
              tenantId,
              userId,
              refType: 'conversation',
              refId: convId,
              amount: freezeAmount,
              scenarioId,
              idempotencyKey: idempotencyKey ?? `conv:${convId}`,
              note: `会话创建冻结 ${freezeAmount} 积分（含 20 轮）`,
            })
          : null
        return { conv: db.prepare('SELECT * FROM conversation WHERE id = ?').get(convId), freezeTxn: f?.txn ?? null, replayed: f?.replayed ?? false }
      })()

      return reply.send({
        conversation: r.conv,
        freeze: r.freezeTxn?.amount ?? 0,
        balance: credit.getBalance(tenantId),
        replayed: r.replayed,
      })
    },
  )

  // ---------- 轮次结算（超轮续扣；第 51 轮拦截） ----------
  app.post<{ Params: { id: string }; Body: { round_no?: number } }>(
    '/api/v1/credit/conversations/:id/rounds',
    {
      preHandler: [authenticate(jwtSecret), tenantGuard],
      schema: {
        body: {
          type: 'object',
          properties: { round_no: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenantId as string
      const userId = request.userId as string
      const convId = request.params.id

      const conv = db.prepare('SELECT * FROM conversation WHERE id = ?').get(convId) as
        | (Record<string, unknown> & {
            tenant_id: string; status: string; turns: number; billing_state: string; scenario_id: string | null
          })
        | undefined
      if (!conv) throw Errors.notFound('会话不存在')
      if (conv.tenant_id !== tenantId) throw Errors.forbidden('无权操作该会话')
      if (conv.billing_state === 'settled') throw Errors.conflict('会话已结算，不可追加轮次')
      if (conv.status !== 'active') throw Errors.conflict('会话已结束，不可继续计费')

      const roundLimit = credit.getPrice(PRICE_KEYS.roundLimit, DEFAULT_PRICES.roundLimit)
      const next = request.body?.round_no ?? conv.turns + 1
      if (next > conv.turns + 1) throw Errors.badRequest(`轮次号不连续：当前 ${conv.turns} 轮，收到 ${next} 轮`)
      if (next <= conv.turns) {
        // 重放：该轮已计费 → 幂等返回
        return reply.send({
          round_no: next,
          charge: 0,
          replayed: true,
          balance: credit.getBalance(tenantId),
          message: '该轮次已计费，幂等返回',
        })
      }
      // 第 51 轮拦截（单会话 50 轮上限，PRD §4.2：提示新开对话，防套利）
      if (conv.turns >= roundLimit) {
        return reply.status(429).send({
          code: 'ROUND_LIMIT_EXCEEDED',
          message: `已达单会话 ${roundLimit} 轮上限，第 ${roundLimit + 1} 轮被拦截。建议新开对话（新开会话重新计费，可防套利）`,
          details: { conversation_id: convId, turns: conv.turns, round_limit: roundLimit },
        })
      }

      const base = credit.getPrice(PRICE_KEYS.session, DEFAULT_PRICES.session)
      const roundExtra = credit.getPrice(PRICE_KEYS.roundExtra, DEFAULT_PRICES.roundExtra)
      // 含 20 轮（INCLUDED_ROUNDS=20）：第 21 轮起：增量冻结 1 → 回复完成结算 1（PRD §4.3 状态机）
      const INCLUDED_ROUNDS = 20
      const charge = next > INCLUDED_ROUNDS ? roundExtra : 0

      const r = db.transaction(() => {
        if (charge > 0) {
          // 增量冻结（余额扣减 + 冻结流水）
          const f = credit.createFreeze({
            tenantId, userId, refType: 'conversation', refId: convId, amount: charge,
            scenarioId: conv.scenario_id, roundNo: next, idempotencyKey: `round:${convId}:${next}:freeze`,
            note: `第 ${next} 轮增量冻结 ${charge} 积分`,
          })
          if (f.replayed) {
            // 该轮已冻结过（并发/重放）→ 轮次号已计费
            const settled = db.prepare(
              `SELECT 1 FROM credit_txn WHERE ref_type='conversation' AND ref_id=? AND type='settle' AND round_no=? LIMIT 1`,
            ).get(convId, next)
            if (settled) {
              db.prepare('UPDATE conversation SET turns = ? WHERE id = ?').run(next, convId)
              return { charge, balance: f.balance, replayed: true }
            }
          }
          // 结算（余额不变，冻结时已扣）
          credit.settle({
            tenantId, userId, refType: 'conversation', refId: convId, amount: charge,
            scenarioId: conv.scenario_id, roundNo: next, idempotencyKey: `round:${convId}:${next}`,
            note: `第 ${next} 轮结算 ${charge} 积分`,
          })
        }
        db.prepare('UPDATE conversation SET turns = ?, settled_credit = settled_credit + ? WHERE id = ?')
          .run(next, charge, convId)
        return { charge, balance: credit.getBalance(tenantId), replayed: false }
      })()

      return reply.send({
        round_no: next,
        charge: r.charge,
        replayed: r.replayed,
        balance: r.balance,
        message: charge > 0 ? `已扣除 ${charge} 积分（超轮续扣）` : `第 ${next} 轮计入会话基础包（含 20 轮）`,
      })
    },
  )

  // ---------- 生图任务冻结 15（unit=image，不冻会话费） ----------
  app.post<{ Body: { task_id?: string; scenario_id?: string; idempotency_key?: string } }>(
    '/api/v1/credit/image-tasks',
    {
      preHandler: [authenticate(jwtSecret), tenantGuard],
      schema: {
        body: {
          type: 'object',
          required: ['task_id'],
          properties: {
            task_id: { type: 'string', maxLength: 64 },
            scenario_id: { type: 'string', maxLength: 64 },
            idempotency_key: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenantId as string
      const userId = request.userId as string
      const { task_id: taskIdRaw, scenario_id: scenarioId, idempotency_key: idempotencyKey } = request.body
      const taskId = taskIdRaw as string
      const price = credit.getPrice(PRICE_KEYS.image, DEFAULT_PRICES.image)

      // 创建 artifact + 冻结在同一事务（原子）
      const r = db.transaction(() => {
        const existing = db.prepare('SELECT * FROM artifact WHERE id = ?').get(taskId) as
          | (Record<string, unknown> & { tenant_id: string })
          | undefined
        if (existing) {
          if (existing.tenant_id !== tenantId) throw Errors.forbidden('无权操作该任务')
          const freeze = db.prepare(
            `SELECT * FROM credit_txn WHERE ref_type='image' AND ref_id=? AND type='freeze' ORDER BY created_at DESC LIMIT 1`,
          ).get(taskId) as TxnRow | undefined
          return { freeze, replayed: true }
        }
        db.prepare(
          `INSERT INTO artifact (id, tenant_id, scenario_id, type, status, ai_label) VALUES (?, ?, ?, 'image', 'pending', 1)`,
        ).run(taskId, tenantId, scenarioId ?? 'industry-worker')
        const f = credit.createFreeze({
          tenantId, userId, refType: 'image', refId: taskId, amount: price,
          scenarioId: scenarioId ?? null,
          idempotencyKey: idempotencyKey ?? `img:${taskId}`,
          note: `生图任务冻结 ${price} 积分`,
        })
        return { freeze: f.txn, replayed: f.replayed }
      })()

      return reply.send({
        task_id: taskId,
        freeze: r.freeze?.amount ?? 0,
        status: 'pending',
        balance: credit.getBalance(tenantId),
        replayed: r.replayed,
        message: r.replayed ? '任务已冻结，幂等返回' : `已冻结 ${r.freeze?.amount ?? 0} 积分`,
      })
    },
  )

  // ---------- 任务失败退分（原子解冻） ----------
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/v1/credit/tasks/:id/fail', {
    preHandler: [authenticate(jwtSecret), tenantGuard],
    schema: {
      body: {
        type: 'object',
        properties: { reason: { type: 'string', maxLength: 200 } },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.tenantId as string
    const taskId = request.params.id
    const reason = request.body?.reason

    const artifact = db.prepare('SELECT * FROM artifact WHERE id = ?').get(taskId) as
      | (Record<string, unknown> & { tenant_id: string })
      | undefined
    if (!artifact) throw Errors.notFound('任务不存在')
    if (artifact.tenant_id !== tenantId) throw Errors.forbidden('无权操作该任务')

    const r = db.transaction(() => {
      db.prepare(`UPDATE artifact SET status = 'failed', fail_reason = ?, completed_at = datetime('now') WHERE id = ?`)
        .run(reason ?? null, taskId)
      return credit.release({
        tenantId, userId: request.userId, refType: 'image', refId: taskId,
        note: reason ? `任务失败退分（${reason}）` : '任务失败退分',
      })
    })()

    return reply.send({
      task_id: taskId,
      refunded: r.refunded,
      replayed: r.replayed,
      balance: r.balance,
      message: r.replayed ? '该任务已退分，幂等返回' : `失败退分 ${r.refunded} 积分已原路退回`,
    })
  })
}
