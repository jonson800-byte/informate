# Informate 场景包 Schema V1 说明文档

> 版本：V1.0 · 日期：2026-08-06 · 状态：正式定义（设计阶段交付物 #1）
> 权威依据：`docs/产品设计/PRD_v1.md`（FR-201~209 / FR-301~307 / FR-401~405 / NFR-06）、`docs/Informate_项目说明_v3.1.md`（Q24/Q25/Q26/Q27/Q28/Q19/Q23）、`docs/决策记录/决策记录_20260806.md`、`artifacts/01_strategy/M1内容工厂复用评估.md`、`docs/评估报告/20260806_Gemini_落地版.md`（商品图 profile 参考实现）
> 机器可校验定义：`场景包Schema_v1.json`（JSON Schema draft-07，`additionalProperties: false` 严格模式）

---

## 1. 场景包概念

**场景包（Scenario Package）= 一个可部署、可计费、可复制的 AI 能力单元。**

```
场景包 = 角色定义（人设/使命/规则/流程，参考 agency-agents-zh frontmatter 格式）
       + Hermes profile 运行时配置（模型 / 供应商 / 工具列表）
       + 场景专属参数（积分单价 / 产出物类型 / 知识库绑定 / 工作流 / 合规）
```

- **部署单元**：客户按需求部署场景（¥500/场景一次性），部署后场景出现在左侧列表（FR-103）
- **运行单元**：按需拉起（Hydration，Q18）——profile 不常驻，会话发起时由无状态 Worker 全量注入后运行，闲置 15 分钟销毁租户绑定
- **计费单元**：所有能力按积分计费（会话型按轮、生成型按张/条），单价为管理后台可配置变量（FR-704），场景包中的值为**出厂默认值**
- **复制单元**：同一场景包按客户部署，靠 bank 隔离（`informate-tenant-{user}-{profile}`）与行业知识叠加层区分客户，实现「角色包跨行业，行业知识薄薄一层」（Q28 核心洞察）

---

## 2. Schema 结构总览

```
scenario-package (object, 13 个顶层字段全部必填)
├── id            string   场景唯一标识（snake_case）
├── name          string   显示名称
├── version       string   语义化版本（MAJOR.MINOR.PATCH）
├── description   string   职责说明
├── emoji         string   场景图标
├── color         string   主题色 #RRGGBB
├── pricing       object   计费配置（积分单价/单位/会话轮数）
│   ├── deduct_points      integer   对外展示价
│   ├── actual_points      integer   实际扣费价
│   ├── refund_on_failure  boolean   失败自动退分
│   ├── unit               enum      计费单位
│   ├── included_rounds    integer   会话含轮数（unit=session 必填）
│   ├── extra_round_points integer   超轮单价（unit=session 必填）
│   └── round_limit        integer   轮次上限（unit=session 必填）
├── runtime       object   Hermes 运行时
│   ├── model              string    模型标识
│   ├── provider           enum      供应商（deepseek/volcengine/minimax）
│   └── skills             array     可调用工具列表
├── memory        object   记忆与知识库绑定
│   ├── bank_id_template   string    租户 bank 命名模板（占位符白名单 {user}/{profile}）
│   └── read_only_banks    array     只读 bank（informate-common / informate-industry_<行业>）
├── knowledge     object   行业知识叠加层
│   ├── types              array     知识类型枚举（terms/faq/scripts/sop/regulations）
│   └── sub_industry       string?   二级行业过滤（P2 检索），null=通用
├── workflow      object   场景工作流
│   ├── description        string    一句话描述
│   ├── produces           enum      产出物类型（须=artifact.type）
│   └── steps              array     步骤序列（order/action/tool/note）
├── artifact      object   产出物 Payload 契约
│   ├── type               enum      text/image/video/file
│   ├── url_template       string?   URL 模板
│   ├── metadata.fields    array     元数据字段定义
│   └── actions            array     支持操作（preview/download/copy/regenerate/send_to_scenario）
└── compliance    object   合规配置
    ├── enabled            boolean   启用合规引擎
    ├── rule_packs         array     规则包（general/medical/education/finance/food_health）
    └── ai_label           boolean   AI 生成标识（国标，永久保留）
```

---

## 3. 字段定义表

### 3.1 顶层字段

| 字段 | 类型 | 必填 | 说明 | 枚举/格式约束 |
|:--|:--|:--:|:--|:--|
| `id` | string | ✅ | 场景唯一标识，全局唯一；跨场景传递 `target_scenario` 引用此值 | `^[a-z][a-z0-9_]{2,63}$`（snake_case，小写开头） |
| `name` | string | ✅ | 场景显示名称（左栏场景列表展示） | 1-32 字符 |
| `version` | string | ✅ | 场景包版本；计价/规则变更必须升版本并留审计 | `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`（语义化版本） |
| `description` | string | ✅ | 场景职责说明（部署审核 + 列表副标题） | 10-500 字符 |
| `emoji` | string | ✅ | 场景图标（建议单个 emoji，如 🏥 / 🖼️） | 1-8 码位（容纳 ZWJ 组合序列） |
| `color` | string | ✅ | 场景主题色（前端卡片/高亮） | `^#[0-9a-fA-F]{6}$` |
| `pricing` | object | ✅ | 计费配置，见 §3.2 | — |
| `runtime` | object | ✅ | 运行时配置，见 §3.3 | — |
| `memory` | object | ✅ | 记忆与知识库绑定，见 §3.4 | — |
| `knowledge` | object | ✅ | 行业知识叠加层，见 §3.5 | — |
| `workflow` | object | ✅ | 场景工作流，见 §3.6 | — |
| `artifact` | object | ✅ | 产出物 Payload 契约，见 §3.7 | — |
| `compliance` | object | ✅ | 合规配置，见 §3.8 | — |

### 3.2 pricing（计费配置）

| 字段 | 类型 | 必填 | 说明 | 枚举/格式约束 |
|:--|:--|:--:|:--|:--|
| `deduct_points` | integer | ✅ | 对外展示价（报价/文案口径） | ≥ 1（积分） |
| `actual_points` | integer | ✅ | 实际扣费价（执行优惠价） | ≥ 1；业务规则 `actual_points ≤ deduct_points` |
| `refund_on_failure` | boolean | ✅ | 失败自动退分（FR-304：仅生成失败/超时退；成功但效果不满意不退） | true/false；会话型建议 false |
| `unit` | enum | ✅ | 计费单位 | `session` / `image` / `video` / `file` / `task` |
| `included_rounds` | integer | 条件必填 | 会话含轮数（`unit=session` 时必填；否则禁止出现） | ≥ 1；业务规则 `< round_limit` |
| `extra_round_points` | integer | 条件必填 | 超轮单价（`unit=session` 时必填） | ≥ 1（积分/轮） |
| `round_limit` | integer | 条件必填 | 单会话轮次上限（`unit=session` 时必填）；达上限拦截并引导新开对话（FR-205，防套利） | ≥ 1 |

### 3.3 runtime（Hermes profile 运行时）

| 字段 | 类型 | 必填 | 说明 | 枚举/格式约束 |
|:--|:--|:--:|:--|:--|
| `model` | string | ✅ | 模型标识 | 已知值：`deepseek-v4-flash`（文本）/ `seedream-5.0`（生图）/ `minimax-h3-768p`（生视频标准档）/ `seedance-2.0-720p`（生视频品质档）；1-64 字符 |
| `provider` | enum | ✅ | 模型供应商 | `deepseek` / `volcengine`（火山方舟：Seedream 生图、Seedance 生视频）/ `minimax`（H3 生视频） |
| `skills` | array | 选填 | 场景可调用工具/skill 列表 | 每项 1-64 字符、去重；`workflow.steps[].tool` 必须 ∈ 此列表 |

### 3.4 memory（记忆与知识库绑定）

| 字段 | 类型 | 必填 | 说明 | 枚举/格式约束 |
|:--|:--|:--:|:--|:--|
| `bank_id_template` | string | ✅ | 租户记忆 bank 命名模板（FR-207 定稿） | **固定值** `informate-tenant-{user}-{profile}`；占位符白名单仅 `{user}`=租户ID（仅后端可信注入）、`{profile}`=场景名；场景包内禁止写死真实租户 ID |
| `read_only_banks` | array | 选填（默认空） | 只读 bank 列表：`informate-common` 通用层 + `informate-industry_<一级行业>` 行业层（部署时按租户一级行业绑定，Q28） | 每项 `^informate-(common\|industry_[A-Za-z0-9_\u4e00-\u9fa5]+)$`；**禁止** `informate-tenant_` 前缀（租户 bank 为读写，由 `bank_id_template` 定义）；去重 |
| `notes` | string | 选填 | 记忆策略补充说明 | ≤ 500 字符 |

### 3.5 knowledge（行业知识叠加层）

| 字段 | 类型 | 必填 | 说明 | 枚举/格式约束 |
|:--|:--|:--:|:--|:--|
| `types` | array | ✅ | 加载的行业知识类型（行业 bank 条目带 `metadata.sub_industry` 二级行业标记） | 枚举元素：`terms`（术语）/ `faq`（FAQ）/ `scripts`（话术）/ `sop`（SOP）/ `regulations`（法规库）；去重；非知识型场景可为空数组 `[]` |
| `sub_industry` | string/null | 选填（默认 null） | 二级行业过滤（精确匹配条目 `metadata.sub_industry`，对应检索优先级 P2）；null/缺省 = 一级行业通用条目（P3）+ 通用层（P4）兜底 | ≤ 32 字符；医美二级行业如：植发/口腔/皮肤/整形/光电 |

**检索优先级（部署时硬编码，Q25）**：P1 租户私有 bank（精确二级行业）→ P2 行业 bank 中 `sub_industry`=租户二级行业 → P3 行业 bank 通用条目 → P4 通用 bank。

### 3.6 workflow（场景工作流）

| 字段 | 类型 | 必填 | 说明 | 枚举/格式约束 |
|:--|:--|:--:|:--|:--|
| `description` | string | 选填 | 工作流一句话描述（人话版） | ≤ 1000 字符 |
| `produces` | enum | 选填 | 本场景最终产出物类型 | `text` / `image` / `video` / `file`；业务规则：须与 `artifact.type` 一致 |
| `steps` | array | ✅ | 步骤序列（工具调用顺序） | 至少 1 步；每步：`order`（integer ≥1，业务规则：从 1 连续递增无重复）、`action`（enum 见下）、`tool`（call_skill 时必填且 ∈ `runtime.skills`）、`note`（≤300 字符） |

**action 枚举**：`intent_parse`（意图解析）/ `memory_load`（租户记忆加载）/ `knowledge_retrieve`（分层知识检索）/ `compliance_check`（合规检查）/ `call_skill`（调用工具，须填 tool）/ `emit_artifact`（产出物入面板）/ `respond`（流式回复）。

> 积分冻结/扣减/解冻由**平台积分管线**执行（Q20：BullMQ + 两阶段确认），不出现在场景工作流字段中——场景包只描述业务动作序列。

### 3.7 artifact（产出物 Payload 契约）

| 字段 | 类型 | 必填 | 说明 | 枚举/格式约束 |
|:--|:--|:--:|:--|:--|
| `type` | enum | ✅ | 产出物类型 | `text` / `image` / `video` / `file` |
| `url_template` | string | 选填 | 产出物 URL 模板（文本型可省略） | ≤ 200 字符，如 `https://cdn.informate.ai/outputs/{year}/{month}/...` |
| `metadata.fields` | array | 选填 | 元数据字段定义（跨场景传递时随文件一起投递，Q23——目标 Agent 基于元数据继续工作） | 每项：`name`（`^[a-z][a-z0-9_]*$`）、`type`（enum：`string`/`number`/`boolean`/`string_array`/`object`）、`description`（≤300）、`required`（boolean，默认 false） |
| `actions` | array | 选填 | 产出物支持操作（右栏按钮） | 每项：`label`（1-32 字符）、`type`（enum 见下）、`target_scenario`（type=`send_to_scenario` 时必填，`^[a-z][a-z0-9_]*$`） |

**action type 枚举**：`preview`（预览）/ `download`（下载）/ `copy`（复制）/ `regenerate`（重新生成，按次计费）/ `send_to_scenario`（跨场景传递，须填 `target_scenario`；运行时校验目标场景已部署且租户 active，试用期禁用 FR-404）。

### 3.8 compliance（合规配置，Q19）

| 字段 | 类型 | 必填 | 说明 | 枚举/格式约束 |
|:--|:--|:--:|:--|:--|
| `enabled` | boolean | ✅ | 是否启用 M1 合规引擎（违禁词引擎 + 规则包 + LLM fallback + 自动修正） | 医美等强监管行业必须 `true` |
| `rule_packs` | array | 条件必填 | 启用规则包（M1 `data/compliance_rules/` 四行业包 + 通用库） | 枚举：`general`（通用违禁词库）/ `medical`（广告法绝对化用语、医疗广告审查、前后对比禁令、违禁词库）/ `education` / `finance` / `food_health`；`enabled=true` 时非空 |
| `ai_label` | boolean | 选填（默认 true） | AI 生成内容标识（水印或元数据标记，2026 生成式 AI 国标 NFR-01） | 默认 true；**永久保留项**，不随试用/正式状态变化（FR-504） |

---

## 4. 校验规则

### 4.1 必填清单（Schema 硬校验）

- **顶层（13 项全必填）**：`id` `name` `version` `description` `emoji` `color` `pricing` `runtime` `memory` `knowledge` `workflow` `artifact` `compliance`
- **嵌套必填**：`pricing.deduct_points` `pricing.actual_points` `pricing.refund_on_failure` `pricing.unit` ｜ `runtime.model` `runtime.provider` ｜ `memory.bank_id_template` ｜ `knowledge.types` ｜ `workflow.steps`（≥1）｜ `artifact.type` ｜ `compliance.enabled`
- **条件必填**：`pricing.included_rounds` / `extra_round_points` / `round_limit`（`unit=session` 时，Schema `if/then` 硬校验；`unit≠session` 时**禁止**出现，Schema `else` 硬校验）｜ `workflow.steps[].tool`（`action=call_skill` 时）｜ `artifact.actions[].target_scenario`（`type=send_to_scenario` 时）｜ `compliance.rule_packs`（`enabled=true` 时非空，Schema 硬校验）

### 4.2 枚举值清单

| 字段 | 允许值 |
|:--|:--|
| `pricing.unit` | `session` / `image` / `video` / `file` / `task` |
| `runtime.provider` | `deepseek` / `volcengine` / `minimax` |
| `knowledge.types[]` | `terms` / `faq` / `scripts` / `sop` / `regulations` |
| `workflow.produces` / `artifact.type` | `text` / `image` / `video` / `file` |
| `workflow.steps[].action` | `intent_parse` / `memory_load` / `knowledge_retrieve` / `compliance_check` / `call_skill` / `emit_artifact` / `respond` |
| `artifact.metadata.fields[].type` | `string` / `number` / `boolean` / `string_array` / `object` |
| `artifact.actions[].type` | `preview` / `download` / `copy` / `regenerate` / `send_to_scenario` |
| `compliance.rule_packs[]` | `general` / `medical` / `education` / `finance` / `food_health` |

### 4.3 格式约束（正则）

| 字段 | 约束 |
|:--|:--|
| `id` / `target_scenario` / 元数据 `name` | `^[a-z][a-z0-9_]{2,63}$`（snake_case） |
| `version` | `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`（语义化版本） |
| `color` | `^#[0-9a-fA-F]{6}$` |
| `bank_id_template` | `^informate-tenant-\{user\}-\{profile\}$`（固定模板） |
| `read_only_banks[]` | `^informate-(common\|industry_[A-Za-z0-9_\u4e00-\u9fa5]+)$`（仅通用层/行业层） |
| 积分字段 | integer ≥ 1（`deduct_points`/`actual_points`/`included_rounds`/`extra_round_points`/`round_limit`） |

### 4.4 业务校验规则（跨字段，由平台 `validateScenarioPackage` 校验层执行）

以下规则无法用 JSON Schema（draft-07 无常量外数值比较）硬表达，部署/保存场景包时由平台校验层强制：

| # | 规则 | 依据 |
|:--|:--|:--|
| B1 | `1 ≤ actual_points ≤ deduct_points`（实际扣费价不超过对外价） | D4 定价口径（对外保守/实际让利） |
| B2 | `round_limit > included_rounds`（轮次上限大于含轮数，如 50 > 20） | Q26 会话计费口径 |
| B3 | `workflow.steps` 的 `order` 从 1 连续递增、无重复、无跳号 | 工具调用顺序语义 |
| B4 | `action=call_skill` 的 `tool` ∈ `runtime.skills`；`compliance_check`/`knowledge_retrieve` 步骤的 `tool` 同理 | 工具白名单 |
| B5 | `workflow.produces == artifact.type`（若 produces 填写） | 产出物一致性 |
| B6 | `read_only_banks` 禁止 `informate-tenant_` 前缀（租户 bank 只读注入仅经 `bank_id_template`） | NFR-06 隔离 |
| B7 | `bank_id_template` 占位符仅 `{user}`/`{profile}`；场景包内禁止出现真实租户 ID | FR-207 安全 |
| B8 | `send_to_scenario.target_scenario` 必须为已存在场景 id；运行时校验目标场景已部署且租户 active；试用期禁用 | FR-403/404 |
| B9 | 行业=医美的部署实例 `compliance.enabled` 必须为 `true` 且 `rule_packs` 含 `medical` | FR-204/209/307、Q19 |
| B10 | 积分单价为后台可配置变量——管理后台改动即时生效，不要求与场景包一致（场景包 = 出厂默认） | FR-704 |

### 4.5 bank 命名与占位符白名单

- **租户记忆 bank（读写）**：由 `bank_id_template` 解析——`informate-tenant-{user}-{profile}`（连字符分隔；`{user}`=租户 ID 仅后端可信注入，`{profile}`=场景名）。同租户不同场景 bank 隔离，进程间不共享（FR-207/NFR-06）。
- **只读 bank（注入检索）**：`informate-common`（通用层，P4）+ `informate-industry_<一级行业>`（行业层，P2/P3，如 `informate-industry_医美`）。
- **一致性说明**：v3.1/NFR-06 早期行文为 `informate-tenant_<租户>_<场景>`（下划线），FR-207 修复后定稿为连字符版 `informate-tenant-{user}-{profile}`——**V1 统一以连字符版为准**，早期表述作废。

---

## 5. 完整实例

### 实例 A：行业工作助手（医美）—— 零号客户部署实例

依据：FR-201~209 / Q25 / Q26 / Q27 / Q28。计费 = 15 积分/会话含 20 轮，超轮 1 积分/轮，上限 50 轮（Q26）。

```yaml
# Informate 场景包实例 · 行业工作助手（医美）V1
id: industry_work_assistant
name: 行业工作助手
display_name_template: "{industry}行业工作助手"   # 部署层按租户一级行业渲染（零号客户=医美行业工作助手）
version: "1.0.0"
description: 医美行业文本对话底座：按租户一级行业加载医美知识叠加层，多轮对话 + 医美内容合规 + 会话级积分计费
emoji: 🏥
color: "#00A0E9"

pricing:
  deduct_points: 10          # 对外价：15 积分/会话（含 20 轮）
  actual_points: 10          # 实际扣费价：与对外一致（毛利 60-70%）
  refund_on_failure: false   # 会话型：已消耗轮次不退；整会话失败走平台兜底解冻
  unit: session
  included_rounds: 20        # 含 20 轮
  extra_round_points: 1      # 超轮 1 积分/轮（第 21 轮起逐轮续扣）
  round_limit: 50            # 单会话上限 50 轮，达上限拦截并引导新开对话（防套利）

runtime:
  model: deepseek-v4-flash
  provider: deepseek
  skills:
    - knowledge_retriever    # Hindsight 分层检索 P1→P4（租户私有→二级行业→一级行业→通用）
    - compliance_check       # M1 合规引擎（general + medical 规则包）

memory:
  bank_id_template: "informate-tenant-{user}-{profile}"   # {user}=租户ID（仅后端可信注入），{profile}=场景名
  read_only_banks:
    - informate-common
    - informate-industry_医美   # 部署时按租户一级行业绑定（Q28）；只读，仅注入检索

knowledge:
  types: [terms, faq, scripts, sop, regulations]   # 术语/FAQ/话术/SOP/法规库
  sub_industry: null            # 部署时由租户二级行业精确匹配（P2）；无条目走 P3/P4 兜底

workflow:
  description: 用户消息 → 意图解析 → 分层知识检索（P1→P4）→ 租户记忆加载 → 医美合规检查 → 流式回复；文案类产出自动附带《医疗广告审查证明》发布审查提示（FR-209）
  produces: text
  steps:
    - order: 1
      action: intent_parse
      note: 识别用户意图（咨询/文案/知识问答）
    - order: 2
      action: knowledge_retrieve
      tool: knowledge_retriever
      note: 按 P1→P4 硬编码优先级检索行业知识叠加层
    - order: 3
      action: memory_load
      note: 读取 informate-tenant-{user}-{profile} 租户私有记忆
    - order: 4
      action: compliance_check
      tool: compliance_check
      note: medical 规则包：绝对化用语/医疗广告审查/前后对比禁令/违禁词库
    - order: 5
      action: respond
      note: 流式回复；计轮（20 轮内含，超轮 1 积分/轮）
    - order: 6
      action: emit_artifact
      note: 文本产出物入右栏（复制/下载）

artifact:
  type: text
  metadata:
    fields:
      - name: content
        type: string
        description: 回复正文
        required: true
      - name: compliance_passed
        type: boolean
        description: 是否通过合规检查（false 表示已自动修正或需人工复核）
      - name: cited_banks
        type: string_array
        description: 命中的知识条目来源 bank 列表
  actions:
    - label: 复制
      type: copy
    - label: 下载
      type: download

compliance:
  enabled: true
  rule_packs: [general, medical]
  ai_label: true
```

### 实例 B：生成图片 —— Seedream 5.0 异步生图场景

依据：FR-301~307 / Q23 / Q24（Gemini 商品图 profile 为起点）/ Q26。计费 = 对外 20 / 实际扣费 15 积分每张。

```yaml
# Informate 场景包实例 · 生成图片 V1
id: generate_image
name: 生成图片
version: "1.0.0"
description: 营销图/海报/产品图生成（Seedream 5.0 异步任务）：Prompt 扩写 + 前置合规检查 + 产出物面板展示与跨场景传递
emoji: 🖼️
color: "#FF7F50"

pricing:
  deduct_points: 20          # 对外展示价：20 积分/张（报价口径，保守档）
  actual_points: 15          # 实际扣费价：15 积分/张（执行优惠，让利口径）
  refund_on_failure: true    # 生成失败/超时原子解冻退分（FR-304）；成功但效果不满意不退
  unit: image                # 按张计费，无会话轮数概念（unit≠session，禁止携带轮数字段）

runtime:
  model: seedream-5.0
  provider: volcengine       # 火山方舟（Seedream 生图）
  skills:
    - seedream_v5_generator  # JSON 工具契约：prompt/negative_prompt/aspect_ratio/image_resolution/ref_image_url/product_fidelity
    - compliance_check       # M1 合规引擎（生图前置检查 FR-306；医美部署启用 medical 拦截前后对比/效果承诺图 FR-307）

memory:
  bank_id_template: "informate-tenant-{user}-{profile}"
  read_only_banks:
    - informate-common

knowledge:
  types: []                  # 非知识型场景：不加载行业知识叠加层
  sub_industry: null

workflow:
  description: 用户描述 → 意图解析&租户记忆提取（品牌视觉风格）→ 前置合规检查（违禁/医美限制）→ Prompt 自动扩写 → 提交异步任务（冻结 15 积分）→ webhook 成功扣费 → 产出物入面板；失败原子解冻
  produces: image
  steps:
    - order: 1
      action: intent_parse
      note: 识别图片需求（营销图/海报/产品图）+ 提取租户品牌色/主视觉偏好
    - order: 2
      action: memory_load
      note: 读取租户 bank 品牌视觉风格记忆（Hindsight 记忆埋点：满意/好评时写入）
    - order: 3
      action: compliance_check
      tool: compliance_check
      note: 违禁提示词拦截并说明，不产生扣费（FR-306）
    - order: 4
      action: call_skill
      tool: seedream_v5_generator
      note: DeepSeek 扩写 Prompt 后提交 Seedream 异步 Job（BullMQ 队列，冻结 15 积分）
    - order: 5
      action: emit_artifact
      note: 图片 + 元数据 Payload 入右栏（预览/下载/重新生成/发送到其他场景）

artifact:
  type: image
  url_template: "https://cdn.informate.ai/outputs/{year}/{month}/{artifact_id}.jpg"
  metadata:
    fields:
      - name: prompt
        type: string
        description: 扩写后的生成提示词（光影/材质/视角/环境）
        required: true
      - name: aspect_ratio
        type: string
        description: 比例（1:1/3:4/4:3/16:9/9:16）
      - name: style_tags
        type: string_array
        description: 风格标签（跨场景传递时目标 Agent 的上下文依据，Q23）
      - name: target_product
        type: string
        description: 目标商品/主题
      - name: seedream_params
        type: object
        description: 模型参数（product_fidelity/model_version）
  actions:
    - label: 预览
      type: preview
    - label: 下载高清图
      type: download
    - label: 重新生成
      type: regenerate
    - label: 发送到行业工作助手
      type: send_to_scenario
      target_scenario: industry_work_assistant   # 目标场景 id（须已部署且租户 active）

compliance:
  enabled: true
  rule_packs: [general, medical]   # 医美零号客户部署实例启用 medical；其他行业部署时按行业调整（B9）
  ai_label: true                   # AI 标识（右下角水印/元数据标记，2026 国标，永久保留）
```

---

## 6. 机器校验方法

场景包以 YAML 编写、以 JSON Schema 校验（YAML 是 JSON 的超集，转 JSON 后校验）：

```bash
# Python（jsonschema + PyYAML）
python - <<'EOF'
import json, yaml
from jsonschema import Draft7Validator
schema = json.load(open('artifacts/02_design/场景包Schema_v1.json', encoding='utf-8'))
v = Draft7Validator(schema)
for name in ['医美行业工作助手.yaml', '生成图片.yaml']:
    pkg = yaml.safe_load(open(name, encoding='utf-8'))
    errs = sorted(v.iter_errors(pkg), key=lambda e: list(e.path))
    print(name, '=>', 'PASS' if not errs else f'FAIL ({len(errs)})')
    for e in errs: print('  -', '/'.join(map(str, e.path)), ':', e.message)
EOF
```

> 校验分层：**① JSON Schema 硬校验**（结构/必填/枚举/正则/条件必填）→ **② 平台业务校验**（§4.4 B1-B10 跨字段规则，`validateScenarioPackage`）→ **③ 部署时校验**（知识叠加层就绪、目标场景存在、合规规则包与行业匹配，不满足拒绝部署 FR-702）。

---

## 7. 与产品文档映射

| Schema 字段 | 产品依据 |
|:--|:--|
| `pricing` 全字段 | Q26 会话计费口径、D4 定价表、FR-205/303/304、FR-704（后台可配置变量） |
| `runtime.model/provider` | Q11 模型分工（deepseek-v4-flash / Seedream 5.0 / H3 / Seedance 2.0） |
| `memory.bank_id_template` | FR-207 定稿（连字符版）、Q3/NFR-06 租户×场景隔离 |
| `memory.read_only_banks` | Q16 三层 bank、Q28 行业知识叠加层、FR-202 |
| `knowledge` | Q25 二级行业、检索优先级 P1-P4（FR-203）、种子知识量级 |
| `workflow` | Q18 Hydration、Q20 积分管线（不在工作流内）、Gemini 落地版交互工作流 |
| `artifact` | Q23 跨场景传递带元数据 Payload、FR-401~405、Gemini Payload 契约 |
| `compliance` | Q19 合规硬约束、FR-204/209/306/307、M1 compliance_rules 4 行业包 |

## 8. 变更记录

| 版本 | 日期 | 变更 |
|:--|:--|:--|
| V1.0 | 2026-08-06 | 首次正式定义：13 顶层字段全量覆盖；bank_id_template 连字符版定稿；会话型计费条件必填；业务校验 B1-B10 |
