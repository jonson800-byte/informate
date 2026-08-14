# Informate 项目全景（v1.0 · 2026-08-08）

> **一句话定位**：B 端 AI 能力平台——企业级场景化 Chat 工作台（三栏：左场景 / 中 Chat / 右产出物），零号客户=医美行业，MVP=行业工作助手 + 生成图片。
> **当前状态**：✅ 第五批 MVP 开发正式闭环（batchA-E 全部通过 Codex 验收），准备进入第六批零号客户试点。

---

## 1. 项目定位与商业模式

| 项 | 内容 |
|:--|:--|
| 产品形态 | Chat 驱动多 Agent 聚合页：左栏场景列表（数据驱动）、中栏对话（SSE 流式）、右栏产出物面板 |
| 技术本质 | **场景 = Hermes profile**（模型+角色+skill+工作流+知识库）；多租户记忆 = `bank_id_template` 动态解析；行业知识沉淀飞轮 = 护城河 |
| 商业闭环 | 企业开户 → 充值得积分（1 元 = 10 积分）→ Chat 场景消耗积分 → 产出物自动展示右侧面板 → 用完再充 |
| 目标客户 | 不限规模的企业客户（非"中小企业"，用户明确避免该标签） |
| 护城河 | 跨客户脱敏聚合 → 行业×场景知识库 → 回灌垂类 agent（竞品未做透）；大厂通用办公 Agent 红海 → 差异化靠"行业深度" |

### 1.1 交付模式（2026-08-06 定稿）
- **部署费**：¥500/场景/一次性（覆盖开通配置成本），**首单免部署费**引流
- **积分制**：1 元 = 10 积分；充值阶梯 100 元=1100 / 500 元=6000 / 2000 元=25000（赠 10%/20%/25%）
- 持续收入靠积分消耗，非订阅

## 2. 决策基线（Q1-Q29 + D1-D5，全部闭环）

核心决策（详见 `docs/决策记录/决策记录_20260806.md`）：

| 编号 | 决策 |
|:--|:--|
| D1 | 定位不绑定行业、执行先聚焦 |
| D2 | MVP 二场景：行业工作助手 + 生成图片 |
| D3 | 部署费 ¥500/场景/一次性 + 首单免部署费 |
| D4 | 定价上调（最终定价表见 §3） |
| D5 | 人工种子知识先行（医美优先） |
| Q18 | 无状态 Worker + 每次全量注入 |
| Q19 | 合规：Opt-in/人工审核/AI 标识/备案 |
| Q20 | BullMQ 积分冻结/结算/解冻 |
| Q23 | Payload 元数据 |
| Q25 | 一级行业定 bank 粒度、二级行业定知识粒度 |
| Q26 | 15 积分/会话含 20 轮、超轮 1 积分/轮、50 轮上限 |
| Q27 | 零号客户=医美（M1 medical 规则包现成） |
| Q28 | 行业工作助手 = 通用底座 + 行业知识叠加层 |
| Q29 | UI/UX 设计先行（informate-ux） |

## 3. 产品规则（最终定价表 2026-08-06 定稿）

| 场景 | 计费单位 | 对外报价 | 实际执行 |
|:--|:--|:--|:--|
| 行业工作助手 | 1 会话含 20 轮，超轮 1 积分/轮，50 轮上限 | 10 积分 | 10 积分（毛利 60-70%） |
| 生成图片 | 1 张（Seedream 5.0） | 20 积分 | 15 积分 |
| 生视频标准档 | 5s（MiniMax H3） | 200 积分 | 150 积分（MVP 降级增购项） |
| 生视频品质档 | 5s（Seedance） | 400 积分 | 300 积分（MVP 降级增购项） |

**关键规则**：
- **轮次计费**：第 1-20 轮免费（含在 10 积分内）；第 21 轮起 1 积分/轮；**第 51 轮发送被拦截**（429，提示新开对话，防套利）
- **生图两阶段**：冻结 15 → 任务队列 → Seedream 生成 → 成功结算 / 失败原子退分；对外展示 20、实扣 15
- **试用**：水印 + 20 次会话 + 禁跨场景传递（转正式解锁）；trial 查次数不查余额、不走冻结页
- **状态机**：trial → active（充值即转）→ paused（余额<场景最小价 15）→ expired；欠费整页冻结，充值 1 分钟恢复
- **余额预警**：<30 积分琥珀色预警
- **双标识独立**：试用营销水印（转正式移除）vs 合规 AI 标识（2026 国标，永久保留）
- **FR-209 文案发布审查**：生成文案附「需人工审核+《医疗广告审查证明》方可投放」提示
- **管理后台**：MVP 必选（租户/场景部署/积分/价格配置/会话审计/员工 6 模块）

## 4. 技术架构

### 4.1 系统拓扑
```
浏览器 (React+Vite :5173)
   │ proxy /api
   ▼
Node.js API (Fastify+TS :8080) ──┬─ BullMQ/内存队列（生图任务，Redis 可选）
   │                              ├─ 积分管线（冻结/结算/解冻，SQLite 事务+幂等）
   ├─ Chat 会话服务 ── Hermes api_server（mock/real 双模式，SSE 流式）
   │                     └─ Hindsight 记忆（租户×场景 bank，P1-P4 检索）
   ├─ 生图执行器 ── Seedream 5.0（mock/real 双模式，火山方舟）
   ├─ 合规引擎 (Python FastAPI :9100，general+medical 规则包，fail-closed)
   └─ SQLite (backend/data/informate.db，WAL)
```

### 4.2 代码规模（git 3 提交：ef53891 基线 / f058f8b batchE / 927b5af 复审）
- **backend/**（Node+TS+Fastify+SQLite）：27 个 TS 文件——10 张表迁移、三角色 JWT 鉴权、13 组路由（credit/chat/imagegen/auth/scenarios/users/workspace/admin 等）、5 个服务（credit 账本/hermesClient/memory/seedream/taskQueue）
- **frontend/**（React 18+Vite 5+TS）：30 源文件——三栏工作台 10 组件 + 管理后台 8 页 + ErrorBoundary + TxnsModal
- **services/compliance/**（Python FastAPI）：纯 Python AC 自动机+正则合规引擎，general-1.0（修正模式）+ medical-1.1（拦截模式含法规依据），0 外部依赖
- **scripts/**：dev_start.sh（一键启动）、dev_smoke.sh（9 项冒烟）、stress_test.sh + stress_cleanup.sh（压测/清理）、change_password.js（改密）、seed_knowledge_to_hindsight.py（种子知识灌入）、hermes_patch（api_server user_id 补丁）

### 4.3 关键机制与已知边界
- **多租户隔离**：`bank_id_template: 'informate-tenant-{user}-{profile}'`（连字符版+场景维度）；Hindsight bank 配置来自 `$HERMES_HOME/hindsight/config.json`（**不读 config.yaml memory 段**——已知坑）；api_server 的 user_id 通道已补（`scripts/hermes_patch_x_hermes_user_id.patch`）
- **合规 fail-closed**：合规服务不可用 → Chat 503/生图 503，不放过未审核内容（batchE 修复了 app.inject 空转 P0）
- **任务队列**：无 Redis → 内存 FIFO（并发 2）；配 REDIS_URL → BullMQ（jobId 去重）
- **真实模型现状**：Chat=mock Hermes（秒级回复）、生图=mock Seedream（SVG 占位图）——**真实接入是试点前置条件**（见 §7）
- **前端本地持久化**：后端无会话/产出物列表端点 → localStorage（刷新恢复已接线）

## 5. 开发历程（批次流水 + 验收记录）

| 阶段 | 批次 | 内容 | 验收 |
|:--|:--|:--|:--|
| 第一批 | PRD v1 / Hermes 隔离 SPIKE / 医美种子知识 | 46 FR↔46 AC + 18 NFR；bank_id_template 机制验证；知识库 5 文件 | ✅ Codex 有条件通过→修复（8 高+12 中+3 低） |
| 第二批 | 场景包 Schema v1 / UIUX 交互设计 v1 / api_server user_id 实验 | 15 顶层字段 JSON Schema 严格模式；三栏交互规范 484 行；P0 集成阻塞确认 | ✅ Codex 有条件通过→修复（2 返工+6 中+6 低） |
| 第三批 | 技术方案 v1 | 60.4K：总体架构/7 模块/DDL/API 清单/Hermes 集成/WBS T1-T13（31.5 人天）/风险 R1-R8 | ✅ Codex 有条件通过→16 项全修复 |
| 第四批 | 设计门评审（双线） | QA 独立复验（4 阻塞项）+ Codex 交叉校验（6 高+14 中+6 低） | ✅ 修复后转"可进入开发" |
| 第五批 | **MVP 开发 batchA-E** | 见下表 | ✅ 全部闭环 |
| 第六批 | 零号客户试点（医美） | ⏳ 未启动 | 前置条件见 §7 |

### 5.1 第五批开发明细
| 批次 | 任务 | 结果 |
|:--|:--|:--|
| batchA | T1 Hermes 源码改造 / T2 隔离用例 / T12 种子知识 | Hermes user_id 补丁 + 600 条医美知识（6 二级行业×100 术语等） |
| batchB | T3 后端骨架 / T4 租户账号场景 / T5 积分管线 / T8 合规 | 39/39 测试绿；修复 JWT 默认密钥、员工限额、调价 409 等 |
| batchC | T6 Chat 会话服务 / T7 生图执行器 | 49/49 绿；修复输出合规、失败重试冻结卡死、SSE 鲁棒性 |
| batchD | T9 三栏工作台 / T10 状态流程 / T11 管理后台 | 30 文件 build 通过；20 项验收 + R1/R2 复验全修复（含"首轮消息 no-op"阻断级 bug） |
| batchE | T14 压测 / T15 部署手册 | 压测全 PASS；429 行部署手册；**Codex 首验抓到合规空转 P0 → 修复 → 复审通过** |

### 5.2 验收方法论（用户定）
- 每批完成 → **Codex RedTeam 交叉校验**（读交付物→对照基线→维度验收→问题清单+前 5 项修复）→ 通过才进下一批
- 关键方案双线验证：QA Agent 独立复验 + Codex 交叉校验
- 关键方案收集多份外部 AI 评估（Gemini/ChatGPT/DeepSeek/Codex 共 17 份报告存档）
- 评估报告共识点直接采纳、分歧点列给用户决策

## 6. 实测数据

### 6.1 压测（T14，mock 模式，2026-08-08）
| 维度 | 实测 | 基线 | 结论 |
|:--|:--|:--|:--|
| Chat 5 并发×3 轮 | 15/15（100%），首包 P95 862ms / 完整 P95 1175ms | 热 Worker ≤2s | ✅ |
| 生图 10 并发 | 10/10（100%），完成 P95 11.3s（队列并发 2 → 5 波） | P95 ≤60s | ✅ |
| 计费验证 | 冻结 15×5 / 超轮 1+幂等重放 0 / 第 20 轮免扣 / 第 51 轮 429 / 生图 15×10 / 余额守恒 | 精确 | ✅ |
| 错误率 | 0×429 / 0×500 / 0 超时；总耗时 13.5s | ≥99.5% | ✅ |
| 计费延迟 | 会话创建 P95 12.7ms / 轮次结算 1.3ms / 生图冻结 22.9ms | ≤1s | ✅ |

> ⚠️ 真实模型延迟（Hermes 首包 ≤2s / Seedream P95 ≤60s）未验证——列为试点放行条件。

### 6.2 冒烟（9/9 全过，可随时重跑）
`bash scripts/dev_smoke.sh`：后端健康/合规健康/登录/场景×2/Chat SSE/生图冻结/入队/成功

### 6.3 测试资产
- 后端：t3-t7 测试套件（smoke/t4_tenant/t5_credit/t6_chat/t7_imagegen）+ 压测驱动
- 合规：10+ 单测（绝对化用语/前后对比/治愈率/语境敏感/重叠去重/拦截优先级）
- 种子账号：owner/owner123（主账号）、employee/emp123、admin/admin123（管理后台）

## 7. 试点前置条件（第六批零号客户·医美）

| # | 条件 | 说明 | 状态 |
|:--|:--|:--|:--|
| G1 | 真实 Hermes 对话 | HERMES_BASE_URL + API Key，验证首包 ≤2s | ⏳ 待接入 |
| G2 | 真实 Seedream 生图 | VOLC_ARK_API_KEY，验证 P95 ≤60s（当前 mock 演示） | ⏳ 待接入 |
| G3 | DeepSeek 定价重算落参 | 上线前按官方价核（含峰谷 2 倍），落 price_config（报告已备 SQL） | ⏳ 上线前 |
| G4 | 合规备案 + Opt-in 条款 | 备案评估留档 + 服务协议并入（报告已备草案） | ⏳ 上线前 |
| G5 | 管理后台改密 | `node scripts/change_password.js` | ✅ 工具就绪 |

**试点流程**（部署手册 §9 已写可执行步骤）：开户 → 试用（20 次会话）→ 充值转正式 → 员工账号 → 15 分钟培训 → 打样（周活≥60% / 完成率≥70% / 续费意向≥80%）。

## 8. 交付物索引（全部落盘）

```
~/Desktop/Informate Project/
├── docs/
│   ├── 产品设计/PRD_v1.md (46FR) + UIUX_交互设计_v1.md
│   ├── 决策记录/决策记录_20260806.md (Q1-Q29+D1-D5)
│   ├── 评估报告/（17 份：外部评估 8 + 批次验收 9）
│   ├── 部署手册_v1.md（429 行 9 章）
│   ├── 上线合规与定价重算报告.md
│   └── Informate_项目说明_v3.1.md（设计基线）
├── artifacts/
│   ├── 01_strategy/（竞品/成本测算/知识库调研/M1 复用评估）
│   ├── 02_design/（SPIKE 报告/场景包 Schema+2 实例/技术方案/原型 HTML/实验报告）
│   └── 03_build/（压测报告+原始数据）
├── backend/（27 TS 文件 + 迁移 + seed + 测试）
├── frontend/（30 文件 + dist）
├── services/compliance/（合规引擎 + 测试）
├── scripts/（8 个运维/工具脚本）
└── ~/Desktop/Informate KB/industries/医美/（600 条种子知识，Obsidian 人工层）
```

## 9. 下一步路线

1. **真实模型接入**（G1/G2）：Hermes api_server 真实对话 + Seedream 真实生图（需火山方舟 Key）
2. **定价重算落参**（G3）：DeepSeek 官方价核 → price_config 落参 → 上线前毛利复核
3. **零号客户试点**（第六批）：医美客户部署 → 试用 → 反馈 → 迭代（全组参与）
4. **试点后**：视频场景增购（H3/Seedance）、场景库扩充（新行业按"GitHub 调研→工作流→模块"方法论）、知识飞轮验证

---

*文档生成：2026-08-08 · 依据全量会话记录 + 文件系统盘点 + git 历史 · 后续更新请在页头追加版本行*
