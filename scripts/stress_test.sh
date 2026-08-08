#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Informate T14 性能压测启动器（mock Hermes Chat + mock Seedream 生图 全链路）
#
# 覆盖（PRD NFR-13/14/15，技术方案 T14）：
#   a) 5 并发会话 × 3 轮 chat（SSE，mock Hermes）——首包/完整回复 P95
#   b) 10 并发生图（冻结 15 → 队列 → 完成，mock Seedream）——完成 P95
#   c) 计费验证：会话冻结 10 / 超轮 1 分 / 生图冻结 15 / 余额守恒
#
# 用法：bash scripts/stress_test.sh [--json artifacts/03_build/stress_raw.json]
# 依赖：backend(:8080) + compliance(:9100) 已启动；node ≥ 18（全局 fetch）
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

BASE=http://127.0.0.1:8080/api/v1
PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "══════════ Informate T14 性能压测 ══════════"
echo "工作目录：$ROOT"

# 1) 前置健康检查
curl -s -m 3 http://127.0.0.1:8080/health | grep -q '"db":true' && ok "backend :8080 health" || bad "backend :8080 health"
curl -s -m 3 http://127.0.0.1:9100/health | grep -q '"status":"ok"' && ok "compliance :9100 health" || bad "compliance :9100 health"
[ $FAIL -gt 0 ] && { echo "前置服务异常，终止压测"; exit 1; }

# 2) 运行压测驱动（Node，三阶段并发；驱动自身用 import.meta.url 定位 DB，不依赖 cwd）
echo "── 压测驱动：backend/tests/stress/stress_driver.mjs ──"
node "$ROOT/backend/tests/stress/stress_driver.mjs" "$@"
RC=$?

echo ""
echo "══════════ 压测结束（exit=${RC}）══════════"
[ "$RC" -eq 0 ] && echo "🎉 压测驱动正常完成" || echo "⚠️ 压测驱动异常退出"
exit "$RC"
