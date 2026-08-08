import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Seedream 生图客户端（T7）
 *
 * 依据：技术方案 §2.4（生图数据流：冻结 15 → 任务队列 → Seedream 5.0 → 回调结算/失败退分）、
 *       PRD FR-301~307、场景包「生成图片」（generate_image：Seedream 5.0 异步任务）。
 *
 * 两种运行模式，按环境变量切换：
 * - mock（默认）：生成占位图（SVG）落盘 data/artifacts/，并模拟 1~3s 生成延迟；
 *   用于本地开发与自动化测试（无火山方舟密钥也能跑通全链路）。
 * - real：预留火山方舟（Volcengine Ark）Seedream 5.0 文生图接口；
 *   设置 VOLC_ARK_API_KEY 后启用（SEEDREAM_MODE=mock 可强制 mock）。
 *
 * 说明：真实接入时补全 generateReal() 内 TODO 标注的 SDK 调用即可，
 * 返回结构保持 SeedreamResult 不变，上游（任务队列 worker）无需改动。
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
 * TODO(真实接入)：
 *   1. `npm i @volcengine/openapi`（或按火山方舟文档用 REST API）；
 *   2. 用 VOLC_ARK_API_KEY 初始化 SDK client（api.volcengine.com/ark/api/v3/images/generations，
 *      model=seedream-5.0 / doubao-seedream-3.0）；
 *   3. 提交异步任务 → 轮询任务状态 → 取回图片 URL → 下载到 artifactsDir（file = ${taskId}.png）；
 *   4. 返回 SeedreamResult（url 指向本地下载端点，保证前端访问路径统一）。
 * 本阶段未配置密钥/未装 SDK → 抛出明确错误，由 worker 走失败退分路径（FR-304）。
 */
async function generateReal(params: SeedreamGenerateParams): Promise<SeedreamResult> {
  void params // 预留参数
  throw new Error(
    'SEEDREAM_REAL_NOT_CONFIGURED: 火山方舟 Seedream 真实模式未接入。' +
    '请安装 @volcengine/openapi 并配置 VOLC_ARK_API_KEY（或设置 SEEDREAM_MODE=mock 使用占位图模式）',
  )
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

  const useReal = !!process.env.VOLC_ARK_API_KEY && process.env.SEEDREAM_MODE !== 'mock'
  const mode: 'mock' | 'real' = useReal ? 'real' : 'mock'
  if (mode === 'mock' && !process.env.VOLC_ARK_API_KEY) {
    // 仅在显式需要 real 但没密钥时提示一次（开发默认 mock 不刷屏）
    void 0
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
