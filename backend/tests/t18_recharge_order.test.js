const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const { buildApp } = require('../src/app.ts')

async function login(app, account, password) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { account, password } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json().token
}

test('T18 生产充值：提交订单不加积分，admin 确认后幂等到账', async () => {
  const app = buildApp({ dbPath: ':memory:', security: false, rechargeMode: 'manual', jwtSecret: 't18-secret' })
  await app.ready()
  try {
    app.db.transaction(() => {
      app.db.prepare(`INSERT INTO tenant (id,name,industry,status,balance) VALUES ('t18','测试机构','医美','trial',0)`).run()
      app.db.prepare(`INSERT INTO user (id,tenant_id,role,name,credentials_hash,status) VALUES ('u18','t18','owner','owner18',?,'active')`)
        .run(bcrypt.hashSync('owner123', 10))
      app.db.prepare(`INSERT INTO admin (id,username,credentials_hash,name,status) VALUES ('a18','admin18',?,'管理员','active')`)
        .run(bcrypt.hashSync('admin123', 10))
    })()
    const owner = await login(app, 'owner18', 'owner123')
    const admin = await login(app, 'admin18', 'admin123')
    const request = await app.inject({
      method: 'POST', url: '/api/v1/credit/recharge', headers: { authorization: `Bearer ${owner}` },
      payload: { tier: 100, idempotency_key: 't18-request' },
    })
    assert.equal(request.statusCode, 202, request.body)
    assert.equal(request.json().pending, true)
    assert.equal(app.db.prepare(`SELECT balance FROM tenant WHERE id='t18'`).get().balance, 0)
    const orderId = request.json().order.id

    const confirm = await app.inject({
      method: 'POST', url: `/api/v1/admin/recharge-orders/${orderId}/confirm`,
      headers: { authorization: `Bearer ${admin}` }, payload: { note: '对公到账' },
    })
    assert.equal(confirm.statusCode, 200, confirm.body)
    assert.equal(confirm.json().points, 1100)
    assert.equal(app.db.prepare(`SELECT balance FROM tenant WHERE id='t18'`).get().balance, 1100)

    const replay = await app.inject({
      method: 'POST', url: `/api/v1/admin/recharge-orders/${orderId}/confirm`,
      headers: { authorization: `Bearer ${admin}` }, payload: {},
    })
    assert.equal(replay.json().replayed, true)
    assert.equal(app.db.prepare(`SELECT balance FROM tenant WHERE id='t18'`).get().balance, 1100)
  } finally {
    await app.close()
  }
})
