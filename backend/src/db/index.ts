import Database from 'better-sqlite3'

/**
 * 创建 SQLite 连接（better-sqlite3）
 * - WAL 模式（技术方案 §1.5 定稿）
 * - 外键开启（DDL 含 REFERENCES 约束）
 * - busy_timeout 缓解并发写锁
 */
export function createDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return db
}
