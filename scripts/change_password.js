#!/usr/bin/env node
'use strict'

/**
 * Informate 账号改密工具（batchE P1-8 / T15 上线准备）
 *
 * 用法：
 *   node scripts/change_password.js <账号> <新密码> [--table=user|admin]
 *
 * 功能：
 *   - 自动匹配：先查 user 表（owner/employee 登录名 = name 字段），再查 admin 表（username 字段）；
 *     两表均命中且未指定 --table → 报错退出，避免误改。
 *   - bcryptjs（rounds=10）哈希写入 credentials_hash，与后端 seed/注册逻辑一致（NFR-09）。
 *   - 写 audit_log 审计记录（action='password_change'，NFR 审计要求）。
 *   - 生产安全（与后端 src/config.ts 同口径）：NODE_ENV=production 时必须注入自定义 JWT_SECRET，
 *     否则拒绝执行；开发/试运行未注入时仅警告（提示生产先注入 JWT_SECRET）。
 *
 * 依赖：backend/node_modules 中的 better-sqlite3 与 bcryptjs（先 `cd backend && npm install`）。
 * 示例：
 *   node scripts/change_password.js admin '新强密码'                  # admin 表（username=admin）
 *   node scripts/change_password.js owner '新强密码' --table=user    # user 表（name=owner）
 */

const path = require('node:path')
const fs = require('node:fs')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const BACKEND_DIR = path.join(PROJECT_ROOT, 'backend')

/** 从 backend/node_modules 解析依赖（脚本独立于 backend 工作目录运行） */
function requireFromBackend(name) {
  const p = path.join(BACKEND_DIR, 'node_modules', name)
  if (!fs.existsSync(p)) {
    console.error(`[change-password] 缺少依赖 ${name}：请先在 backend/ 执行 npm install`)
    process.exit(1)
  }
  return require(p)
}

const bcrypt = requireFromBackend('bcryptjs')
const Database = requireFromBackend('better-sqlite3')

const DEV_DEFAULT_SECRET = 'informate-dev-secret-change-me'

// ---------------- 参数解析 ----------------
const args = process.argv.slice(2)
const tableFlag = args.find((a) => a.startsWith('--table='))
const positional = args.filter((a) => !a.startsWith('--'))
const [account, newPassword] = positional
const table = tableFlag ? tableFlag.split('=')[1] : null

function usage() {
  console.log(`用法: node scripts/change_password.js <账号> <新密码> [--table=user|admin]
  账号: user 表登录名（owner/employee，即 name 字段）或 admin 表登录名（username 字段）
  新密码: 明文密码（≥6 位），脚本以 bcrypt(10) 哈希后写入 credentials_hash
  --table: 账号在 user 与 admin 两表均存在时必填，避免歧义（可选值为 user|admin）
示例:
  node scripts/change_password.js admin '新强密码'
  node scripts/change_password.js owner '新强密码' --table=user`)
}

if (!account || !newPassword) {
  usage()
  process.exit(1)
}
if (table && table !== 'user' && table !== 'admin') {
  console.error('[change-password] --table 仅支持 user|admin')
  process.exit(1)
}
if (newPassword.length < 6) {
  console.error('[change-password] 新密码过短（至少 6 位，与后端注册/创建员工校验一致）')
  process.exit(1)
}

// ---------------- 生产安全校验（JWT_SECRET 注入提示） ----------------
const isProduction = process.env.NODE_ENV === 'production'
const jwtSecret = process.env.JWT_SECRET
if (isProduction && (!jwtSecret || jwtSecret === DEV_DEFAULT_SECRET)) {
  console.error(
    '[change-password] 生产环境必须注入自定义 JWT_SECRET（禁止默认密钥，与后端 config.ts 同口径）。\n' +
    '请先设置环境变量再执行，例如:\n' +
    "  NODE_ENV=production JWT_SECRET='<强随机值>' node scripts/change_password.js <账号> <新密码>",
  )
  process.exit(1)
}
if (!isProduction && (!jwtSecret || jwtSecret === DEV_DEFAULT_SECRET)) {
  console.warn('[change-password] 警告：未检测到自定义 JWT_SECRET（开发默认值）。生产环境改密前务必先注入强随机 JWT_SECRET。')
}

// ---------------- 打开数据库 ----------------
const dbPath = process.env.DB_PATH || path.join(BACKEND_DIR, 'data', 'informate.db')
if (!fs.existsSync(dbPath)) {
  console.error(`[change-password] 数据库文件不存在：${dbPath}（可设置 DB_PATH 覆盖；先执行 npm run migrate && npm run seed）`)
  process.exit(1)
}
const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')

// ---------------- 定位账号 ----------------
function findUser() {
  return db.prepare('SELECT id, tenant_id, role, name, credentials_hash FROM user WHERE name = ?').get(account)
}
function findAdmin() {
  return db.prepare('SELECT id, username, credentials_hash FROM admin WHERE username = ?').get(account)
}

const userRow = findUser()
const adminRow = findAdmin()

if (!userRow && !adminRow) {
  console.error(`[change-password] 账号不存在：${account}（user 表与 admin 表均未命中）`)
  db.close()
  process.exit(1)
}
if (userRow && adminRow && !table) {
  console.error(
    `[change-password] 账号 ${account} 在 user 表与 admin 表均存在，请用 --table=user 或 --table=admin 明确目标，避免误改。`,
  )
  db.close()
  process.exit(1)
}
if (table === 'user' && !userRow) {
  console.error(`[change-password] user 表不存在账号：${account}`)
  db.close()
  process.exit(1)
}
if (table === 'admin' && !adminRow) {
  console.error(`[change-password] admin 表不存在账号：${account}`)
  db.close()
  process.exit(1)
}

const target = table === 'admin' ? adminRow : userRow && (!adminRow || table === 'user') ? userRow : adminRow
const isAdminTarget = target === adminRow

// ---------------- 改密（bcrypt 哈希 + 更新 + 审计） ----------------
const hash = bcrypt.hashSync(newPassword, 10)

try {
  db.transaction(() => {
    if (isAdminTarget) {
      db.prepare("UPDATE admin SET credentials_hash = ?, updated_at = datetime('now') WHERE id = ?")
        .run(hash, target.id)
      db.prepare(
        "INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip) VALUES (NULL, ?, 'password_change', 'admin', ?, ?, 'cli')",
      ).run(target.id, target.id, `改密工具修改密码（账号 ${account}）`)
    } else {
      db.prepare("UPDATE user SET credentials_hash = ?, updated_at = datetime('now') WHERE id = ?")
        .run(hash, target.id)
      db.prepare(
        "INSERT INTO audit_log (tenant_id, user_id, action, object_type, object_id, detail, ip) VALUES (?, ?, 'password_change', 'user', ?, ?, 'cli')",
      ).run(target.tenant_id, target.id, target.id, `改密工具修改密码（账号 ${account}）`)
    }
  })()
} catch (err) {
  console.error(`[change-password] 写库失败（已回滚，密码未变更）：${err.message}`)
  db.close()
  process.exit(1)
}

// ---------------- 验证 ----------------
const verify = isAdminTarget
  ? db.prepare('SELECT credentials_hash FROM admin WHERE id = ?').get(target.id)
  : db.prepare('SELECT credentials_hash FROM user WHERE id = ?').get(target.id)
const ok = verify && bcrypt.compareSync(newPassword, String(verify.credentials_hash))

db.close()

if (!ok) {
  console.error('[change-password] 写入后验证失败，请检查数据库状态')
  process.exit(1)
}

console.log(`[change-password] ✅ 已修改：${isAdminTarget ? 'admin' : 'user'} 表账号「${account}」（bcrypt rounds=10）
  数据库: ${dbPath}
  审计: audit_log 已记录 action=password_change
  请用新密码实际登录验证（后端 /api/v1/auth/login）。`)
