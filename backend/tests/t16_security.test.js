/**
 * Informate P0-6 安全基线测试（2026-08-16 外部评估优化）
 *
 * 验证点：
 *   1. 登录限流：连续失败/高频 → 429 RATE_LIMITED（独立实例 security:true）
 *   2. JWT 伪造：篡改 token / 过期签名 → 401
 *   3. 安全响应头：X-Content-Type-Options / X-Frame-Options / CSP 存在
 *   4. CORS 白名单：非白名单 origin 不返回 Access-Control-Allow-Origin
 *   5. 跨租户越权枚举：其他租户会话/产出物 → 403
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { buildApp } = require('../src/app.ts')

function startMockServer(handler) {
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    let parsed = null
    try { parsed = body ? JSON.parse(body) : null } catch { parsed = null }
    try {
      const r = await handler(req, parsed)
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.body))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err && err.message) }))
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}
function closeServer(server) { return new Promise((resolve) => { server.close(resolve) }) }

function seed(app) {
  const db = app.db
  db.transaction(() => {
    db.prepare(`INSERT INTO tenant (id, name, industry, status, plan, balance, trial_sessions_used, trial_session_limit)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t-sec-1', '安全测试医美', '医美', 'active', 'standard', 500, 0, 20)
    db.prepare(`INSERT INTO tenant (id, name, industry, status, plan, balance, trial_sessions_used, trial_session_limit)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t-sec-2', '另一机构', '医美', 'active', 'standard', 500, 0, 20)
    db.prepare(`INSERT INTO user (id, tenant_id, role, name, credentials_hash, status)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run('u-sec-1', 't-sec-1', 'owner', 'owner', bcrypt.hashSync('owner123', 10), 'active')
    db.prepare(`INSERT INTO user (id, tenant_id, role, name, credentials_hash, status)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run('u-sec-2', 't-sec-2', 'owner', 'other', bcrypt.hashSync('other123', 10), 'active')
    db.prepare(`INSERT INTO scenario_deployment (id, tenant_id, scenario_id, scenario_version, display_name, status)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run('d-sec-1', 't-sec-1', 'industry-worker', '1.0.0', '行业工作助手', 'active')
    db.prepare(`INSERT INTO conversation (id, tenant_id, user_id, scenario_id, deployment_id, status, turns, billing_state, frozen_credit, settled_credit)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('conv-sec-1', 't-sec-1', 'u-sec-1', 'industry-worker', 'd-sec-1', 'active', 0, 'frozen', 15, 0)
    db.prepare(`INSERT INTO artifact (id, tenant_id, scenario_id, type, status, ai_label, trial_watermark)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('art-sec-1', 't-sec-1', 'generate_image', 'image', 'success', 1, 0)
  })()
}

let app
let complianceServer
let memoryServer

test.before(async () => {
  complianceServer = await startMockServer(() => ({
    status: 200, body: { passed: true, blocked: false, fixed_text: null, reason: null, fixes: [], rule_packs: ['general', 'medical'], mode: 'text' },
  }))
  memoryServer = await startMockServer(() => ({ status: 200, body: { success: true } }))
  app = buildApp({
    dbPath: ':memory:',
    jwtSecret: 'sec-test-secret',
    security: true, // 本文件专门测安全加固 → 开启
    chat: {
      hermes: { mode: 'mock', streamDelayMs: 1, chunkSize: 20 },
      memoryBaseUrl: memoryServer.url,
      complianceBaseUrl: complianceServer.url,
    },
  })
  await app.ready()
  seed(app)
})

test.after(async () => {
  await app.close()
  await closeServer(complianceServer.server)
  await closeServer(memoryServer.server)
})

async function login(account, password) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { account, password } })
}

test('T16.1 安全响应头：X-Content-Type-Options / X-Frame-Options / CSP', async () => {
  const res = await login('owner', 'owner123')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['x-frame-options'], 'DENY')
  assert.ok(res.headers['content-security-policy']?.includes("default-src 'self'"))
})

test('T16.2 CORS 白名单：非白名单 origin 不返回 ACAO；白名单返回', async () => {
  const evil = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example.com' } })
  assert.equal(evil.headers['access-control-allow-origin'], undefined, '非白名单来源不应获得 CORS')

  const ok = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } })
  assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5173')
})

test('T16.3 JWT 伪造：篡改签名/过期 → 401', async () => {
  const loginRes = await login('owner', 'owner123')
  const token = loginRes.json().token
  // 篡改 payload（角色提权）
  const parts = token.split('.')
  const forged = parts[0] + '.' + Buffer.from(JSON.stringify({ role: 'admin' })).toString('base64url') + '.' + parts[2]
  const r1 = await app.inject({ method: 'GET', url: '/api/v1/workspace', headers: { authorization: `Bearer ${forged}` } })
  assert.equal(r1.statusCode, 401, '篡改 token 应 401')

  // 过期 token
  const expired = jwt.sign({ sub: 'u-sec-1', tenantId: 't-sec-1', role: 'owner' }, 'sec-test-secret', { expiresIn: '-1s' })
  const r2 = await app.inject({ method: 'GET', url: '/api/v1/workspace', headers: { authorization: `Bearer ${expired}` } })
  assert.equal(r2.statusCode, 401, '过期 token 应 401')
})

test('T16.4 登录限流：连续失败超过阈值 → 429 RATE_LIMITED', async () => {
  // 独立实例（避免污染主 app 的限流桶）：security 开启
  const app2 = buildApp({ dbPath: ':memory:', jwtSecret: 'sec2-secret', security: true })
  await app2.ready()
  seed(app2)
  let got429 = false
  for (let i = 0; i < 15; i++) {
    const res = await app2.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { account: 'owner', password: 'wrong' } })
    if (res.statusCode === 429) { got429 = true; assert.equal(res.json().code, 'RATE_LIMITED'); break }
  }
  assert.ok(got429, '连续失败应触发登录限流 429')
  await app2.close()
})

test('T16.5 跨租户越权枚举：其他租户会话/产出物 → 403/404', async () => {
  const otherLogin = await login('other', 'other123')
  assert.equal(otherLogin.statusCode, 200, otherLogin.body)
  const otherToken = otherLogin.json().token

  // 访问 t-sec-1 的会话历史 → 403
  const r1 = await app.inject({ method: 'GET', url: '/api/v1/chat/messages?conversation_id=conv-sec-1', headers: { authorization: `Bearer ${otherToken}` } })
  assert.equal(r1.statusCode, 403, '跨租户会话应 403')

  // 访问 t-sec-1 的产出物下载 → 403
  const r2 = await app.inject({ method: 'GET', url: '/api/v1/artifacts/art-sec-1/download', headers: { authorization: `Bearer ${otherToken}` } })
  assert.equal(r2.statusCode, 403, '跨租户产出物应 403')

  // 会话列表只返回本租户
  const list = await app.inject({ method: 'GET', url: '/api/v1/chat/conversations', headers: { authorization: `Bearer ${otherToken}` } })
  const ids = list.json().data.map((c) => c.id)
  assert.ok(!ids.includes('conv-sec-1'), '会话列表不应包含其他租户数据')
})
