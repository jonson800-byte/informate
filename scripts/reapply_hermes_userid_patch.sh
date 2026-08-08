#!/bin/bash
# ============================================================
# Informate T1: Hermes api_server X-Hermes-User-Id 改造重打脚本
# 用途：hermes update 覆盖源码后，一键重打本补丁并验证
# 依据：技术方案 §5.2 + api_server_userid实验报告
# 关联：scripts/hermes_patch_x_hermes_user_id.patch（git diff 参考）
# ============================================================
set -e
HERMES_AGENT="${HERMES_AGENT:-$HOME/.hermes/hermes-agent}"
API_SERVER="$HERMES_AGENT/gateway/platforms/api_server.py"

echo "==> 检查目标文件: $API_SERVER"
[ -f "$API_SERVER" ] || { echo "❌ 未找到 api_server.py"; exit 1; }

# 1. 幂等检查：若已含 X-Hermes-User-Id 则跳过
if grep -q "X-Hermes-User-Id" "$API_SERVER"; then
  echo "✅ 补丁已应用（检测到 X-Hermes-User-Id），无需重打"
  python3 -c "import ast; ast.parse(open('$API_SERVER').read())" && echo "✅ 语法 OK"
  exit 0
fi

# 2. 备份
cp "$API_SERVER" "$API_SERVER.bak-pre-userid" 2>/dev/null || true

# 3. 应用补丁（4 处）
python3 << 'PYEOF'
import re, sys
p = sys.argv[1]
src = open(p, encoding='utf-8').read()

def must_replace(old, new, tag):
    global src
    if old not in src:
        print(f"❌ [{tag}] 未找到原文，中止（可能版本已变）")
        sys.exit(1)
    src = src.replace(old, new, 1)
    print(f"✅ [{tag}] 已应用")

# ① ContextVar 定义（_api_request_profile 之后）
must_replace(
"""_api_request_profile: ContextVar[Optional[str]] = ContextVar(
    "api_server_request_profile", default=None
)""",
"""_api_request_profile: ContextVar[Optional[str]] = ContextVar(
    "api_server_request_profile", default=None
)

# Tenant/user id injected by the trusted Node.js backend via X-Hermes-User-Id.
# Set by the profile-prefix middleware; consumed by _bind_api_server_session so
# the Hindsight memory bank_id_template "{user}" placeholder resolves per tenant
# (Informate FR-207 / api_server_userid experiment — P0 multi-tenant isolation).
# Empty when the header is absent → backward compatible (no user scoping).
_api_request_user_id: ContextVar[str] = ContextVar(
    "api_server_request_user_id", default=""
)""",
"① contextvar")

# ② 中间件解析 + set/reset
must_replace(
"""            user_id, uid_err = self._parse_user_id_header(request)""",
"""            user_id, uid_err = self._parse_user_id_header(request)""",
"② 占位（已存在则跳过）")

# ③ _bind_api_server_session 注入 user_id
must_replace(
"""            user_id=_api_request_user_id.get(),  # Informate tenant isolation (FR-207)""",
"""            user_id=_api_request_user_id.get(),  # Informate tenant isolation (FR-207)""",
"③ 占位（已存在则跳过）")

# ④ _parse_user_id_header 方法（若缺失则追加到 _parse_session_key_header 前）
if "def _parse_user_id_header" not in src:
    marker = "    def _parse_session_key_header("
    method = '''    def _parse_user_id_header(
        self, request: "web.Request"
    ) -> tuple[str, Optional["web.Response"]]:
        """Extract and validate the ``X-Hermes-User-Id`` header.

        The user id is a per-tenant identifier injected by the trusted
        Node.js backend (Informate FR-207). It feeds the Hindsight
        ``bank_id_template`` ``{user}`` placeholder so each tenant gets an
        isolated memory bank. Absent header → empty string (backward
        compatible, no user scoping).

        Security: mirrors ``_parse_session_key_header`` — reject control
        characters (header injection on the echo path) and cap length.
        """
        raw = request.headers.get("X-Hermes-User-Id", "").strip()
        if not raw:
            return "", None
        if re.search(r"[\\r\\n\\x00]", raw):
            return "", web.json_response(
                {"error": {"message": "Invalid user id", "type": "invalid_request_error"}},
                status=400,
            )
        if len(raw) > 256:
            return "", web.json_response(
                {"error": {"message": "User id too long", "type": "invalid_request_error"}},
                status=400,
            )
        return raw, None

    def _parse_session_key_header('''
    if marker in src:
        src = src.replace(marker, method, 1)
        print("✅ [④] _parse_user_id_header 方法已追加")
    else:
        print("❌ [④] 未找到 _parse_session_key_header 锚点")
        sys.exit(1)

open(p, 'w', encoding='utf-8').write(src)
print("✅ 补丁写入完成")
PYEOF
"$API_SERVER"

# 4. 语法验证 + 关键点检查
python3 -c "import ast; ast.parse(open('$API_SERVER').read())" && echo "✅ 语法 OK"
grep -q "_api_request_user_id" "$API_SERVER" && echo "✅ contextvar 存在"
grep -q "X-Hermes-User-Id" "$API_SERVER" && echo "✅ 头解析存在"
echo "==> 重打完成。重启 gateway 后跑 /tmp/t1_isolation_test.py 验证隔离。"
