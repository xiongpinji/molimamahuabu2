-- 价格沿用线上当前启用的同类模型；只补不存在的别名，不覆盖管理员已有调整。
-- 该迁移在应用启动的 ensureSchema 之前运行，因此先为旧库补齐价格表扩展列。
ALTER TABLE model_credit_prices ADD COLUMN billing_unit TEXT NOT NULL DEFAULT '';
ALTER TABLE model_credit_prices ADD COLUMN cost_unit TEXT NOT NULL DEFAULT 'request';
ALTER TABLE model_credit_prices ADD COLUMN cost_micros_per_unit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_credit_prices ADD COLUMN input_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_credit_prices ADD COLUMN output_cost_micros_per_1k INTEGER NOT NULL DEFAULT 0;

INSERT INTO model_credit_prices (
  model, credits, display_name, category, status, billing_unit,
  cost_unit, cost_micros_per_unit, input_cost_micros_per_1k,
  output_cost_micros_per_1k, updated_at
) VALUES
  ('fumin-seedance-2.0-fast', 107, 'fumin Seedance 2.0 Fast', 'video', 'enabled', 'second', 'second', 280000, 0, 0, datetime('now')),
  ('fumin-seedance-2.0-mini', 50, 'fumin Seedance 2.0 Mini', 'video', 'enabled', 'second', 'second', 100000, 0, 0, datetime('now')),
  ('fumin-gpt-image-2', 40, 'fumin GPT Image 2', 'image', 'enabled', 'request', 'image', 46000, 0, 0, datetime('now')),
  ('fumin-gpt-image-2-4K', 70, 'fumin GPT Image 2 4K', 'image', 'enabled', 'request', 'image', 80000, 0, 0, datetime('now'))
ON CONFLICT(model) DO NOTHING;
