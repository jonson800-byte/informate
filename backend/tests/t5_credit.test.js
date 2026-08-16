/**
 * Informate 积分管线 T5 测试（tsx --test 运行）
 *
 * 验证点（PRD §4.2/§4.3/§4.4 + AC-601 + Codex G1 兜底）：
 *   1. 充值到账：100=1100 / 500=6000 / 2000=25000（AC-601），非法档位 400
 *   2. 会话冻结：创建会话冻结 15（unit=session），billing_state=frozen
 *   3. 超轮续扣：前 20 轮不追加，第 21 轮起 1 积分/轮
 *   4. 51 轮拦截：第 51 轮 → 429 ROUND_LIMIT_EXCEEDED，提示新开对话
 *   5. 生图双冻结不冲突：会话冻结 15 + 生图冻结 15 互不干扰
 *   6. 失败退分：生图失败原子解冻 15，重复失败不二次退分
 *   7. 幂等重放：充值/会话/轮次 idempotency 重放不重复扣减
 *   8. 欠费 paused 判定：余额 < 10 → 租户 paused，拦截新会话，充值即时恢复
 *   9. 兜底扫描：活跃会话跳过 / 生图超时解冻 / 成功补结算 / 结束会话结算（G1）
 *  10. 管理后台：overview 看板 / adjust 调账 / export CSV / price-config 读写（admin 专属）
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const { buildApp } = require('../src/app.ts')
const { createCreditService } = require('../src/services/credit.ts')

/** 种子：主租户 t-001（余额 500）+ owner/employee/admin + 价格配置 */
function seed(app) {
  const db = app.db
  const t = db.transaction(() => {
    db.prepare(`INSERT INTO tenant (id, name, industry, sub_industry, status, plan, balance, trial_sessions_used, trial_session_limit)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t-001', '测试医美', '医美', '植发', 'active', 'standard', 500, 3, 20)
    db.prepare(`INSERT INTO user (id, tenant_id, role, name, credentials_hash, status, credit_limit)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('u-owner', 't-001', 'owner', 'owner', bcrypt.hashSync('owner123', 10), 'active', null)
    db.prepare(`INSERT INTO user (id, tenant_id, role, name, credentials_hash, status, credit_limit)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('u-emp', 't-001', 'employee', 'employee', bcrypt.hashSync('emp123', 10), 'active', 200)
    db.prepare(`INSERT INTO admin (id, username, credentials_hash, name, status)
                VALUES (?, ?, ?, ?, ?)`)
      .run('a-001', 'admin', bcrypt.hashSync('admin123', 10), '运营管理员', 'active')
    db.prepare(`INSERT INTO scenario_deployment (id, tenant_id, scenario_id, scenario_version, display_name, status)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run('d-001', 't-001', 'industry-worker', '1.0.0', '行业工作助手', 'active')
    // 价格配置（FR-704 后台可配变量；T5 价格默认值与常量一致）
    const prices = [
      ['credit.work_assistant.session', '15'],
      ['credit.image_task', '15'],
      ['credit.round_extra', '1'],
      ['credit.round_limit', '50'],
      ['credit.min_freeze', '15'],
      ['recharge.100', '1100'],
      ['recharge.500', '6000'],
      ['recharge.2000', '25000'],
    ]
    prices.forEach(([key, value], i) => {
      // INSERT OR IGNORE：price_config 有 UNIQUE(key, effective_at)，重复 seed 幂等；
      // effective_at 用过去时间（NULL 会使 getPrice 的 <= datetime('now') 比较失效）
      db.prepare(`INSERT OR IGNORE INTO price_config (id, key, value, effective_at, operator, note) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(`p-${String(i + 1).padStart(3, '0')}`, key, value, '2026-01-01 00:00:00', 'seed', 'T5 测试价格')
    })
  })
  t()
}

let app
let ownerToken
let empToken
let adminToken

/** 便捷登录 */
async function login(account, password) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { account, password } })
  assert.equal(res.statusCode, 200, `登录失败 ${account}: ${res.body}`)
  return res.json().token
}

/** 便捷注入 */
function inject(method, url, token, payload) {
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  return app.inject({ method, url, headers, payload })
}

test.before(async () => {
  app = buildApp({ dbPath: ':memory:', jwtSecret: 't5-test-secret', security: false })
  await app.ready()
  seed(app)
  ownerToken = await login('owner', 'owner123')
  empToken = await login('employee', 'emp123')
  adminToken = await login('admin', 'admin123')
})

test.after(async () => {
  await app.close()
})

test('T5.1 充值到账（AC-601）：100=1100 / 500=6000 / 2000=25000', async () => {
  // 初始余额 500
  let res = await inject('POST', '/api/v1/credit/recharge', ownerToken, { tier: 100 })
  assert.equal(res.statusCode, 200, res.body)
  let body = res.json()
  assert.equal(body.balance, 1600)
  assert.equal(body.txn.type, 'recharge')
  assert.equal(body.txn.amount, 1100)
  assert.equal(body.replayed, false)

  res = await inject('POST', '/api/v1/credit/recharge', ownerToken, { tier: 500 })
  body = res.json()
  assert.equal(body.balance, 7600)
  assert.equal(body.txn.amount, 6000)

  res = await inject('POST', '/api/v1/credit/recharge', ownerToken, { tier: 2000 })
  body = res.json()
  assert.equal(body.balance, 32600)
  assert.equal(body.txn.amount, 25000)

  // 非法档位 → 400 VALIDATION_ERROR
  res = await inject('POST', '/api/v1/credit/recharge', ownerToken, { tier: 50 })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'VALIDATION_ERROR')

  // employee 无权充值（仅 owner）
  res = await inject('POST', '/api/v1/credit/recharge', empToken, { tier: 100 })
  assert.equal(res.statusCode, 403)
})

test('T5.2 会话冻结：创建会话冻结 15（unit=session），billing_state=frozen', async () => {
  const res = await inject('POST', '/api/v1/credit/conversations', ownerToken, {
    conversation_id: 'conv-c1', scenario_id: 'industry-worker',
  })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.freeze, 15)
  assert.equal(body.balance, 32585) // 32600 - 15
  assert.equal(body.conversation.billing_state, 'frozen')
  assert.equal(body.conversation.frozen_credit, 15)
  assert.equal(body.conversation.turns, 0)
  assert.equal(body.replayed, false)

  // 冻结流水落库
  const freeze = app.db.prepare(
    `SELECT * FROM credit_txn WHERE ref_type='conversation' AND ref_id='conv-c1' AND type='freeze'`,
  ).get()
  assert.ok(freeze, '缺少会话冻结流水')
  assert.equal(freeze.amount, 15)
  assert.equal(freeze.balance_after, 32585)
})

test('T5.3 超轮续扣：前 20 轮免费，第 21 轮起 1 积分/轮（25 轮会话共扣 15）', async () => {
  await inject('POST', '/api/v1/credit/conversations', ownerToken, {
    conversation_id: 'conv-c2', scenario_id: 'industry-worker',
  })
  // 32585 - 15 = 32570（conv-c2 冻结）
  let charged = 0
  for (let round = 1; round <= 25; round++) {
    const res = await inject('POST', `/api/v1/credit/conversations/conv-c2/rounds`, ownerToken, {})
    assert.equal(res.statusCode, 200, `第 ${round} 轮失败: ${res.body}`)
    const body = res.json()
    const expected = round > 20 ? 1 : 0
    assert.equal(body.round_no, round)
    assert.equal(body.charge, expected, `第 ${round} 轮计费错误`)
    charged += expected
  }
  assert.equal(charged, 5, '21-25 轮应续扣 5 积分')
  const balanceRes = await inject('GET', '/api/v1/credit/balance', ownerToken)
  assert.equal(balanceRes.json().balance, 32565) // 32570 - 5
  const conv = app.db.prepare('SELECT turns, settled_credit, billing_state FROM conversation WHERE id = ?').get('conv-c2')
  assert.equal(conv.turns, 25)
  assert.equal(conv.settled_credit, 5)
  assert.equal(conv.billing_state, 'frozen')
})

test('T5.4 51 轮拦截：第 51 轮 → 429 并提示新开对话', async () => {
  await inject('POST', '/api/v1/credit/conversations', ownerToken, {
    conversation_id: 'conv-c3', scenario_id: 'industry-worker',
  })
  // 32565 - 15 = 32550（conv-c3 冻结）
  for (let round = 1; round <= 50; round++) {
    const res = await inject('POST', `/api/v1/credit/conversations/conv-c3/rounds`, ownerToken, {})
    assert.equal(res.statusCode, 200, `第 ${round} 轮失败: ${res.body}`)
  }
  const balanceRes = await inject('GET', '/api/v1/credit/balance', ownerToken)
  assert.equal(balanceRes.json().balance, 32520) // 32550 - 30（21-50 轮）

  // 第 51 轮 → 429
  const res = await inject('POST', `/api/v1/credit/conversations/conv-c3/rounds`, ownerToken, {})
  assert.equal(res.statusCode, 429)
  const body = res.json()
  assert.equal(body.code, 'ROUND_LIMIT_EXCEEDED')
  assert.ok(body.message.includes('新开对话'), '拦截提示应建议新开对话')
  assert.equal(body.details.round_limit, 50)

  // 被拦截后不冻结不扣费
  const afterRes = await inject('GET', '/api/v1/credit/balance', ownerToken)
  assert.equal(afterRes.json().balance, 32520)
})

test('T5.5 生图双冻结不冲突：会话冻结 15 + 生图冻结 15 互不干扰', async () => {
  // 会话冻结
  const convRes = await inject('POST', '/api/v1/credit/conversations', ownerToken, {
    conversation_id: 'conv-c4', scenario_id: 'industry-worker',
  })
  assert.equal(convRes.json().balance, 32505) // 32520 - 15（conv-c4 冻结）

  // 生图冻结 15（unit=image，不冻会话费）
  const imgRes = await inject('POST', '/api/v1/credit/image-tasks', ownerToken, {
    task_id: 'img-1', scenario_id: 'industry-worker',
  })
  assert.equal(imgRes.statusCode, 200, imgRes.body)
  assert.equal(imgRes.json().freeze, 15)
  assert.equal(imgRes.json().balance, 32490) // 32505 - 15

  // 会话冻结未被生图冻结影响
  const conv = app.db.prepare('SELECT frozen_credit, billing_state FROM conversation WHERE id = ?').get('conv-c4')
  assert.equal(conv.frozen_credit, 15)
  assert.equal(conv.billing_state, 'frozen')

  // 两条冻结流水独立存在
  const convFreeze = app.db.prepare(`SELECT COUNT(*) AS c FROM credit_txn WHERE type='freeze' AND ref_type='conversation' AND ref_id='conv-c4'`).get()
  const imgFreeze = app.db.prepare(`SELECT COUNT(*) AS c FROM credit_txn WHERE type='freeze' AND ref_type='image' AND ref_id='img-1'`).get()
  assert.equal(convFreeze.c, 1)
  assert.equal(imgFreeze.c, 1)

  // artifact 落库 pending
  const art = app.db.prepare('SELECT status FROM artifact WHERE id = ?').get('img-1')
  assert.equal(art.status, 'pending')
})

test('T5.6 失败退分：生图失败原子解冻 15，重复失败不二次退分', async () => {
  let res = await inject('POST', '/api/v1/credit/tasks/img-1/fail', ownerToken, { reason: '上游生成超时' })
  assert.equal(res.statusCode, 200, res.body)
  let body = res.json()
  assert.equal(body.refunded, 15)
  assert.equal(body.balance, 32505) // 32490 + 15
  assert.equal(body.replayed, false)

  // 失败流水：unfreeze 原路退回
  const unfreeze = app.db.prepare(`SELECT * FROM credit_txn WHERE type='unfreeze' AND ref_type='image' AND ref_id='img-1'`).get()
  assert.ok(unfreeze, '缺少解冻流水')
  assert.equal(unfreeze.amount, 15)
  assert.equal(unfreeze.balance_after, 32505)

  // artifact 标记失败
  const art = app.db.prepare('SELECT status, fail_reason FROM artifact WHERE id = ?').get('img-1')
  assert.equal(art.status, 'failed')
  assert.ok(art.fail_reason.includes('超时'))

  // 重复失败 → 幂等，不二次退分
  res = await inject('POST', '/api/v1/credit/tasks/img-1/fail', ownerToken, {})
  assert.equal(res.statusCode, 200)
  body = res.json()
  assert.equal(body.refunded, 0)
  assert.equal(body.replayed, true)
  assert.equal(body.balance, 32505)

  // 失败任务不可重复退分后再次冻结（createFreeze ref 幂等）
  const again = await inject('POST', '/api/v1/credit/image-tasks', ownerToken, { task_id: 'img-1' })
  assert.equal(again.json().balance, 32505, '已退分任务重放冻结不应再次扣减')
})

test('T5.7 幂等重放：充值/会话/轮次重放不重复扣减', async () => {
  // 充值幂等
  let res = await inject('POST', '/api/v1/credit/recharge', ownerToken, { tier: 100, idempotency_key: 're-key-1' })
  assert.equal(res.statusCode, 200)
  const first = res.json()
  assert.equal(first.balance, 33605) // 32505 + 1100
  assert.equal(first.replayed, false)

  res = await inject('POST', '/api/v1/credit/recharge', ownerToken, { tier: 100, idempotency_key: 're-key-1' })
  const second = res.json()
  assert.equal(second.balance, 33605, '重放不应重复到账')
  assert.equal(second.replayed, true)
  assert.equal(second.txn.id, first.txn.id, '重放应返回同一条流水')

  // 会话创建幂等（同 conversation_id 重放）
  res = await inject('POST', '/api/v1/credit/conversations', ownerToken, { conversation_id: 'conv-c1' })
  assert.equal(res.json().replayed, true)
  assert.equal(res.json().balance, 33605, '会话重放不应重复冻结')

  // 轮次幂等（round_no 重放已计费轮）
  res = await inject('POST', '/api/v1/credit/conversations/conv-c2/rounds', ownerToken, { round_no: 22 })
  const replay = res.json()
  assert.equal(replay.replayed, true)
  assert.equal(replay.charge, 0)
  assert.equal(replay.balance, 33605, '轮次重放不应重复扣费')

  // 流水里该轮只有一条 settle
  const settles = app.db.prepare(
    `SELECT COUNT(*) AS c FROM credit_txn WHERE type='settle' AND ref_id='conv-c2' AND round_no=22`,
  ).get()
  assert.equal(settles.c, 1)

  // 流水查询接口
  res = await inject('GET', '/api/v1/credit/txns?page=1&pageSize=5', ownerToken)
  assert.equal(res.statusCode, 200)
  const txns = res.json()
  assert.equal(txns.pagination.page, 1)
  assert.equal(txns.pagination.pageSize, 5)
  assert.equal(txns.data.length, 5)
  assert.ok(txns.pagination.total > 5)

  // admin 访问租户侧 credit 路由 → 403
  res = await inject('GET', '/api/v1/credit/balance', adminToken)
  assert.equal(res.statusCode, 403)
})

test('T5.8 欠费 paused 判定：余额 < 10 → 租户 paused，拦截新会话，充值即时恢复', async () => {
  // 新租户：trial + 余额 0
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { name: '欠费测试机构', industry: '医美', owner_account: 'poor_owner', owner_password: 'poor123' },
  })
  assert.equal(reg.statusCode, 201, reg.body)
  const fresh = reg.json()
  const freshToken = fresh.token
  const freshTenantId = fresh.tenant.id

  // 余额 0 + trial 状态 → 发起会话走 20 次试用额度（不查余额，M2/FR-208）
  let res = await inject('POST', '/api/v1/credit/conversations', freshToken, {})
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().conversation.billing_state, 'trial', 'trial 会话不冻结积分')
  const me0 = await inject('GET', '/api/v1/auth/me', freshToken)
  assert.equal(me0.json().tenant.trial_sessions_used, 1, '试用次数应递增')

  // 充值 100 → trial → active，余额 1100
  res = await inject('POST', '/api/v1/credit/recharge', freshToken, { tier: 100 })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().balance, 1100)
  const me = await inject('GET', '/api/v1/auth/me', freshToken)
  assert.equal(me.json().tenant.status, 'active')

  // 管理员调账扣到 9（< 10）→ 自动转 paused（FR-605）
  res = await inject('POST', '/api/v1/admin/adjust', adminToken, { tenant_id: freshTenantId, amount: -1091, note: '欠费测试' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().balance, 9)
  const bal = await inject('GET', '/api/v1/credit/balance', freshToken)
  assert.equal(bal.json().status, 'paused', '余额 < 10 应转 paused')

  // paused 租户发起新会话 → 409 TENANT_PAUSED
  res = await inject('POST', '/api/v1/credit/conversations', freshToken, {})
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'TENANT_PAUSED')

  // 生图同样拦截
  res = await inject('POST', '/api/v1/credit/image-tasks', freshToken, { task_id: 'poor-img-1' })
  assert.equal(res.statusCode, 409)

  // 充值即时恢复 active（AC-605）
  res = await inject('POST', '/api/v1/credit/recharge', freshToken, { tier: 100 })
  assert.equal(res.json().balance, 1109)
  const bal2 = await inject('GET', '/api/v1/credit/balance', freshToken)
  assert.equal(bal2.json().status, 'active')
  // 恢复后会话可用
  res = await inject('POST', '/api/v1/credit/conversations', freshToken, {})
  assert.equal(res.statusCode, 200)
})

test('T5.9 兜底扫描（G1）：活跃会话跳过 / 生图超时解冻 / 成功补结算 / 结束会话结算', async () => {
  const credit = createCreditService(app.db)
  const db = app.db
  // 独立租户，避免干扰其他测试
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { name: '扫描测试机构', industry: '医美', owner_account: 'scan_owner', owner_password: 'scan123' },
  })
  const fresh = reg.json()
  const token = fresh.token

  await inject('POST', '/api/v1/credit/recharge', token, { tier: 100 }) // 1100

  // a) 活跃会话 → 跳过（不按时长解冻）
  await inject('POST', '/api/v1/credit/conversations', token, { conversation_id: 'sc-conv-active' })
  // b) 未使用已结束会话 → 全额解冻
  await inject('POST', '/api/v1/credit/conversations', token, { conversation_id: 'sc-conv-unused' })
  db.prepare(`UPDATE conversation SET status = 'completed' WHERE id = 'sc-conv-unused'`).run()
  // c) 已用会话（5 轮）已结束 → 结算 base 10
  await inject('POST', '/api/v1/credit/conversations', token, { conversation_id: 'sc-conv-done' })
  for (let r = 1; r <= 5; r++) {
    await inject('POST', '/api/v1/credit/conversations/sc-conv-done/rounds', token, {})
  }
  db.prepare(`UPDATE conversation SET status = 'completed' WHERE id = 'sc-conv-done'`).run()
  // d) 生图 pending 超时 → 解冻
  await inject('POST', '/api/v1/credit/image-tasks', token, { task_id: 'sc-img-timeout' })
  db.prepare(`UPDATE credit_txn SET created_at = datetime('now','-2 hour') WHERE ref_type='image' AND ref_id='sc-img-timeout'`).run()
  // e) 生图 pending 未超时 → 跳过
  await inject('POST', '/api/v1/credit/image-tasks', token, { task_id: 'sc-img-fresh' })
  // f) 生图成功未回调 → 补结算
  await inject('POST', '/api/v1/credit/image-tasks', token, { task_id: 'sc-img-ok' })
  db.prepare(`UPDATE artifact SET status = 'success' WHERE id = 'sc-img-ok'`).run()
  // g) 生图失败未退分且超时 → 解冻
  await inject('POST', '/api/v1/credit/image-tasks', token, { task_id: 'sc-img-failed' })
  db.prepare(`UPDATE artifact SET status = 'failed' WHERE id = 'sc-img-failed'`).run()
  db.prepare(`UPDATE credit_txn SET created_at = datetime('now','-2 hour') WHERE ref_type='image' AND ref_id='sc-img-failed'`).run()

  // 余额演算：1100 - 15*3（三会话） - 15*4（四生图）= 1100 - 45 - 60 = 995
  let bal = (await inject('GET', '/api/v1/credit/balance', token)).json().balance
  assert.equal(bal, 995)

  const r = credit.scanExpiredFreezes({ imageTimeoutMs: 30 * 60 * 1000 })

  // 活跃会话仍在冻结中
  const active = db.prepare(`SELECT billing_state FROM conversation WHERE id = 'sc-conv-active'`).get()
  assert.equal(active.billing_state, 'frozen', '活跃会话不应被扫描解冻')

  // 未使用会话：10 退回
  const unused = db.prepare(`SELECT billing_state FROM conversation WHERE id = 'sc-conv-unused'`).get()
  assert.equal(unused.billing_state, 'settled')

  // 已用会话：base 15 结算（995 - 15 = 980）
  const done = db.prepare(`SELECT billing_state, settled_credit FROM conversation WHERE id = 'sc-conv-done'`).get()
  assert.equal(done.billing_state, 'settled')
  assert.equal(done.settled_credit, 15)

  // 超时生图解冻 15、失败超时解冻 15 → 未使用会话解冻 15 + 30 = 1040（995 + 45）
  // 成功生图补结算（余额不变）
  bal = (await inject('GET', '/api/v1/credit/balance', token)).json().balance
  assert.equal(bal, 1040)

  // 超时任务标记失败可重试
  const timeoutArt = db.prepare(`SELECT status, fail_reason FROM artifact WHERE id = 'sc-img-timeout'`).get()
  assert.equal(timeoutArt.status, 'failed')
  assert.ok(timeoutArt.fail_reason.includes('超时'))

  // 成功任务已有 settle 流水
  const okSettle = db.prepare(`SELECT COUNT(*) AS c FROM credit_txn WHERE type='settle' AND ref_type='image' AND ref_id='sc-img-ok'`).get()
  assert.equal(okSettle.c, 1)

  // 二次扫描幂等：不再重复处理
  const r2 = credit.scanExpiredFreezes({ imageTimeoutMs: 30 * 60 * 1000 })
  const balAfter = (await inject('GET', '/api/v1/credit/balance', token)).json().balance
  assert.equal(balAfter, 1040, '二次扫描不应重复扣减/退分')
})

test('T5.10 管理后台：overview 看板 / adjust 调账 / export CSV / price-config 读写', async () => {
  // 角色隔离：owner/employee 访问 admin 积分路由 → 403
  let res = await inject('GET', '/api/v1/admin/overview', ownerToken)
  assert.equal(res.statusCode, 403)
  res = await inject('GET', '/api/v1/admin/overview', empToken)
  assert.equal(res.statusCode, 403)

  // overview 看板
  res = await inject('GET', '/api/v1/admin/overview', adminToken)
  assert.equal(res.statusCode, 200, res.body)
  const ov = res.json().overview
  assert.ok(ov.tenant_count >= 3, '租户数应 ≥ 3')
  assert.ok(ov.total_revenue >= 3300, `总收入应 ≥ 3300，实际 ${ov.total_revenue}`) // 1100*3（t-001 三笔 + 两新租户各一笔）
  assert.ok(ov.total_consumed > 0, '总消耗应 > 0')
  assert.equal(ov.min_freeze, 15)

  // export CSV
  res = await inject('GET', '/api/v1/admin/export', adminToken)
  assert.equal(res.statusCode, 200)
  assert.ok(res.headers['content-type'].includes('text/csv'))
  assert.ok(res.body.startsWith('\uFEFF'), 'CSV 应带 BOM（Excel 中文）')
  assert.ok(res.body.includes('流水ID'))
  assert.ok(res.body.includes('recharge'))

  // price-config 读取（默认值 + source 标注）
  res = await inject('GET', '/api/v1/admin/price-config', adminToken)
  assert.equal(res.statusCode, 200)
  const pc = res.json().data
  const sessionCfg = pc.find((p) => p.key === 'credit.work_assistant.session')
  assert.equal(sessionCfg.value, '15')
  assert.equal(sessionCfg.source, 'price_config')

  // price-config 修改：超轮单价 1 → 2（FR-704 新版本即刻生效）
  res = await inject('PUT', '/api/v1/admin/price-config', adminToken, { key: 'credit.round_extra', value: '2', note: '测试调价' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().value, '2')

  // 非白名单 key → 400
  res = await inject('PUT', '/api/v1/admin/price-config', adminToken, { key: 'hack.key', value: '1' })
  assert.equal(res.statusCode, 400)

  // 新会话验证新单价生效：冻结 15 → 第 21 轮扣 2
  res = await inject('POST', '/api/v1/credit/conversations', ownerToken, { conversation_id: 'conv-price' })
  const convBal = res.json().balance // 33605 - 15 = 33590
  assert.equal(convBal, 33590)
  for (let r = 1; r <= 20; r++) {
    await inject('POST', '/api/v1/credit/conversations/conv-price/rounds', ownerToken, {})
  }
  res = await inject('POST', '/api/v1/credit/conversations/conv-price/rounds', ownerToken, {})
  assert.equal(res.json().charge, 2, '调价后第 21 轮应扣 2 积分')
  assert.equal(res.json().balance, 33588)

  // 恢复原价
  await inject('PUT', '/api/v1/admin/price-config', adminToken, { key: 'credit.round_extra', value: '1', note: '恢复' })
  // 调账审计留痕
  const audit = app.db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action='credit.adjust'`).get()
  assert.ok(audit.c >= 1, '调账应有审计日志')
})

// ---------- 11. 结束会话（P0-4 显式终态闭环） ----------
test('T5.11 结束会话：未使用会话全额解冻 + 幂等 + 审计', async () => {
  const beforeBal = (await inject('GET', '/api/v1/credit/balance', ownerToken)).json().balance
  await inject('POST', '/api/v1/credit/conversations', ownerToken, { conversation_id: 'conv-end-1' })
  const afterFreeze = (await inject('GET', '/api/v1/credit/balance', ownerToken)).json().balance
  assert.equal(afterFreeze, beforeBal - 15, '创建会话应冻结 15')

  const res = await inject('POST', '/api/v1/credit/conversations/conv-end-1/end', ownerToken, {})
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.status, 'completed')
  assert.equal(body.billing_state, 'settled')
  assert.equal(body.refunded, 15, '未使用会话应全额解冻')
  assert.equal(body.balance, beforeBal, '解冻后余额回到创建前')
  assert.equal(body.replayed, false)

  // 幂等：再次 end 不重复结算/解冻
  const again = await inject('POST', '/api/v1/credit/conversations/conv-end-1/end', ownerToken, {})
  assert.equal(again.statusCode, 200, again.body)
  assert.equal(again.json().replayed, true)
  assert.equal(again.json().refunded, 0, '幂等重放不应重复解冻')
  assert.equal((await inject('GET', '/api/v1/credit/balance', ownerToken)).json().balance, beforeBal)

  // 审计留痕
  const audits = app.db.prepare("SELECT action FROM audit_log WHERE object_id = 'conv-end-1'").all()
  assert.ok(audits.some((a) => a.action === 'conversation_end'), '应有结束会话审计')
})

test('T5.12 结束会话：已使用会话按轮数结算（不重复扣费）', async () => {
  const beforeBal = (await inject('GET', '/api/v1/credit/balance', ownerToken)).json().balance
  await inject('POST', '/api/v1/credit/conversations', ownerToken, { conversation_id: 'conv-end-2' })
  // 快进 20 轮（含轮内不扣费）
  for (let r = 1; r <= 20; r++) {
    const rr = await inject('POST', '/api/v1/credit/conversations/conv-end-2/rounds', ownerToken, {})
    assert.equal(rr.statusCode, 200, rr.body)
  }
  const after20 = (await inject('GET', '/api/v1/credit/balance', ownerToken)).json().balance
  assert.equal(after20, beforeBal - 15, '20 轮内仅冻结 base 15')

  const res = await inject('POST', '/api/v1/credit/conversations/conv-end-2/end', ownerToken, {})
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.status, 'completed')
  assert.equal(body.refunded, 0, '已使用会话不退还 base')
  assert.equal(body.balance, after20, '结算不改变余额（冻结时已扣）')

  // 结束后的会话不能再计费/发消息
  const round = await inject('POST', '/api/v1/credit/conversations/conv-end-2/rounds', ownerToken, {})
  assert.equal(round.statusCode, 409, '已结束会话不可继续计费')
})
