-- 允许统一模型调用日志记录 DeepSeek 直连供应商。
PRAGMA foreign_keys = OFF;

ALTER TABLE model_call_log RENAME TO model_call_log_old;

CREATE TABLE model_call_log (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('hermes', 'deepseek', 'seedream')),
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

INSERT INTO model_call_log SELECT * FROM model_call_log_old;
DROP TABLE model_call_log_old;

CREATE INDEX idx_mcl_created ON model_call_log(created_at);
CREATE INDEX idx_mcl_provider ON model_call_log(provider, status, created_at);

PRAGMA foreign_keys = ON;
