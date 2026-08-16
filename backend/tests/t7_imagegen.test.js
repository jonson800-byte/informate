/**
 * Informate 生图执行器 T7 测试（npx tsx --test 运行）
 *
 * 验证点（技术方案 §2.4 + §G13 + PRD FR-301~307 + Q20 两阶段积分）：
 *   1. 成功路径：冻结 15 → execute 入队 → pending/processing → success → 图片文件落盘
 *      → settle 结算流水 → 积分扣减（冻结时已扣，settle 不改余额）
 *   2. 失败路径：mock 强制失败 → artifact failed + fail_reason → unfreeze 退分 → 余额回补（FR-304）
 *   3. 幂等：重复 execute 不重复入队/计费；失败重试重新冻结（FR-303）；
 *      未冻结任务 execute → 400 IMAGE_TASK_NOT_FROZEN
 *
 * 说明：Seedream 走 mock 模式（无 VOLC_ARK_API_KEY），mock 延迟注入为 30~80ms 加速测试；
 * 图片落盘到临时目录（os.tmpdir()），测试结束清理。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { buildApp } = require('../src/app.ts')

const ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'informate-t7-'))
const MOCK_DELAY = [30, 80] // mock 生成延迟 30~80ms（默认 1~3s，测试提速）

let app
let ownerToken

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

/** 轮询任务状态直至目标状态（收集途经状态，验证 processing 中间态） */
async function waitStatus(taskId, target, { timeout = 8000 } = {}) {
  const seen = new Set()
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    const res = await inject('GET', `/api/v1/image-tasks/${taskId}`, ownerToken)
    assert.equal(res.statusCode, 200, res.body)
    last = res.json()
    seen.add(last.status)
    if (last.status === target) break
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(last.status, target,
    `任务 ${taskId} 未在 ${timeout}ms 内到达 ${target}：最后状态 ${last.status}，途经 ${[...seen].join('→')}`)
  return { last, seen }
}

test.before(async () => {
  app = buildApp({
    security: false,
    dbPath: ':memory:',
    jwtSecret: 't7-test-secret',
    artifactsDir: ARTIFACTS_DIR,
    seedreamMockDelayMs: MOCK_DELAY,
  })
  await app.ready()
  const db = app.db
  db.transaction(() => {
    db.prepare(`INSERT INTO tenant (id, name, industry, sub_industry, status, plan, balance, trial_sessions_used, trial_session_limit)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t-001', '测试医美', '医美', '植发', 'active', 'standard', 500, 3, 20)
    db.prepare(`INSERT INTO user (id, tenant_id, role, name, credentials_hash, status, credit_limit)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('u-owner', 't-001', 'owner', 'owner', bcrypt.hashSync('owner123', 10), 'active', null)
    // 场景包（generate_image：unit=image 按张计费，种子对齐 src/db/seed.ts）
    db.prepare(`INSERT INTO scenario_package (id, name, display_name_template, version, pricing_unit, deduct_points, schema_payload)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('generate_image', '生成图片', '{industry}营销生图', '1.0.0', 'image', 20, '{}')
  })()
  ownerToken = await login('owner', 'owner123')
})

test.after(async () => {
  await app.close()
  fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true })
})

test('T7.1 成功路径：冻结→入队→processing→success→文件落盘→settle→积分扣减', async () => {
  // ① 冻结 15（T5 端点）：500 - 15 = 485
  let res = await inject('POST', '/api/v1/credit/image-tasks', ownerToken, {
    task_id: 'img-t1', scenario_id: 'generate_image',
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().freeze, 15)
  assert.equal(res.json().balance, 485)
  assert.equal(res.json().status, 'pending')

  // ② 执行钩子：入队
  res = await inject('POST', '/api/v1/image-tasks/img-t1/execute', ownerToken, {
    prompt: '生成一张医美品牌海报：简约高级、暖色调',
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().status, 'pending')
  assert.equal(res.json().queued, true)

  // ③ 轮询：应观察到 processing 中间态 → success
  const { last, seen } = await waitStatus('img-t1', 'success')
  assert.ok(seen.has('processing'), `应观察到 processing 中间态，实际途经 ${[...seen].join('→')}`)
  assert.ok(last.url, '成功状态应带图片 URL')
  assert.equal(last.freeze, 15)
  assert.equal(last.settled, 15)
  assert.equal(last.refunded, 0)

  // ④ 图片文件落盘 data/artifacts/
  const files = fs.readdirSync(ARTIFACTS_DIR)
  assert.ok(files.includes('img-t1.svg'), `图片文件缺失，目录内容：${files.join(', ')}`)
  assert.ok(fs.statSync(path.join(ARTIFACTS_DIR, 'img-t1.svg')).size > 0, '图片文件应为非空')

  // ⑤ settle 结算流水 + 积分扣减（冻结时已扣 15，settle 不改余额）
  const settle = app.db.prepare(
    `SELECT * FROM credit_txn WHERE ref_type='image' AND ref_id='img-t1' AND type='settle'`,
  ).get()
  assert.ok(settle, '缺少 settle 结算流水')
  assert.equal(settle.amount, 15)
  assert.equal(settle.balance_after, 485)
  const bal = (await inject('GET', '/api/v1/credit/balance', ownerToken)).json()
  assert.equal(bal.balance, 485, '结算不改余额（冻结时已扣）')

  // ⑥ artifact 落库：status/url/合规 AI 标识
  const art = app.db.prepare('SELECT status, url, ai_label, completed_at FROM artifact WHERE id = ?').get('img-t1')
  assert.equal(art.status, 'success')
  assert.equal(art.url, '/api/v1/artifacts/img-t1/download')
  assert.equal(art.ai_label, 1)
  assert.ok(art.completed_at, '成功任务应有 completed_at')

  // ⑦ 下载接口：本地文件流（G13）
  res = await inject('GET', '/api/v1/artifacts/img-t1/download', ownerToken)
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(res.headers['content-type'].includes('image/svg+xml'), `Content-Type 异常：${res.headers['content-type']}`)
  assert.ok(res.body.includes('<svg'), '应返回 SVG 图片内容')
  assert.ok(res.body.includes('医美品牌海报'), 'SVG 内应包含提示词内容')

  // ⑧ 未登录下载 → 401（NFR-09 鉴权）
  res = await app.inject({ method: 'GET', url: '/api/v1/artifacts/img-t1/download' })
  assert.equal(res.statusCode, 401)
})

test('T7.2 失败路径：mock 强制失败 → failed+fail_reason → 退分回补（FR-304）', async () => {
  // 冻结：485 - 15 = 470
  let res = await inject('POST', '/api/v1/credit/image-tasks', ownerToken, {
    task_id: 'img-fail', scenario_id: 'generate_image',
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().balance, 470)

  // 执行（prompt 带强制失败标记 __SEEDREAM_FAIL__）
  res = await inject('POST', '/api/v1/image-tasks/img-fail/execute', ownerToken, {
    prompt: '__SEEDREAM_FAIL__ 模拟上游生成错误',
  })
  assert.equal(res.statusCode, 200, res.body)

  const { last } = await waitStatus('img-fail', 'failed')
  assert.ok(last.fail_reason, '失败任务应有 fail_reason')
  assert.ok(last.fail_reason.includes('__SEEDREAM_FAIL__'), `失败原因应含标记：${last.fail_reason}`)
  assert.equal(last.refunded, 15, '应退分 15')

  // 退分流水：unfreeze 原路退回
  const unfreeze = app.db.prepare(
    `SELECT * FROM credit_txn WHERE ref_type='image' AND ref_id='img-fail' AND type='unfreeze'`,
  ).get()
  assert.ok(unfreeze, '缺少 unfreeze 退分流水')
  assert.equal(unfreeze.amount, 15)
  assert.equal(unfreeze.balance_after, 485)

  // 余额回补
  const bal = (await inject('GET', '/api/v1/credit/balance', ownerToken)).json()
  assert.equal(bal.balance, 485, '失败退分后余额应回补 15')

  // artifact 落库 failed
  const art = app.db.prepare('SELECT status, fail_reason, completed_at FROM artifact WHERE id = ?').get('img-fail')
  assert.equal(art.status, 'failed')
  assert.ok(art.completed_at, '失败任务应有 completed_at')

  // 失败任务下载 → 404（无图片可下载）
  res = await inject('GET', '/api/v1/artifacts/img-fail/download', ownerToken)
  assert.equal(res.statusCode, 404)
})

test('T7.3 幂等与重试：重复 execute 不重复计费；失败重试重新冻结（FR-303）', async () => {
  // ① 已完成任务重复 execute → 幂等返回 success，不新增冻结/结算
  let res = await inject('POST', '/api/v1/image-tasks/img-t1/execute', ownerToken, {})
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().status, 'success')
  assert.equal(res.json().replayed, true)
  const t1Freezes = app.db.prepare(
    `SELECT COUNT(*) AS c FROM credit_txn WHERE ref_type='image' AND ref_id='img-t1' AND type='freeze'`,
  ).get()
  const t1Settles = app.db.prepare(
    `SELECT COUNT(*) AS c FROM credit_txn WHERE ref_type='image' AND ref_id='img-t1' AND type='settle'`,
  ).get()
  assert.equal(t1Freezes.c, 1, '重复 execute 不应新增冻结')
  assert.equal(t1Settles.c, 1, '重复 execute 不应新增结算')

  // ② FR-303 失败重试：failed → execute → 重新冻结 15 → 成功
  res = await inject('POST', '/api/v1/image-tasks/img-fail/execute', ownerToken, {
    prompt: '重试：生成产品主图',
  })
  assert.equal(res.statusCode, 200, res.body)
  // 重试重新冻结：485 - 15 = 470
  const balRetry = (await inject('GET', '/api/v1/credit/balance', ownerToken)).json().balance
  assert.equal(balRetry, 470, '失败重试应重新冻结 15')

  const { last: retryLast } = await waitStatus('img-fail', 'success')
  assert.ok(retryLast.url, '重试成功应有图片 URL')
  assert.equal(retryLast.settled, 15)
  assert.equal(retryLast.refunded, 15, '历史退分 15 应仍可见')

  // 重试后：冻结共 2 次（首次 + 重试），结算 1 次；settle 不改余额
  const failFreezes = app.db.prepare(
    `SELECT COUNT(*) AS c FROM credit_txn WHERE ref_type='image' AND ref_id='img-fail' AND type='freeze'`,
  ).get()
  const failSettles = app.db.prepare(
    `SELECT COUNT(*) AS c FROM credit_txn WHERE ref_type='image' AND ref_id='img-fail' AND type='settle'`,
  ).get()
  assert.equal(failFreezes.c, 2, '重试应新增一次冻结（共 2 次）')
  assert.equal(failSettles.c, 1, '重试成功只结算一次')
  const balAfter = (await inject('GET', '/api/v1/credit/balance', ownerToken)).json().balance
  assert.equal(balAfter, 470, '重试成功结算不改余额')
  // 重试后图片文件存在
  assert.ok(fs.existsSync(path.join(ARTIFACTS_DIR, 'img-fail.svg')), '重试成功后图片文件应存在')

  // ③ 未冻结任务 execute → 400 IMAGE_TASK_NOT_FROZEN
  app.db.prepare(
    `INSERT INTO artifact (id, tenant_id, scenario_id, type, status, ai_label) VALUES ('img-nofreeze', 't-001', 'generate_image', 'image', 'pending', 1)`,
  ).run()
  res = await inject('POST', '/api/v1/image-tasks/img-nofreeze/execute', ownerToken, {})
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'IMAGE_TASK_NOT_FROZEN')

  // ④ 并发重复入队防护：连续两次 execute（不等完成）→ 最终只结算一次、只冻结一次
  res = await inject('POST', '/api/v1/credit/image-tasks', ownerToken, {
    task_id: 'img-t3', scenario_id: 'generate_image',
  })
  assert.equal(res.json().balance, 455) // 470 - 15
  await inject('POST', '/api/v1/image-tasks/img-t3/execute', ownerToken, { prompt: '并发重复执行' })
  await inject('POST', '/api/v1/image-tasks/img-t3/execute', ownerToken, { prompt: '并发重复执行' })
  const t3 = await waitStatus('img-t3', 'success')
  assert.ok(t3.last.url, 'img-t3 应成功')
  const t3Freezes = app.db.prepare(
    `SELECT COUNT(*) AS c FROM credit_txn WHERE ref_type='image' AND ref_id='img-t3' AND type='freeze'`,
  ).get()
  const t3Settles = app.db.prepare(
    `SELECT COUNT(*) AS c FROM credit_txn WHERE ref_type='image' AND ref_id='img-t3' AND type='settle'`,
  ).get()
  assert.equal(t3Freezes.c, 1, '重复 execute 只应冻结一次')
  assert.equal(t3Settles.c, 1, '重复 execute 只应结算一次')
  assert.equal((await inject('GET', '/api/v1/credit/balance', ownerToken)).json().balance, 455)

  // ⑤ 越权/不存在：其他租户 token → 403；不存在任务 → 404
  res = await inject('GET', '/api/v1/image-tasks/not-exist', ownerToken)
  assert.equal(res.statusCode, 404)
  res = await inject('GET', '/api/v1/image-tasks/img-t1', 'bad-token')
  assert.equal(res.statusCode, 401)
})

test('T7.4 H3 回归：失败→重试再冻结→再失败 → freeze #2 也能退（资金损失修复）', async () => {
  // 独立租户避免干扰
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
    payload: { name: 'H3回归机构', industry: '医美', owner_account: 'h3owner', owner_password: 'h3pass' } })
  const token = reg.json().token
  await inject('POST', '/api/v1/credit/recharge', token, { tier: 100 })

  // 创建任务 + 冻结 15（首次）
  await inject('POST', '/api/v1/credit/image-tasks', token, { task_id: 'h3-retry-task' })
  // 强制失败（mock 标记）
  await inject('POST', '/api/v1/image-tasks/h3-retry-task/execute', token, { prompt: '__SEEDREAM_FAIL__ 首次失败' })
  // 等任务终态
  await new Promise((r) => setTimeout(r, 400))
  let art = app.db.prepare(`SELECT status FROM artifact WHERE id='h3-retry-task'`).get()
  assert.equal(art.status, 'failed', '首次应失败')
  const balAfterFail1 = (await inject('GET', '/api/v1/credit/balance', token)).json().balance
  assert.equal(balAfterFail1, 1100, '失败应全额退分（1100-15+15）')

  // 重试（失败路径再次冻结 15 → 再失败）
  await inject('POST', '/api/v1/image-tasks/h3-retry-task/execute', token, { prompt: '__SEEDREAM_FAIL__ 二次失败' })
  await new Promise((r) => setTimeout(r, 400))
  art = app.db.prepare(`SELECT status FROM artifact WHERE id='h3-retry-task'`).get()
  assert.equal(art.status, 'failed', '重试应再失败')
  const balAfterFail2 = (await inject('GET', '/api/v1/credit/balance', token)).json().balance
  assert.equal(balAfterFail2, 1100, '二次失败 freeze #2 也应退（资金损失 H3 修复）')
})
