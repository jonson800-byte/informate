/**
 * Chat 会话服务路由（T6）
 *
 * POST /api/v1/chat/messages  {conversation_id, content} → SSE 流式回复
 *   流程（技术方案 §2.3 / PRD FR-201/204/205/207/208/209）：
 *   1. 会话归属校验：token 无效 → 401；会话不存在 → 404；跨租户/非本租户用户 → 403
 *   2. 轮次校验：turns >= 50 → 429（第 51 轮拦截，提示新开对话；不冻结不扣费）
 *   3. 合规检查：调合规服务（默认 http://127.0.0.1:9100 /check，rule_packs=[general,medical]）；
 *      blocked → 400 COMPLIANCE_BLOCKED 返回拦截原因；general 命中自动修正（用 fixed_text 生成）
 *   4. 记忆 recall 注入：P1 租户私有 bank（recallMemory）+ P2/P3 行业 bank（industryRecall，
 *      sub_industry 命中优先）→ 合并注入 system prompt
 *   5. 调 Hermes 客户端生成（mock/real，见 services/hermesClient.ts）→ 流式 SSE 透传
 *   6. 每轮结束调 credit rounds 接口计费（POST /api/v1/credit/conversations/:id/rounds，
 *      第 21 轮起 1 积分/轮，幂等）
 *   7. 消息落库（user + assistant，round_no/credit_charged/compliance_passed）
 *      + 记忆 writeMemory 异步写入租户私有 bank
 *
 * SSE 事件契约（§2.3）：delta {text} / round_hint {type,message} /
 *   round_complete {turns,credit_charged} / error {code,message}
 *
 * GET /api/v1/chat/messages?conversation_id= → 历史消息列表（T9 前端加载用）
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { authenticate, requireRole } from '../middleware/auth'
import { AppError, Errors } from '../utils/errors'
import { createCreditService, DEFAULT_PRICES, PRICE_KEYS } from '../services/credit'
import { createHermesClient, type HermesClient, type HermesChatMessage } from '../services/hermesClient'
import { createMemoryService, type MemoryService, type MemoryHit } from '../services/memory'

export interface ChatRouteOptions {
  /** Hermes 客户端配置（默认 mock 模式，见 hermesClient.ts） */
  hermes?: Parameters<typeof createHermesClient>[0]
  /** 测试注入：自定义 Hermes 客户端（优先于 hermes 配置） */
  hermesClient?: HermesClient
  /** 测试注入：自定义记忆服务（优先于 memoryBaseUrl） */
  memoryService?: MemoryService
  /** Hindsight 地址（默认 http://localhost:9177，可用 HINDSIGHT_API_BASE 覆盖） */
  memoryBaseUrl?: string
  /** 合规服务地址（默认 http://127.0.0.1:9100，可用 COMPLIANCE_BASE_URL 覆盖） */
  complianceBaseUrl?: string
  complianceTimeoutMs?: number
}

interface ConversationRow {
  id: string
  tenant_id: string
  user_id: string
  scenario_id: string
  status: string
  turns: number
  billing_state: string
}

interface ComplianceResult {
  passed: boolean
  blocked: boolean
  fixed_text: string | null
  reason: string | null
}

/** 与 credit 路由轮次结算一致的含轮数（第 21 轮起计费） */
const INCLUDED_ROUNDS = 20

export function registerChatRoutes(app: FastifyInstance, jwtSecret: string, opts: ChatRouteOptions = {}): void {
  const db = app.db
  const credit = createCreditService(db)
  const tenantGuard = requireRole('owner', 'employee')
  const complianceBaseUrl = opts.complianceBaseUrl ?? process.env.COMPLIANCE_BASE_URL ?? 'http://127.0.0.1:9100'
  const complianceTimeoutMs = opts.complianceTimeoutMs ?? 5000

  // 客户端：测试注入优先，否则按配置创建（默认 mock）
  const hermesClient = opts.hermesClient ?? createHermesClient(opts.hermes)
  const memory: MemoryService = opts.memoryService ?? createMemoryService({ baseUrl: opts.memoryBaseUrl })

  /** 调合规服务（fail-closed：服务不可用 → 503，不放过未审核内容） */
  async function checkCompliance(text: string): Promise<ComplianceResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), complianceTimeoutMs)
    try {
      const res = await fetch(`${complianceBaseUrl}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, rule_packs: ['general', 'medical'] }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`合规服务 HTTP ${res.status}`)
      return (await res.json()) as ComplianceResult
    } catch {
      // 医美合规是产品红线能力：服务不可用时宁可拒绝，也不放行未审核内容
      throw new AppError(503, 'COMPLIANCE_UNAVAILABLE', '合规服务暂不可用，请稍后重试')
    } finally {
      clearTimeout(timer)
    }
  }

  /** 会话归属校验（共用）：404 不存在 / 403 跨租户或用户不属于该租户 */
  function loadConversation(convId: string, tenantId: string, userId: string): ConversationRow {
    const conv = db.prepare('SELECT * FROM conversation WHERE id = ?').get(convId) as ConversationRow | undefined
    if (!conv) throw Errors.notFound('会话不存在')
    if (conv.tenant_id !== tenantId) throw Errors.forbidden('无权操作该会话')
    const user = db.prepare('SELECT tenant_id FROM user WHERE id = ?').get(userId) as
      | { tenant_id: string }
      | undefined
    if (!user || user.tenant_id !== tenantId) throw Errors.forbidden('账号不属于该租户')
    return conv
  }

  // ---------- 发消息：POST /api/v1/chat/messages（SSE 流式回复） ----------
  app.post<{ Body: { conversation_id: string; content: string } }>(
    '/api/v1/chat/messages',
    {
      preHandler: [authenticate(jwtSecret), tenantGuard],
      schema: {
        body: {
          type: 'object',
          required: ['conversation_id', 'content'],
          properties: {
            conversation_id: { type: 'string', maxLength: 64 },
            content: { type: 'string', minLength: 1, maxLength: 4000 },
          },
        },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenantId as string
      const userId = request.userId as string
      const { conversation_id: convId, content } = request.body

      // 1. 会话归属校验（404/403）
      const conv = loadConversation(convId, tenantId, userId)
      if (conv.status !== 'active') throw Errors.conflict('会话已结束，请新开对话')
      if (conv.billing_state === 'settled') throw Errors.conflict('会话已结算，请新开对话')

      // 2. 轮次校验：turns >= 50 → 第 51 轮拦截（不冻结不扣费，PRD §4.2 / FR-205）
      const roundLimit = credit.getPrice(PRICE_KEYS.roundLimit, DEFAULT_PRICES.roundLimit)
      if (conv.turns >= roundLimit) {
        return reply.status(429).send({
          code: 'ROUND_LIMIT_EXCEEDED',
          message: `已达单会话 ${roundLimit} 轮上限，第 ${roundLimit + 1} 轮被拦截。建议新开对话（新开会话重新计费，可防套利）`,
          details: { conversation_id: convId, turns: conv.turns, round_limit: roundLimit },
        })
      }
      const nextRound = conv.turns + 1

      // 3. 合规检查（输入侧前置合规，FR-204）：blocked → 400；general 命中 → 用修正后文本
      const check = await checkCompliance(content)
      if (check.blocked) {
        return reply.status(400).send({
          code: 'COMPLIANCE_BLOCKED',
          message: `内容未通过医美合规检查：${check.reason ?? '命中医美红线（医疗广告审查）'}。请修改后重试`,
          details: { reason: check.reason, rule_packs: ['general', 'medical'] },
        })
      }
      const userText = check.fixed_text ?? content

      // 4. 记忆 recall 注入 system prompt（P1 租户私有 → P2/P3 行业；失败跳过不影响主流程）
      const tenant = db.prepare('SELECT industry, sub_industry FROM tenant WHERE id = ?').get(tenantId) as
        | { industry: string; sub_industry: string | null }
        | undefined
      const sysParts = [
        '你是 Informate「行业工作助手」，面向 B 端行业用户提供专业、简洁的回答。',
        '回答要求：贴合用户所属行业；引用行业知识时保持准确；涉及营销文案时不得承诺治疗效果，并附带提示「需人工审核且取得《医疗广告审查证明》后方可投放」（FR-209）。',
      ]
      let tenantHits: MemoryHit[] = []
      let industryHits: MemoryHit[] = []
      try {
        ;[tenantHits, industryHits] = await Promise.all([
          memory.recallMemory(tenantId, conv.scenario_id, userText, 5),
          tenant ? memory.industryRecall(tenant.industry, userText, tenant.sub_industry, 8) : Promise.resolve([]),
        ])
      } catch (err) {
        console.warn('[chat] 记忆检索失败，跳过记忆注入:', (err as Error).message)
      }
      if (tenantHits.length > 0) {
        sysParts.push(`【租户记忆】（P1）\n${tenantHits.map((h) => `- ${h.text}`).join('\n')}`)
      }
      if (industryHits.length > 0) {
        sysParts.push(`【行业知识】（P2 二级行业命中优先 / P3 通用兜底）\n${industryHits.map((h) => `- ${h.text}`).join('\n')}`)
      }

      // 上下文：最近 10 条历史 + 当前消息（FR-206：超长由 Hermes 原生压缩）
      const history = db.prepare(
        `SELECT role, content FROM message WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 10`,
      ).all(convId).reverse() as { role: 'user' | 'assistant'; content: string }[]
      const messages: HermesChatMessage[] = [
        { role: 'system', content: sysParts.join('\n\n') },
        ...history,
        { role: 'user', content: userText },
      ]

      // 5. 流式 SSE 返回（hijack 后自行写 raw 流，错误自行捕获）
      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      /** 安全写 SSE 事件（客户端断开后忽略写错误） */
      const send = (event: string, data: unknown) => {
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        } catch {
          // 连接已关闭，忽略
        }
      }

      // 客户端断开 → 中止生成
      const ac = new AbortController()
      const onClose = () => ac.abort()
      request.raw.on('close', onClose)
      // H5 修复（Codex 批次 C）：写入中途断开（ECONNRESET）不崩溃
      const swallow = () => ac.abort()
      reply.raw.on('error', swallow)
      request.raw.on('error', swallow)

      let replyText = ''
      // P0-2 分段闸门（外部评估优化，2026-08-16）：
      // 流式输出改为「服务端按句缓冲 → 增量合规 → 通过才转发」，
      // 保证被 blocked 的文本块【绝不】到达浏览器（医疗广告违规展示即风险）。
      // 流结束后仍保留完整回复终检（控制落库/结算；已展示块均为闸门通过）。
      const SENTENCE_END = /[。！？；!?;\n]/
      const MAX_BUFFER = 60 // 无句末标点时按长度强制切块（敏感词跨块由终检兜底）
      let chunkBuffer = ''
      let gateOpen = true

      /** 刷新缓冲块：合规通过 → 转发；blocked/不可用 → 发 error 并关闭闸门 */
      const flushChunk = async (): Promise<boolean> => {
        if (!chunkBuffer) return true
        const block = chunkBuffer
        chunkBuffer = ''
        let check: { passed: boolean; blocked?: boolean; reason?: string | null; fixed_text?: string | null } | null = null
        try {
          check = await checkCompliance(block)
        } catch {
          // 合规服务不可用时 fail-closed（NFR-10）：停止转发、不结算不落库
          send('error', { code: 'COMPLIANCE_UNAVAILABLE', message: '合规服务不可用，请稍后重试' })
          return false
        }
        if (check && check.blocked) {
          send('error', {
            code: 'COMPLIANCE_BLOCKED_OUTPUT',
            message: `回复未通过医美合规检查：${check.reason ?? '命中医美红线（医疗广告审查）'}。已不扣费，请修改提问重试`,
          })
          return false
        }
        send('delta', { text: check?.fixed_text && check.fixed_text !== block ? check.fixed_text : block })
        return true
      }

      try {
        for await (const chunk of hermesClient.streamChat({ messages, userId, sessionId: convId, signal: ac.signal })) {
          replyText += chunk
          chunkBuffer += chunk
          // 句末标点或缓冲达阈值 → 切块过闸
          if (SENTENCE_END.test(chunkBuffer) || chunkBuffer.length >= MAX_BUFFER) {
            if (!(await flushChunk())) {
              gateOpen = false
              ac.abort() // 停止上游生成
              break
            }
          }
        }
        // 流结束后：清空剩余缓冲（最后一块过闸）
        if (gateOpen && chunkBuffer) {
          if (!(await flushChunk())) gateOpen = false
        }
        // 闸门关闭（已发 COMPLIANCE_BLOCKED/COMPLIANCE_UNAVAILABLE）→ 不再落库/结算
        if (!gateOpen) return

        // H1 修复（Codex 批次 C / FR-204）+ P0 修复（batchE 验收）：输出侧终检——完整回复再过合规引擎
        // 分段闸门已保证展示安全；终检控制落库/结算（含跨块敏感词、修正文本一致性）
        let outputCheck: { passed: boolean; blocked?: boolean; reason?: string | null; fixed_text?: string | null } | null = null
        try {
          outputCheck = await checkCompliance(replyText)
        } catch {
          // 合规服务不可用时 fail-closed（NFR-10）：不结算不落库
          send('error', { code: 'COMPLIANCE_UNAVAILABLE', message: '合规服务不可用，请稍后重试' })
          return
        }
        if (outputCheck && outputCheck.blocked) {
          send('error', {
            code: 'COMPLIANCE_BLOCKED_OUTPUT',
            message: `回复未通过医美合规检查：${outputCheck.reason ?? '命中医美红线（医疗广告审查）'}。已不扣费，请修改提问重试`,
          })
          return
        }
        const finalReply = outputCheck?.fixed_text && outputCheck.fixed_text !== replyText ? outputCheck.fixed_text : replyText

        // 轮次提示（FR-205 / AC-205：20 轮末提示、21 轮起提示）
        if (nextRound === INCLUDED_ROUNDS) {
          send('round_hint', { type: 'included_used', message: '已用满 20 轮含轮，之后每轮 1 积分' })
        } else if (nextRound > INCLUDED_ROUNDS) {
          send('round_hint', { type: 'extra_round', message: `第 ${nextRound} 轮为超轮，已扣除 1 积分` })
        }

        // 6. 每轮结束调 credit rounds 接口计费（第 21 轮起 1 积分/轮，幂等；技术方案 §2.3 流程 3）
        const chargeRes = await app.inject({
          method: 'POST',
          url: `/api/v1/credit/conversations/${encodeURIComponent(convId)}/rounds`,
          headers: { authorization: String(request.headers.authorization ?? '') },
          payload: { round_no: nextRound },
        })
        const chargeBody = chargeRes.json() as {
          charge?: number; round_no?: number; code?: string; message?: string
        }
        if (chargeRes.statusCode !== 200) {
          send('error', {
            code: chargeBody.code ?? 'BILLING_FAILED',
            message: chargeBody.message ?? '轮次计费失败，请稍后重试',
          })
          return
        }
        const charge = chargeBody.charge ?? 0

        // 7. 消息落库（user + assistant，同一事务）
        db.transaction(() => {
          db.prepare(
            `INSERT INTO message (id, conversation_id, tenant_id, role, content, round_no, credit_charged, compliance_passed)
             VALUES (?, ?, ?, 'user', ?, ?, 0, 1)`,
          ).run(randomUUID(), convId, tenantId, userText, nextRound)
          db.prepare(
            `INSERT INTO message (id, conversation_id, tenant_id, role, content, round_no, credit_charged, compliance_passed)
             VALUES (?, ?, ?, 'assistant', ?, ?, ?, 1)`,
          ).run(randomUUID(), convId, tenantId, finalReply, nextRound, charge)
          // FR-405 跨场景传递审计：消息以传递标记开头 → 记录来源/目标会话/操作人
          if (userText.startsWith('[跨场景传递]')) {
            db.prepare(
              `INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip)
               VALUES (?, ?, 'cross_scenario_transfer', 'conversation', ?, ?, ?)`,
            ).run(tenantId, userId, convId, userText.slice(0, 200), (request.headers['x-forwarded-for'] as string) ?? request.ip)
          }
        })()

        // 记忆 writeMemory 异步写入租户私有 bank（Q30；失败仅记日志，不影响本轮响应）
        void memory
          .writeMemory(tenantId, conv.scenario_id, userText, {
            context: `chat-${conv.scenario_id}`,
            tags: ['informate', conv.scenario_id, 'chat'],
          })
          .catch((err: unknown) => {
            console.error('[chat] 记忆写入失败:', (err as Error).message)
          })

        send('round_complete', { turns: chargeBody.round_no ?? nextRound, credit_charged: charge })
      } catch (err) {
        const aborted = ac.signal.aborted
        send('error', {
          code: 'GENERATION_FAILED',
          message: aborted ? '客户端已断开' : `AI 生成失败：${(err as Error).message}。请重试`,
        })
      } finally {
        request.raw.off('close', onClose)
        try {
          reply.raw.end()
        } catch {
          // 忽略
        }
      }
    },
  )

  // ---------- 历史消息：GET /api/v1/chat/messages?conversation_id= ----------
  app.get<{ Querystring: { conversation_id: string } }>(
    '/api/v1/chat/messages',
    { preHandler: [authenticate(jwtSecret), tenantGuard] },
    async (request) => {
      const tenantId = request.tenantId as string
      const userId = request.userId as string
      const convId = request.query.conversation_id
      loadConversation(convId, tenantId, userId)
      const rows = db.prepare(
        `SELECT id, role, content, round_no, credit_charged, compliance_passed, created_at
         FROM message WHERE conversation_id = ? ORDER BY rowid ASC`,
      ).all(convId)
      return { conversation_id: convId, messages: rows }
    },
  )
}
