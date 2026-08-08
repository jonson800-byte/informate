-- ============================================================
-- Informate MVP 初始化迁移（001）
-- 依据：技术方案_v1.md §三（数据模型 DDL 草案）
-- 说明：
--   1. 9 张业务表字段/约束/索引严格对齐 §三；
--   2. admin 为独立运营账号体系（决策记录 G3 定稿：admin 表 + 种子账号 + 独立登录），
--      不混入租户 user 表；
--   3. 所有表带 tenant_id（NFR-07 租户隔离）；
--   4. 外键级联删除禁用（租户数据保留策略，PRD §3.3）；
--   5. 时间统一 TEXT 存储（ISO-8601 / SQLite datetime('now')）。
-- ============================================================

-- ---------- 1. 租户表 ----------
CREATE TABLE tenant (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  sub_industry TEXT,
  status TEXT NOT NULL DEFAULT 'trial'
    CHECK (status IN ('trial', 'active', 'paused', 'expired')),
  plan TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  enterprise_scale TEXT,
  business_type TEXT,
  target_market TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  trial_sessions_used INTEGER NOT NULL DEFAULT 0,
  trial_session_limit INTEGER NOT NULL DEFAULT 20,   -- FR-501：试用会话 20 次/租户
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tenant_status ON tenant(status, industry);

-- ---------- 2. 用户表（租户侧账号：owner 主账号 / employee 员工） ----------
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'employee')),
  name TEXT NOT NULL,                       -- 登录账号（user 表无独立 account 字段，以 name 作登录名）
  credentials_hash TEXT NOT NULL,           -- bcrypt 密码哈希（NFR-09）
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  credit_limit INTEGER,                     -- FR-105：员工限额
  credit_period TEXT NOT NULL DEFAULT 'day',
  guide_seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_user_tenant ON user(tenant_id, status);

-- ---------- 3. 场景部署表 ----------
CREATE TABLE scenario_deployment (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  scenario_id TEXT NOT NULL,
  scenario_version TEXT NOT NULL,
  display_name TEXT NOT NULL,
  industry_bank TEXT,                       -- 行业知识叠加层 bank（Q28 行业工作助手）
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused')),
  deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, scenario_id)
);
CREATE INDEX idx_deploy_tenant ON scenario_deployment(tenant_id, status);

-- ---------- 4. 会话表 ----------
CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  scenario_id TEXT NOT NULL,
  deployment_id TEXT REFERENCES scenario_deployment(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'blocked')),
  turns INTEGER NOT NULL DEFAULT 0,
  billing_state TEXT NOT NULL DEFAULT 'frozen'
    CHECK (billing_state IN ('frozen', 'settled', 'trial')),  -- trial=试用会话（不冻结积分，FR-208/M2）
  frozen_credit INTEGER NOT NULL DEFAULT 0, -- 冻结积分（Q20 两阶段确认）
  settled_credit INTEGER NOT NULL DEFAULT 0,
  hermes_session_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX idx_conv_tenant ON conversation(tenant_id, scenario_id, started_at DESC);

-- ---------- 5. 消息表 ----------
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  round_no INTEGER,
  token_usage TEXT,
  credit_charged INTEGER NOT NULL DEFAULT 0,
  compliance_passed INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_msg_conv ON message(conversation_id, created_at);

-- ---------- 6. 产出物表 ----------
CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  scenario_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversation(id),
  type TEXT NOT NULL CHECK (type IN ('image', 'text', 'video', 'file')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'success', 'failed')),
  url TEXT,
  metadata_payload TEXT,                    -- Q23：跨场景传递元数据
  ai_label INTEGER NOT NULL DEFAULT 1,      -- 合规 AI 标识（2026 国标，永久保留）
  trial_watermark INTEGER NOT NULL DEFAULT 0, -- FR-502：试用营销水印（转正式后清除，与 ai_label 独立）
  source_artifact_id TEXT,
  fail_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX idx_art_conv ON artifact(conversation_id, created_at);
CREATE INDEX idx_art_tenant ON artifact(tenant_id, scenario_id, created_at DESC);

-- ---------- 7. 积分流水表 ----------
CREATE TABLE credit_txn (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT REFERENCES user(id),
  type TEXT NOT NULL
    CHECK (type IN ('recharge', 'freeze', 'settle', 'unfreeze', 'adjust')),
  amount INTEGER NOT NULL,
  balance_after INTEGER,
  scenario_id TEXT,
  ref_type TEXT,
  ref_id TEXT,
  round_no INTEGER,
  idempotency_key TEXT UNIQUE,              -- 幂等（对公转账回调等）
  operator TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_txn_tenant ON credit_txn(tenant_id, created_at DESC);
CREATE INDEX idx_txn_freeze ON credit_txn(type, created_at);

-- ---------- 8. 价格配置表（管理后台可配置变量，FR-704） ----------
CREATE TABLE price_config (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  effective_at TEXT NOT NULL DEFAULT (datetime('now')),
  operator TEXT NOT NULL,
  note TEXT,
  UNIQUE (key, effective_at)
);

-- ---------- 9. 审计日志表（NFR 审计要求：登录/操作/合规拦截/传递） ----------
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,                           -- admin 操作可无租户
  user_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, created_at);

-- ---------- 10. admin 表（独立运营账号体系，G3 定稿，与租户 user 表分离） ----------
CREATE TABLE admin (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,            -- 运营账号登录名
  credentials_hash TEXT NOT NULL,           -- bcrypt 密码哈希
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
