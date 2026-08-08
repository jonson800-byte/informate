#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Informate T14 压测数据清理（P1-11 整改）
#
# 按 RUN_ID 删除压测产生的全部数据：
#   - conversation / message / credit_txn / artifact 中带 stress- 前缀且含 RUN_ID 的行
#   - data/artifacts/ 下对应的 stress-img-* 产物文件
#   - 可选（--restore-balance）：按被删 credit_txn 净冻结额返还租户余额，
#     并记录清理前余额与清理后核对（balance_after == balance_before + 返还额）
#
# 用法：
#   bash scripts/stress_cleanup.sh <RUN_ID> [--restore-balance] [--dry-run]
#   bash scripts/stress_cleanup.sh all --restore-balance --yes   # 清理全部 stress-* 数据
#
#   <RUN_ID>：stress_raw JSON 的 runId 字段，形如 1786158659107-958356
#             （会话/任务 id 均内嵌该 RUN_ID：stress-chat-<RUN_ID>-0 等）
#   --restore-balance：返还被删流水对应的余额（默认不返还）
#   --dry-run：只统计不删除
#   --yes：配合 `all` 使用，跳过二次确认
#
# 依赖：node ≥ 18 + backend/node_modules/better-sqlite3（无需 sqlite3 CLI）；
#       backend(:8080) 在线时 WAL 模式可并发清理（写锁由 SQLite 串行化）。
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

RUN_ID="${1:-}"
RESTORE=0; DRY=0; YES=0
for arg in "$@"; do
  case "$arg" in
    --restore-balance) RESTORE=1 ;;
    --dry-run)         DRY=1 ;;
    --yes)             YES=1 ;;
  esac
done

if [ -z "$RUN_ID" ]; then
  echo "用法：bash scripts/stress_cleanup.sh <RUN_ID> [--restore-balance] [--dry-run]" >&2
  echo "      bash scripts/stress_cleanup.sh all --restore-balance --yes" >&2
  exit 2
fi

if [ "$RUN_ID" = "all" ] && [ "$RESTORE" = "1" ] && [ "$YES" != "1" ]; then
  echo "⚠️  清理全部 stress-* 数据且恢复余额，请确认：bash scripts/stress_cleanup.sh all --restore-balance --yes" >&2
  exit 2
fi

echo "══════════ Informate T14 压测数据清理 ══════════"
echo "RUN_ID：${RUN_ID}    恢复余额：$([ "$RESTORE" = 1 ] && echo 是 || echo 否)    干跑：$([ "$DRY" = 1 ] && echo 是 || echo 否)"
[ -f "$ROOT/backend/data/informate.db" ] || { echo "❌ 未找到 backend/data/informate.db" >&2; exit 1; }

export CLEANUP_RUN_ID="$RUN_ID" CLEANUP_RESTORE="$RESTORE" CLEANUP_DRY="$DRY" CLEANUP_ROOT="$ROOT"
node <<'NODE'
const path = require('node:path')
const fs = require('node:fs')
const Database = require(path.join(process.env.CLEANUP_ROOT, 'backend/node_modules/better-sqlite3'))

const dbPath = path.join(process.env.CLEANUP_ROOT, 'backend/data/informate.db')
const artDir = path.join(process.env.CLEANUP_ROOT, 'backend/data/artifacts')
const runId = process.env.CLEANUP_RUN_ID
const restore = process.env.CLEANUP_RESTORE === '1'
const dry = process.env.CLEANUP_DRY === '1'

// 匹配模式：`all` → 全部 stress-*；否则 stress-* 且内嵌 RUN_ID（RUN_ID 仅数字+短横，无 LIKE 特殊字符）
const like = runId === 'all' ? 'stress-%' : `%${runId}%`
const filePattern = runId === 'all' ? /^stress-/ : new RegExp(`^stress-img-.*${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\.svg$`)

const db = new Database(dbPath, { timeout: 15000 })
const sum = (rows) => rows.reduce((s, r) => s + r.amount, 0)

// 清理前余额（所有受影响租户）
const affectedTenants = db.prepare(
  `SELECT DISTINCT tenant_id FROM credit_txn WHERE ref_id LIKE ? AND ref_id LIKE 'stress-%'`,
).all(like).map((r) => r.tenant_id)
const balBefore = {}
for (const t of affectedTenants) {
  const row = db.prepare('SELECT balance FROM tenant WHERE id = ?').get(t)
  balBefore[t] = row ? row.balance : null
}

// 待删数据统计
const cnt = (sql, ...args) => db.prepare(sql).get(...args).c
const stats = {
  conversation: cnt(`SELECT COUNT(*) c FROM conversation WHERE id LIKE ?`, like),
  message: cnt(`SELECT COUNT(*) c FROM message WHERE conversation_id LIKE ?`, like),
  credit_txn: cnt(`SELECT COUNT(*) c FROM credit_txn WHERE ref_id LIKE ? AND ref_id LIKE 'stress-%'`, like),
  artifact: cnt(`SELECT COUNT(*) c FROM artifact WHERE id LIKE ? OR conversation_id LIKE ?`, like, like),
}
// 净冻结额（freeze − unfreeze/release；settle 不改变余额，不参与返还）
const txnRows = db.prepare(
  `SELECT tenant_id, type, amount FROM credit_txn WHERE ref_id LIKE ? AND ref_id LIKE 'stress-%'`,
).all(like)
const netByTenant = {}
for (const t of txnRows) netByTenant[t.tenant_id] = (netByTenant[t.tenant_id] ?? 0) + (t.type === 'freeze' ? t.amount : -t.amount)
// 待删产物文件
let files = []
if (fs.existsSync(artDir)) {
  files = fs.readdirSync(artDir).filter((f) => filePattern.test(f)).map((f) => path.join(artDir, f))
}

console.log('待清理统计：')
console.log(`  conversation ${stats.conversation} 行 / message ${stats.message} 行 / credit_txn ${stats.credit_txn} 行 / artifact ${stats.artifact} 行 / 产物文件 ${files.length} 个`)
if (restore) {
  console.log('  净冻结返还：' + Object.entries(netByTenant).map(([t, n]) => `${t}: +${n}`).join('，'))
  console.log('  清理前余额：' + Object.entries(balBefore).map(([t, b]) => `${t}: ${b}`).join('，'))
}

if (dry) {
  console.log('（--dry-run：仅统计，未执行删除）')
  db.close()
  process.exit(0)
}

// 执行删除（单事务）
const del = db.transaction(() => {
  db.prepare(`DELETE FROM message WHERE conversation_id LIKE ?`).run(like)
  db.prepare(`DELETE FROM conversation WHERE id LIKE ?`).run(like)
  db.prepare(`DELETE FROM credit_txn WHERE ref_id LIKE ? AND ref_id LIKE 'stress-%'`).run(like)
  db.prepare(`DELETE FROM artifact WHERE id LIKE ? OR conversation_id LIKE ?`).run(like, like)
  if (restore) {
    for (const [tenantId, net] of Object.entries(netByTenant)) {
      if (net !== 0) db.prepare('UPDATE tenant SET balance = balance + ? WHERE id = ?').run(net, tenantId)
    }
  }
})
del()

// 清理后核对
const after = {
  conversation: cnt(`SELECT COUNT(*) c FROM conversation WHERE id LIKE ?`, like),
  message: cnt(`SELECT COUNT(*) c FROM message WHERE conversation_id LIKE ?`, like),
  credit_txn: cnt(`SELECT COUNT(*) c FROM credit_txn WHERE ref_id LIKE ? AND ref_id LIKE 'stress-%'`, like),
  artifact: cnt(`SELECT COUNT(*) c FROM artifact WHERE id LIKE ? OR conversation_id LIKE ?`, like, like),
}
let deletedFiles = 0
for (const f of files) { try { fs.unlinkSync(f); deletedFiles++ } catch { /* 文件已不存在 */ } }

const balAfter = {}
const balOk = {}
for (const t of affectedTenants) {
  const row = db.prepare('SELECT balance FROM tenant WHERE id = ?').get(t)
  balAfter[t] = row ? row.balance : null
  const net = netByTenant[t] ?? 0
  balOk[t] = restore ? (balAfter[t] === (balBefore[t] ?? 0) + net) : true
}
const rowsOk = after.conversation === 0 && after.message === 0 && after.credit_txn === 0 && after.artifact === 0
const allOk = rowsOk && Object.values(balOk).every(Boolean)

console.log('清理完成：')
console.log(`  删除 conversation ${stats.conversation} / message ${stats.message} / credit_txn ${stats.credit_txn} / artifact ${stats.artifact} 行，产物文件 ${deletedFiles}/${files.length} 个`)
if (restore) {
  console.log('  清理后余额（核对）：' + Object.entries(balAfter).map(([t, b]) => `${t}: ${b}（${balOk[t] ? '✅ 一致' : '❌ 不一致'}）`).join('，'))
}
console.log(`  核对结果：${allOk ? '✅ 通过（stress-* 数据已清零）' : '❌ 未通过（仍有残留，请人工检查）'}`)
db.close()
process.exit(allOk ? 0 : 1)
NODE
RC=$?

echo ""
echo "══════════ 清理结束（exit=${RC}）══════════"
exit "$RC"
