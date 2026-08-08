# api_server user_id 集成实验报告（P0）

> 日期：2026-08-06 · 执行：architect（子代理实验 50 calls）+ 主会话整理
> 状态：**P0 集成阻塞确认**——api_server 路径当前无法实现租户级 bank 隔离，需源码级改造
> 前置：Hermes 隔离 SPIKE（artifacts/02_design/Hermes隔离SPIKE报告.md）确认 bank_id_template 机制

---

## 一、实验结论（速览）

| # | 验证项 | 结论 | 证据 |
|:--|:--|:--|:--|
| 1 | set_session_vars 是否支持 user_id | ✅ **原生支持**（有参数） | gateway/session_context.py:206 定义 `set_session_vars(...)` 含 user_id 形参（api_server.py import 使用） |
| 2 | api_server 是否传 user_id | ❌ **不传**（默认空串） | `_bind_api_server_session` 调用未传 user_id |
| 3 | X-Hermes-Session-Id / X-Hermes-Session-Key 是否官方支持 | ✅ 官方声明 | api_server features: `session_continuity_header` / `session_key_header` |
| 4 | 通过 X-Hermes-Session-Key 能否实现用户级 bank 隔离 | ❌ **实测不能**（session 隔离未生效） | Scenario 1：两 session 记录后检索返回同一完整列表 |
| 5 | agent 层 → hindsight provider 的 user_id 链路 | ✅ 通 | run_agent.py 573 `user_id=user_id` → agent_init.py 596 `agent._user_id` → hindsight 1491 `self._user_id` → 1541 `user=self._user_id` |
| 6 | Hindsight 是否支持跨 bank 检索/写读 | ✅ bank 参数明确 | openapi：`POST /v1/default/banks/{bank_id}/memories/recall` |

**结论**：**缺失点在 api_server 请求入口**——agent 层/Hindsight 层 user_id 链路完整，只差 api_server 把请求方的 user_id 注入 `set_session_vars`。这是可修复的源码缺口，不是架构不可行。

---

## 二、源码证据（文件:行号）

### 2.1 缺失点（核心）
```
gateway/platforms/api_server.py:5925  def _bind_api_server_session(...)   # 会话绑定函数
gateway/platforms/api_server.py:6013/6511  tokens = self._bind_api_server_session(...)
→ 内部调用 set_session_vars(platform/chat_id/session_key/session_id/async_delivery/cron_session)
→ 未传 user_id（默认空串）
```

### 2.2 user_id 完整链路（agent 层已通）
```
gateway/run.py:4534  user_id=getattr(ctx.source, "user_id", None)   # messaging 平台已传
gateway/run.py:6666  user_id=str(source.user_id)
run_agent.py:573     user_id=user_id                               # → agent
agent/agent_init.py:596  agent._user_id = user_id                  # → agent 属性
plugins/memory/hindsight/__init__.py:1491  self._user_id = str(kwargs.get("user_id") or "")
plugins/memory/hindsight/__init__.py:1541  user=self._user_id      # → Hindsight API
```

### 2.3 api_server 官方头声明
```
gateway/platforms/api_server.py:3065  "session_continuity_header": "X-Hermes-Session-Id",
gateway/platforms/api_server.py:3066  "session_key_header": "X-Hermes-Session-Key",
```

### 2.4 bank_id_template 解析（机制确认）
```
plugins/memory/hindsight/__init__.py:644  def _resolve_bank_id_template(template, fallback, **placeholders)
  占位符: {profile} {workspace} {platform} {user} {session}（缺失自动折叠）
```

---

## 三、Scenario 1 实验记录（真实执行）

环境：spike-userid profile（clone architect 后改配 `bank_id=informate-exp-fallback` + `bank_id_template=informate-exp-{user}-{profile}`），api_server :8647，Hindsight :9177。

| 步骤 | 命令/操作 | 结果 | 解读 |
|:--|:--|:--|:--|
| 记录 | Session A 发"记住暗号青苹果" | 200「已记住青苹果」(35s 冷启动) | 写入成功 |
| 记录 | Session B 发"记住暗号红玫瑰" | 200「已记住红玫瑰」(5s) | 写入成功 |
| 检索 | Session A/B 分别查"我记录的暗号" | **两次都返回「紫罗兰、骆驼、青苹果、红玫瑰」** | ❌ **未按 session 隔离**：两 session 命中同一 bank（且含 informate-arch 历史暗号紫罗兰/骆驼，说明检索甚至跨了实验 bank 边界或 user 折叠为空） |

**解读**：X-Hermes-Session-Key 只做会话连续性/长时记忆作用域（api_server.py:2046 docstring「scopes long-term memory」），**未注入 user 维度**，不能作租户隔离——`{user}` 折叠为空 → bank 退化为模板静态解析，所有请求落同一 bank。与 SPIKE 判定一致：**api_server 路径租户隔离必须源码改造**。

---

## 四、三方案对比

| 方案 | 改动量 | 风险 | 优点 | 缺点 |
|:--|:--|:--|:--|:--|
| **a. api_server 支持 X-Hermes-User-Id 头** | 小（api_server.py 1 处解析 + 传入 set_session_vars） | 低 | 最直接；Node.js 后端每请求带租户 ID 头；语义清晰 | 需改 Hermes 源码（fork 或提 PR） |
| b. session 创建接口绑定 user_id | 中（session 对象加字段 + 创建接口扩展） | 中 | 长连接语义（session 级租户归属） | 需维护 session 生命周期与租户映射 |
| **c. X-Hermes-Session-Key 作用域** | 零改动（现有通道） | **高** | 无需改源码 | **实测隔离不生效**；且 key 可被猜测注入（`_parse_session_key_header` 警告未认证客户端可猜 key）→ 仅可作会话连续性，不可作租户隔离 |

**推荐：方案 a（X-Hermes-User-Id 头）**，理由：改动最小、语义最清晰（租户 ID 由 Node.js 后端可信注入，每请求显式携带）、不引入 session 生命周期复杂度。

---

## 五、落地步骤（推荐方案 a）

1. **改 api_server.py**（约 10-20 行）：
   - 在 `_bind_api_server_session` 或请求处理入口解析 `X-Hermes-User-Id` 请求头
   - 校验 API key 通过后，将该值传入 `set_session_vars(user_id=<租户ID>)`
   - 参考 messaging 平台路径（gateway/run.py:4534）的传法
2. **本地 fork 验证**：改本机源码 → 起 spike-userid → 带 X-Hermes-User-Id 头重跑 Scenario 1 → 断言 A/B 租户 bank 不同、检索不串
3. **提 PR 给 Hermes 上游**（NousResearch/hermes-agent）：这个缺口影响所有 API 接入方做多租户，值得 upstream
4. **Node.js 后端**：租户上下文解析 → 每个 api_server 请求带 `X-Hermes-User-Id: <tenant_id>`；api_server 仅内网/带 API key 访问，不向浏览器直连开放

---

## 六、对 Informate 的影响

- **P0 阻塞确认**：MVP 开发前必须先完成方案 a（或等价）的源码改造 + 隔离测试
- **不阻塞设计**：场景包 Schema 的 memory 段照常写 `bank_id_template: 'informate-tenant-{user}-{profile}'`（FR-207 已定稿），等 api_server 支持后生效
- **架构方向不变**：无状态 Worker + 动态 bank 依然成立；只是 api_server 需要一次源码增强
- **安全要求**：user_id 由 Node.js 后端可信注入（不信任浏览器直传）；api_server 强制 API key 认证

---

## 七、遗留

- Scenario 1 的检索返回含 informate-arch 历史暗号（紫罗兰/骆驼）——需排查是 Hindsight 检索的跨 bank 语义还是实验环境残留（spike-userid 克隆自 architect 时 bank 未完全切换），建议正式隔离测试用全新空 bank
- 方案 a 的 PR 提交时机：MVP 开发前（第三批技术方案应包含此改造任务）
