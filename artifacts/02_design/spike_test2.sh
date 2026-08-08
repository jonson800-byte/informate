#!/bin/bash
# Hermes 隔离 SPIKE 实验脚本 v2 — spike-iso profile, api_server :8646
set -u
KEY=$(grep '^API_SERVER_KEY=' ~/.hermes/profiles/spike-iso/.env | head -1 | cut -d= -f2)
BASE="http://127.0.0.1:8646"
H="Authorization: Bearer $KEY"
HS="http://localhost:9177"
DIR="/Users/zhangyihui/Desktop/Informate Project/artifacts/02_design"

chat() {
  # $1=session_key  $2=system_prompt  $3=user_message
  local key="$1" sys="$2" msg="$3"
  local extra=()
  if [ -n "$key" ]; then extra=(-H "X-Hermes-Session-Key: $key"); fi
  curl -s -m 180 "$BASE/v1/chat/completions" \
    -H "$H" -H "Content-Type: application/json" \
    "${extra[@]}" \
    -d "$(python3 "$DIR/mkreq.py" "$sys" "$msg")" \
    | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if 'choices' in d:
        print('REPLY:', d['choices'][0]['message']['content'][:500].replace(chr(10),' '))
    elif 'error' in d:
        print('ERROR:', d['error'].get('message','')[:300])
    else:
        print('RAW:', str(d)[:300])
except Exception as e:
    print('PARSE_FAIL:', e)
"
}

echo "===== 2. 租户A 会话（session-key=tenant-a，含租户system prompt注入）====="
chat "tenant-a" "你是租户A的专属客服助手，只服务租户A的客户。回答前调用你的记忆工具检索租户信息。" "客户问：我们的客户编号是什么？根据记忆回答，记忆里没有就说'记忆中无此信息'。"

echo
echo "===== 3. 租户B 会话（session-key=tenant-b）—— 隔离断言：不得泄漏A的CUST-A-001 ====="
chat "tenant-b" "你是租户B的专属客服助手，只服务租户B的客户。回答前调用你的记忆工具检索租户信息。" "客户问：我们的客户编号是什么？根据记忆回答，记忆里没有就说'记忆中无此信息'。"

echo
echo "===== 4. 无会话键匿名会话 —— 无租户绑定，应无任何租户记忆 ====="
chat "" "" "你知道我的客户编号吗？根据你的记忆回答，没有就说不知道。"

echo
echo "===== 5. stateless 验证：同 key 连续两次请求（不带 X-Hermes-Session-Id）====="
chat "tenant-a" "你是租户A的客服助手。" "请只回答一个字：把'青苹果'这个词记在你心里，不要复述。"
chat "tenant-a" "你是租户A的客服助手。" "我刚才让你记的词是什么？本会话上下文里没有就说'本会话无此信息'，记忆里有就说出来。"

echo
echo "===== 6. 会话续接验证：带 X-Hermes-Session-Id 恢复历史 ====="
R=$(curl -s -m 180 "$BASE/v1/chat/completions" -H "$H" -H "Content-Type: application/json" \
  -H "X-Hermes-Session-Key: tenant-a" \
  -d "$(python3 "$DIR/mkreq.py" "你是租户A的客服助手。" "请记住这个暗号：紫罗兰。然后只回复'已记住'。")")
SID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
echo "session id: $SID"
chat "tenant-a" "你是租户A的客服助手。" "我们刚才约定的暗号是什么？"
