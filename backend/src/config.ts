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
