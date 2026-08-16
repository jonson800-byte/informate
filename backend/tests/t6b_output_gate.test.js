/**
 * Informate P0-2 输出合规闸门测试（2026-08-16 外部评估优化）
 *
 * 验证点：流式输出「服务端按句缓冲 → 增量合规 → 通过才转发」：
 *   1. 含违规块的回复：违规块绝不转发（SSE 无该文本）、error COMPLIANCE_BLOCKED_OUTPUT、
 *      不落库、不结算（turns/余额不变）
 *   2. 无违禁词回复：闸门不误伤，delta 正常转发 + 落库
 *   3. 违规块之后的文本不达浏览器（闸门关闭 + 上游中止）
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const bcrypt = require('bcryptjs')
const { buildApp } = require('../src/app.ts')

function startMockServer(handler) {
  const records = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    let parsed = null
    try { parsed = body ? JSON.parse(body) : null } catch { parsed = null }
    records.push({ method: req.method, url: req.url, body: parsed })
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
      resolve({ server, records, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => { server.close(resolve) })
}

function parseSSE(body) {
  const events = []
  let event = null
  const dataParts = []
  for (const line of String(body).split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) dataParts.push(line.slice(6).trim())
    else if (line === '') {
      if (event || dataParts.length) {
        events.push({ event: event ?? 'message', data: dataParts.join('\n') })
        event = null
        dataParts.length = 0
      }
    }
  }
  return events
}

function seed(app) {
  const db = app.db
  db.transaction(() => {
    db.prepare(`INSERT INTO tenant (id, name, industry, sub_industry, status, plan, balance, trial_sessions_used, trial_session_limit)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t-001', '测试医美', '医美', '植发', 'active', 'standard', 500, 3, 20)
    db.prepare(`INSERT INTO user (id, tenant_id, role, name, credentials_hash, status, credit_limit)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('u-owner', 't-001', 'owner', 'owner', bcrypt.hashSync('owner123', 10), 'active', null)
    db.prepare(`INSERT INTO admin (id, username, credentials_hash, name, status)
                VALUES (?, ?, ?, ?, ?)`)
      .run('a-001', 'admin', bcrypt.hashSync('admin123', 10), '运营管理员', 'active')
    db.prepare(`INSERT INTO scenario_deployment (id, tenant_id, scenario_id, scenario_version, display_name, status)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run('d-001', 't-001', 'industry-worker', '1.0.0', '行业工作助手', 'active')
    const prices = [
      ['credit.work_assistant.session', '15'],
      ['credit.image_task', '15'],
      ['credit.round_extra', '1'],
      ['credit.round_limit', '50'],
      ['credit.min_freeze', '15'],
    ]
    prices.forEach(([key, value], i) => {
      db.prepare(`INSERT OR IGNORE INTO price_config (id, key, value, effective_at, operator, note) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(`tp-${String(i + 1).padStart(3, '0')}`, key, value, '2026-01-01 00:00:00', 'seed', '测试价格')
    })
  })()
}

let app
let ownerToken
let complianceServer
let memoryServer

async function login(account, password) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { account, password } })
  assert.equal(res.statusCode, 200, `登录失败: ${res.body}`)
  return res.json().token
}
function inject(method, url, token, payload) {
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  return app.inject({ method, url, headers, payload })
}
async function createConv(token, conversationId) {
  const res = await inject('POST', '/api/v1/credit/conversations', token, {
    conversation_id: conversationId, scenario_id: 'industry-worker',
  })
  assert.equal(res.statusCode, 200, res.body)
}

/**
 * 合规 mock：按文本内容判定——含「无痛」→ medical 红线 block；含「顶级」→ general 修正；
 * 其余通过。这模拟真实合规引擎的拦截/修正双模式。
 */
async function startMocks() {
  complianceServer = await startMockServer((req, body) => {
    if (req.url !== '/check') return { status: 404, body: { error: 'not found' } }
    const text = body?.text ?? body?.image_prompt ?? ''
    if (text.includes('无痛')) {
      return {
        status: 200,
        body: {
          passed: false, blocked: true, fixed_text: null,
          reason: '命中《医疗美容广告执法指南》红线：含「无痛无痕」类承诺',
          fixes: [], rule_packs: ['general', 'medical'], mode: 'text',
        },
      }
    }
    if (text.includes('顶级')) {
      return {
        status: 200,
        body: {
          passed: true, blocked: false, fixed_text: text.replace('顶级', '优质'),
          reason: null, fixes: [{ word: '顶级', suggestion: '优质' }],
          rule_packs: ['general', 'medical'], mode: 'text',
        },
      }
    }
    return {
      status: 200,
      body: {
        passed: true, blocked: false, fixed_text: null, reason: null,
        fixes: [], rule_packs: ['general', 'medical'], mode: 'text',
      },
    }
  })
  memoryServer = await startMockServer((req) => {
    if (req.url.includes('/memories/recall')) {
      return { status: 200, body: { results: [] } }
    }
    if (req.url.includes('/memories')) {
      return { status: 200, body: { success: true, items_count: 0, async: false } }
    }
    return { status: 404, body: { error: 'not found' } }
  })
}

test.before(async () => {
  await startMocks()
  app = buildApp({
    security: false,
    dbPath: ':memory:',
    jwtSecret: 't6b-test-secret',
    chat: {
      // 注入含违规块的回复：第一句通过、第二句含「无痛」红线、第三句本应到达但被闸门阻止
      hermes: { mode: 'mock', streamDelayMs: 1, chunkSize: 6, mockReply: '我们医院提供顶级服务。绝对无痛无痕。请放心咨询。' },
      memoryBaseUrl: memoryServer.url,
      complianceBaseUrl: complianceServer.url,
      complianceTimeoutMs: 2000,
    },
  })
  await app.ready()
  seed(app)
  ownerToken = await login('owner', 'owner123')
})

test.after(async () => {
  await app.close()
  await closeServer(complianceServer.server)
  await closeServer(memoryServer.server)
})

test('T6B.1 输出合规闸门：违规块不达浏览器 + 不落库不结算', async () => {
  await createConv(ownerToken, 'conv-gate-1')
  const beforeMsg = app.db.prepare(`SELECT COUNT(*) AS c FROM message WHERE conversation_id = 'conv-gate-1'`).get().c
  const beforeBal = (await inject('GET', '/api/v1/credit/balance', ownerToken)).json().balance

  const res = await inject('POST', '/api/v1/chat/messages', ownerToken, {
    conversation_id: 'conv-gate-1', content: '给我写一条医美广告文案',
  })
  assert.equal(res.statusCode, 200, res.body)

  const events = parseSSE(res.body)
  const deltas = events.filter((e) => e.event === 'delta').map((e) => JSON.parse(e.data).text).join('')
  const errs = events.filter((e) => e.event === 'error').map((e) => JSON.parse(e.data))

  // 1. 通过闸门的 delta 只有第一句（修正后），不含违规文本
  assert.ok(!deltas.includes('无痛'), `违规文本不应达浏览器，实际: ${deltas}`)
  assert.ok(!deltas.includes('顶级'), `修正词未生效，实际: ${deltas}`)
  assert.ok(deltas.includes('优质'), `general 修正应生效: ${deltas}`)
  assert.ok(deltas.includes('我们医院提供'), `第一句应正常转发: ${deltas}`)
  // 2. 违规块之后的文本（请放心咨询）不达浏览器
  assert.ok(!deltas.includes('请放心咨询'), '闸门关闭后后续文本不应转发')

  // 3. 错误事件：COMPLIANCE_BLOCKED_OUTPUT
  const blockedErr = errs.find((e) => e.code === 'COMPLIANCE_BLOCKED_OUTPUT')
  assert.ok(blockedErr, `应有 COMPLIANCE_BLOCKED_OUTPUT 错误，实际: ${JSON.stringify(errs)}`)
  assert.ok(blockedErr.message.includes('红线'), '错误应含红线原因')

  // 4. 不落库（user/assistant 均不写入）
  const afterMsg = app.db.prepare(`SELECT COUNT(*) AS c FROM message WHERE conversation_id = 'conv-gate-1'`).get().c
  assert.equal(afterMsg, beforeMsg, '被拦截回复不应落库')

  // 5. 不结算（turns 不变、余额不变）
  const conv = app.db.prepare('SELECT turns, billing_state FROM conversation WHERE id = ?').get('conv-gate-1')
  assert.equal(conv.turns, 0, '被拦截轮次不应递增')
  const afterBal = (await inject('GET', '/api/v1/credit/balance', ownerToken)).json().balance
  assert.equal(afterBal, beforeBal, '被拦截回复不应扣费')
})

test('T6B.2 输出合规闸门：无违禁词回复正常通过（不误伤）', async () => {
  // 独立实例（无违规注入）验证闸门不误伤
  const app2 = buildApp({
    security: false,
    dbPath: ':memory:',
    jwtSecret: 't6b2-secret',
    chat: {
      hermes: { mode: 'mock', streamDelayMs: 1, chunkSize: 6, mockReply: '植发术后请保持头皮清洁。两周内避免剧烈运动。' },
      memoryBaseUrl: memoryServer.url,
      complianceBaseUrl: complianceServer.url,
      complianceTimeoutMs: 2000,
    },
  })
  await app2.ready()
  seed(app2)
  const token = await (async () => {
    const r = await app2.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { account: 'owner', password: 'owner123' } })
    return r.json().token
  })()
  const r = await app2.inject({
    method: 'POST', url: '/api/v1/credit/conversations',
    headers: { authorization: `Bearer ${token}` },
    payload: { conversation_id: 'conv-gate-2', scenario_id: 'industry-worker' },
  })
  assert.equal(r.statusCode, 200, r.body)
  const res = await app2.inject({
    method: 'POST', url: '/api/v1/chat/messages',
    headers: { authorization: `Bearer ${token}` },
    payload: { conversation_id: 'conv-gate-2', content: '术后注意事项？' },
  })
  assert.equal(res.statusCode, 200, res.body)
  const events = parseSSE(res.body)
  const deltas = events.filter((e) => e.event === 'delta').map((e) => JSON.parse(e.data).text).join('')
  const errs = events.filter((e) => e.event === 'error')
  assert.equal(errs.length, 0, `不应有错误事件: ${JSON.stringify(events)}`)
  assert.ok(deltas.includes('植发术后'), '无违禁词回复应完整转发')
  assert.ok(deltas.includes('两周内避免'), '多句回复应全部转发')

  // 正常落库
  const msgCount = app2.db.prepare(`SELECT COUNT(*) AS c FROM message WHERE conversation_id = 'conv-gate-2' AND role='assistant'`).get().c
  assert.equal(msgCount, 1, '通过闸门的回复应落库')
  await app2.close()
})
