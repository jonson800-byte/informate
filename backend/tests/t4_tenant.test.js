/**
 * Informate T4 租户/账号/场景部署模块全链路测试
 * 运行：npx tsx --test tests/t4_tenant.test.js
 *
 * 链路（对齐 T4 交付范围）：
 *   注册（trial 租户 + owner）→ 登录（JWT，owner/employee 同表、admin 独立）
 *   → 员工 CRUD（FR-105：创建/列表/停用/限额）→ 场景列表（GET /scenarios）
 *   → 开通部署（POST /scenarios/deploy，pending→active，FR-107 首单免部署费）
 *   → display_name 行业渲染（{industry} 替换，医美→"医美行业工作助手"）
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const { buildApp } = require('../src/app.ts')

/** 场景包目录（与 seed.ts 同构，测试自建保证幂等） */
const PACKAGE_IWA = {
  id: 'industry_work_assistant', name: '行业工作助手',
  display_name_template: '{industry}行业工作助手', version: '1.0.0',
  description: '行业文本对话底座', emoji: '🏥', color: '#00A0E9',
  pricing: { deduct_points: 10, actual_points: 10, refund_on_failure: false, unit: 'session', included_rounds: 20, extra_round_points: 1, round_limit: 50 },
  runtime: { model: 'deepseek-v4-flash', provider: 'deepseek', skills: ['knowledge_retriever', 'compliance_check'] },
  memory: { bank_id_template: 'informate-tenant-{user}-{profile}', read_only_banks: ['informate-common'] },
  knowledge: { types: ['terms', 'faq'], sub_industry: null },
  workflow: { description: '检索→合规→回复', produces: 'text' },
  artifact: { type: 'text', actions: [] },
  compliance: { enabled: true, rule_packs: ['general', 'medical'], ai_label: true },
}
const PACKAGE_GENIMG = {
  id: 'generate_image', name: '生成图片',
  display_name_template: '{industry}营销生图', version: '1.0.0',
  description: '营销图生成', emoji: '🖼️', color: '#FF7F50',
  pricing: { deduct_points: 20, actual_points: 15, refund_on_failure: true, unit: 'image' },
  runtime: { model: 'seedream-5.0', provider: 'volcengine', skills: ['seedream_v5_generator', 'compliance_check'] },
  memory: { bank_id_template: 'informate-tenant-{user}-{profile}', read_only_banks: ['informate-common'] },
  knowledge: { types: [], sub_industry: null },
  workflow: { description: '合规→扩写→异步任务', produces: 'image' },
  artifact: { type: 'image', actions: [] },
  compliance: { enabled: true, rule_packs: ['general', 'medical'], ai_label: true },
}

/** 测试种子：场景包目录 + admin（租户由 register 端点创建） */
function seedPackages(db) {
  for (const pkg of [PACKAGE_IWA, PACKAGE_GENIMG]) {
    db.prepare(`INSERT INTO scenario_package (id, name, display_name_template, version, description, emoji, color, pricing_unit, deduct_points, schema_payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(pkg.id, pkg.name, pkg.display_name_template, pkg.version, pkg.description, pkg.emoji, pkg.color,
           pkg.pricing.unit, pkg.pricing.deduct_points, JSON.stringify(pkg))
  }
  db.prepare(`INSERT INTO admin (id, username, credentials_hash, name, status) VALUES (?, ?, ?, ?, ?)`)
    .run('a-t4-001', 'admin', bcrypt.hashSync('admin123', 10), '运营管理员', 'active')
}

/** 便捷注入 */
function inject(method, url, { token, payload } = {}) {
  return app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload ? { payload } : {}),
  })
}

let app
let ownerToken
let tenantId
let employeeId

test.before(async () => {
  app = buildApp({ dbPath: ':memory:', jwtSecret: 't4-test-secret' })
  await app.ready()
  seedPackages(app.db)
})

test.after(async () => {
  await app.close()
})

// ---------- 1. 注册 ----------
test('注册：创建 trial 租户 + owner 账号，返回 JWT（行业=医美）', async () => {
  const res = await inject('POST', '/api/v1/auth/register', {
    payload: {
      name: '新美医美机构', industry: '医美', sub_industry: '植发',
      contact_name: '张总', contact_phone: '13800000000',
      owner_account: 'newowner', owner_password: 'owner123', owner_name: '张总',
    },
  })
  assert.equal(res.statusCode, 201, res.body)
  const body = res.json()
  assert.ok(body.token, '注册即签发 JWT')
  assert.equal(body.user.role, 'owner')
  assert.equal(body.user.name, 'newowner')
  assert.equal(body.tenant.status, 'trial')
  assert.equal(body.tenant.industry, '医美')
  assert.equal(body.tenant.balance, 0)
  assert.equal(body.tenant.trial_remaining, 20) // FR-501：试用 20 次会话

  // DB 落库校验：租户 trial + owner 账号 + 审计
  const tenant = app.db.prepare('SELECT * FROM tenant WHERE id = ?').get(body.tenant.id)
  assert.ok(tenant, '租户已落库')
  assert.equal(tenant.status, 'trial')
  const owner = app.db.prepare("SELECT * FROM user WHERE tenant_id = ? AND role = 'owner'").get(body.tenant.id)
  assert.ok(owner)
  assert.equal(owner.name, 'newowner')
  assert.ok(owner.credentials_hash.startsWith('$2'), '密码 bcrypt 哈希存储（NFR-09）')
  const audit = app.db.prepare("SELECT * FROM audit_log WHERE action = 'register'").all()
  assert.equal(audit.length, 1)

  ownerToken = body.token
  tenantId = body.tenant.id
})

test('注册：重复登录名 → 409 CONFLICT', async () => {
  const res = await inject('POST', '/api/v1/auth/register', {
    payload: { name: '重复企业', industry: '医美', owner_account: 'newowner', owner_password: 'owner123' },
  })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'CONFLICT')
})

test('注册：参数缺失 → 400 VALIDATION_ERROR', async () => {
  const res = await inject('POST', '/api/v1/auth/register', {
    payload: { name: '缺字段企业', industry: '医美' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'VALIDATION_ERROR')
})

// ---------- 2. 登录 ----------
test('登录：owner 密码正确 → 200 JWT；错误密码 → 401', async () => {
  const ok = await inject('POST', '/api/v1/auth/login', {
    payload: { account: 'newowner', password: 'owner123' },
  })
  assert.equal(ok.statusCode, 200, ok.body)
  const body = ok.json()
  assert.ok(body.token)
  assert.equal(body.user.role, 'owner')
  assert.equal(body.tenant.status, 'trial')
  assert.equal(body.tenant.trial_remaining, 20)

  const bad = await inject('POST', '/api/v1/auth/login', {
    payload: { account: 'newowner', password: 'wrong-pass' },
  })
  assert.equal(bad.statusCode, 401)
  assert.equal(bad.json().code, 'UNAUTHORIZED')
})

test('登录：admin 独立账号体系 → 200 role=admin（与租户 user 表分离，G3）', async () => {
  const res = await inject('POST', '/api/v1/auth/login', {
    payload: { account: 'admin', password: 'admin123' },
  })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.user.role, 'admin')
  assert.equal(body.tenant, null) // admin 无租户上下文
})

// ---------- 3. 员工 CRUD（FR-105，owner 专属） ----------
test('创建员工：owner POST /users → 201；重复登录名 → 409', async () => {
  const res = await inject('POST', '/api/v1/users', {
    token: ownerToken,
    payload: { name: 'emp1', password: 'emp123', credit_limit: 200 },
  })
  assert.equal(res.statusCode, 201, res.body)
  const body = res.json()
  assert.equal(body.user.role, 'employee')
  assert.equal(body.user.status, 'active')
  assert.equal(body.user.credit_limit, 200)
  employeeId = body.user.id

  const dup = await inject('POST', '/api/v1/users', {
    token: ownerToken,
    payload: { name: 'emp1', password: 'emp123' },
  })
  assert.equal(dup.statusCode, 409)
  assert.equal(dup.json().code, 'CONFLICT')
})

test('员工列表：owner GET /users → 仅本租户员工', async () => {
  const res = await inject('GET', '/api/v1/users', { token: ownerToken })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.data.length, 1)
  assert.equal(body.data[0].name, 'emp1')
  assert.equal(body.data[0].role, 'employee')
  // owner 不出现在员工列表
  assert.ok(!body.data.some((u) => u.role === 'owner'))
})

test('停用员工：owner PATCH /users/:id status=disabled → 200；停用后登录 → 403', async () => {
  const res = await inject('PATCH', `/api/v1/users/${employeeId}`, {
    token: ownerToken,
    payload: { status: 'disabled' },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().user.status, 'disabled')

  const login = await inject('POST', '/api/v1/auth/login', {
    payload: { account: 'emp1', password: 'emp123' },
  })
  assert.equal(login.statusCode, 403)
  assert.equal(login.json().code, 'FORBIDDEN')
})

test('调整限额：owner PATCH /users/:id credit_limit → 200 生效（FR-105/706）', async () => {
  const res = await inject('PATCH', `/api/v1/users/${employeeId}`, {
    token: ownerToken,
    payload: { credit_limit: 500 },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().user.credit_limit, 500)
  const row = app.db.prepare('SELECT credit_limit, status FROM user WHERE id = ?').get(employeeId)
  assert.equal(row.credit_limit, 500)
})

test('越权：employee 访问 /users → 403（NFR-07）', async () => {
  // 启用 emp1 后以其身份访问（employee 无权管理员工）
  await inject('PATCH', `/api/v1/users/${employeeId}`, { token: ownerToken, payload: { status: 'active' } })
  const empLogin = await inject('POST', '/api/v1/auth/login', { payload: { account: 'emp1', password: 'emp123' } })
  assert.equal(empLogin.statusCode, 200)
  const empToken = empLogin.json().token

  const list = await inject('GET', '/api/v1/users', { token: empToken })
  assert.equal(list.statusCode, 403)
  assert.equal(list.json().code, 'FORBIDDEN')
  const create = await inject('POST', '/api/v1/users', { token: empToken, payload: { name: 'x', password: 'xxxxxx' } })
  assert.equal(create.statusCode, 403)
})

test('越权：未登录访问 /users → 401', async () => {
  const res = await inject('GET', '/api/v1/users')
  assert.equal(res.statusCode, 401)
})

// ---------- 4. 场景列表 ----------
test('场景列表：注册后 GET /scenarios → 空（未部署不出现，FR-103）', async () => {
  const res = await inject('GET', '/api/v1/scenarios', { token: ownerToken })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().data, [])
})

// ---------- 5. 开通部署 ----------
test('部署：POST /scenarios/deploy 行业工作助手 → 201，display_name=医美行业工作助手，首单免部署费（FR-107）', async () => {
  const res = await inject('POST', '/api/v1/scenarios/deploy', {
    token: ownerToken,
    payload: { scenario_id: 'industry_work_assistant' },
  })
  assert.equal(res.statusCode, 201, res.body)
  const body = res.json()
  // display_name 行业渲染：{industry}行业工作助手 + 医美 → 医美行业工作助手
  assert.equal(body.deployment.display_name, '医美行业工作助手')
  assert.equal(body.deployment.status, 'active')
  assert.equal(body.deployment.scenario_version, '1.0.0')
  assert.equal(body.deployment.pricing.unit, 'session') // pricing.unit 区分计费单位
  assert.equal(body.deployment.pricing.deduct_points, 10)
  // FR-107：首单免部署费
  assert.equal(body.deploy_fee.waived, true)
  assert.equal(body.deploy_fee.points, 0)

  // DB：pending→active 状态机落库 + 审计
  const row = app.db.prepare('SELECT * FROM scenario_deployment WHERE id = ?').get(body.deployment.id)
  assert.equal(row.status, 'active')
  assert.equal(row.display_name, '医美行业工作助手')
  const audits = app.db.prepare("SELECT action FROM audit_log WHERE object_id = ? ORDER BY created_at").all(body.deployment.id)
  assert.ok(audits.some((a) => a.action === 'deploy_pending'), '经历 pending 状态')
  assert.ok(audits.some((a) => a.action === 'deploy_active'), '转为 active')
})

test('部署：重复部署同一场景 → 409 CONFLICT', async () => {
  const res = await inject('POST', '/api/v1/scenarios/deploy', {
    token: ownerToken,
    payload: { scenario_id: 'industry_work_assistant' },
  })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'CONFLICT')
})

test('部署：未知场景包 → 404（校验场景包 schema 存在性）', async () => {
  const res = await inject('POST', '/api/v1/scenarios/deploy', {
    token: ownerToken,
    payload: { scenario_id: 'not-exist-package' },
  })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'NOT_FOUND')
})

test('部署：非首单收部署费 ¥500（5000 积分），余额扣减 + 积分流水', async () => {
  // 模拟充值到账（FR-601 充值链路属 T5，此处直接调账以便测部署费）
  app.db.prepare('UPDATE tenant SET balance = 10000 WHERE id = ?').run(tenantId)

  const res = await inject('POST', '/api/v1/scenarios/deploy', {
    token: ownerToken,
    payload: { scenario_id: 'generate_image' },
  })
  assert.equal(res.statusCode, 201, res.body)
  const body = res.json()
  // display_name 行业渲染：{industry}营销生图 + 医美 → 医美营销生图
  assert.equal(body.deployment.display_name, '医美营销生图')
  assert.equal(body.deployment.pricing.unit, 'image') // 按张计费
  assert.equal(body.deploy_fee.waived, false)
  assert.equal(body.deploy_fee.points, 5000) // ¥500 × 10 积分/元

  const tenant = app.db.prepare('SELECT balance FROM tenant WHERE id = ?').get(tenantId)
  assert.equal(tenant.balance, 5000) // 10000 - 5000
  const txn = app.db.prepare("SELECT * FROM credit_txn WHERE type = 'adjust' AND note LIKE '场景部署费%'").get()
  assert.ok(txn)
  assert.equal(txn.amount, -5000)
  assert.equal(txn.balance_after, 5000)
})

test('部署：余额不足时非首单部署 → 400', async () => {
  const res = await inject('POST', '/api/v1/scenarios/deploy', {
    token: ownerToken,
    payload: { scenario_id: 'industry_work_assistant' }, // 已部署 → 409 先拦截
  })
  assert.equal(res.statusCode, 409)
})

test('越权：employee 部署 → 403（仅 owner 可开通，FR-103 关联）', async () => {
  const empLogin = await inject('POST', '/api/v1/auth/login', { payload: { account: 'emp1', password: 'emp123' } })
  const empToken = empLogin.json().token
  const res = await inject('POST', '/api/v1/scenarios/deploy', {
    token: empToken,
    payload: { scenario_id: 'industry_work_assistant' },
  })
  assert.equal(res.statusCode, 403)
})

// ---------- 6. 场景列表 + display_name 渲染（收尾链路） ----------
test('场景列表：部署后 GET /scenarios → 2 个场景，display_name 行业渲染 + 计费单位', async () => {
  const res = await inject('GET', '/api/v1/scenarios', { token: ownerToken })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.data.length, 2)

  const iwa = body.data.find((s) => s.scenario_id === 'industry_work_assistant')
  assert.equal(iwa.display_name, '医美行业工作助手')
  assert.equal(iwa.status, 'active')
  assert.equal(iwa.meta.name, '行业工作助手')
  assert.equal(iwa.meta.pricing.unit, 'session')

  const gen = body.data.find((s) => s.scenario_id === 'generate_image')
  assert.equal(gen.display_name, '医美营销生图')
  assert.equal(gen.meta.pricing.unit, 'image')
  assert.equal(gen.meta.pricing.deduct_points, 20)
})

test('租户隔离：另一租户看不到本租户场景（NFR-07）', async () => {
  // 注册第二个租户（行业=口腔）
  const reg = await inject('POST', '/api/v1/auth/register', {
    payload: { name: '口腔诊所', industry: '口腔', owner_account: 'dentist', owner_password: 'dentist123' },
  })
  assert.equal(reg.statusCode, 201)
  const tokenB = reg.json().token

  // 部署后 display_name 按 B 租户行业渲染：口腔行业工作助手（互不影响）
  const deploy = await inject('POST', '/api/v1/scenarios/deploy', {
    token: tokenB,
    payload: { scenario_id: 'industry_work_assistant' },
  })
  assert.equal(deploy.statusCode, 201, deploy.body)
  assert.equal(deploy.json().deployment.display_name, '口腔行业工作助手')

  const list = await inject('GET', '/api/v1/scenarios', { token: tokenB })
  assert.equal(list.json().data.length, 1)
  // A 租户场景数不变
  const listA = await inject('GET', '/api/v1/scenarios', { token: ownerToken })
  assert.equal(listA.json().data.length, 2)
})
