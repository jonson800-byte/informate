import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { createDb } from './index'

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

/**
 * 执行 migrations 目录下的 .sql 迁移文件（按文件名升序，幂等）。
 * 已应用的迁移记录在 schema_migrations 表。
 */
export function runMigrations(db: Database.Database, migrationsDir: string = MIGRATIONS_DIR): string[] {
  // 迁移记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  )
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  const newlyApplied: string[] = []

  const applyAll = db.transaction(() => {
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file)
      newlyApplied.push(file)
      console.log(`[migrate] applied ${file}`)
    }
  })
  // H3 修复（Codex 批次 B）：迁移可能 DROP/重建带 FK 的表（如 002 scenario_deployment）。
  // PRAGMA foreign_keys 在事务内无效——必须在事务外关闭，迁移完成后恢复并校验无孤儿引用。
  db.pragma('foreign_keys = OFF')
  try {
    applyAll()
  } finally {
    db.pragma('foreign_keys = ON')
    const issues = db.pragma('foreign_keys = ON') && (db.pragma('foreign_key_check') as unknown[])
    if (Array.isArray(issues) && issues.length > 0) {
      throw new Error(`[migrate] 迁移后外键完整性校验失败：${JSON.stringify(issues.slice(0, 5))}`)
    }
  }

  return newlyApplied
}

/**
 * CLI 入口：npm run migrate
 */
if (require.main === module) {
  const dbPath = process.env.DB_PATH ?? path.join(__dirname, '..', '..', 'data', 'informate.db')
  // 确保数据目录存在
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  const db = createDb(dbPath)
  try {
    runMigrations(db)
    console.log(`[migrate] done, db=${dbPath}`)
  } finally {
    db.close()
  }
}
