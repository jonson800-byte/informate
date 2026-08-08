#!/usr/bin/env node
/**
 * Informate T14 性能压测驱动（mock Hermes Chat + mock Seedream 生图 全链路）
 *
 * 覆盖（对应 PRD NFR-13/14/15、技术方案 T14 验收）：
 *   A) 5 并发会话 × 每会话 3 轮 chat（SSE 流式，mock Hermes）——记录首包/完整回复耗时
 *   B) 10 并发生图任务（冻结 15 → execute 入队 → 轮询完成，mock Seedream）——记录完成耗时
 *   C) 计费验证：
 *      C1 会话冻结 10
 *      C2 超轮 1 分（第 21 轮）＋重放幂等
 *      C2b 边界：第 20 轮 charge=0（19 轮后发第 20 轮不扣费，含轮边界）
 *      C2c 边界：第 51 轮 429 ROUND_LIMIT_EXCEEDED（单会话 50 轮上限，不冻结不扣费）
 *      C3 生图冻结 15 / settle 15 / artifact success（含服务端 completed_at 校准）
 *      C4 余额守恒
 *   D) 计费端点计时采样：会话创建（POST /credit/conversations）、轮次结算
 *      （POST /credit/conversations/:id/rounds）、生图冻结（POST /credit/image-tasks）
 *      的逐次 ms 数组写入 stress_raw JSON（可复算报告 §3.4 全部数字）
 *
 * 用法：
 *   node backend/tests/stress/stress_driver.mjs [--json out.json]
 * 环境变量（可调负载）：
 *   BASE_URL=http://127.0.0.1:8080/api/v1  ACCOUNT=owner  PASSWORD=owner123
 *   CHAT_SESSIONS=5  CHAT_ROUNDS=3  IMAGE_TASKS=10
 *
 * 说明：mock 模式已足够验证平台链路（计费/SSE/队列/并发/幂等/轮次边界）；真实 LLM/生图
 * 延迟试点时另行评估（报告结论已降级为「mock 链路有条件通过」）。
 */
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8080/api/v1'
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '..', '..', 'data', 'informate.db')
const ACCOUNT = process.env.ACCOUNT ?? 'owner'
const PASSWORD = process.env.PASSWORD ?? 'owner123'
const CHAT_SESSIONS = Number(process.env.CHAT_SESSIONS ?? 5)
const CHAT_ROUNDS = Number(process.env.CHAT_ROUNDS ?? 3)
const IMAGE_TASKS = Number(process.env.IMAGE_TASKS ?? 10)
const POLL_INTERVAL_MS = 400
const IMAGE_TIMEOUT_MS = 90000
const CHAT_TIMEOUT_MS = 60000
const IDLE_TIMEOUT_MS = 30000
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

const stats = {
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  balance: { before: null, after: null, expected: null },
  chat: { rounds: 0, ok: 0, firstMs: [], fullMs: [], errors: [], statusCounts: {} },
  image: { tasks: 0, ok: 0, doneMs: [], freezes: [], errors: [], statusCounts: {} },
  billing: {
    // 计费端点逐次计时（ms，原始采样，可复算）——P1-10 整改
    sessionCreateMs: [],
    roundSettleMs: [],
    imageFreezeMs: [],
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1 }

/** P 分位（nearest-rank；小样本下 P95≈max，报告注明样本量） */
function pct(arr, p) {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)
  return Math.round(s[idx] * 10) / 10
}
const fmt = (v) => (v === null ? '-' : `${v} ms`)

/** 普通 JSON API 调用（带超时） */
async function api(method, urlPath, { token, body, timeoutMs = 30000 } = {}) {
  const t0 = performance.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  let res
  try {
    res = await fetch(`${BASE}${urlPath}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, status: 0, code: e.name === 'AbortError' ? 'TIMEOUT' : e.message, ms: performance.now() - t0, body: null }
  }
  clearTimeout(timer)
  let json = null
  try { json = await res.json() } catch { /* 非 JSON（如 SSE hijack 误用） */ }
  return { ok: res.ok, status: res.status, code: json?.code ?? null, ms: performance.now() - t0, body: json }
}

function parseSseBlock(block) {
  let event = 'message'
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return null
  try { return { event, data: JSON.parse(data) } } catch { return { event, data: null } }
}

/** 单轮 chat：POST /chat/messages（SSE），测首包（首个 delta）与完整回复（round_complete） */
async function chatRound({ token, convId, content }) {
  const t0 = performance.now()
  const ac = new AbortController()
  let lastDataAt = Date.now()
  const idleWatchdog = setInterval(() => {
    if (Date.now() - lastDataAt > IDLE_TIMEOUT_MS) ac.abort()
  }, 1000)
  const hardTimer = setTimeout(() => ac.abort(), CHAT_TIMEOUT_MS)
  let res
  try {
    res = await fetch(`${BASE}/chat/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversation_id: convId, content }),
      signal: ac.signal,
    })
  } catch (e) {
    clearTimeout(hardTimer); clearInterval(idleWatchdog)
    return { ok: false, status: 0, code: e.name === 'AbortError' ? 'TIMEOUT' : e.message, firstMs: null, fullMs: null, events: [] }
  }
  if (!res.ok || !res.body) {
    clearTimeout(hardTimer); clearInterval(idleWatchdog)
    let body = null
    try { body = await res.json() } catch { /* ignore */ }
    return { ok: false, status: res.status, code: body?.code ?? null, firstMs: null, fullMs: null, events: [], ms: performance.now() - t0 }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let firstMs = null
  let roundComplete = false
  let errorEvent = null
  const events = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      lastDataAt = Date.now()
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = parseSseBlock(block)
        if (!ev) continue
        events.push(ev)
        if (ev.event === 'delta' && firstMs === null) firstMs = performance.now() - t0
        if (ev.event === 'round_complete') roundComplete = true
        if (ev.event === 'error') errorEvent = ev.data
      }
    }
  } catch (e) {
    clearTimeout(hardTimer); clearInterval(idleWatchdog)
    return {
      ok: false, status: 0,
      code: e.name === 'AbortError' ? (roundComplete ? 'STREAM_CUT_AFTER_COMPLETE' : 'TIMEOUT') : e.message,
      firstMs, fullMs: null, events, errorEvent,
    }
  }
  clearTimeout(hardTimer); clearInterval(idleWatchdog)
  return { ok: roundComplete && !errorEvent, status: 200, code: errorEvent?.code ?? null, firstMs, fullMs: performance.now() - t0, events, errorEvent }
}

/** 单生图任务：冻结 15 → execute 入队 → 轮询 success/failed */
async function imageTask({ token, taskId }) {
  const t0 = performance.now()
  const freeze = await api('POST', '/credit/image-tasks', {
    token, body: { task_id: taskId, scenario_id: 'generate_image', idempotency_key: `img:${taskId}` },
  })
  stats.billing.imageFreezeMs.push(freeze.ms) // 计费端点计时采样（生图冻结）
  if (!freeze.ok) return { ok: false, phase: 'freeze', status: freeze.status, code: freeze.code, freeze: null, ms: freeze.ms }
  const freezeAmt = freeze.body?.freeze ?? 0
  const exe = await api('POST', `/image-tasks/${encodeURIComponent(taskId)}/execute`, {
    token, body: { prompt: '医美营销海报（T14 压测）' },
  })
  if (!exe.ok) return { ok: false, phase: 'execute', status: exe.status, code: exe.code, freeze: freezeAmt, ms: performance.now() - t0 }
  let finalStatus = null
  let last = null
  let pollErrors = 0
  while (performance.now() - t0 < IMAGE_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS)
    const st = await api('GET', `/image-tasks/${encodeURIComponent(taskId)}`, { token, timeoutMs: 10000 })
    if (!st.ok) { pollErrors++; last = st; continue }
    last = st
    finalStatus = st.body?.status
    if (finalStatus === 'success' || finalStatus === 'failed' || finalStatus === 'blocked') break
  }
  const ms = performance.now() - t0
  return {
    ok: finalStatus === 'success', phase: finalStatus ? 'done' : 'poll-timeout',
    status: last?.status ?? 0, code: last?.code ?? null, finalStatus,
    freeze: freezeAmt, settled: last?.body?.settled ?? 0, refunded: last?.body?.refunded ?? 0,
    ms, pollErrors,
  }
}

// ---------- Phase A：5 并发会话 × 3 轮 chat ----------
async function phaseA(token, convIds) {
  const started = performance.now()
  const results = await Promise.all(convIds.map(async (convId, i) => {
    const create = await api('POST', '/credit/conversations', {
      token, body: { scenario_id: 'industry_work_assistant', conversation_id: convId, idempotency_key: `conv:${convId}` },
    })
    stats.billing.sessionCreateMs.push(create.ms) // 计费端点计时采样（会话创建）
    bump(stats.chat.statusCounts, create.status)
    const rounds = []
    for (let r = 1; r <= CHAT_ROUNDS; r++) {
      const rr = await chatRound({ token, convId, content: `压测消息 会话${i + 1} 第${r}轮 请介绍医美行业工作助手能力` })
      stats.chat.rounds++
      if (rr.ok) {
        stats.chat.ok++
        stats.chat.firstMs.push(rr.firstMs)
        stats.chat.fullMs.push(rr.fullMs)
        bump(stats.chat.statusCounts, 200)
      } else {
        stats.chat.errors.push({ convId, round: r, status: rr.status, code: rr.code })
        bump(stats.chat.statusCounts, rr.status)
      }
      rounds.push(rr)
      await sleep(80) // 模拟用户思考间隔，避免轮间 0 间隔
    }
    return { convId, createStatus: create.status, freeze: create.body?.freeze ?? null, rounds }
  }))
  return { ms: performance.now() - started, results }
}

// ---------- Phase B：10 并发生图 ----------
async function phaseB(token, taskIds) {
  const started = performance.now()
  const results = await Promise.all(taskIds.map(async (taskId) => {
    const r = await imageTask({ token, taskId })
    stats.image.tasks++
    if (r.ok) {
      stats.image.ok++
      stats.image.doneMs.push(r.ms)
      stats.image.freezes.push(r.freeze)
      bump(stats.image.statusCounts, 200)
    } else {
      stats.image.errors.push({ taskId, phase: r.phase, status: r.status, code: r.code, finalStatus: r.finalStatus ?? null })
      bump(stats.image.statusCounts, r.status)
    }
    return { taskId, ...r }
  }))
  return { ms: performance.now() - started, results }
}

// ---------- Phase C：计费验证（含轮次边界 API 用例 C2b/C2c，P1-16 整改） ----------
async function phaseC(token, chatConvs, taskIds, balanceBefore) {
  const Database = require('better-sqlite3')
  const db = new Database(DB_PATH)
  const billing = { sessionFreeze10: null, overRound1: null, round20Free: null, round51Limit: null, imageFreeze15: null, balance: null }

  // 计费验证辅助会话创建（计时采样一并记录）
  const createBillConv = async (id) => {
    const c = await api('POST', '/credit/conversations', {
      token, body: { scenario_id: 'industry_work_assistant', conversation_id: id, idempotency_key: `conv:${id}` },
    })
    stats.billing.sessionCreateMs.push(c.ms)
    return c
  }

  // C1 会话冻结 10（DB：conversation.frozen_credit + credit_txn freeze）
  const convRows = chatConvs.map((id) =>
    db.prepare(`SELECT id, billing_state, turns, frozen_credit, settled_credit FROM conversation WHERE id = ?`).get(id))
  const c1All10 = convRows.every((c) => c && c.frozen_credit === 10)
  billing.sessionFreeze10 = { pass: c1All10, rows: convRows }

  // C2 超轮 1 分：快进 turns=20（压测提速，等价自然 20 轮后的状态）→ 第 21 轮应收 1 分，重放幂等
  const billConv = `stress-bill-${RUN_ID}`
  const c2create = await createBillConv(billConv)
  db.prepare('UPDATE conversation SET turns = 20 WHERE id = ?').run(billConv)
  const c2 = await api('POST', `/credit/conversations/${encodeURIComponent(billConv)}/rounds`, { token, body: { round_no: 21 } })
  stats.billing.roundSettleMs.push(c2.ms)
  const c2replay = await api('POST', `/credit/conversations/${encodeURIComponent(billConv)}/rounds`, { token, body: { round_no: 21 } })
  stats.billing.roundSettleMs.push(c2replay.ms)
  const c2row = db.prepare(`SELECT turns, settled_credit, billing_state FROM conversation WHERE id = ?`).get(billConv)
  billing.overRound1 = {
    pass: c2.ok && c2.body?.charge === 1 && c2replay.ok && c2replay.body?.replayed === true && c2replay.body?.charge === 0,
    createStatus: c2create.status, charge: c2.body?.charge ?? null,
    replayCharge: c2replay.body?.charge ?? null, replayReplayed: c2replay.body?.replayed ?? null,
    row: c2row,
  }

  // C2b 含轮边界：快进 turns=19 → 第 20 轮应 charge=0（INCLUDED_ROUNDS=20，第 20 轮仍在基础包内）
  const bill20Conv = `stress-bill20-${RUN_ID}`
  const c2bcreate = await createBillConv(bill20Conv)
  db.prepare('UPDATE conversation SET turns = 19 WHERE id = ?').run(bill20Conv)
  const c2b = await api('POST', `/credit/conversations/${encodeURIComponent(bill20Conv)}/rounds`, { token, body: { round_no: 20 } })
  stats.billing.roundSettleMs.push(c2b.ms)
  const c2brow = db.prepare(`SELECT turns, settled_credit, billing_state FROM conversation WHERE id = ?`).get(bill20Conv)
  billing.round20Free = {
    pass: c2b.ok && c2b.body?.charge === 0 && c2brow?.turns === 20 && c2brow?.settled_credit === 0,
    createStatus: c2bcreate.status, status: c2b.status, charge: c2b.body?.charge ?? null,
    message: c2b.body?.message ?? null, row: c2brow,
  }

  // C2c 轮次上限：快进 turns=50 → 第 51 轮应 429 ROUND_LIMIT_EXCEEDED（不冻结不扣费）
  const bill51Conv = `stress-bill51-${RUN_ID}`
  const c2ccreate = await createBillConv(bill51Conv)
  db.prepare('UPDATE conversation SET turns = 50 WHERE id = ?').run(bill51Conv)
  const c2c = await api('POST', `/credit/conversations/${encodeURIComponent(bill51Conv)}/rounds`, { token, body: { round_no: 51 } })
  stats.billing.roundSettleMs.push(c2c.ms)
  const c2crow = db.prepare(`SELECT turns, settled_credit, billing_state FROM conversation WHERE id = ?`).get(bill51Conv)
  // 除会话创建时的基础冻结 10 外，不应新增任何 credit_txn（429 不冻结不扣费）
  const c2cTxnCount = db.prepare(
    `SELECT COUNT(*) AS c FROM credit_txn WHERE ref_type='conversation' AND ref_id = ?`,
  ).get(bill51Conv).c
  billing.round51Limit = {
    pass: c2c.status === 429 && c2c.code === 'ROUND_LIMIT_EXCEEDED' && c2crow?.turns === 50 && c2cTxnCount === 1,
    createStatus: c2ccreate.status, status: c2c.status, code: c2c.code ?? null,
    txnCount: c2cTxnCount, row: c2crow,
  }

  // C3 生图冻结 15（API 响应 + DB credit_txn freeze/settle；completed_at 供轮询量化误差校准）
  const pattern = taskIds.map((id) => `'${id}'`).join(',')
  const imgTxns = db.prepare(
    `SELECT ref_id, type, amount, COUNT(*) AS c FROM credit_txn WHERE ref_type='image' AND ref_id IN (${pattern}) GROUP BY ref_id, type ORDER BY ref_id, type`,
  ).all()
  const artRows = db.prepare(
    `SELECT id, status, url, created_at, completed_at FROM artifact WHERE id IN (${pattern}) ORDER BY id`,
  ).all()
  const allFrozen15 = imgTxns.filter((t) => t.type === 'freeze').every((t) => t.amount === 15 && t.c === 1)
  const allSettled15 = imgTxns.filter((t) => t.type === 'settle').every((t) => t.amount === 15 && t.c === 1)
  const allSuccess = artRows.every((a) => a.status === 'success' && a.url)
  billing.imageFreeze15 = { pass: allFrozen15 && allSettled15 && allSuccess, txns: imgTxns, artifacts: artRows }

  // C4 余额守恒：before − 会话冻结(5×10) − 超轮(1) − 生图冻结(10×15) − 计费会话冻结(3×10: bill/bill20/bill51)
  const balAfter = await api('GET', '/credit/balance', { token })
  const expected = balanceBefore - chatConvs.length * 10 - 1 - taskIds.length * 15 - 3 * 10
  billing.balance = {
    before: balanceBefore,
    after: balAfter.body?.balance ?? null,
    expected,
    pass: balAfter.body?.balance === expected,
  }
  db.close()
  return billing
}

// ---------- 主流程 ----------
async function main() {
  const tAll0 = performance.now()
  const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null

  // 登录
  const login = await api('POST', '/auth/login', { body: { account: ACCOUNT, password: PASSWORD } })
  if (!login.ok) {
    console.error(`❌ 登录失败（${login.status}/${login.code}）：${JSON.stringify(login.body)}`)
    process.exit(1)
  }
  const token = login.body.token
  const bal0 = await api('GET', '/credit/balance', { token })
  stats.balance.before = bal0.body?.balance ?? null
  console.log(`✔ 登录成功（${ACCOUNT}），初始余额 ${stats.balance.before}`)
  console.log(`══ Phase A：${CHAT_SESSIONS} 并发会话 × ${CHAT_ROUNDS} 轮 chat（mock Hermes） ══`)
  const convIds = Array.from({ length: CHAT_SESSIONS }, (_, i) => `stress-chat-${RUN_ID}-${i}`)
  const a = await phaseA(token, convIds)
  console.log(`  A 完成：${stats.chat.rounds} 轮 / 成功 ${stats.chat.ok}，阶段耗时 ${Math.round(a.ms)} ms`)
  console.log(`  首包 P50/P90/P95/max = ${fmt(pct(stats.chat.firstMs, 50))} / ${fmt(pct(stats.chat.firstMs, 90))} / ${fmt(pct(stats.chat.firstMs, 95))} / ${fmt(pct(stats.chat.firstMs, 100))}`)
  console.log(`  完整回复 P50/P90/P95/max = ${fmt(pct(stats.chat.fullMs, 50))} / ${fmt(pct(stats.chat.fullMs, 90))} / ${fmt(pct(stats.chat.fullMs, 95))} / ${fmt(pct(stats.chat.fullMs, 100))}`)

  console.log(`══ Phase B：${IMAGE_TASKS} 并发生图（mock Seedream，队列并发 2） ══`)
  const taskIds = Array.from({ length: IMAGE_TASKS }, (_, i) => `stress-img-${RUN_ID}-${i}`)
  const b = await phaseB(token, taskIds)
  console.log(`  B 完成：${stats.image.tasks} 任务 / 成功 ${stats.image.ok}，阶段耗时 ${Math.round(b.ms)} ms`)
  console.log(`  完成 P50/P90/P95/max = ${fmt(pct(stats.image.doneMs, 50))} / ${fmt(pct(stats.image.doneMs, 90))} / ${fmt(pct(stats.image.doneMs, 95))} / ${fmt(pct(stats.image.doneMs, 100))}`)

  console.log('══ Phase C：计费验证 ══')
  const c = await phaseC(token, convIds, taskIds, stats.balance.before)
  stats.billing = { ...stats.billing, ...c }
  console.log(`  C1 会话冻结 10：${c.sessionFreeze10.pass ? '✅ PASS' : '❌ FAIL'}（${convIds.length} 会话 frozen_credit=${JSON.stringify(c.sessionFreeze10.rows.map((r) => r?.frozen_credit))}）`)
  console.log(`  C2 超轮 1 分：${c.overRound1.pass ? '✅ PASS' : '❌ FAIL'}（charge=${c.overRound1.charge}，重放 charge=${c.overRound1.replayCharge}/replayed=${c.overRound1.replayReplayed}）`)
  console.log(`  C2b 第 20 轮免扣：${c.round20Free.pass ? '✅ PASS' : '❌ FAIL'}（charge=${c.round20Free.charge}，turns=${c.round20Free.row?.turns}，settled_credit=${c.round20Free.row?.settled_credit}）`)
  console.log(`  C2c 第 51 轮上限：${c.round51Limit.pass ? '✅ PASS' : '❌ FAIL'}（status=${c.round51Limit.status} code=${c.round51Limit.code}，turns=${c.round51Limit.row?.turns}，txnCount=${c.round51Limit.txnCount}）`)
  console.log(`  C3 生图冻结 15：${c.imageFreeze15.pass ? '✅ PASS' : '❌ FAIL'}（freeze/settle 均 15、artifacts 全 success）`)
  console.log(`  C4 余额：${c.balance.before} → ${c.balance.after}（期望 ${c.balance.expected}）${c.balance.pass ? '✅' : '❌'}`)
  console.log(`  计费端点计时采样：会话创建 n=${stats.billing.sessionCreateMs.length}（P50/P95=${fmt(pct(stats.billing.sessionCreateMs, 50))}/${fmt(pct(stats.billing.sessionCreateMs, 95))}）；轮次结算 n=${stats.billing.roundSettleMs.length}（P50/P95=${fmt(pct(stats.billing.roundSettleMs, 50))}/${fmt(pct(stats.billing.roundSettleMs, 95))}）；生图冻结 n=${stats.billing.imageFreezeMs.length}（P50/P95=${fmt(pct(stats.billing.imageFreezeMs, 50))}/${fmt(pct(stats.billing.imageFreezeMs, 95))}）`)

  // 汇总
  const totalMs = performance.now() - tAll0
  const chatRate = stats.chat.rounds > 0 ? Math.round((stats.chat.ok / stats.chat.rounds) * 1000) / 10 : 0
  const imgRate = stats.image.tasks > 0 ? Math.round((stats.image.ok / stats.image.tasks) * 1000) / 10 : 0
  console.log('\n══════ 汇总 ══════')
  console.log(`总耗时：${(totalMs / 1000).toFixed(1)} s（登录+三阶段+计费验证）`)
  console.log(`Chat 成功率：${stats.chat.ok}/${stats.chat.rounds}（${chatRate}%）`)
  console.log(`生图成功率：${stats.image.ok}/${stats.image.tasks}（${imgRate}%）`)
  console.log(`错误分布 chat：${JSON.stringify(stats.chat.statusCounts)}`)
  console.log(`错误分布 image：${JSON.stringify(stats.image.statusCounts)}`)
  if (stats.chat.errors.length) console.log('chat 错误明细：', JSON.stringify(stats.chat.errors, null, 1))
  if (stats.image.errors.length) console.log('image 错误明细：', JSON.stringify(stats.image.errors, null, 1))

  stats.finishedAt = new Date().toISOString()
  stats.totalMs = Math.round(totalMs)
  stats.chat.chatRatePct = chatRate
  stats.image.imageRatePct = imgRate
  stats.chat.p50 = { first: pct(stats.chat.firstMs, 50), full: pct(stats.chat.fullMs, 50) }
  stats.chat.p95 = { first: pct(stats.chat.firstMs, 95), full: pct(stats.chat.fullMs, 95) }
  stats.chat.p90 = { first: pct(stats.chat.firstMs, 90), full: pct(stats.chat.fullMs, 90) }
  stats.chat.max = { first: pct(stats.chat.firstMs, 100), full: pct(stats.chat.fullMs, 100) }
  stats.image.p95 = pct(stats.image.doneMs, 95)
  stats.image.p90 = pct(stats.image.doneMs, 90)
  stats.image.p50 = pct(stats.image.doneMs, 50)
  stats.image.max = pct(stats.image.doneMs, 100)
  stats.billing.latency = {
    sessionCreate: { n: stats.billing.sessionCreateMs.length, p50: pct(stats.billing.sessionCreateMs, 50), p95: pct(stats.billing.sessionCreateMs, 95), max: pct(stats.billing.sessionCreateMs, 100) },
    roundSettle: { n: stats.billing.roundSettleMs.length, p50: pct(stats.billing.roundSettleMs, 50), p95: pct(stats.billing.roundSettleMs, 95), max: pct(stats.billing.roundSettleMs, 100) },
    imageFreeze: { n: stats.billing.imageFreezeMs.length, p50: pct(stats.billing.imageFreezeMs, 50), p95: pct(stats.billing.imageFreezeMs, 95), max: pct(stats.billing.imageFreezeMs, 100) },
  }
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(stats, null, 2))
    console.log(`JSON 明细已写入：${jsonOut}`)
  }
}

main().catch((e) => { console.error('压测驱动异常：', e); process.exit(1) })
