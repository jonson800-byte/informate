-- Informate 定价落参 SQL（2026-08-17 DeepSeek 新价格后定稿）
-- 工作助手 15 积分/会话（含 20 轮，超轮 1 积分/轮，上限 50 轮）
-- 生图对外 20 / 实扣 15；充值 100=1100 / 500=6000 / 2000=25000
INSERT OR REPLACE INTO price_config (id, key, value, effective_at, operator, note) VALUES
('pc-20260817-1', 'credit.work_assistant.session', '15', datetime('now'), 'manual', 'DeepSeek 2026-08-17 涨价后定稿（高峰价重算，毛利 76%）'),
('pc-20260817-2', 'credit.work_assistant.extra_round', '1', datetime('now'), 'manual', '超轮 1 积分/轮（毛利 82%，不变）'),
('pc-20260817-3', 'credit.round_limit', '50', datetime('now'), 'manual', '50 轮上限（不变）'),
('pc-20260817-4', 'credit.min_freeze', '15', datetime('now'), 'manual', '欠费冻结阈值=场景最小价 15（原 10 随涨价上调）'),
('pc-20260817-5', 'credit.image_task', '15', datetime('now'), 'manual', '生图实扣 15（不变）'),
('pc-20260817-6', 'recharge.100', '1100', datetime('now'), 'manual', '100 元=1100 积分（不变）'),
('pc-20260817-7', 'recharge.500', '6000', datetime('now'), 'manual', '500 元=6000 积分（不变）'),
('pc-20260817-8', 'recharge.2000', '25000', datetime('now'), 'manual', '2000 元=25000 积分（不变）');
-- 验证：SELECT key, value FROM price_config ORDER BY key;
