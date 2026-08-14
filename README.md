# Informate · 企业级场景化 AI 工作台

**B 端 AI 能力平台** —— 让企业用 AI 干活。Chat 驱动多 Agent 聚合页：左栏场景列表、中栏对话、右栏产出物，一个窗口完成行业工作助手、营销内容生成等场景化任务。

> 零号客户行业：医疗美容（行业工作助手 + 生成图片）
> 当前状态：✅ MVP 开发完成（batchA-E 全部通过验收），准备零号客户试点

---

## ✨ 核心特性

| 能力 | 说明 |
|:--|:--|
| 🗂️ 场景化 Chat 工作台 | 三栏布局：左场景（数据驱动）/ 中 Chat（SSE 流式）/ 右产出物面板 |
| 💰 积分计费闭环 | 1 元=10 积分；工作助手 15 积分/会话含 20 轮、生图 20 积分/张；充值即转正式、欠费自动冻结 |
| 🏢 企业多租户 | 租户×场景独立记忆（Hindsight bank 隔离）、主账号+员工子账号+限额管理 |
| ⚖️ 行业合规引擎 | 医疗广告红线自动拦截/修正（绝对化用语、前后对比、治愈率等），AI 生成标识永久保留、发布前人工审核提示 |
| 🖼️ 生成图片 | Seedream 5.0 接入（mock/real 双模式），两阶段积分冻结/结算，失败原子退分 |
| 📊 管理后台 | 租户/场景部署/积分/价格配置/会话审计/员工 6 模块 |

## 🏗️ 技术架构

```
浏览器 (React + Vite)
   │ proxy /api
   ▼
Node.js API (Fastify + TypeScript + SQLite)
   ├─ Chat 会话服务 ── Hermes api_server（mock/real 双模式，SSE 流式）
   │                    └─ Hindsight 记忆（租户×场景独立 bank）
   ├─ 生图执行器 ── Seedream 5.0 + 任务队列（内存 FIFO / BullMQ）
   ├─ 积分管线 ── 冻结/结算/解冻（幂等事务）
   ├─ 合规引擎 ── Python FastAPI（general + medical 规则包，fail-closed）
   └─ SQLite（WAL，10 张表）
```

- **后端**：Node.js ≥20 · TypeScript · Fastify · better-sqlite3 · JWT 三角色鉴权
- **前端**：React 18 · Vite 5 · TypeScript（零 UI 框架依赖）
- **合规**：Python 3.11 · FastAPI · 纯 Python AC 自动机 + 正则规则引擎（0 外部依赖）
- **队列**：无 Redis 时内存 FIFO；配置 `REDIS_URL` 自动切换 BullMQ

## 🚀 快速启动（开发环境）

```bash
# 1. 后端依赖 + 数据库初始化
cd backend && npm install && npm run migrate && npm run seed

# 2. 合规服务（:9100）
cd ../services/compliance && python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn main:app --port 9100 &

# 3. 后端（:8080）
cd ../backend && npm run dev

# 4. 前端（:5173）
cd ../frontend && npm install && npm run dev
```

或使用一键脚本：`bash scripts/dev_start.sh`（幂等，支持 `--reset-db` 重置数据）

**种子账号**：`owner/owner123`（主账号）· `employee/emp123` · `admin/admin123`（管理后台）

**冒烟验证**：`bash scripts/dev_smoke.sh`（9 项端到端检查）

## 📖 文档索引

| 文档 | 路径 | 内容 |
|:--|:--|:--|
| 项目全景 | `docs/Informate_项目全景_v1.0.md` | 定位/决策/规则/架构/历程/实测/试点（**从这里开始**） |
| PRD | `docs/产品设计/PRD_v1.md` | 46 FR ↔ 46 AC + 18 NFR |
| 技术方案 | `artifacts/02_design/技术方案_v1.md` | 架构/模块/DDL/API/WBS/风险 |
| 部署手册 | `docs/部署手册_v1.md` | 环境/启动/环境变量/备份回滚/上线清单 |
| 决策记录 | `docs/决策记录/决策记录_20260806.md` | Q1-Q29 + D1-D5 全部决策 |
| 评估报告 | `docs/评估报告/` | 17 份外部评审 + 批次验收 |

## 🧪 测试与验收

- 后端单测：`cd backend && npm test`（租户/积分/Chat/生图/合规，全绿）
- 压测：`bash scripts/stress_test.sh`（5 并发会话 + 10 并发生图，实测 Chat P95 862ms / 生图 11.3s / 计费 6/6）
- 验收方法论：每批次 Codex RedTeam 交叉校验 + QA 独立复验，全部通过后才进入下一批

## 🗺️ 路线图

- [x] 决策闭环（Q1-Q29 + D1-D5）
- [x] 设计门评审（QA + Codex 双线）
- [x] MVP 开发（batchA-E：后端/前端/合规/压测/部署手册）
- [ ] 真实模型接入（Hermes 对话 + Seedream 生图，试点前置）
- [ ] 零号客户试点（医美：部署 → 试用 → 反馈 → 迭代）
- [ ] 视频场景增购（H3 / Seedance）、场景库扩充（多行业）

## ⚠️ 部署注意事项（上线前必读）

- 生产环境必须注入 `JWT_SECRET`（未注入则拒绝启动）
- 当前生图为 mock 模式，真实 Seedream 接入为试点前置任务（`VOLC_ARK_API_KEY`）
- 计费定价需按 DeepSeek 最新官方价重算落参（见 `docs/上线合规与定价重算报告.md`）
- 医美行业内容发布需人工审核 + 《医疗广告审查证明》（FR-209）

---

*Informate · B 端 AI 能力平台 · 2026-08-08*
