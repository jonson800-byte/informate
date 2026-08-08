#!/bin/bash
# Informate MVP 端到端冒烟测试（重启后验证环境健康）
# 用法: bash scripts/dev_smoke.sh
set -e
BASE=http://127.0.0.1:8080/api/v1
PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "══════════ Informate 冒烟测试 ══════════"

# 1) 健康检查
curl -s -m 3 http://127.0.0.1:8080/health | grep -q '"db":true' && ok "backend health" || bad "backend health"
curl -s -m 3 http://127.0.0.1:9100/health | grep -q '"status":"ok"' && ok "compliance health" || bad "compliance health"

# 2) 登录
LOGIN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{"account":"owner","password":"owner123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
[ -n "$TOKEN" ] && ok "登录 owner/owner123" || { bad "登录"; echo "$LOGIN"; exit 1; }

# 3) workspace（应有 2 个场景）
SC=$(curl -s $BASE/workspace -H "Authorization: Bearer $TOKEN")
echo "$SC" | grep -q "行业工作助手" && ok "场景: 行业工作助手" || bad "场景: 行业工作助手"
echo "$SC" | grep -q "营销生图" && ok "场景: 营销生图" || bad "场景: 营销生图"

# 4) Chat SSE 流式
CONV="smoke-$(date +%s)"
curl -s -X POST $BASE/credit/conversations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"scenario_id\":\"industry_work_assistant\",\"conversation_id\":\"$CONV\",\"idempotency_key\":\"conv:$CONV\"}" >/dev/null
SSE=$(curl -s -N -X POST $BASE/chat/messages -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"conversation_id\":\"$CONV\",\"content\":\"测试\"}" 2>&1)
echo "$SSE" | grep -q "round_complete" && ok "Chat SSE 流式（含 round_complete）" || bad "Chat SSE 流式"

# 5) 生图（mock Seedream）
TASK="img-$(date +%s)"
curl -s -X POST $BASE/credit/image-tasks -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"task_id\":\"$TASK\",\"scenario_id\":\"generate_image\"}" | grep -q '"freeze":15' && ok "生图冻结 15" || bad "生图冻结 15"
curl -s -X POST $BASE/image-tasks/$TASK/execute -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"医美海报"}' | grep -q "queued" && ok "生图入队" || bad "生图入队"
sleep 4
curl -s $BASE/image-tasks/$TASK -H "Authorization: Bearer $TOKEN" | grep -q '"status":"success"' && ok "生图成功（mock）" || bad "生图成功（mock）"

echo ""
echo "══════════ 结果: $PASS 通过 / $FAIL 失败 ══════════"
[ $FAIL -eq 0 ] && echo "🎉 全部通过，环境健康" || exit 1
