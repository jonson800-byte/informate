import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth'
import { AppError, Errors } from '../utils/errors'
import { createCreditService, DEFAULT_PRICES, PRICE_KEYS, type TxnRow } from '../services/credit'
import { createSeedreamClient, safeFileName, type SeedreamClient, type SeedreamClientOptions } from '../services/seedream'
import { createTaskQueue, type QueueTask } from '../services/taskQueue'

/**
 * 生图执行器路由（T7）
 *
 * 依据：技术方案 §2.4（生图数据流：冻结 15 → 任务队列 → Seedream 5.0 → 结算/失败退分）、
 *       §G13（图片本地文件流下载）、PRD FR-301~307（prompt 生成/任务状态/失败重试/产出物面板/两阶段积分）。
 *
 * 路由：
 * - POST /api/v1/image-tasks/:id/execute   执行钩子：校验冻结 → 入队 → worker 处理
 *                                          （pending→processing→success/failed；失败自动退分 FR-304）
 * - GET  /api/v1/image-tasks/:id           状态查询（前端轮询，FR-302）
 * - GET  /api/v1/artifacts/:id/download    图片下载（本地文件流，G13）
 *
 * 计费闭环（两阶段积分，Q20）：
 *   ① T5 POST /api/v1/credit/image-tasks 冻结 15（unit=image，不冻会话费）→ artifact=pending
 *   ② execute → 入队 → worker：pending→processing → Seedream 生成
 *   ③ 成功：artifact=success + url 落盘 + credit.settle 确认（幂等，余额不变，冻结时已扣）
 *   ④ 失败：artifact=failed + fail_reason + credit.release 原子退分（余额回补）
 *   ⑤ 重试（FR-303）：failed 状态再次 execute → 重新冻结 → 重置 pending → 重新入队
 *
 * 幂等：success/processing 状态重复 execute 直接幂等返回；队列同 id 去重；
 *       settle/release 按 (ref_type, ref_id) 幂等，重复执行不重复计费。
 */

/** artifact 行只读形态 */
interface ArtifactRow {
  id: string
  tenant_id: string
  scenario_id: string
  conversation_id: string | null
  type: string
  status: 'pending' | 'processing' | 'success' | 'failed'
  url: string | null
  metadata_payload: string | null
  ai_label: number
  trial_watermark: number
  source_artifact_id: string | null
  fail_reason: string | null
  created_at: string
  completed_at: string | null
}

/** 默认提示词（前端未传 prompt 时；正式链路由场景包 Prompt 扩写产出，FR-301） */
const DEFAULT_PROMPT = 'Informate 营销生图占位图'

export interface ImageGenRouteOptions {
  /** 图片落盘目录（默认 backend/data/artifacts） */
  artifactsDir?: string
  /** Seedream 客户端选项（测试注入 mock 延迟/失败标记；artifactsDir 由路由注入） */
  seedream?: Omit<SeedreamClientOptions, 'artifactsDir'>
}

/** 查询任务最新一条指定类型流水 */
function latestTxn(db: FastifyInstance['db'], taskId: string, type: string): TxnRow | undefined {
  return db.prepare(
    `SELECT * FROM credit_txn WHERE ref_type='image' AND ref_id=? AND type=? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(taskId, type) as TxnRow | undefined
}

/** 生图任务 worker 处理器：pending→processing → 生成 → success/failed + 结算/退分 */
function buildProcessor(
  db: FastifyInstance['db'],
  credit: ReturnType<typeof createCreditService>,
  seedream: SeedreamClient,
) {
  return async (task: QueueTask): Promise<{ ok: boolean; url?: string; error?: string }> => {
    const taskId = task.id
    const prompt = (task.payload as { prompt?: string } | undefined)?.prompt ?? DEFAULT_PROMPT
    const art = db.prepare('SELECT * FROM artifact WHERE id = ?').get(taskId) as ArtifactRow | undefined
    if (!art) throw new Error(`生图任务 ${taskId} 不存在（worker）`)

    // pending → processing（前端轮询可见中间态，FR-302）
    db.prepare(`UPDATE artifact SET status = 'processing' WHERE id = ?`).run(taskId)

    try {
      const result = await seedream.generateImage({ taskId, prompt, tenantId: art.tenant_id })
      const price = credit.getPrice(PRICE_KEYS.image, DEFAULT_PRICES.image)
      // 成功：URL 落盘 + settle 结算确认（同一事务；settle 幂等，余额不变——冻结时已扣）
      db.transaction(() => {
        db.prepare(
          `UPDATE artifact SET status='success', url=?, metadata_payload=?, completed_at=datetime('now') WHERE id=?`,
        ).run(
          result.url,
          JSON.stringify({ file: result.file, mime: result.mime, size: result.size, model: result.model, mode: result.mode, prompt }),
          taskId,
        )
        credit.settle({
          tenantId: art.tenant_id,
          refType: 'image',
          refId: taskId,
          amount: price,
          idempotencyKey: `img:${taskId}:settle`,
          note: `生图成功：结算确认 ${price} 积分（冻结时已扣）`,
        })
      })()
      return { ok: true, url: result.url }
    } catch (err) {
      // 失败：标记 failed + fail_reason + 原子退分（FR-304 失败退分；同一事务，失败不留半账）
      const msg = (err as Error).message ?? '未知错误'
      db.transaction(() => {
        db.prepare(
          `UPDATE artifact SET status='failed', fail_reason=?, completed_at=datetime('now') WHERE id=?`,
        ).run(msg, taskId)
        credit.release({
          tenantId: art.tenant_id,
          refType: 'image',
          refId: taskId,
          note: `生图失败退分（${msg}）`,
        })
      })()
      return { ok: false, error: msg }
    }
  }
}

/**
 * 注册生图执行器路由。
 * 说明：worker 队列绑定本 app 实例的 db，随 app.close() 排空关闭；
 *       app.ts 中本函数须在 db.close 钩子之后注册（Fastify onClose 按 LIFO 执行，保证先排空队列再关库）。
 */
export function registerImageGenRoutes(
  app: FastifyInstance,
  jwtSecret: string,
  opts: ImageGenRouteOptions = {},
): void {
  const db = app.db
  const credit = createCreditService(db)
  const artifactsDir = opts.artifactsDir ?? path.join(__dirname, '..', '..', 'data', 'artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })

  const seedream = createSeedreamClient({ artifactsDir, ...opts.seedream })
  const queue = createTaskQueue({ concurrency: 2, processor: buildProcessor(db, credit, seedream) })

  const tenantGuard = requireRole('owner', 'employee')

  // 优雅关闭：先排空队列（在途任务落账完成），再随 app 关闭数据库
  app.addHook('onClose', async () => {
    await queue.close()
  })

  // ---------- 执行钩子：入队执行（幂等 + FR-303 失败重试） ----------
  app.post<{ Params: { id: string }; Body: { prompt?: string } }>(
    '/api/v1/image-tasks/:id/execute',
    {
      preHandler: [authenticate(jwtSecret), tenantGuard],
      schema: {
        body: {
          type: 'object',
          properties: { prompt: { type: 'string', maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenantId as string
      const taskId = request.params.id
      const price = credit.getPrice(PRICE_KEYS.image, DEFAULT_PRICES.image)

      const art = db.prepare('SELECT * FROM artifact WHERE id = ?').get(taskId) as ArtifactRow | undefined
      if (!art) throw Errors.notFound('生图任务不存在')
      if (art.tenant_id !== tenantId) throw Errors.forbidden('无权操作该任务')
      if (art.type !== 'image') throw Errors.badRequest('该产出物不是生图任务（type 应为 image）')

      // 冻结校验：须先经 T5 POST /api/v1/credit/image-tasks 冻结 15
      const freeze = latestTxn(db, taskId, 'freeze')
      if (!freeze) {
        throw new AppError(400, 'IMAGE_TASK_NOT_FROZEN', '生图任务未冻结积分，请先调用 POST /api/v1/credit/image-tasks 冻结')
      }

      // 幂等：已完成 → 直接返回（重复执行不重复计费）
      if (art.status === 'success') {
        return reply.send({
          task_id: taskId, status: 'success', url: art.url, replayed: true,
          message: '任务已完成，幂等返回',
        })
      }
      // 幂等：执行中 → 不重复入队
      if (art.status === 'processing') {
        return reply.send({
          task_id: taskId, status: 'processing', queued: false, replayed: true,
          message: '任务正在执行中，请轮询 GET /api/v1/image-tasks/:id',
        })
      }
      // FR-303 失败重试：重新冻结（新幂等键）→ 重置 pending → 重新入队
      if (art.status === 'failed') {
        const attempt = ((db.prepare(
          `SELECT COUNT(*) AS c FROM credit_txn WHERE ref_type='image' AND ref_id=? AND type='freeze'`,
        ).get(taskId)) as { c: number }).c + 1
        db.transaction(() => {
          credit.createFreeze({
            tenantId,
            userId: request.userId as string,
            refType: 'image',
            refId: taskId,
            amount: price,
            idempotencyKey: `img:${taskId}:freeze:r${attempt}`,
            note: `失败重试第 ${attempt} 次：重新冻结 ${price} 积分`,
          })
          db.prepare(`UPDATE artifact SET status='pending', fail_reason=NULL, completed_at=NULL WHERE id=?`).run(taskId)
        })()
      }

      // H2 修复（Codex 批次 C / FR-306/307）：生图前置合规——违禁提示词不入队并解冻（不产生扣费）
      // P0 修复（batchE 验收）：此前用 app.inject 打绝对 URL 只路由本地实例（404 → 恒放行），
      // 改为 fetch + COMPLIANCE_BASE_URL 真实外呼，失败 fail-closed 503
      const promptToCheck = request.body?.prompt
      if (promptToCheck) {
        let check: { blocked?: boolean; reason?: string | null } | null = null
        try {
          const complianceBaseUrl = process.env.COMPLIANCE_BASE_URL ?? 'http://127.0.0.1:9100'
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 5000)
          try {
            const res = await fetch(`${complianceBaseUrl}/check`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image_prompt: promptToCheck, rule_packs: ['general', 'medical'] }),
              signal: controller.signal,
            })
            if (!res.ok) throw new Error(`合规服务 HTTP ${res.status}`)
            check = (await res.json()) as typeof check
          } finally {
            clearTimeout(timer)
          }
        } catch {
          // 合规服务不可用 → fail-closed（NFR-10）
          throw new AppError(503, 'COMPLIANCE_UNAVAILABLE', '合规服务不可用，请稍后重试')
        }
        if (check && check.blocked) {
          // 拦截：不产生扣费——原子 release 已冻结分
          try {
            credit.release({ tenantId, refType: 'image', refId: taskId, note: '生图前置合规拦截，解冻退回' })
          } catch {
            // 解冻失败不阻断响应（兜底扫描会处理）
          }
          return reply.send({
            task_id: taskId,
            status: 'blocked',
            reason: check.reason ?? '提示词命中医美红线（医疗广告审查）',
            message: '提示词未通过合规检查，已解冻不扣费，请修改后重试',
          })
        }
      }

      // pending → 入队（队列同 id 去重，重复调用安全）
      queue.enqueue({ id: taskId, type: 'image-gen', payload: { prompt: request.body?.prompt } })
      return reply.send({
        task_id: taskId,
        status: 'pending',
        queued: true,
        replayed: false,
        message: `任务已入队执行（Seedream ${seedream.mode === 'mock' ? 'mock 占位图' : '火山方舟'}），请轮询状态`,
      })
    },
  )

  // ---------- 状态查询（前端轮询，FR-302） ----------
  app.get<{ Params: { id: string } }>('/api/v1/image-tasks/:id', {
    preHandler: [authenticate(jwtSecret), tenantGuard],
  }, async (request, reply) => {
    const tenantId = request.tenantId as string
    const taskId = request.params.id
    const art = db.prepare('SELECT * FROM artifact WHERE id = ?').get(taskId) as ArtifactRow | undefined
    if (!art) throw Errors.notFound('生图任务不存在')
    if (art.tenant_id !== tenantId) throw Errors.forbidden('无权操作该任务')

    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(art.metadata_payload ?? '{}') } catch { /* 历史数据无 metadata */ }

    const freeze = latestTxn(db, taskId, 'freeze')
    const settle = latestTxn(db, taskId, 'settle')
    const unfreeze = latestTxn(db, taskId, 'unfreeze')

    return reply.send({
      task_id: art.id,
      status: art.status,
      url: art.url,
      fail_reason: art.fail_reason,
      prompt: (meta.prompt as string | undefined) ?? null,
      model: (meta.model as string | undefined) ?? null,
      mode: (meta.mode as string | undefined) ?? null,
      created_at: art.created_at,
      completed_at: art.completed_at,
      // 计费视角（两阶段积分）：freeze=冻结 15；settled=已确认扣减；refunded=已退回
      freeze: freeze?.amount ?? 0,
      settled: settle?.amount ?? 0,
      refunded: unfreeze?.amount ?? 0,
    })
  })

  // ---------- 图片下载：本地文件流（技术方案 G13） ----------
  app.get<{ Params: { id: string } }>('/api/v1/artifacts/:id/download', {
    preHandler: [authenticate(jwtSecret), tenantGuard],
  }, async (request, reply) => {
    const tenantId = request.tenantId as string
    const artId = request.params.id
    const art = db.prepare('SELECT * FROM artifact WHERE id = ?').get(artId) as ArtifactRow | undefined
    if (!art) throw Errors.notFound('产出物不存在')
    if (art.tenant_id !== tenantId) throw Errors.forbidden('无权操作该产出物')
    if (art.status !== 'success' || !art.url) throw Errors.notFound('图片尚未生成完成')

    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(art.metadata_payload ?? '{}') } catch { /* 忽略 */ }
    // 文件名来自 worker 落盘记录（防路径穿越：必须等于 basename）
    const fileName = (meta.file as string | undefined) ?? `${safeFileName(art.id)}.svg`
    if (!fileName || path.basename(fileName) !== fileName) throw Errors.badRequest('非法文件路径')
    const filePath = path.join(artifactsDir, fileName)
    if (!fs.existsSync(filePath)) throw Errors.notFound('图片文件不存在（可能已被清理）')

    const mime = (meta.mime as string | undefined) ?? 'image/svg+xml'
    reply.header('Content-Type', mime)
    reply.header('Content-Disposition', `inline; filename="${fileName}"`)
    return reply.send(fs.createReadStream(filePath))
  })

  // ---------- 产出物列表：GET /api/v1/artifacts?scenario_id=&type=&page=&pageSize= ----------
  // P1-1 服务端持久化（外部评估优化）：产出物由服务端列表提供（含 AI 标识/试用水印/会话归属）
  app.get<{ Querystring: { scenario_id?: string; type?: string; page?: string; pageSize?: string } }>(
    '/api/v1/artifacts',
    { preHandler: [authenticate(jwtSecret), tenantGuard] },
    async (request) => {
      const tenantId = request.tenantId as string
      const scenarioId = request.query.scenario_id ?? null
      const type = request.query.type ?? null
      const page = Math.max(1, Number(request.query.page) || 1)
      const pageSize = Math.min(50, Math.max(1, Number(request.query.pageSize) || 20))
      const where = ['tenant_id = ?']
      const params: unknown[] = [tenantId]
      if (scenarioId) { where.push('scenario_id = ?'); params.push(scenarioId) }
      if (type) { where.push('type = ?'); params.push(type) }
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM artifact WHERE ${where.join(' AND ')}`).get(...params) as { c: number }).c
      const rows = db.prepare(
        `SELECT id, scenario_id, conversation_id, type, status, url, ai_label, trial_watermark,
                source_artifact_id, fail_reason, created_at, completed_at
         FROM artifact WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ).all(...params, pageSize, (page - 1) * pageSize) as {
        id: string; scenario_id: string; conversation_id: string | null; type: string; status: string
        url: string | null; ai_label: number; trial_watermark: number; source_artifact_id: string | null
        fail_reason: string | null; created_at: string; completed_at: string | null
      }[]
      return {
        data: rows.map((r) => ({
          id: r.id, scenario_id: r.scenario_id, conversation_id: r.conversation_id, type: r.type, status: r.status,
          url: r.url, ai_label: r.ai_label === 1, trial_watermark: r.trial_watermark === 1,
          source_artifact_id: r.source_artifact_id, fail_reason: r.fail_reason,
          created_at: r.created_at, completed_at: r.completed_at,
        })),
        pagination: { page, pageSize, total },
      }
    },
  )
}
