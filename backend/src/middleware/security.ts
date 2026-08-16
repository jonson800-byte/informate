import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * 安全加固（P0-6 外部评估优化，2026-08-16）
 *
 * 1. rateLimit：内存滑动窗口限流（IP + 可选账号维度），分级规则
 * 2. 安全响应头 + CORS 白名单 + 请求体大小限制（HSTS 仅生产）
 *
 * 说明：单机部署内存限流足够；多实例扩展时需换 Redis（与任务队列同源）。
 */

export interface RateLimitRule {
  /** 窗口时长 ms */
  windowMs: number
  /** 窗口内最大请求数 */
  max: number
}

/** 分级限流规则（key → 规则） */
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  /** 登录/注册：防暴力破解与批量注册 */
  auth: { windowMs: 60_000, max: 10 },
  /** 一般 API：防爬/枚举 */
  general: { windowMs: 60_000, max: 120 },
  /** 模型调用（chat/生图/充值）：防成本消耗攻击 */
  model: { windowMs: 60_000, max: 60 },
  /** 下载/导出：防资源耗尽 */
  download: { windowMs: 60_000, max: 60 },
}

interface Bucket {
  count: number
  windowStart: number
}

/** 内存滑动窗口限流器 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  private cleanupAt = 0

  constructor(private rules: Record<string, RateLimitRule> = RATE_LIMITS) {}

  /** 命中规则则消耗一次；返回 true=允许，false=拒绝（429） */
  allow(key: string, ruleName: string): boolean {
    const rule = this.rules[ruleName]
    if (!rule) return true
    const now = Date.now()
    // 周期性清理过期桶（防内存膨胀）
    if (now > this.cleanupAt) {
      this.cleanupAt = now + 300_000
      for (const [k, b] of this.buckets) {
        if (now - b.windowStart > rule.windowMs * 2) this.buckets.delete(k)
      }
    }
    const b = this.buckets.get(key)
    if (!b || now - b.windowStart >= rule.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now })
      return true
    }
    if (b.count >= rule.max) return false
    b.count++
    return true
  }
}

/** 根据路径匹配限流规则名 */
export function rateRuleForUrl(url: string): string {
  if (url.includes('/auth/login') || url.includes('/auth/register')) return 'auth'
  if (url.includes('/chat/messages') || url.includes('/image-tasks') || url.includes('/credit/recharge')) return 'model'
  if (url.includes('/download') || url.includes('/admin/export')) return 'download'
  return 'general'
}

/** 在 Fastify 上安装安全加固（限流 + 响应头 + CORS） */
export function installSecurity(app: FastifyInstance, opts: { corsOrigin?: string; isProd?: boolean } = {}): void {
  const limiter = new RateLimiter()
  const corsOrigin = opts.corsOrigin ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173'
  const isProd = opts.isProd ?? process.env.NODE_ENV === 'production'

  // 1) 全局请求钩子：限流 + 安全响应头 + CORS
  app.addHook('onRequest', async (request, reply) => {
    const ip = (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || request.ip || 'unknown'
    const rule = rateRuleForUrl(request.url)
    if (!limiter.allow(`ip:${ip}:${rule}`, rule)) {
      return reply.status(429).send({ code: 'RATE_LIMITED', message: `请求过于频繁，请稍后重试（限流规则：${rule}）` })
    }

    // CORS：仅允许白名单来源（开发=5173，生产=CORS_ORIGIN）
    const origin = request.headers.origin
    if (origin) {
      if (origin === corsOrigin) {
        reply.header('Access-Control-Allow-Origin', origin)
        reply.header('Vary', 'Origin')
      }
    }
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    reply.header('Access-Control-Max-Age', '86400')
    if (request.method === 'OPTIONS') return reply.status(204).send()

    // 安全响应头
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'")
    if (isProd) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
  })

  // 2) 请求体大小限制（防超大请求消耗）：默认 64KB；chat 内容字段本身已限 4000 字符
  app.addHook('preValidation', async (request, reply) => {
    const len = request.headers['content-length']
    if (len && Number(len) > 64 * 1024) {
      return reply.status(413).send({ code: 'PAYLOAD_TOO_LARGE', message: '请求体过大（上限 64KB）' })
    }
  })
}
