/**
 * Hermes api_server 客户端封装（T6）
 *
 * - mock 模式（默认）：本地生成流式 SSE 模拟响应，不依赖 Hermes gateway，
 *   用于 T6 单测与前端联调（集成联调 T13 再接真）。
 * - real 模式：POST http://127.0.0.1:8647/v1/chat/completions
 *   带 X-Hermes-User-Id（租户上下文，仅后端可信注入）+ Authorization: Bearer <API_KEY>，
 *   解析 OpenAI 兼容 SSE 流（data: {...} → choices[0].delta.content）逐块转发。
 *
 * 模式选择优先级：显式 mode 参数 > HERMES_MODE 环境变量 > 'mock'。
 * 环境变量：HERMES_API_BASE（默认 http://127.0.0.1:8647）、HERMES_API_KEY（默认 spike-userid-test-key）。
 */

export interface HermesChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface HermesClientOptions {
  mode?: 'mock' | 'real'
  baseUrl?: string
  apiKey?: string
  /** mock 模式：分块间隔 ms（默认 20） */
  streamDelayMs?: number
  /** mock 模式：每块字符数（默认 12） */
  chunkSize?: number
  /** mock 模式：自定义回复文本（测试注入违禁词等场景用；缺省用 buildMockReply） */
  mockReply?: string
}

export interface HermesStreamParams {
  messages: HermesChatMessage[]
  /** 租户上下文（X-Hermes-User-Id），仅后端可信注入 */
  userId: string
  /** 会话 ID（X-Hermes-Session-Id = Informate conversation_id，保证 Hermes 侧会话作用域独立） */
  sessionId: string
  signal?: AbortSignal
}

export interface HermesClient {
  streamChat(params: HermesStreamParams): AsyncGenerator<string>
}

/** mock 回复模板：引用用户消息并说明当前为模拟输出 */
function buildMockReply(userContent: string): string {
  return [
    `已收到您的消息：「${userContent}」。`,
    '（T6 Mock 回复）这是 Hermes api_server 的模拟流式输出，用于验证 Chat 会话链路：SSE 透传、轮次计费、消息落库与记忆写入均正常。',
    '正式环境将由 Hermes agent 结合行业知识库与租户记忆生成专业回答。',
  ].join('\n')
}

/** 按码点切块（中文场景足够） */
function* chunkText(text: string, size: number): Generator<string> {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createHermesClient(opts: HermesClientOptions = {}): HermesClient {
  const mode = opts.mode ?? process.env.HERMES_MODE ?? 'mock'
  const baseUrl = opts.baseUrl ?? process.env.HERMES_API_BASE ?? 'http://127.0.0.1:8647'
  const apiKey = opts.apiKey ?? process.env.HERMES_API_KEY ?? 'spike-userid-test-key'
  const streamDelayMs = opts.streamDelayMs ?? 20
  const chunkSize = opts.chunkSize ?? 12

  if (mode === 'real') {
    // 真实模式：转发 Hermes api_server 的 OpenAI 兼容流式接口
    return {
      async *streamChat({ messages, userId, sessionId, signal }) {
        // H5 修复（Codex 批次 C）：Hermes 上游挂起时给首包超时（冷启动 SLA ≤40s）+ 空闲超时
        const firstByteMs = Number(process.env.HERMES_FIRST_BYTE_TIMEOUT_MS ?? 40000)
        const idleMs = Number(process.env.HERMES_IDLE_TIMEOUT_MS ?? 60000)
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'X-Hermes-User-Id': userId,
            'X-Hermes-Session-Id': sessionId,
          },
          body: JSON.stringify({ model: 'hermes-agent', messages, stream: true }),
          signal,
        })
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '')
          throw new Error(`Hermes api_server 请求失败：HTTP ${res.status} ${detail.slice(0, 300)}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let lastChunkAt = Date.now()
        const startedAt = Date.now()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // H5：首包超时（冷启动 SLA ≤40s）+ 空闲超时（上游静默）
          const now = Date.now()
          if (buf.length === 0 && now - startedAt > firstByteMs) {
            throw new Error(`Hermes api_server 首包超时（>${firstByteMs}ms），请检查场景 Worker 是否就绪`)
          }
          if (now - lastChunkAt > idleMs) {
            throw new Error(`Hermes api_server 空闲超时（>${idleMs}ms 无数据）`)
          }
          lastChunkAt = now
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') return
            try {
              const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
              const delta = parsed.choices?.[0]?.delta?.content
              if (delta) yield delta
            } catch {
              // 忽略无法解析的 SSE 块（心跳/keep-alive 等）
            }
          }
        }
      },
    }
  }

  // mock 模式：本地生成模拟流式响应
  return {
    async *streamChat({ messages, signal }) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const reply = opts.mockReply ?? buildMockReply(lastUser?.content ?? '')
      for (const chunk of chunkText(reply, chunkSize)) {
        if (signal?.aborted) throw new Error('生成已中止（客户端断开）')
        yield chunk
        await sleep(streamDelayMs)
      }
    },
  }
}
