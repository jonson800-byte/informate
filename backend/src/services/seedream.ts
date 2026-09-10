import * as fs from 'node:fs'
import * as path from 'node:path'
import { classifyModelError, retryWithBackoff, type ModelErrorClass } from './modelLog'

/**
 * Seedream 生图客户端（T7）
 *
 * 依据：技术方案 §2.4（生图数据流：冻结 15 → 任务队列 → Seedream 5.0 → 回调结算/失败退分）、
 *       PRD FR-301~307、场景包「生成图片」（generate_image：Seedream 5.0 异步任务）。
 *
 * 两种运行模式，按环境变量切换：
 * - mock（默认）：生成占位图（SVG）落盘 data/artifacts/，并模拟 1~3s 生成延迟；
 *   用于本地开发与自动化测试（无火山方舟密钥也能跑通全链路）。
 * - real：调用火山方舟 OpenAI 兼容 images/generations 接口，支持 URL 或 base64 响应，
 *   下载校验后落盘；配置 VOLC_ARK_API_KEY 与 VOLC_ARK_SEEDREAM_MODEL 启用。
 */

/** 生图请求参数 */
export interface SeedreamGenerateParams {
  /** 任务 ID（= artifact.id），用作文件名基底 */
  taskId: string
  /** 正向提示词（Prompt 扩写产物，FR-301） */
  prompt: string
  /** 租户 ID（审计/计费用，mock 模式不消费） */
  tenantId?: string | null
}

/** 生图结果（成功时返回，供 worker 落库） */
export interface SeedreamResult {
  /** 对外访问 URL（走本地下载端点，技术方案 G13 文件流） */
  url: string
  /** 落盘文件名（相对 artifactsDir） */
  file: string
  /** MIME 类型 */
  mime: string
  /** 文件字节数 */
  size: number
  /** 模型标识（mock 为 seedream-5.0-mock） */
  model: string
  /** 运行模式 mock / real */
  mode: 'mock' | 'real'
}

export interface SeedreamClientOptions {
  /** 图片落盘目录（默认 backend/data/artifacts） */
  artifactsDir: string
  /** mock 延迟区间（毫秒），默认 [1000, 3000]（模拟真实生成耗时） */
  mockDelayMs?: [number, number]
  /** mock 强制失败标记：prompt 包含该串时抛错（测试失败路径用） */
  mockFailMarker?: string
  mode?: 'mock' | 'real'
  apiKey?: string
  apiBase?: string
  /** 火山方舟推理接入点 ID/模型 ID，生产必须显式配置。 */
  model?: string
  size?: string
  timeoutMs?: number
  maxRetries?: number
  onCall?: (call: {
    provider: 'seedream'; model: string; requestId?: string | null; kind: 'image'
    latencyMs: number; status: 'success' | 'error'; errorClass?: ModelErrorClass | null
    errorMsg?: string | null; meta?: Record<string, unknown> | null
  }) => void
}

export interface SeedreamClient {
  readonly mode: 'mock' | 'real'
  /** 执行生图（阻塞至生成完成，worker 中调用） */
  generateImage(params: SeedreamGenerateParams): Promise<SeedreamResult>
}

/** XML 转义（SVG 内嵌 prompt 防注入） */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 文件名安全化：仅保留 [a-zA-Z0-9_-]（防路径穿越） */
export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * mock 占位图：生成一张带任务信息与提示词的 SVG（1024x1024），落盘 artifactsDir。
 * 说明：MVP 用 SVG 零依赖生成；真实模式由 Seedream 返回 PNG/WebP，落盘逻辑复用。
 */
function generateMockSvg(params: SeedreamGenerateParams, artifactsDir: string): SeedreamResult {
  const file = `${safeFileName(params.taskId)}.svg`
  const ts = new Date().toISOString()
  const prompt = escapeXml(params.prompt || '（无提示词）')
  const taskId = escapeXml(params.taskId)
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FF7F50"/>
      <stop offset="100%" stop-color="#7B2FBE"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <circle cx="512" cy="430" r="180" fill="#ffffff" opacity="0.15"/>
  <rect x="180" y="560" width="664" height="190" rx="24" fill="#ffffff" opacity="0.92"/>
  <text x="512" y="620" font-family="PingFang SC, sans-serif" font-size="34" fill="#333333" text-anchor="middle">Seedream 5.0 占位图（mock）</text>
  <text x="512" y="676" font-family="PingFang SC, sans-serif" font-size="26" fill="#555555" text-anchor="middle">任务：${taskId}</text>
  <text x="512" y="720" font-family="PingFang SC, sans-serif" font-size="22" fill="#888888" text-anchor="middle">提示词：${prompt}</text>
  <text x="512" y="982" font-family="sans-serif" font-size="20" fill="#ffffff" opacity="0.7" text-anchor="middle">AI 生成内容 · ${ts}</text>
</svg>`
  const filePath = path.join(artifactsDir, file)
  fs.writeFileSync(filePath, svg, 'utf8')
  return {
    url: `/api/v1/artifacts/${safeFileName(params.taskId)}/download`,
    file,
    mime: 'image/svg+xml',
    size: Buffer.byteLength(svg, 'utf8'),
    model: 'seedream-5.0-mock',
    mode: 'mock',
  }
}

/**
 * 真实模式：火山方舟（Volcengine Ark）Seedream 5.0 文生图接口。
 *
 * 真实模式通过火山方舟 REST API 生成图片；供应商错误统一分类并按安全策略重试，
 * 成功后下载到 artifactsDir，前端仍通过受鉴权的本地下载端点访问。
 */
function extensionForMime(mime: string): string {
  if (mime.includes('jpeg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  return 'png'
}

function assertSafeRemoteImageUrl(raw: string): URL {
  const url = new URL(raw)
  const host = url.hostname.toLowerCase()
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
  if (url.protocol !== 'https:' || host === 'localhost' || host.endsWith('.local') || isIp) {
    throw new Error('Seedream 返回了不安全的图片下载地址')
  }
  return url
}

/**
 * 创建 Seedream 客户端。
 * 模式判定：VOLC_ARK_API_KEY 已设置且 SEEDREAM_MODE !== 'mock' → real；否则 mock。
 */
export function createSeedreamClient(opts: SeedreamClientOptions): SeedreamClient {
  // 确保落盘目录存在（幂等）
  fs.mkdirSync(opts.artifactsDir, { recursive: true })

  const mockDelayMs: [number, number] = opts.mockDelayMs ?? [1000, 3000]
  const failMarker = opts.mockFailMarker ?? '__SEEDREAM_FAIL__'

  const apiKey = opts.apiKey ?? process.env.VOLC_ARK_API_KEY ?? ''
  const model = opts.model ?? process.env.VOLC_ARK_SEEDREAM_MODEL ?? ''
  const requestedMode = opts.mode ?? process.env.SEEDREAM_MODE
  const mode: 'mock' | 'real' = requestedMode === 'real' || (!requestedMode && !!apiKey) ? 'real' : 'mock'
  const apiBase = (opts.apiBase ?? process.env.VOLC_ARK_API_BASE ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '')
  const size = opts.size ?? process.env.SEEDREAM_SIZE ?? '2048x2048'
  const timeoutMs = opts.timeoutMs ?? Number(process.env.SEEDREAM_TIMEOUT_MS ?? 90000)
  const maxRetries = opts.maxRetries ?? Number(process.env.SEEDREAM_MAX_RETRIES ?? 2)

  async function generateReal(params: SeedreamGenerateParams): Promise<SeedreamResult> {
    if (!apiKey) throw new Error('VOLC_ARK_API_KEY 未配置')
    if (!model) throw new Error('VOLC_ARK_SEEDREAM_MODEL 未配置（请填写火山方舟推理接入点/模型 ID）')
    const startedAt = Date.now()
    let requestId: string | null = null
    try {
      const generated = await retryWithBackoff(async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const res = await fetch(`${apiBase}/images/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, prompt: params.prompt, size, response_format: 'url', watermark: true }),
            signal: controller.signal,
          })
          requestId = res.headers.get('x-request-id') ?? res.headers.get('request-id')
          if (!res.ok) {
            const detail = await res.text().catch(() => '')
            throw classifyModelError(
              new Error(`Seedream 请求失败：HTTP ${res.status} ${detail.slice(0, 500)}`),
              'seedream',
              res.status,
            )
          }
          return await res.json() as { data?: Array<{ url?: string; b64_json?: string }> }
        } finally {
          clearTimeout(timer)
        }
      }, { maxRetries })

      const item = generated.data?.[0]
      if (!item?.url && !item?.b64_json) throw new Error('Seedream 响应缺少图片数据')
      let bytes: Buffer
      let mime = 'image/png'
      if (item.b64_json) {
        bytes = Buffer.from(item.b64_json, 'base64')
      } else {
        const imageUrl = assertSafeRemoteImageUrl(item.url as string)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const imageRes = await fetch(imageUrl, { signal: controller.signal })
          if (!imageRes.ok) throw new Error(`Seedream 图片下载失败：HTTP ${imageRes.status}`)
          mime = imageRes.headers.get('content-type')?.split(';')[0] ?? mime
          if (!mime.startsWith('image/')) throw new Error(`Seedream 返回非图片内容：${mime}`)
          bytes = Buffer.from(await imageRes.arrayBuffer())
        } finally {
          clearTimeout(timer)
        }
      }
      if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) throw new Error('Seedream 图片大小异常')
      const file = `${safeFileName(params.taskId)}.${extensionForMime(mime)}`
      fs.writeFileSync(path.join(opts.artifactsDir, file), bytes)
      opts.onCall?.({
        provider: 'seedream', model, requestId, kind: 'image', latencyMs: Date.now() - startedAt,
        status: 'success', meta: { size, bytes: bytes.length },
      })
      return {
        url: `/api/v1/artifacts/${safeFileName(params.taskId)}/download`,
        file,
        mime,
        size: bytes.length,
        model,
        mode: 'real',
      }
    } catch (err) {
      const normalized = classifyModelError(err, 'seedream')
      opts.onCall?.({
        provider: 'seedream', model: model || 'unconfigured', requestId, kind: 'image',
        latencyMs: Date.now() - startedAt, status: 'error', errorClass: normalized.cls,
        errorMsg: normalized.message,
      })
      throw normalized
    }
  }

  return {
    mode,
    async generateImage(params: SeedreamGenerateParams): Promise<SeedreamResult> {
      if (mode === 'real') return generateReal(params)
      // mock：模拟真实生成延迟（1~3s，可注入缩短以加速测试）
      const [min, max] = mockDelayMs
      const delay = min + Math.floor(Math.random() * Math.max(1, max - min + 1))
      await sleep(delay)
      // 强制失败标记：测试失败路径（FR-304 失败退分）
      if (params.prompt && params.prompt.includes(failMarker)) {
        throw new Error(`Seedream 生成失败（mock 强制失败）：上游返回错误或内容违规（${failMarker}）`)
      }
      return generateMockSvg(params, opts.artifactsDir)
    },
  }
}
