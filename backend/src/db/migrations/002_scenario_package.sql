-- ============================================================
-- Informate 迁移 002：场景包目录表 + 场景部署状态机扩展
-- 依据：技术方案_v1.md §四（POST /scenarios/deploy、GET /scenarios）、
--       FR-107（部署费免收首单）、场景包 Schema V1（artifacts/02_design/场景包Schema_v1）
-- 说明：
--   1. 新增 scenario_package 表：场景包目录（seed 预置，schema_payload 存完整场景包 JSON，
--      pricing_unit 区分 session/image 计费单位，G2 定稿）；
--   2. scenario_deployment.status 状态机扩展 pending（开通中）→ active/paused，
--      对齐 T4 部署流程 pending→active（开通即生效，含部署费免收判定）；
--   3. SQLite 无 ALTER CHECK 语法，采用标准「建新表 → 拷贝 → 改名」重建，保留原数据。
-- ============================================================

-- ---------- 1. 场景包目录表 ----------
CREATE TABLE scenario_package (
  id TEXT PRIMARY KEY,                  -- 场景唯一标识（snake_case，如 industry_work_assistant）
  name TEXT NOT NULL,                   -- 场景包名称（行业工作助手）
  display_name_template TEXT NOT NULL,  -- 部署渲染模板：{industry}行业工作助手（部署层按租户一级行业替换）
  version TEXT NOT NULL,                -- 场景包版本（1.0.0）
  description TEXT,
  emoji TEXT,
  color TEXT,
  pricing_unit TEXT NOT NULL CHECK (pricing_unit IN ('session', 'image')),  -- G2：计费单位（会话/张）
  deduct_points INTEGER NOT NULL,       -- 对外展示单价（积分）
  schema_payload TEXT NOT NULL,         -- 完整场景包 JSON（Schema V1）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pkg_unit ON scenario_package(pricing_unit);

-- ---------- 2. 场景部署表重建：状态机加入 pending（开通中） ----------
CREATE TABLE scenario_deployment_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  scenario_id TEXT NOT NULL,
  scenario_version TEXT NOT NULL,
  display_name TEXT NOT NULL,
  industry_bank TEXT,                       -- 行业知识叠加层 bank（Q28 行业工作助手）
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'paused')),
  deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, scenario_id)
);
INSERT INTO scenario_deployment_new (id, tenant_id, scenario_id, scenario_version, display_name, industry_bank, status, deployed_at)
  SELECT id, tenant_id, scenario_id, scenario_version, display_name, industry_bank, status, deployed_at FROM scenario_deployment;
DROP TABLE scenario_deployment;
ALTER TABLE scenario_deployment_new RENAME TO scenario_deployment;
CREATE INDEX idx_deploy_tenant ON scenario_deployment(tenant_id, status);
