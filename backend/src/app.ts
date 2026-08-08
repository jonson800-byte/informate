import Fastify, { type FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { config } from './config'
import { createDb } from './db'
import { runMigrations } from './db/migrate'
import { errorHandler } from './utils/errors'
import { registerHealthRoutes } from './routes/health'
import { registerAuthRoutes } from './routes/auth'
import { registerAuthTenantRoutes } from './routes/auth_tenant'
import { registerUserRoutes } from './routes/users'
import { registerScenarioRoutes } from './routes/scenarios'
import { registerWorkspaceRoutes } from './routes/workspace'
import { registerAdminRoutes } from './routes/admin'
import { registerCreditRoutes } from './routes/credit'
import { registerAdminCreditRoutes } from './routes/admin_credit'
import { registerChatRoutes, type ChatRouteOptions } from './routes/chat'
import { registerImageGenRoutes } from './routes/imagegen'

/** Fastify 类型扩展：app.db 全局数据库实例 */
declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database
  }
}

export interface BuildAppOptions {
  dbPath?: string
  jwtSecret?: string
  jwtExpiresIn?: string
  logger?: boolean
  /** 生图产物落盘目录（T7；默认 backend/data/artifacts） */
  artifactsDir?: string
  /** 测试注入：mock 生图延迟区间（毫秒，默认 1000~3000） */
  seedreamMockDelayMs?: [number, number]
  /** T6 Chat 路由选项（Hermes 客户端 / 记忆 / 合规服务地址，测试可注入 mock） */
  chat?: ChatRouteOptions
}

/**
 * 构建 Fastify 应用（可注入配置，便于测试）
 * - 连接 SQLite（WAL）+ 执行迁移
 * - 注册统一错误处理器（{code,message,details}）
 * - 注册路由：/health、/api/v1/auth、/api/v1/workspace、/api/v1/admin、/api/v1/credit
 */
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const dbPath = opts.dbPath ?? config.dbPath
  const jwtSecret = opts.jwtSecret ?? config.jwtSecret
  const jwtExpiresIn = opts.jwtExpiresIn ?? config.jwtExpiresIn

  // 连接数据库（默认 data/informate.db，测试传 :memory:）
  const db = createDb(dbPath)
  runMigrations(db)

  const app = Fastify({
    logger: opts.logger ?? false,
  })

  // 挂载全局 db 实例
  app.decorate('db', db)

  // 统一错误格式
  app.setErrorHandler(errorHandler)

  // 路由
  registerHealthRoutes(app)
  registerAuthRoutes(app, jwtSecret)                 // /auth/me（登录已迁至 auth_tenant.ts）
  registerAuthTenantRoutes(app, jwtSecret, jwtExpiresIn) // /auth/register + /auth/login
  registerUserRoutes(app, jwtSecret)                 // /users（FR-105 员工管理）
  registerScenarioRoutes(app, jwtSecret)             // /scenarios + /scenarios/deploy
  registerWorkspaceRoutes(app, jwtSecret)
  registerAdminRoutes(app, jwtSecret)                // /admin/tenants
  registerCreditRoutes(app, jwtSecret)               // /credit/*（积分管线，T5）
  registerAdminCreditRoutes(app, jwtSecret)          // /admin/overview|adjust|export|price-config（T5）
  registerChatRoutes(app, jwtSecret, opts.chat)      // /chat/messages（Chat 会话服务，T6）

  // 优雅关闭：关闭数据库连接
  app.addHook('onClose', async () => {
    db.close()
  })

  // T7 生图执行器（注册在 db.close 钩子之后：Fastify onClose 按 LIFO 执行，
  // 后注册的钩子先跑 → 队列先排空落账，再关闭数据库，避免在途任务写已关闭连接）
  registerImageGenRoutes(app, jwtSecret, {
    artifactsDir: opts.artifactsDir ?? config.artifactsDir,
    seedream: opts.seedreamMockDelayMs ? { mockDelayMs: opts.seedreamMockDelayMs } : undefined,
  })

  return app
}
