/**
 * Informate 后端骨架冒烟测试（T3 交付验证）
 * 运行：npm test（tsx --test）
 *
 * 验证点：
 *   1. 迁移执行成功（10 张表就绪）
 *   2. GET /health → 200 {status:'ok', db:true}
 *   3. 无 token 访问受保护路由 → 401（统一错误格式 {code,message,details}）
 *   4. owner 登录 → 200 token；受保护路由 200
 *   5. employee 访问 admin 专用路由 → 403
 *   6. admin 登录访问 admin 路由 → 200
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const { buildApp } = require('../src/app.ts')

/** 种子数据：1 租户 + owner/employee 用户 + admin + 1 场景部署 + 价格配置 */
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

    // admin 独立账号体系（G3）
    db.prepare(`INSERT INTO admin (id, username, credentials_hash, name, status)
                VALUES (?, ?, ?, ?, ?)`)
      .run('a-001', 'admin', bcrypt.hashSync('admin123', 10), '运营管理员', 'active')

    db.prepare(`INSERT INTO scenario_deployment (id, tenant_id, scenario_id, scenario_version, display_name, status)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run('d-001', 't-001', 'industry-worker', '1.0.0', '行业工作助手', 'active')

    db.prepare(`INSERT INTO price_config (id, key, value, operator, note) VALUES (?, ?, ?, ?, ?)`)
      .run('p-001', 'credit.work_assistant.session', '10', 'seed', '会话含20轮单价')
  })
  t()
}

/** 便捷登录：返回 token */
async function login(app, account, password) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { account, password },
  })
  assert.equal(res.statusCode, 200, `登录失败 ${account}: ${res.body}`)
  return res.json().token
}

let app

test.before(async () => {
  app = buildApp({ dbPath: ':memory:', jwtSecret: 'smoke-test-secret' })
  await app.ready()
  seed(app)
})

test.after(async () => {
  await app.close()
})

test('迁移执行：10 张表就绪（9 业务表 + admin 独立表）', () => {
  const tables = app.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((r) => r.name)
  for (const t of ['tenant', 'user', 'scenario_deployment', 'conversation', 'message', 'artifact', 'credit_txn', 'price_config', 'audit_log', 'admin']) {
    assert.ok(tables.includes(t), `缺少表 ${t}，实际: ${tables.join(',')}`)
  }
  // 索引抽查
  const idx = app.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all().map((r) => r.name)
  for (const i of ['idx_tenant_status', 'idx_user_tenant', 'idx_conv_tenant', 'idx_txn_tenant', 'idx_audit_action']) {
    assert.ok(idx.includes(i), `缺少索引 ${i}`)
  }
})

test('GET /health → 200 {status:"ok", db:true}', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { status: 'ok', db: true })
})

test('无 token 访问受保护路由 → 401 统一错误格式', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' })
  assert.equal(res.statusCode, 401)
  const body = res.json()
  assert.equal(body.code, 'UNAUTHORIZED')
  assert.ok(typeof body.message === 'string' && body.message.length > 0)
  // 无 token 访问 admin 路由同样 401
  const adminRes = await app.inject({ method: 'GET', url: '/api/v1/admin/tenants' })
  assert.equal(adminRes.statusCode, 401)
  assert.equal(adminRes.json().code, 'UNAUTHORIZED')
})

test('伪造 token → 401', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: 'Bearer not-a-real-token' },
  })
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'UNAUTHORIZED')
})

test('owner 登录 → 200 token；/auth/me 与 /workspace 均 200 且注入租户上下文', async () => {
  const token = await login(app, 'owner', 'owner123')

  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } })
  assert.equal(me.statusCode, 200)
  const meBody = me.json()
  assert.equal(meBody.user.role, 'owner')
  assert.equal(meBody.tenant.id, 't-001')
  assert.equal(meBody.tenant.balance, 500)

  const ws = await app.inject({ method: 'GET', url: '/api/v1/workspace', headers: { authorization: `Bearer ${token}` } })
  assert.equal(ws.statusCode, 200)
  const wsBody = ws.json().workspace
  assert.equal(wsBody.scenarios.length, 1)
  assert.equal(wsBody.scenarios[0].display_name, '行业工作助手')
  assert.equal(wsBody.prices['credit.work_assistant.session'], '10')
})

test('错误密码 → 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { account: 'owner', password: 'wrong-password' },
  })
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'UNAUTHORIZED')
})

test('employee 访问 admin 路由 → 403（越权，NFR-07）', async () => {
  const token = await login(app, 'employee', 'emp123')
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/tenants',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
  const body = res.json()
  assert.equal(body.code, 'FORBIDDEN')
  assert.ok(typeof body.message === 'string')
})

test('owner 访问 admin 路由 → 403', async () => {
  const token = await login(app, 'owner', 'owner123')
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/tenants',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 403)
})

test('admin 登录（独立账号体系）→ admin 路由 200', async () => {
  const token = await login(app, 'admin', 'admin123')
  // admin 无租户上下文，/workspace 应 403（角色守卫）
  const ws = await app.inject({ method: 'GET', url: '/api/v1/workspace', headers: { authorization: `Bearer ${token}` } })
  assert.equal(ws.statusCode, 403)

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/admin/tenants',
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.data.length, 1)
  assert.equal(body.data[0].name, '测试医美')
  assert.equal(body.pagination.total, 1)
})
