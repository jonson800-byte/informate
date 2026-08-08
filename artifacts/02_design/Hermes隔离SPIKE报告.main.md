# Hermes 隔离 SPIKE 报告

> 日期：2026-08-06 · 执行：architect（子代理实验）+ 主会话源码验证
> 目的：验证 Hermes 是否支持多租户注入/生命周期/状态清理，为 Informate 架构（无状态 Worker + 租户×场景独立记忆）提供事实依据
> 方法：Hermes 源码审阅（plugins/memory/hindsight/__init__.py、gateway/platforms/api_server.py）+ 真实实验（spike-iso profile）

---

## 一、验证结论（速览）

| # | 问题 | 结论 | 证据 |
|:--|:--|:--|:--|
| 1 | HINDSIGHT_BANK_ID 环境变量能否动态切换 bank | ❌ **不能**（仅 fallback，config.yaml bank_id 优先） | 实验证实（三个实验全跑在 informate-arch） |
| 2 | bank_id_template 动态 bank 机制 | ✅ **支持**（源码确认） | hindsight provider `_resolve_bank_id_template` |
| 3 | user_id 区分（同 profile 多用户隔离） | ✅ **支持**（源码确认） | provider `self._user_id` + `{user}` 占位符 |
| 4 | api_server 会话连续性 | ✅ 支持 | `X-Hermes-Session-Id` 请求头（api_server.py） |
| 5 | api_server 层 user_id 传递 | ⚠️ **未完全确认** | 无 X-Hermes-User 头；需 Node.js 后端验证传递方式 |
| 6 | 生命周期（按需拉起/复用） | ✅ 支持 | profile 可独立启动/停止；`hermes -p <profile> chat` 按需执行 |

---

## 二、关键机制详解

### 2.1 bank_id_template（多租户隔离的正确机制）✅

源码 `plugins/memory/hindsight/__init__.py`（Hermes 正式功能）：
```python
# 第 1072 行（provider 配置 schema）
{"key": "bank_id_template",
 "description": "Optional template to derive bank_id dynamically. "
                 "Placeholders: {profile}, {workspace}, {platform}, {user}, {session}. "
                 "Example: hermes-{profile}", "default": ""}

# 第 1534-1536 行（运行时解析）
self._bank_id_template = self._config.get("bank_id_template", "") or ""
self._bank_id = _resolve_bank_id_template(
    self._bank_id_template, ...)

# 第 644-670 行（解析函数，占位符缺失自动折叠）
# {user} 来自 platform user id（gateway sessions）
# 空模板时回退到 bank_id
```

**占位符**：`{profile}`（profile 名）/ `{workspace}` / `{platform}` / `{user}`（用户ID）/ `{session}`（会话ID）

**对 Informate 的意义**：配置 `bank_id_template: 'informate-tenant-{user}'` → 每个租户 user_id 自动解析出独立 bank → **租户×场景独立记忆在 profile 层原生支持**。

### 2.2 HINDSIGHT_BANK_ID 环境变量（不可靠）❌

- 实验：`HINDSIGHT_BANK_ID=tnt-cli-a hermes -p spike-iso chat -q "记录暗号"` → 实际写入 **informate-arch**（spike-iso config.yaml 绑定的 bank）
- 验证：spike-iso config.yaml bank_id=informate-arch；.env HINDSIGHT_BANK_ID=informate-arch
- 源码：`os.environ.get("HINDSIGHT_BANK_ID", "hermes")`（399 行）仅为 fallback
- **结论：环境变量不能动态切换 bank**——子代理实验中"跨租户泄漏"是假象（三实验同 bank），但反证了**config 静态 bank_id 无法满足多租户动态隔离**

### 2.3 user_id 与 api_server 传递 ⚠️

- provider 层：`self._user_id = str(kwargs.get("user_id") or "")` → bank_id_template 的 {user} 从 user_id 解析 ✅
- api_server 层：`X-Hermes-Session-Id` 请求头支持会话连续性（需 API key）✅；**未发现 X-Hermes-User-Id 头** ⚠️
- **待验证**：Node.js 后端调用 Hermes api_server 时如何传递租户 user_id（可能通过 session 绑定、或请求体/自定义头）——这是集成层的关键对接点

### 2.4 生命周期 ✅

- `hermes -p <profile> chat -q`：一次性执行（每次 20-40s 冷启动，含记忆加载）
- profile gateway / api_server：可启动/停止（lingxi-demo 已验证 8650/8651 端口）
- **对 Informate**：Worker 池 = N 个场景模板 profile 的 api_server 实例；租户绑定 = 每次请求带 user_id/session → 动态 bank；闲置 15 分钟销毁租户绑定（进程回池）

---

## 三、子代理实验记录（真实执行）

| 实验 | 命令 | 结果 | 解读 |
|:--|:--|:--|:--|
| 记录 | `HINDSIGHT_BANK_ID=tnt-cli-a hermes -p spike-iso chat -q "记录暗号骆驼"` | 已记录 ✅ | 实际写入 informate-arch（env 未生效） |
| 同租户检索 | `HINDSIGHT_BANK_ID=tnt-cli-a ... "检索暗号"` | 返回"紫罗兰"+骆驼 | informate-arch 中既有记忆（architect bank）混入 |
| 跨租户负例 | `HINDSIGHT_BANK_ID=tnt-cli-b ... "检索暗号"` | 返回同样内容 | **非泄漏**——bank 未切换，仍 informate-arch |

**实验教训**：①环境变量不能用于租户切换；②正确实验需配 bank_id_template + 不同 user_id；③architect bank 已有 234 条灵犀记忆会污染实验（应用空白 profile + 干净 bank）

---

## 四、对 Informate 架构的影响与建议

### 影响
1. **架构可行**：租户×场景独立记忆 = `bank_id_template: 'informate-tenant-{user}'`（profile 原生支持），无需每租户独立 profile 进程
2. **无状态 Worker 可行**：Worker 池共享场景模板 profile；租户隔离靠 bank_id_template 动态解析 + user_id 传递
3. **环境变量方案废弃**：不依赖 HINDSIGHT_BANK_ID 切换（不可靠）

### 建议
1. **集成层验证（P0）**：Node.js 后端 → Hermes api_server 的 user_id 传递方式（X-Hermes-Session-Id 绑定 session → user？或自定义头？）——设计阶段第一个集成实验
2. **隔离测试用例（P0）**：A/B 租户（不同 user_id）→ 各写暗号 → 互查 → 断言不串；纳入 qa-engineer 验收
3. **SPIKE 环境**：用干净 profile + 空 bank（避免 architect bank 记忆污染）
4. **配置模板**：场景包 schema 中 memory 段采用 `bank_id_template`（非静态 bank_id）
5. **性能基准**：冷启动 20-40s → 必须 Worker 池保活；池大小按并发会话（5-10）建模

---

## 五、风险

| 风险 | 等级 | 说明 | 缓解 |
|:--|:--|:--|:--|
| api_server user_id 传递未确认 | 🔴 高 | 集成层关键对接点未知 | 设计阶段第一个集成实验 |
| bank_id_template 配置入口 | 🟠 中 | `hermes config set memory.bank_id_template` 提示 not recognized（schema 未注册，但 provider 运行时读取） | 直接编辑 config.yaml memory 段（或验证正确设置路径） |
| 冷启动 20-40s | 🟠 中 | 按需拉起体验差 | Worker 池保活（闲置 15 分钟销毁绑定，进程保留） |
| 记忆污染 | 🟡 低 | 复用 profile 时旧记忆混入 | 场景 profile 用干净 bank（bank_id_template 天然隔离） |
