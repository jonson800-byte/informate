# Informate 合规服务（T8）

医美内容合规检查/自动修正/拦截服务。对应需求：**FR-204**（医美合规检查默认能力）、**FR-306**（生图前置合规）、**FR-307**（医美生图限制）、**FR-209**（文案发布审查提示）、**NFR-01**（AI 内容标识配合项）。规则依据：`~/Desktop/Informate KB/industries/医美/通用/合规要点.md` 红线清单（《医疗美容广告执法指南》2021 第 37 号 /《医疗广告管理办法》/《广告法》）。

## 快速开始

```bash
cd "services/compliance"
python3.11 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests/ -v          # 跑单测
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 9100   # 启动服务
```

## API

### POST /check —— 合规检查（文本修正 / 生图拦截）

请求（`text` 与 `image_prompt` 二选一）：

```json
{ "text": "本方案可根治脱发问题", "rule_packs": ["general", "medical"] }
{ "image_prompt": "医美海报，展示前后对比效果", "rule_packs": ["general", "medical"] }
```

`rule_packs` 缺省 = `["general", "medical"]`（场景包 Schema compliance.rule_packs 枚举；education/finance/food_health 为后续迭代，传了返回 400）。

响应：

```json
{
  "passed": true,                       // 是否通过
  "fixes": [{"keyword": "根治", "category": "承诺效果",
             "before": "根治", "after": "改善", "start": 5, "end": 7}],
  "fixed_text": "本方案可改善脱发问题",  // 修正后文本（text 场景；拦截/生图为 null）
  "blocked": false,                     // 是否被拦截（需人工审核）
  "reason": null,                       // 拦截原因（含法规依据；未拦截为 null）
  "rule_packs": ["general", "medical"],
  "ruleset_version": "general-1.0+medical-1.1",
  "mode": "text"                        // text | image_prompt
}
```

行为约定：

| 场景 | 行为 |
|:--|:--|
| text + general 命中 | **自动修正**（如 根治→改善、100% 有效→效果因人而异、全网最低→实惠），passed=true，返回 fixes + fixed_text |
| text + medical 命中 | **拦截**：passed=false、blocked=true、fixes=[]、reason 说明红线与法规依据（不做部分修正） |
| text 语境豁免 | 「第一条/第一次」「术前术后注意事项」等不误伤（M1 T6 经验） |
| image_prompt 任一命中 | **拦截并说明，不产生扣费**（FR-306/307）；提示词不做自动改写 |
| 多轮修正后仍有残留 | 拦截人工（passed=false、blocked=true） |

### GET /hint —— FR-209 发布审查提示

```json
{ "enabled": true, "text": "需人工审核且取得《医疗广告审查证明》后方可投放",
  "source": "default", "configurable": true }
```

### PUT /hint —— 后台配置提示文案（持久化）

```bash
curl -X PUT localhost:9100/hint -H 'Content-Type: application/json' \
  -d '{"text":"需取得广告审查证明并经人工审核后方可投放"}'
```

配置优先级：环境变量 `PUBLISH_REVIEW_HINT`（启动覆盖）> `data/publish_hint.json`（PUT 持久化）> 缺省文案。文案限 200 字（对齐场景包 Schema `publish_review_hint.text` maxLength）。

## 目录结构

```
services/compliance/
├── main.py            # FastAPI 服务（端口 9100）
├── engine.py          # 合规引擎：AC 自动机 + 正则 + 语境敏感 + 修正/拦截
├── rule_packs.py      # 规则包定义（general-1.0 / medical-1.1，含法规依据 reason）
├── requirements.txt / requirements-dev.txt
├── data/              # 运行时配置（publish_hint.json；compliance_rules/<pack>.json 外挂规则包）
└── tests/test_compliance.py   # 20 个用例（pytest + TestClient）
```

## 规则包

- **general**（fix 模式，自动修正）：绝对化用语（最佳/第一/顶级/唯一/100% 有效…）、承诺效果（根治/保证/永不复发…）、诱导消费、贬低竞品、夸大宣传、虚假数据。逐词合规替代表达见 `rule_packs.FIXES`。
- **medical**（block 模式，拦截）：前后对比承诺、治愈率承诺、疗效承诺（永久/一次见效类）、安全承诺（无痛无痕/零风险）、变相广告、代言人证言、贬低同行（含正则句式兜底）、容貌焦虑。

**规则包外挂**：`data/compliance_rules/<pack>.json`（可选）含 `"rules"` 数组时整体替换内置包，便于后台配置规则内容（对齐 M1 `compliance_rules` 外挂点与 Q12 决策）。

## 设计对齐

- 复用 M1 compliance.py 设计：AC 自动机、位置感知修复（T7）、重叠去重取最长、语境敏感（T6）、多轮修正（fix_and_recheck）、ruleset_version 版本锁定（M11）、拦截优先（M9 规则引擎权威）。
- 响应结构对齐场景包 Schema：`rule_packs` / `publish_review_hint`。
- 生图拦截原因附「未产生扣费，FR-306」说明（对齐 FR-306 扣费语义）。
