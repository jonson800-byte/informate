const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHermesClient } = require('../src/services/hermesClient.ts')
const { createSeedreamClient } = require('../src/services/seedream.ts')

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` })
    })
  })
}

test('T17.1 DeepSeek 直连：OpenAI SSE、租户标识和 token 用量', async (t) => {
  let requestBody
  const mock = await startServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requestBody = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'ds-request-1' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '，世界' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  t.after(() => mock.server.close())
  const calls = []
  const client = createHermesClient({
    mode: 'deepseek', baseUrl: mock.baseUrl, apiKey: 'test-key', model: 'deepseek-test',
    onCall: (call) => calls.push(call),
  })
  let output = ''
  for await (const chunk of client.streamChat({
    messages: [{ role: 'user', content: '测试' }], tenantId: 'tenant-001', sessionId: 'conv-001',
  })) output += chunk
  assert.equal(output, '你好，世界')
  assert.equal(requestBody.model, 'deepseek-test')
  assert.equal(requestBody.user, 'tenant-001')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'deepseek')
  assert.equal(calls[0].tokensIn, 12)
  assert.equal(calls[0].tokensOut, 4)
})

test('T17.2 Seedream 真实模式：REST 响应落盘并记录调用', async (t) => {
  let requestBody
  const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const mock = await startServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requestBody = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'sd-request-1' })
      res.end(JSON.stringify({ data: [{ b64_json: onePixelPng }] }))
    })
  })
  t.after(() => mock.server.close())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'informate-seedream-real-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const calls = []
  const client = createSeedreamClient({
    artifactsDir: dir, mode: 'real', apiKey: 'test-key', model: 'seedream-test', apiBase: mock.baseUrl,
    maxRetries: 0, onCall: (call) => calls.push(call),
  })
  const result = await client.generateImage({ taskId: 'real-1', prompt: '一张品牌海报' })
  assert.equal(result.mode, 'real')
  assert.equal(result.model, 'seedream-test')
  assert.ok(fs.statSync(path.join(dir, result.file)).size > 0)
  assert.equal(requestBody.watermark, true)
  assert.equal(calls[0].status, 'success')
  assert.equal(calls[0].requestId, 'sd-request-1')
})
