/**
 * 统一错误格式：{ code, message, details }
 * - code：机器可读错误码（UNAUTHORIZED / FORBIDDEN / ...）
 * - message：人类可读描述（中文）
 * - details：可选附加信息（参数校验明细等）
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/** 常用错误快捷构造 */
export const Errors = {
  /** 401：未登录 / token 缺失或无效 */
  unauthorized: (message = '未登录或凭证无效') => new AppError(401, 'UNAUTHORIZED', message),
  /** 403：越权（NFR-07：越权访问返回 403） */
  forbidden: (message = '无权访问该资源') => new AppError(403, 'FORBIDDEN', message),
  /** 404：资源不存在 */
  notFound: (message = '资源不存在') => new AppError(404, 'NOT_FOUND', message),
  /** 400：请求参数错误 */
  badRequest: (message = '请求参数错误', details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details),
  /** 409：状态冲突 */
  conflict: (message = '状态冲突') => new AppError(409, 'CONFLICT', message),
}

/**
 * Fastify 全局错误处理器：把所有异常归一为 {code,message,details}
 * - AppError → 对应 statusCode
 * - Fastify schema 校验错误 → 400 VALIDATION_ERROR
 * - 其余 → 500 INTERNAL_ERROR
 */
export function errorHandler(err: unknown, _req: unknown, reply: {
  status: (code: number) => { send: (body: unknown) => void },
}) {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    })
  }

  const anyErr = err as { validation?: unknown; message?: string }
  if (anyErr && anyErr.validation) {
    return reply.status(400).send({
      code: 'VALIDATION_ERROR',
      message: '请求参数校验失败',
      details: anyErr.validation,
    })
  }

  // 兜底：不向客户端泄露内部堆栈
  console.error('[error]', anyErr?.message ?? err)
  return reply.status(500).send({
    code: 'INTERNAL_ERROR',
    message: '服务器内部错误',
  })
}
