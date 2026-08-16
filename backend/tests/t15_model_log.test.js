/**
 * Informate P0-1 统一模型适配层测试：错误分类 + 重试退避 + 调用日志落库
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyModelError, ModelError, retryWithBackoff, logModelCall } = require('../src/services/modelLog.ts')
const { createDb } = require('../src/db/index.ts')

test('T15.1 错误分类：HTTP 状态优先', () => {
  assert.equal(classifyModelError(new Error('x'), 'hermes', 429).cls, 'rate_limited')
  assert.equal(classifyModelError(new Error('x'), 'hermes', 429).retryable, true)
  assert.equal(classifyModelError(new Error('x'), 'seedream', 401).cls, 'auth')
  assert.equal(classifyModelError(new Error('x'), 'seedream', 401).retryable, false)
  assert.equal(classifyModelError(new Error('x'), 'hermes', 503).cls, 'server')
  assert.equal(classifyModelError(new Error('x'), 'hermes', 503).retryable, true)
  assert.equal(classifyModelError(new Error('x'), 'hermes', 400).cls, 'bad_request')
  assert.equal(classifyModelError(new Error('x'), 'hermes', 400).retryable, false)
})

test('T15.2 错误分类：消息特征（无状态时）', () => {
  assert.equal(classifyModelError(new Error('rate limit exceeded')).cls, 'rate_limited')
  assert.equal(classifyModelError(new Error('首包超时（>40000ms）')).cls, 'timeout')
  assert.equal(classifyModelError(new Error('fetch failed: ECONNREFUSED')).cls, 'network')
  assert.equal(classifyModelError(new Error('HTTP 500 Internal')).cls, 'server')
  assert.equal(classifyModelError(new Error('密钥错误 401')).cls, 'auth')
  assert.equal(classifyModelError(new Error('其他错误')).cls, 'unknown')
})

test('T15.3 重试退避：可重试错误按次数重试，不可重试立即抛出', async () => {
  let calls = 0
  const fn = async () => {
    calls++
    if (calls < 3) throw new ModelError('限流', 'rate_limited', 'seedream', true)
    return 'ok'
  }
  const r = await retryWithBackoff(fn, { maxRetries: 2, baseMs: 1 })
  assert.equal(r, 'ok')
  assert.equal(calls, 3, '应重试 2 次后成功')

  // 不可重试错误立即抛
  await assert.rejects(
    () => retryWithBackoff(() => { throw new ModelError('参数错误', 'bad_request', 'seedream', false) }, { maxRetries: 2, baseMs: 1 }),
    /参数错误/,
  )
})

test('T15.4 调用日志落库：成功/错误 + 字段校验', () => {
  const db = createDb(':memory:')
  const { runMigrations } = require('../src/db/migrate.ts')
  runMigrations(db, require('node:path').join(__dirname, '..', 'src', 'db', 'migrations'))
  logModelCall(db, { provider: 'hermes', model: 'hermes-agent', requestId: 'hm-test-1', kind: 'chat', latencyMs: 1234, status: 'success', tokensIn: 100, tokensOut: 50 })
  logModelCall(db, { provider: 'seedream', model: 'seedream-5.0', kind: 'image', latencyMs: 8000, status: 'error', errorClass: 'timeout', errorMsg: '首包超时' })
  const rows = db.prepare('SELECT * FROM model_call_log ORDER BY created_at').all()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].provider, 'hermes')
  assert.equal(rows[0].kind, 'chat')
  assert.equal(rows[0].status, 'success')
  assert.equal(rows[0].latency_ms, 1234)
  assert.equal(rows[1].error_class, 'timeout')
  assert.equal(rows[1].error_msg, '首包超时')
  db.close()
})
