-- 生产充值订单：客户提交申请，运营确认收款后才入账，避免公开接口无支付即加积分。
CREATE TABLE recharge_order (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  tier_yuan INTEGER NOT NULL CHECK (tier_yuan IN (100, 500, 2000)),
  points INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  request_key TEXT NOT NULL UNIQUE,
  operator TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT
);
CREATE INDEX idx_recharge_order_status ON recharge_order(status, created_at DESC);
CREATE INDEX idx_recharge_order_tenant ON recharge_order(tenant_id, created_at DESC);
