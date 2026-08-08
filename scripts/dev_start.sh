#!/bin/bash
# Informate MVP 干净环境一键启动（重启电脑后使用）
# 用法: bash scripts/dev_start.sh [--reset-db] [--no-seed]
#   --reset-db  删除数据库重新 migrate+seed（干净测试数据；默认保留现有数据）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "══════════ Informate 开发环境启动 ══════════"

# 1) 合规服务 :9100
if curl -s -m 2 http://127.0.0.1:9100/health >/dev/null 2>&1; then
  echo "[1/4] compliance :9100 ✅ 已在运行"
else
  echo "[1/4] 启动 compliance :9100 …"
  (cd services/compliance && .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 9100 >/tmp/informate_compliance.log 2>&1 &)
  sleep 2
  curl -s -m 3 http://127.0.0.1:9100/health >/dev/null 2>&1 && echo "  ✅ compliance 就绪" || echo "  ⚠️ compliance 未就绪（看 /tmp/informate_compliance.log）"
fi

# 2) 数据库（可选重置）
if [[ "$1" == "--reset-db" ]]; then
  echo "[2/4] 重置数据库（删旧 + migrate + seed）…"
  rm -f backend/data/informate.db
  (cd backend && npm run migrate >/dev/null && npm run seed)
  echo "  ✅ 数据库已重建（owner/owner123, employee/emp123, admin/admin123）"
else
  if [ -f backend/data/informate.db ]; then
    echo "[2/4] 数据库已存在，保留（--reset-db 可重置）"
  else
    echo "[2/4] 初始化数据库（migrate + seed）…"
    (cd backend && npm run migrate >/dev/null && npm run seed)
  fi
fi

# 3) 后端 :8080
if curl -s -m 2 http://127.0.0.1:8080/health >/dev/null 2>&1; then
  echo "[3/4] backend :8080 ✅ 已在运行"
else
  echo "[3/4] 启动 backend :8080 …"
  (cd backend && nohup npm run dev >/tmp/informate_backend.log 2>&1 &)
  for i in $(seq 1 15); do
    sleep 1
    curl -s -m 2 http://127.0.0.1:8080/health >/dev/null 2>&1 && break
  done
  curl -s -m 2 http://127.0.0.1:8080/health >/dev/null 2>&1 && echo "  ✅ backend 就绪" || echo "  ⚠️ backend 未就绪（看 /tmp/informate_backend.log）"
fi

# 4) 前端 :5173
if curl -s -m 2 http://127.0.0.1:5173/ >/dev/null 2>&1; then
  echo "[4/4] frontend :5173 ✅ 已在运行"
else
  echo "[4/4] 启动 frontend :5173 …"
  (cd frontend && nohup npm run dev >/tmp/informate_frontend.log 2>&1 &)
  for i in $(seq 1 20); do
    sleep 1
    curl -s -m 2 http://127.0.0.1:5173/ >/dev/null 2>&1 && break
  done
  curl -s -m 2 http://127.0.0.1:5173/ >/dev/null 2>&1 && echo "  ✅ frontend 就绪" || echo "  ⚠️ frontend 未就绪（看 /tmp/informate_frontend.log）"
fi

echo ""
echo "══════════ 启动完成 ══════════"
echo "前端:   http://localhost:5173   （owner/owner123, employee/emp123, admin/admin123）"
echo "后端:   http://localhost:8080/health"
echo "合规:   http://127.0.0.1:9100/health"
echo "冒烟:   bash scripts/dev_smoke.sh"
