-- ============================================================
-- Informate 迁移 003：模型调用日志表（P0-1 统一模型适配层）
-- 依据：外部评估优化（2026-08-16）
-- 说明：记录每次真实模型调用（供应商/模型/请求ID/延迟/错误分类/token/成本），
--       供成本核算、SLO 监控与审计；不存密钥与完整敏感提示词（error_msg 截断 500 字符）。
-- ============================================================
CREATE TABLE IF NOT EXISTS model_call_log (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('hermes', 'seedream')),
  model TEXT NOT NULL,
  request_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'image', 'video')),
  latency_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  error_class TEXT CHECK (error_class IN ('rate_limited', 'timeout', 'server', 'network', 'auth', 'bad_request', 'unknown')),
  error_msg TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_yuan REAL,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mcl_created ON model_call_log(created_at);
CREATE INDEX IF NOT EXISTS idx_mcl_provider ON model_call_log(provider, status, created_at);
