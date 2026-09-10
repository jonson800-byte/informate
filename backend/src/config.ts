import path from 'node:path'

/** 环境配置（可从 .env / 进程环境覆盖） */
// ⚠️ H1 安全修复（Codex 批次 B 验收）：生产环境必须注入 JWT_SECRET，缺省直接拒绝启动——
// 默认密钥写死在仓库内，任何人可用已知密钥签发 {role:'admin'} token 接管管理接口
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('生产环境必须设置 JWT_SECRET 环境变量（禁止使用默认密钥）')
    }
    console.warn('[config] 开发模式使用默认 JWT_SECRET，生产环境必须注入')
    return 'informate-dev-secret-change-me'
  }
  return secret
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  // 注意：src/config.ts 位于 src/，向上 1 级即 backend/（与 migrate.ts/seed.ts 的 src/db/../../ 指向同一 DB）
  dbPath: process.env.DB_PATH ?? path.join(__dirname, '..', 'data', 'informate.db'),
  // 生图产物落盘目录（T7，技术方案 G13 本地文件存储）
  artifactsDir: process.env.ARTIFACTS_DIR ?? path.join(__dirname, '..', 'data', 'artifacts'),
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
}

/** 生产启动门禁：禁止带 mock/缺失关键依赖的配置误上线。 */
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return
  const errors: string[] = []
  const placeholder = (value?: string) => !value || value.includes('CHANGE_ME')
  if (placeholder(env.JWT_SECRET) || (env.JWT_SECRET?.length ?? 0) < 48) errors.push('JWT_SECRET 必须至少 48 字节且不能使用模板占位值')
  if (!env.REDIS_URL) errors.push('REDIS_URL 未配置')
  const chatProvider = env.CHAT_PROVIDER ?? (env.HERMES_MODE === 'real' ? 'hermes' : env.HERMES_MODE)
  if (chatProvider === 'deepseek') {
    if (placeholder(env.DEEPSEEK_API_KEY)) errors.push('CHAT_PROVIDER=deepseek 时必须配置真实 DEEPSEEK_API_KEY')
  } else if (chatProvider === 'hermes') {
    if (placeholder(env.HERMES_API_KEY) || !env.HERMES_API_BASE) errors.push('CHAT_PROVIDER=hermes 时必须配置真实 HERMES_API_BASE/HERMES_API_KEY')
  } else {
    errors.push('CHAT_PROVIDER 必须为 deepseek 或 hermes（生产禁止 mock）')
  }
  if (env.SEEDREAM_MODE !== 'real') errors.push('SEEDREAM_MODE 必须为 real（生产禁止 mock）')
  if (placeholder(env.VOLC_ARK_API_KEY)) errors.push('VOLC_ARK_API_KEY 未配置真实值')
  if (placeholder(env.VOLC_ARK_SEEDREAM_MODEL)) errors.push('VOLC_ARK_SEEDREAM_MODEL 未配置真实值')
  if (env.RECHARGE_MODE === 'mock') errors.push('生产禁止 RECHARGE_MODE=mock')
  if (errors.length > 0) throw new Error(`生产配置校验失败：${errors.join('；')}`)
}
