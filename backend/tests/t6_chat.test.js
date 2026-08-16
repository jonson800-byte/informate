/**
 * Informate Chat 会话服务 T6 测试（tsx --test 运行）
 *
 * 验证点（PRD FR-201/204/205/207 + AC-201/205 + 技术方案 §2.3/§5.2 + Q30）：
 *   1. 会话归属校验：无 token → 401；跨租户会话 → 403；不存在 → 404
 *   2. 发消息 → SSE 流式回复（delta 事件）→ AI 回复落库 → 轮次递增（AC-201）
 *   3. 轮次计费：第 20 轮末提示含轮用满、第 21 轮起扣 1 积分（AC-205）
 *   4. 第 51 轮拦截：turns>=50 → 429，提示新开对话，不扣费（FR-205）
 *   5. 合规违规拦截：blocked → 400 COMPLIANCE_BLOCKED，不生成不落库（FR-204）
 *   6. 记忆链路（Q30）：recall 注入（租户 bank + 行业 bank）+ writeMemory 异步写入调用记录
 *
 * 测试替身：合规服务与 Hindsight 均为本地 mock HTTP 服务（随机端口注入 buildApp），
 * Hermes 生成器用 mock 模式（本地模拟流式，1ms 分块）。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const bcrypt = require('bcryptjs')
const { buildApp } = require('../src/app.ts')

// ---------- 工具：mock HTTP 服务（记录全部请求） ----------
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

/** 轮询等待条件成立（记忆写入是异步 fire-and-forget） */
async function waitFor(fn, timeoutMs = 3000, intervalMs = 20) {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 解析 SSE 文本 → [{event, data(JSON 字符串)}] */
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

// ---------- 种子（对齐 T5：主租户 t-001 医美/植发 + 价格配置） ----------
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
        .run(`tp-${String(i + 1).padStart(3, '0')}`, key, value, '2026-01-01 00:00:00', 'seed', 'T6 测试价格')
    })
  })()
}

let app
let ownerToken
let otherToken
let complianceServer
let memoryServer
/** 合规服务行为开关：'pass' 通过 / 'block' 拦截 */
let complianceMode = 'pass'

async function login(account, password) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { account, password } })
  assert.equal(res.statusCode, 200, `登录失败 ${account}: ${res.body}`)
  return res.json().token
}

function inject(method, url, token, payload) {
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  return app.inject({ method, url, headers, payload })
}

/** 创建会话（走 credit 接口，冻结 15） */
async function createConv(token, conversationId) {
  const res = await inject('POST', '/api/v1/credit/conversations', token, {
    conversation_id: conversationId, scenario_id: 'industry-worker',
  })
  assert.equal(res.statusCode, 200, res.body)
  return res.json()
}

/** 发消息，返回完整 SSE 文本 */
async function sendMessage(token, conversationId, content) {
  return inject('POST', '/api/v1/chat/messages', token, { conversation_id: conversationId, content })
}

test.before(async () => {
  // 合规服务 mock（默认通过；测试 5 切 block）
  complianceServer = await startMockServer((req, body) => {
    if (req.url !== '/check') return { status: 404, body: { error: 'not found' } }
    if (complianceMode === 'block') {
      return {
        status: 200,
        body: {
          passed: false, blocked: true, fixed_text: null,
          reason: '命中《医疗广告管理办法》红线：含绝对化用语「最佳」，需人工审核',
          fixes: [], rule_packs: ['general', 'medical'], mode: 'text',
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
  // Hindsight mock（Q30：recall + write）
  memoryServer = await startMockServer((req, body) => {
    if (req.url.includes('/memories/recall')) {
      return {
        status: 200,
        body: {
          results: [
            { text: '植发术后护理：保持清洁、避免抓挠（行业知识注入验证）', entities: [], tags: ['sub_industry:植发'], scores: [0.9] },
            { text: '医美咨询通用话术：先了解客户诉求再给方案', entities: [], tags: ['general'], scores: [0.6] },
          ],
        },
      }
    }
    if (req.url.includes('/memories')) {
      return {
        status: 200,
        body: {
          success: true,
          bank_id: decodeURIComponent(req.url.split('/banks/')[1].split('/')[0]),
          items_count: body?.items?.length ?? 0,
          async: false,
        },
      }
    }
    return { status: 404, body: { error: 'not found' } }
  })

  app = buildApp({
    dbPath: ':memory:',
    jwtSecret: 't6-test-secret',
    chat: {
      hermes: { mode: 'mock', streamDelayMs: 1, chunkSize: 20 },
      memoryBaseUrl: memoryServer.url,
      complianceBaseUrl: complianceServer.url,
      complianceTimeoutMs: 2000,
    },
  })
  await app.ready()
  seed(app)
  ownerToken = await login('owner', 'owner123')
  // 第二租户（跨租户越权测试）
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { name: '另一机构', industry: '医美', owner_account: 'other', owner_password: 'other123' },
  })
  assert.equal(reg.statusCode, 201, reg.body)
  otherToken = reg.json().token
})

test.after(async () => {
  await app.close()
  await closeServer(complianceServer.server)
  await closeServer(memoryServer.server)
})

// ---------- 1. 会话归属校验（401/403/404） ----------
test('T6.1 会话归属校验：无 token 401 / 跨租户 403 / 不存在 404', async () => {
  await createConv(ownerToken, 'conv-t6-1')

  // 无 token → 401
  let res = await inject('POST', '/api/v1/chat/messages', null, { conversation_id: 'conv-t6-1', content: '你好' })
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'UNAUTHORIZED')

  // 跨租户 → 403
  res = await sendMessage(otherToken, 'conv-t6-1', '你好')
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'FORBIDDEN')

  // 会话不存在 → 404
  res = await sendMessage(ownerToken, 'conv-not-exist', '你好')
  assert.equal(res.statusCode, 404)

  // 越权访问历史消息同样 403
  res = await app.inject({
    method: 'GET', url: '/api/v1/chat/messages?conversation_id=conv-t6-1',
    headers: { authorization: `Bearer ${otherToken}` },
  })
  assert.equal(res.statusCode, 403)
})

// ---------- 2. 发消息 → SSE 流式 → 落库 → 轮次递增 ----------
test('T6.2 发消息：SSE 流式回复（delta/round_complete）+ AI 回复落库 + 轮次递增', async () => {
  const res = await sendMessage(ownerToken, 'conv-t6-1', '帮我写植发项目朋友圈文案')
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(res.headers['content-type'].includes('text/event-stream'), '应为 SSE 响应')

  const events = parseSSE(res.body)
  const deltas = events.filter((e) => e.event === 'delta').map((e) => JSON.parse(e.data).text)
  assert.ok(deltas.length >= 3, `应有多个 delta 分块，实际 ${deltas.length}`)
  const full = deltas.join('')
  assert.ok(full.includes('植发项目朋友圈文案'), '回复应引用用户消息')
  assert.ok(full.includes('Mock'), 'mock 模式回复')

  const done = events.find((e) => e.event === 'round_complete')
  assert.ok(done, '缺少 round_complete 事件')
  const rc = JSON.parse(done.data)
  assert.equal(rc.turns, 1)
  assert.equal(rc.credit_charged, 0, '第 1 轮含轮内不扣费')

  // 消息落库：user + assistant
  const rows = app.db.prepare(
    `SELECT role, content, round_no, credit_charged, compliance_passed FROM message WHERE conversation_id = 'conv-t6-1' ORDER BY rowid`,
  ).all()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].role, 'user')
  assert.equal(rows[0].content, '帮我写植发项目朋友圈文案')
  assert.equal(rows[0].round_no, 1)
  assert.equal(rows[0].compliance_passed, 1)
  assert.equal(rows[1].role, 'assistant')
  assert.equal(rows[1].round_no, 1)
  assert.equal(rows[1].credit_charged, 0)
  assert.ok(rows[1].content.length > 0, 'AI 回复应非空')

  // 轮次递增
  const conv = app.db.prepare('SELECT turns, billing_state FROM conversation WHERE id = ?').get('conv-t6-1')
  assert.equal(conv.turns, 1)
  assert.equal(conv.billing_state, 'frozen')

  // 历史消息接口
  const hist = await app.inject({
    method: 'GET', url: '/api/v1/chat/messages?conversation_id=conv-t6-1',
    headers: { authorization: `Bearer ${ownerToken}` },
  })
  assert.equal(hist.statusCode, 200)
  assert.equal(hist.json().messages.length, 2)

  // 余额：500 - 15（会话冻结）= 485
  const bal = await inject('GET', '/api/v1/credit/balance', ownerToken)
  assert.equal(bal.json().balance, 485)
})

// ---------- 3. 第 20 轮末提示 + 第 21 轮起扣 1 积分 ----------
test('T6.3 轮次计费：第 20 轮末提示含轮用满，第 21 轮扣 1 积分（AC-205）', async () => {
  // 快进到 19 轮（已发生 1 轮，再补 18 轮）
  app.db.prepare(`UPDATE conversation SET turns = 19 WHERE id = 'conv-t6-1'`).run()

  // 第 20 轮：含轮用满提示，不扣费
  let res = await sendMessage(ownerToken, 'conv-t6-1', '第 20 轮')
  assert.equal(res.statusCode, 200, res.body)
  let events = parseSSE(res.body)
  let hint = events.find((e) => e.event === 'round_hint')
  assert.ok(hint, '第 20 轮末应有 round_hint')
  assert.equal(JSON.parse(hint.data).type, 'included_used')
  let rc = JSON.parse(events.find((e) => e.event === 'round_complete').data)
  assert.equal(rc.turns, 20)
  assert.equal(rc.credit_charged, 0)
  let bal = await inject('GET', '/api/v1/credit/balance', ownerToken)
  assert.equal(bal.json().balance, 485, '20 轮内不追加扣费')

  // 第 21 轮：超轮续扣 1 积分
  res = await sendMessage(ownerToken, 'conv-t6-1', '第 21 轮')
  assert.equal(res.statusCode, 200, res.body)
  events = parseSSE(res.body)
  hint = events.find((e) => e.event === 'round_hint')
  assert.equal(JSON.parse(hint.data).type, 'extra_round')
  rc = JSON.parse(events.find((e) => e.event === 'round_complete').data)
  assert.equal(rc.turns, 21)
  assert.equal(rc.credit_charged, 1, '第 21 轮应扣 1 积分')

  // 余额：485 - 1 = 484
  bal = await inject('GET', '/api/v1/credit/balance', ownerToken)
  assert.equal(bal.json().balance, 484)

  // 轮次结算流水：freeze + settle（round_no=21）
  const settle = app.db.prepare(
    `SELECT * FROM credit_txn WHERE ref_type='conversation' AND ref_id='conv-t6-1' AND type='settle' AND round_no=21`,
  ).get()
  assert.ok(settle, '缺少第 21 轮 settle 流水')
  assert.equal(settle.amount, 1)

  const conv = app.db.prepare('SELECT turns, settled_credit FROM conversation WHERE id = ?').get('conv-t6-1')
  assert.equal(conv.turns, 21)
  assert.equal(conv.settled_credit, 1)

  // 助手消息 credit_charged 落库
  const lastMsg = app.db.prepare(
    `SELECT credit_charged FROM message WHERE conversation_id='conv-t6-1' AND role='assistant' ORDER BY rowid DESC LIMIT 1`,
  ).get()
  assert.equal(lastMsg.credit_charged, 1)
})

// ---------- 4. 第 51 轮拦截 → 429 ----------
test('T6.4 第 51 轮拦截：turns>=50 → 429，不扣费，提示新开对话', async () => {
  await createConv(ownerToken, 'conv-t6-51')
  // 484 - 15 = 469（新会话冻结）
  app.db.prepare(`UPDATE conversation SET turns = 50 WHERE id = 'conv-t6-51'`).run()

  const res = await sendMessage(ownerToken, 'conv-t6-51', '第 51 轮')
  assert.equal(res.statusCode, 429)
  const body = res.json()
  assert.equal(body.code, 'ROUND_LIMIT_EXCEEDED')
  assert.ok(body.message.includes('新开对话'), '应提示建议新开对话')
  assert.equal(body.details.round_limit, 50)

  // 不冻结不扣费：无新增消息、turns 不变、余额不变
  const msgCount = app.db.prepare(`SELECT COUNT(*) AS c FROM message WHERE conversation_id = 'conv-t6-51'`).get()
  assert.equal(msgCount.c, 0)
  const conv = app.db.prepare('SELECT turns FROM conversation WHERE id = ?').get('conv-t6-51')
  assert.equal(conv.turns, 50)
  const bal = await inject('GET', '/api/v1/credit/balance', ownerToken)
  assert.equal(bal.json().balance, 469)
})

// ---------- 5. 合规违规拦截 → 400 ----------
test('T6.5 合规违规拦截：blocked → 400，不生成不落库不扣费', async () => {
  complianceMode = 'block'
  try {
    const beforeCount = app.db.prepare(`SELECT COUNT(*) AS c FROM message WHERE conversation_id = 'conv-t6-1'`).get().c
    const res = await sendMessage(ownerToken, 'conv-t6-1', '这是全行业最佳方案，可根治脱发')
    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.equal(body.code, 'COMPLIANCE_BLOCKED')
    assert.ok(body.message.includes('合规检查'), '应返回拦截提示')
    assert.ok(body.details.reason.includes('最佳'), '应返回拦截原因')

    // 未产生消息、轮次不变、未扣费
    const msgCount = app.db.prepare(`SELECT COUNT(*) AS c FROM message WHERE conversation_id = 'conv-t6-1'`).get()
    assert.equal(msgCount.c, beforeCount, '拦截不应新增消息')
    const conv = app.db.prepare('SELECT turns FROM conversation WHERE id = ?').get('conv-t6-1')
    assert.equal(conv.turns, 21)
    const bal = await inject('GET', '/api/v1/credit/balance', ownerToken)
    assert.equal(bal.json().balance, 469, '拦截不应扣费')
  } finally {
    complianceMode = 'pass'
  }
})

// ---------- 6. 记忆链路（Q30）：recall 注入 + writeMemory 异步写入 ----------
test('T6.6 记忆链路：recall 注入（租户/行业 bank）+ writeMemory 异步写入调用记录', async () => {
  const before = memoryServer.records.length
  const res = await sendMessage(ownerToken, 'conv-t6-1', '植发术后多久可以洗头')
  assert.equal(res.statusCode, 200, res.body)
  // 第 22 轮：469 - 1 = 468
  const rc = JSON.parse(parseSSE(res.body).find((e) => e.event === 'round_complete').data)
  assert.equal(rc.turns, 22)
  assert.equal(rc.credit_charged, 1)

  // 本轮新增记录（用实时 records 数组，writeMemory 是异步 fire-and-forget）
  const isNew = (r) => memoryServer.records.indexOf(r) >= before
  const newRecords = () => memoryServer.records.filter(isNew)

  // a) recall 调用记录：租户私有 bank（P1）
  const tenantRecall = newRecords().find((r) =>
    r.method === 'POST' && r.url.includes('/informate-tenant-t-001-industry-worker/memories/recall'))
  assert.ok(tenantRecall, '缺少租户 bank recall 调用')
  assert.ok(tenantRecall.body.query.includes('植发术后多久可以洗头'), 'recall query 应为用户消息')

  // b) recall 调用记录：行业 bank（P2/P3，中文 bank_id 已 URL 编码）
  const industryRecall = newRecords().find((r) =>
    r.method === 'POST' && r.url.includes('/informate-industry_%E5%8C%BB%E7%BE%8E/memories/recall'))
  assert.ok(industryRecall, '缺少行业 bank recall 调用（informate-industry_医美）')

  // c) writeMemory 异步写入调用记录（轮询等待 fire-and-forget 落定）
  const write = await waitFor(() => newRecords().find((r) =>
    r.method === 'POST' && r.url.includes('/informate-tenant-t-001-industry-worker/memories') &&
    !r.url.includes('/recall')))
  assert.ok(write, '缺少记忆写入调用记录')
  assert.ok(Array.isArray(write.body.items) && write.body.items.length === 1)
  assert.ok(write.body.items[0].content.includes('植发术后多久可以洗头'), '记忆内容应为用户消息')
  assert.ok(write.body.items[0].tags.includes('chat'), '记忆 tags 应含场景标记')

  // 余额校验：第 22 轮续扣 1 积分 → 468
  const bal = await inject('GET', '/api/v1/credit/balance', ownerToken)
  assert.equal(bal.json().balance, 468)
})

// ---------- 7. 已结束会话禁发消息（P0-4 显式终态闭环） ----------
test('T6.7 已结束会话发消息 → 400 CONVERSATION_CLOSED', async () => {
  await createConv(ownerToken, 'conv-closed')
  const end = await inject('POST', '/api/v1/credit/conversations/conv-closed/end', ownerToken, {})
  assert.equal(end.statusCode, 200, end.body)

  const res = await sendMessage(ownerToken, 'conv-closed', '还能继续问吗')
  assert.equal(res.statusCode, 409, '已结束会话发消息应 409')
  assert.ok(res.json().message.includes('新开对话'))
})

// ---------- 8. 服务端会话列表（P1-1） ----------
test('T6.8 会话列表：GET /chat/conversations 按场景分页 + title 摘要', async () => {
  const res = await inject('GET', '/api/v1/chat/conversations?scenario_id=industry-worker&pageSize=20', ownerToken)
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.ok(Array.isArray(body.data))
  assert.ok(body.data.length >= 3, `应有多个会话，实际 ${body.data.length}`)
  const mine = body.data.find((c) => c.id === 'conv-t6-1')
  assert.ok(mine, '应有 conv-t6-1')
  assert.equal(mine.scenario_id, 'industry-worker')
  assert.equal(mine.status, 'active')
  assert.equal(typeof mine.title, 'string')
  assert.ok(mine.message_count >= 1, '应有消息数')

  // 场景过滤
  const imgRes = await inject('GET', '/api/v1/chat/conversations?scenario_id=nonexist', ownerToken)
  assert.equal(imgRes.json().data.length, 0, '无关场景不应返回')
})
