import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { AppError, Errors } from '../utils/errors'

/**
 * 积分服务（T5 核心）
 *
 * 计费模型（PRD §4.2/§4.3 + Codex G1 兜底修复）：
 * - 会话：创建即冻结 10（unit=session，含 20 轮）；第 21 轮起每轮增量冻结+结算 1 积分；
 *   单会话 50 轮上限，第 51 轮拦截（429）；会话结束按实际轮数结算，未使用会话全额解冻。
 * - 生图：提交任务冻结 15（unit=image，与会话费相互独立，不冻会话费）；
 *   成功结算（webhook 幂等），失败/超时原子解冻。
 * - 欠费：余额 < 最低冻结额（默认 10）→ 租户转 paused；充值后即时恢复 active。
 * - 幂等：credit_txn.idempotency_key UNIQUE + 按 (ref_type, ref_id) 查重，重放不重复记账。
 * - 兜底：定时扫描任务级冻结按 ref 状态判定——活跃会话跳过（不按时长解冻），
 *   生图任务超时（默认 30 分钟）原子解冻，成功任务补结算，失败任务补退分。
 *
 * 所有写操作在 better-sqlite3 事务内原子执行（同步单连接天然串行，busy_timeout 兜底并发）。
 */

/** 冻结引用类型：会话 / 生图任务 */
export type RefType = 'conversation' | 'image'

/** credit_txn 行的只读形态 */
export interface TxnRow {
  id: string
  tenant_id: string
  user_id: string | null
  type: string
  amount: number
  balance_after: number | null
  scenario_id: string | null
  ref_type: string | null
  ref_id: string | null
  round_no: number | null
  idempotency_key: string | null
  operator: string | null
  note: string | null
  created_at: string
}

/** 默认价格常量（FR-704：管理后台 price_config 可覆盖，未配置时回落常量） */
export const DEFAULT_PRICES = {
  session: 15,        // 会话基础冻结额（含 20 轮，2026-08-17 DeepSeek 涨价后定稿）
  roundExtra: 1,      // 超轮单价（第 21 轮起 1 积分/轮）
  roundLimit: 50,     // 单会话轮次上限（第 51 轮拦截）
  image: 15,          // 生图冻结/执行价（对外展示 20，实际执行 15，M-13 口径）
  minFreeze: 15,      // 最低冻结额（欠费冻结判定阈值 = 场景最小价，FR-605）
  recharge: { 100: 1100, 500: 6000, 2000: 25000 } as Record<number, number>, // AC-601 阶梯
}

/** 价格配置 key（与 workspace 展示口径一致） */
export const PRICE_KEYS = {
  session: 'credit.work_assistant.session',
  image: 'credit.image_task',
  roundExtra: 'credit.round_extra',
  roundLimit: 'credit.round_limit',
  minFreeze: 'credit.min_freeze',
  rechargeTier: (yuan: number) => `recharge.${yuan}`,
}

export interface CreditService {
  getBalance(tenantId: string): number
  getPrice(key: string, fallback: number): number
  getRoundLimit(tenantId: string): number
  recharge(params: {
    tenantId: string
    userId: string
    tier: number
    idempotencyKey?: string
    note?: string
  }): { txn: TxnRow; balance: number; replayed: boolean }
  createFreeze(params: {
    tenantId: string
    userId: string
    refType: RefType
    refId: string
    amount: number
    scenarioId?: string | null
    idempotencyKey?: string
    note?: string
  }): { txn: TxnRow; balance: number; replayed: boolean }
  /** 结算：把已冻结的积分正式扣减（余额不变，因冻结时已扣）；含超轮增量结算 */
  settle(params: {
    tenantId: string
    userId?: string | null
    refType: RefType
    refId: string
    amount: number
    scenarioId?: string | null
    roundNo?: number
    idempotencyKey?: string
    note?: string
  }): { txn: TxnRow; balance: number; replayed: boolean }
  /** 解冻（release）：失败/超时/未使用会话原子退回冻结积分 */
  release(params: {
    tenantId: string
    userId?: string | null
    refType: RefType
    refId: string
    note?: string
  }): { txn: TxnRow; balance: number; refunded: number; replayed: boolean }
  /** 会话结算（扫描/会话结束时调用）：按实际轮数收 base 费，未使用会话全额解冻 */
  settleConversation(conversationId: string): { settled: number; refunded: number; balance: number }
  adjust(params: {
    tenantId: string
    operator: string
    amount: number
    note?: string
    idempotencyKey?: string
  }): { txn: TxnRow; balance: number; replayed: boolean }
  listTxns(tenantId: string, opts: { page?: number; pageSize?: number; type?: string }): {
    data: TxnRow[]
    pagination: { page: number; pageSize: number; total: number }
  }
  /** 定时兜底扫描：按 ref 状态释放任务级冻结（活跃会话跳过，生图超时解冻） */
  scanExpiredFreezes(opts?: { imageTimeoutMs?: number }): {
    scanned: number
    settled: number
    released: number
    skipped: number
  }
}

/** 创建积分服务（绑定一个数据库实例） */
export function createCreditService(db: Database.Database): CreditService {
  const nowSql = `datetime('now')`

  /** 读取最新生效的价格配置（无配置回落常量） */
  function getPrice(key: string, fallback: number): number {
    const row = db.prepare(
      `SELECT value FROM price_config
       WHERE key = ? AND effective_at <= ${nowSql}
       ORDER BY effective_at DESC LIMIT 1`,
    ).get(key) as { value: string } | undefined
    if (!row) return fallback
    const v = Number(row.value)
    return Number.isFinite(v) ? Math.trunc(v) : fallback
  }

  function getTenant(tenantId: string): { balance: number; status: string } {
    const row = db.prepare('SELECT balance, status FROM tenant WHERE id = ?').get(tenantId) as
      | { balance: number; status: string }
      | undefined
    if (!row) throw Errors.notFound('租户不存在')
    return row
  }

  /**
   * 欠费状态同步（必须在调用方事务内执行）：
   * - active 且 balance < minFreeze → paused（FR-605 欠费冻结）
   * - paused 且 balance >= minFreeze → active（充值即时恢复，AC-605）
   */
  function syncTenantStatus(tenantId: string, balance: number): void {
    const min = getPrice(PRICE_KEYS.minFreeze, DEFAULT_PRICES.minFreeze)
    const tenant = db.prepare('SELECT status FROM tenant WHERE id = ?').get(tenantId) as { status: string } | undefined
    if (!tenant) return
    if (tenant.status === 'active' && balance < min) {
      db.prepare(`UPDATE tenant SET status = 'paused', updated_at = ${nowSql} WHERE id = ?`).run(tenantId)
    } else if (tenant.status === 'paused' && balance >= min) {
      db.prepare(`UPDATE tenant SET status = 'active', updated_at = ${nowSql} WHERE id = ?`).run(tenantId)
    }
  }

  /** 幂等查询：idempotency_key 已存在 → 返回既有流水 */
  function findByIdempotencyKey(key: string): TxnRow | undefined {
    return db.prepare('SELECT * FROM credit_txn WHERE idempotency_key = ?').get(key) as TxnRow | undefined
  }

  /** 该 ref 是否存在指定类型的流水 */
  function txnExistsForRef(refType: RefType, refId: string, type: string, roundNo?: number | null): boolean {
    if (roundNo !== undefined && roundNo !== null) {
      return !!db.prepare(
        `SELECT 1 FROM credit_txn WHERE ref_type = ? AND ref_id = ? AND type = ? AND round_no = ? LIMIT 1`,
      ).get(refType, refId, type, roundNo)
    }
    return !!db.prepare(
      `SELECT 1 FROM credit_txn WHERE ref_type = ? AND ref_id = ? AND type = ? LIMIT 1`,
    ).get(refType, refId, type)
  }

  /** 写一条流水（调用方事务内） */
  function insertTxn(p: {
    tenantId: string
    userId?: string | null
    type: string
    amount: number
    balanceAfter: number | null
    scenarioId?: string | null
    refType?: RefType | null
    refId?: string | null
    roundNo?: number | null
    idempotencyKey?: string | null
    operator?: string | null
    note?: string | null
  }): TxnRow {
    const id = randomUUID()
    db.prepare(
      `INSERT INTO credit_txn
        (id, tenant_id, user_id, type, amount, balance_after, scenario_id, ref_type, ref_id, round_no, idempotency_key, operator, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, p.tenantId, p.userId ?? null, p.type, p.amount, p.balanceAfter,
      p.scenarioId ?? null, p.refType ?? null, p.refId ?? null, p.roundNo ?? null,
      p.idempotencyKey ?? null, p.operator ?? null, p.note ?? null,
    )
    return db.prepare('SELECT * FROM credit_txn WHERE id = ?').get(id) as TxnRow
  }

  return {
    getBalance(tenantId) {
      return getTenant(tenantId).balance
    },

    getPrice,

    getRoundLimit() {
      return getPrice(PRICE_KEYS.roundLimit, DEFAULT_PRICES.roundLimit)
    },

    recharge({ tenantId, userId, tier, idempotencyKey, note }) {
      return db.transaction(() => {
        if (idempotencyKey) {
          const existing = findByIdempotencyKey(idempotencyKey)
          if (existing) return { txn: existing, balance: getTenant(tenantId).balance, replayed: true }
        }
        const tierPrice = getPrice(PRICE_KEYS.rechargeTier(tier), DEFAULT_PRICES.recharge[tier])
        if (!Number.isInteger(tierPrice) || tierPrice <= 0) {
          throw Errors.badRequest(`充值档位 ${tier} 元无有效到账配置`)
        }
        const tenant = getTenant(tenantId)
        const newBalance = tenant.balance + tierPrice
        // 充值即开通：trial/paused → active（AC-504 / AC-605 充值即时恢复）
        db.prepare(`UPDATE tenant SET balance = ?, status = 'active', updated_at = ${nowSql} WHERE id = ?`)
          .run(newBalance, tenantId)
        const txn = insertTxn({
          tenantId, userId, type: 'recharge', amount: tierPrice, balanceAfter: newBalance,
          idempotencyKey, note: note ?? `充值 ${tier} 元档，到账 ${tierPrice} 积分`,
        })
        return { txn, balance: newBalance, replayed: false }
      })()
    },

    createFreeze({ tenantId, userId, refType, refId, amount, scenarioId, idempotencyKey, note, roundNo = null }) {
      return db.transaction(() => {
        if (idempotencyKey) {
          const existing = findByIdempotencyKey(idempotencyKey)
          if (existing) return { txn: existing, balance: getTenant(tenantId).balance, replayed: true }
        }
        // 同 ref（按轮次）已有未终结冻结 → 视为重放（幂等，不重复扣减）
        // ⚠️ 必须按 roundNo 区分：会话级冻结（roundNo=null）不得误伤轮次级增量冻结（roundNo=N）
        if (txnExistsForRef(refType, refId, 'freeze', roundNo)
          && !txnExistsForRef(refType, refId, 'settle', roundNo)
          && !txnExistsForRef(refType, refId, 'unfreeze', roundNo)) {
          const existing = db.prepare(
            `SELECT * FROM credit_txn WHERE ref_type = ? AND ref_id = ? AND type = 'freeze'
             AND (round_no = ? OR (round_no IS NULL AND ? IS NULL)) ORDER BY created_at DESC LIMIT 1`,
          ).get(refType, refId, roundNo, roundNo) as TxnRow
          return { txn: existing, balance: getTenant(tenantId).balance, replayed: true }
        }
        const tenant = getTenant(tenantId)
        if (tenant.status === 'paused' || tenant.status === 'expired') {
          throw new AppError(409, 'TENANT_PAUSED', `租户已${tenant.status === 'paused' ? '欠费冻结' : '到期'}，请先充值或联系运营`)
        }
        // H2 修复（Codex 批次 B / FR-706）：员工限额校验——先判租户余额，再判员工限额（PRD §4.4）
        if (userId) {
          const u = db.prepare('SELECT status, credit_limit FROM user WHERE id = ?').get(userId) as
            | { status: string; credit_limit: number | null }
            | undefined
          if (!u || u.status !== 'active') {
            throw new AppError(403, 'USER_DISABLED', '账号已停用')
          }
          if (u.credit_limit !== null && u.credit_limit > 0) {
            // 员工周期已消耗 = Σ(settle) + 在途冻结（本人），限额=credit_limit
            const usedRow = db.prepare(
              `SELECT COALESCE(SUM(CASE WHEN type='freeze' THEN amount ELSE 0 END), 0)
                     - COALESCE(SUM(CASE WHEN type IN ('unfreeze') THEN amount ELSE 0 END), 0) AS used
               FROM credit_txn WHERE user_id = ? AND tenant_id = ? AND type IN ('freeze','unfreeze')`,
            ).get(userId, tenantId) as { used: number }
            const used = usedRow?.used ?? 0
            if (used + amount > u.credit_limit) {
              throw new AppError(402, 'EMPLOYEE_LIMIT_EXCEEDED',
                `员工积分限额不足：本周期已用 ${used} / 限额 ${u.credit_limit}，本次需 ${amount}。请联系主账号调整限额（FR-706）`)
            }
          }
        }
        if (tenant.balance < amount) {
          throw new AppError(402, 'INSUFFICIENT_BALANCE', `余额不足：需冻结 ${amount} 积分，当前余额 ${tenant.balance}，请充值`)
        }
        const newBalance = tenant.balance - amount
        db.prepare(`UPDATE tenant SET balance = ?, updated_at = ${nowSql} WHERE id = ?`).run(newBalance, tenantId)
        const txn = insertTxn({
          tenantId, userId, type: 'freeze', amount, balanceAfter: newBalance,
          scenarioId, refType, refId, roundNo, idempotencyKey,
          note: note ?? `冻结 ${amount} 积分（${refType === 'conversation' ? '会话' : '生图任务'} ${refId}${roundNo != null ? ` 第${roundNo}轮` : ''}）`,
        })
        syncTenantStatus(tenantId, newBalance)
        return { txn, balance: newBalance, replayed: false }
      })()
    },

    settle({ tenantId, userId = null, refType, refId, amount, scenarioId, roundNo, idempotencyKey, note }) {
      return db.transaction(() => {
        if (idempotencyKey) {
          const existing = findByIdempotencyKey(idempotencyKey)
          if (existing) return { txn: existing, balance: getTenant(tenantId).balance, replayed: true }
        }
        // 同 ref（含轮次）已结算 → 重放
        if (txnExistsForRef(refType, refId, 'settle', roundNo ?? null)) {
          const existing = db.prepare(
            `SELECT * FROM credit_txn WHERE ref_type = ? AND ref_id = ? AND type = 'settle'
             AND (round_no = ? OR (round_no IS NULL AND ? IS NULL)) ORDER BY created_at DESC LIMIT 1`,
          ).get(refType, refId, roundNo ?? null, roundNo ?? null) as TxnRow
          return { txn: existing, balance: getTenant(tenantId).balance, replayed: true }
        }
        const tenant = getTenant(tenantId)
        // 结算不改变余额：冻结时已扣减（PRD §4.3 冻结→扣减模型）
        const txn = insertTxn({
          tenantId, userId, type: 'settle', amount, balanceAfter: tenant.balance,
          scenarioId, refType, refId, roundNo, idempotencyKey,
          note: note ?? `结算 ${amount} 积分（${refType === 'conversation' ? '会话' : '生图任务'} ${refId}${roundNo != null ? ` 第${roundNo}轮` : ''}）`,
        })
        return { txn, balance: tenant.balance, replayed: false }
      })()
    },

    release({ tenantId, userId = null, refType, refId, note }) {
      return db.transaction(() => {
        // H3 修复（Codex 批次 C）：按 ref 计算未终结冻结差额 Σfreeze − Σunfreeze − Σsettle。
        // 旧逻辑"有任意 unfreeze 即重放"在"失败→重试再冻结→再失败"场景下会卡死 freeze #2（资金损失）。
        const agg = db.prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN type='freeze' THEN amount ELSE 0 END), 0) AS fz,
             COALESCE(SUM(CASE WHEN type='unfreeze' THEN amount ELSE 0 END), 0) AS unf,
             COALESCE(SUM(CASE WHEN type='settle' THEN amount ELSE 0 END), 0) AS st
           FROM credit_txn WHERE ref_type = ? AND ref_id = ? AND type IN ('freeze','unfreeze','settle')`,
        ).get(refType, refId) as { fz: number; unf: number; st: number }
        const outstanding = Math.max(0, (agg?.fz ?? 0) - (agg?.unf ?? 0) - (agg?.st ?? 0))
        if (outstanding <= 0) {
          // 已全部退回/结算 → 重放（不二次退分）
          const existing = db.prepare(
            `SELECT * FROM credit_txn WHERE ref_type = ? AND ref_id = ? AND type = 'unfreeze' ORDER BY created_at DESC LIMIT 1`,
          ).get(refType, refId) as TxnRow | undefined
          return { txn: existing, balance: getTenant(tenantId).balance, refunded: 0, replayed: true }
        }
        // 已结算的不再解冻（Σsettle 已含在差额中，此处仅兜底语义）
        const tenant = getTenant(tenantId)
        const newBalance = tenant.balance + outstanding
        db.prepare(`UPDATE tenant SET balance = ?, updated_at = ${nowSql} WHERE id = ?`).run(newBalance, tenantId)
        const txn = insertTxn({
          tenantId, userId, type: 'unfreeze', amount: outstanding, balanceAfter: newBalance,
          scenarioId: null, refType, refId,
          note: note ?? `解冻退回 ${outstanding} 积分（${refType === 'conversation' ? '会话' : '生图任务'} ${refId}）`,
        })
        return { txn, balance: newBalance, refunded: outstanding, replayed: false }
      })()
    },

    settleConversation(conversationId) {
      return db.transaction(() => {
        const conv = db.prepare('SELECT * FROM conversation WHERE id = ?').get(conversationId) as
          | (Record<string, unknown> & { tenant_id: string; turns: number; billing_state: string; settled_credit: number; frozen_credit: number; scenario_id: string | null })
          | undefined
        if (!conv) throw Errors.notFound('会话不存在')
        if (conv.billing_state === 'settled') {
          return { settled: 0, refunded: 0, balance: getTenant(conv.tenant_id).balance }
        }

        const base = getPrice(PRICE_KEYS.session, DEFAULT_PRICES.session)
        const roundExtra = getPrice(PRICE_KEYS.roundExtra, DEFAULT_PRICES.roundExtra)
        const min = getPrice(PRICE_KEYS.minFreeze, DEFAULT_PRICES.minFreeze)

        // 未使用会话（0 轮）→ 全额解冻（G5：未使用会话结算规则）
        if (conv.turns <= 0) {
          const released = this.release({
            tenantId: conv.tenant_id, refType: 'conversation', refId: conversationId,
            note: '会话未使用，全额解冻',
          })
          db.prepare(`UPDATE conversation SET billing_state = 'settled', ended_at = ${nowSql} WHERE id = ?`).run(conversationId)
          return { settled: 0, refunded: released.refunded, balance: released.balance }
        }

        // 已使用会话：应收 = base + max(0, turns - 20) * roundExtra；超轮已逐轮结算
        // ⚠️ 余额已通过"创建冻结 base + 逐轮超轮扣减"收齐——结算写真实应收流水（amount=totalDue），
        //    使看板 frozen_outstanding=freeze−settle−unfreeze、total_consumed=Σsettle 账实一致（H5 修复）
        const totalDue = base + Math.max(0, conv.turns - 20) * roundExtra
        const settledNow = Math.max(totalDue, conv.settled_credit)
        db.prepare(`UPDATE conversation SET settled_credit = ?, billing_state = 'settled', status = 'completed', ended_at = ${nowSql} WHERE id = ?`)
          .run(settledNow, conversationId)
        insertTxn({
          tenantId: conv.tenant_id, type: 'settle', amount: totalDue, balanceAfter: getTenant(conv.tenant_id).balance,
          scenarioId: conv.scenario_id, refType: 'conversation', refId: conversationId,
          note: `会话结算确认（共 ${conv.turns} 轮，应收 ${totalDue}，冻结时已扣）`,
        })
        return { settled: 0, refunded: 0, balance: getTenant(conv.tenant_id).balance }
      })()
    },

    adjust({ tenantId, operator, amount, note, idempotencyKey }) {
      return db.transaction(() => {
        if (idempotencyKey) {
          const existing = findByIdempotencyKey(idempotencyKey)
          if (existing) return { txn: existing, balance: getTenant(tenantId).balance, replayed: true }
        }
        if (!Number.isInteger(amount) || amount === 0) throw Errors.badRequest('调账金额必须为非零整数（积分）')
        const tenant = getTenant(tenantId)
        const newBalance = tenant.balance + amount
        if (newBalance < 0) throw Errors.badRequest(`调账后余额为负（${newBalance}），拒绝操作`)
        db.prepare(`UPDATE tenant SET balance = ?, updated_at = ${nowSql} WHERE id = ?`).run(newBalance, tenantId)
        const txn = insertTxn({
          tenantId, type: 'adjust', amount, balanceAfter: newBalance,
          idempotencyKey, operator,
          note: note ?? `管理员调账 ${amount > 0 ? '+' : ''}${amount} 积分`,
        })
        syncTenantStatus(tenantId, newBalance)
        return { txn, balance: newBalance, replayed: false }
      })()
    },

    listTxns(tenantId, { page = 1, pageSize = 20, type }) {
      const p = Math.max(1, page)
      const ps = Math.min(100, Math.max(1, pageSize))
      const where = ['tenant_id = ?']
      const params: unknown[] = [tenantId]
      if (type) { where.push('type = ?'); params.push(type) }
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM credit_txn WHERE ${where.join(' AND ')}`).get(...params) as { c: number }).c
      const data = db.prepare(
        `SELECT * FROM credit_txn WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ).all(...params, ps, (p - 1) * ps) as TxnRow[]
      return { data, pagination: { page: p, pageSize: ps, total } }
    },

    scanExpiredFreezes({ imageTimeoutMs = 30 * 60 * 1000 } = {}) {
      let scanned = 0
      let settled = 0
      let released = 0
      let skipped = 0

      const handle = (refType: RefType, refId: string, tenantId: string, freeze: TxnRow) => {
        scanned++
        if (refType === 'conversation') {
          // 活跃会话跳过（Codex G1：不按时长解冻，避免误伤进行中的会话）
          const conv = db.prepare('SELECT status FROM conversation WHERE id = ?').get(refId) as
            | { status: string }
            | undefined
          if (conv && conv.status === 'active') { skipped++; return }
          // 已结束/已拦截的会话 → 按实际轮数结算（未使用则解冻）；settleConversation 幂等
          const r = this.settleConversation(refId)
          if (r.refunded > 0) released++
          else if (r.settled > 0) settled++
          else skipped++
        } else if (refType === 'image') {
          // 生图任务按 artifact 状态判定（G1 兜底）
          const art = db.prepare('SELECT status FROM artifact WHERE id = ?').get(refId) as
            | { status: string }
            | undefined
          const freezeAge = Date.now() - new Date(freeze.created_at.replace(' ', 'T') + 'Z').getTime()
          if (art && art.status === 'success') {
            // 上游成功但未收到结算回调 → 补结算（幂等，余额不变，冻结时已扣）
            this.settle({ tenantId, refType: 'image', refId, amount: freeze.amount, note: '兜底扫描：上游成功补结算' })
            settled++
          } else if ((art && art.status === 'failed' && freezeAge > imageTimeoutMs)
            || (art && (art.status === 'pending' || art.status === 'processing') && freezeAge > imageTimeoutMs)
            || (!art && freezeAge > imageTimeoutMs)) {
            // 失败未退分 / 超时（webhook 丢失）→ 原子解冻，用户可重试（PRD §4.4）
            this.release({ tenantId, refType: 'image', refId, note: '兜底扫描：超时/失败原子解冻' })
            // 超时任务标记 failed 可重试（art 存在且非 failed 时）
            if (art && art.status !== 'failed') {
              db.prepare(`UPDATE artifact SET status = 'failed', fail_reason = '兜底扫描：任务超时自动解冻，可重试' WHERE id = ?`).run(refId)
            }
            released++
          } else {
            skipped++
          }
        } else {
          skipped++
        }
      }

      // 1) 会话基础冻结（round_no IS NULL，未解冻）：无论是否已有轮次结算都纳入，
      //    由 settleConversation 幂等收敛 billing_state（活跃会话跳过）
      const convFreezes = db.prepare(
        `SELECT f.* FROM credit_txn f
         WHERE f.type = 'freeze' AND f.ref_type = 'conversation' AND f.round_no IS NULL
           AND NOT EXISTS (SELECT 1 FROM credit_txn u
                           WHERE u.type = 'unfreeze' AND u.ref_type = f.ref_type AND u.ref_id = f.ref_id)`,
      ).all() as TxnRow[]
      for (const freeze of convFreezes) {
        try {
          handle('conversation', freeze.ref_id as string, freeze.tenant_id, freeze)
        } catch (err) {
          console.error(`[credit-scan] 处理会话冻结 ${freeze.id} 失败:`, (err as Error).message)
          skipped++
        }
      }

      // 2) 生图任务冻结（未结算未解冻）：按 artifact 状态 + 超时判定
      const imageFreezes = db.prepare(
        `SELECT f.* FROM credit_txn f
         WHERE f.type = 'freeze' AND f.ref_type = 'image'
           AND NOT EXISTS (SELECT 1 FROM credit_txn s
                           WHERE s.type = 'settle' AND s.ref_type = f.ref_type AND s.ref_id = f.ref_id)
           AND NOT EXISTS (SELECT 1 FROM credit_txn u
                           WHERE u.type = 'unfreeze' AND u.ref_type = f.ref_type AND u.ref_id = f.ref_id)`,
      ).all() as TxnRow[]
      for (const freeze of imageFreezes) {
        try {
          handle('image', freeze.ref_id as string, freeze.tenant_id, freeze)
        } catch (err) {
          console.error(`[credit-scan] 处理生图冻结 ${freeze.id} 失败:`, (err as Error).message)
          skipped++
        }
      }

      return { scanned, settled, released, skipped }
    },
  }
}
