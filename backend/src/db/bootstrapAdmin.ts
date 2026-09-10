import bcrypt from 'bcryptjs'
import type Database from 'better-sqlite3'
import { createDb } from './index'
import { runMigrations } from './migrate'
import { newId } from '../utils/id'
import path from 'node:path'

export function bootstrapAdmin(db: Database.Database, env: NodeJS.ProcessEnv = process.env): boolean {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM admin').get() as { c: number }).c
  if (count > 0) return false
  const username = env.BOOTSTRAP_ADMIN_USERNAME?.trim()
  const password = env.BOOTSTRAP_ADMIN_PASSWORD
  if (!username || !password || password.length < 12 || password.includes('CHANGE_ME')) {
    throw new Error('数据库尚无管理员：请设置 BOOTSTRAP_ADMIN_USERNAME 和至少 12 位的 BOOTSTRAP_ADMIN_PASSWORD')
  }
  db.prepare(`INSERT INTO admin (id, username, credentials_hash, name, status) VALUES (?, ?, ?, ?, 'active')`)
    .run(newId('admin'), username, bcrypt.hashSync(password, 12), env.BOOTSTRAP_ADMIN_NAME?.trim() || '平台管理员')
  console.log(`[bootstrap] 已创建首个管理员：${username}（请登录后轮换密码并清除 BOOTSTRAP_ADMIN_PASSWORD）`)
  return true
}

if (require.main === module) {
  const dbPath = process.env.DB_PATH ?? path.join(__dirname, '..', '..', 'data', 'informate.db')
  const db = createDb(dbPath)
  try {
    runMigrations(db)
    bootstrapAdmin(db)
  } finally {
    db.close()
  }
}
