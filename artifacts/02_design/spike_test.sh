#!/bin/bash
# Hermes 隔离 SPIKE 实验脚本 — spike-iso profile, api_server :8646
set -u
KEY=$(grep '^API_SERVER_KEY=' ~/.hermes/profiles/spike-iso/.env | head -1 | cut -d= -f2)
BASE="http://127.0.0.1:8646"
H="Authorization: Bearer $KEY"
HS="http://localhost:9177"

echo "===== 0. 环境检查 ====="
echo "API key len: ${#KEY}"
echo "banks before:"
curl -s "$HS/v1/default/banks" | python3 -c "import sys,json; d=json.load(sys.stdin); print([b['bank_id'] for b in d.get('banks',[])])" 2>/dev/null || curl -s "$HS/v1/default/banks" | head -c 300

echo
echo "===== 1. 种子：向 tenant-tenant-a / tenant-tenant-b 写入隔离记忆 ====="
curl -s -X POST "$HS/v1/default/banks/tenant-tenant-a/memories" -H "Content-Type: application/json" -d '{"items":[{"content":"租户A专属机密：客户编号CUST-A-001，电话号码13800000001","context":"spike test","tags":["spike"]}]}' | head -c 200
echo
curl -s -X POST "$HS/v1/default/banks/tenant-tenant-b/memories" -H "Content-Type: application/json" -d '{"items":[{"content":"租户B专属机密：客户编号CUST-B-999，邮箱b@example.com","context":"spike test","tags":["spike"]}]}' | head -c 200
echo

chat() {
  # $1=session_key  $2=system_prompt  $3=user_message
  local key="$1" sys="$2" msg="$3"
  curl -s -m 120 "$BASE/v1/chat/completions" \
    -H "$H" -H "Content-Type: application/json" \
    -H "X-Hermes-Session-Key: $key" \
    -d "$(python3 -c "
import json,sys
body={'model':'deepseek-v4-flash','messages':[]}
if '$sys': body['messages'].append({'role':'system','content':'''$sys'''})
body['messages'].append({'role':'user','content':'''$msg'''})
print(json.dumps(body,ensure_ascii=False))
")" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    if 'choices' in d: print('REPLY:', d['choices'][0]['message']['content'][:400])
    elif 'error' in d: print('ERROR:', d['error'].get('message','')[:300])
    else: print('RAW:', str(d)[:300])
except Exception as e: print('PARSE_FAIL:', e)
"
}

echo
echo "===== 2. 租户A 会话（session-key=tenant-a）====="
chat "tenant-a" "你是租户A的客服助手。你现在服务的客户属于租户A。" "客户问：我们的客户编号是什么？（根据你的记忆回答，如果记忆里没有就说不知道）"

echo
echo "===== 3. 租户B 会话（session-key=tenant-b）—— 必须不知道A的机密 ====="
chat "tenant-b" "你是租户B的客服助手。你现在服务的客户属于租户B。" "客户问：我们的客户编号是什么？（根据你的记忆回答，如果记忆里没有就说不知道）"

echo
echo "===== 4. 无会话键 匿名会话 —— 应无任何租户记忆 ====="
chat "" "" "客户问：你知道我的客户编号吗？根据记忆回答，没有就说不知道。"

echo
echo "===== 5. 同 key 换新会话（无 X-Hermes-Session-Id，stateless）— 无记忆回传测试 ====="
chat "tenant-a" "你是租户A的客服助手。" "我刚才告诉过你一个电话号码，是什么？（如果本会话上下文和记忆里都没有，就说不知道）"
