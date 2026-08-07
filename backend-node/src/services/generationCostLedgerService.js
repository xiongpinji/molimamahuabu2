const modelPrice = require('./modelPriceService');
const creditLedger = require('./creditLedgerService');

const PERIOD_LENGTHS = {
  day: 10,
  month: 7,
  year: 4,
};

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_cost_records (
      reservation_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      resolution TEXT,
      cost_unit TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      cost_micros INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      usage_source TEXT NOT NULL DEFAULT 'configured',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_business_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      credit_value_micros INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_generation_cost_model_created
      ON generation_cost_records(model, created_at DESC);
  `);
  const columns = db.prepare('PRAGMA table_info(generation_cost_records)').all();
  if (!columns.some((column) => column.name === 'resolution')) {
    db.exec('ALTER TABLE generation_cost_records ADD COLUMN resolution TEXT');
  }
}

function record(db, input) {
  ensureSchema(db);
  const quote = modelPrice.quoteCost(db, input.model, {
    quantity: input.quantity,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    reasoningTokens: input.reasoningTokens,
    resolution: input.resolution,
  });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO generation_cost_records
      (reservation_id, model, resolution, cost_unit, quantity, cost_micros, input_tokens,
       output_tokens, reasoning_tokens, usage_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(reservation_id) DO UPDATE SET
      model = excluded.model,
      resolution = excluded.resolution,
      cost_unit = excluded.cost_unit,
      quantity = excluded.quantity,
      cost_micros = excluded.cost_micros,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      usage_source = excluded.usage_source,
      updated_at = excluded.updated_at`)
    .run(
      String(input.reservationId),
      quote.model,
      quote.resolution || null,
      quote.cost_unit,
      quote.quantity,
      quote.cost_micros,
      quote.input_tokens,
      quote.output_tokens,
      quote.reasoning_tokens,
      String(input.usageSource || 'configured'),
      now,
      now,
    );
  return db.prepare('SELECT * FROM generation_cost_records WHERE reservation_id = ?')
    .get(String(input.reservationId));
}

function getSettings(db) {
  ensureSchema(db);
  const row = db.prepare('SELECT credit_value_micros, updated_at FROM billing_business_settings WHERE id = 1').get();
  return row || { credit_value_micros: 0, updated_at: null };
}

function updateSettings(db, value) {
  ensureSchema(db);
  const creditValueMicros = Number(value);
  if (!Number.isSafeInteger(creditValueMicros) || creditValueMicros < 0) {
    const error = new Error('每积分估值必须是非负整数微元');
    error.code = 'INVALID_BILLING_SETTING';
    throw error;
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO billing_business_settings (id, credit_value_micros, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      credit_value_micros = excluded.credit_value_micros,
      updated_at = excluded.updated_at`)
    .run(creditValueMicros, now);
  return getSettings(db);
}

function report(db, period = 'day') {
  ensureSchema(db);
  creditLedger.ensureSchema(db);
  const length = PERIOD_LENGTHS[period];
  if (!length) {
    const error = new Error('统计周期必须是 day、month 或 year');
    error.code = 'INVALID_LEDGER_PERIOD';
    throw error;
  }
  const settings = getSettings(db);
  const rows = db.prepare(`
    WITH confirmed_usage AS (
      SELECT id AS reservation_id, model, resource_type, amount, updated_at AS occurred_at
      FROM usage_reservations WHERE status = 'confirmed'
      UNION ALL
      SELECT id AS reservation_id, model, resource_type, amount, updated_at AS occurred_at
      FROM tenant_usage_reservations WHERE status = 'confirmed'
    )
    SELECT substr(u.occurred_at, 1, ?) AS period,
      u.model,
      u.resource_type,
      c.resolution,
      COUNT(*) AS usage_count,
      SUM(u.amount) AS credits_consumed,
      SUM(COALESCE(c.cost_micros, 0)) AS cost_micros,
      SUM(COALESCE(c.input_tokens, 0)) AS input_tokens,
      SUM(COALESCE(c.output_tokens, 0)) AS output_tokens,
      SUM(COALESCE(c.reasoning_tokens, 0)) AS reasoning_tokens,
      SUM(CASE WHEN c.reservation_id IS NULL OR c.usage_source = 'unavailable' THEN 1 ELSE 0 END)
        AS uncosted_usage_count
    FROM confirmed_usage u
    LEFT JOIN generation_cost_records c ON c.reservation_id = u.reservation_id
    GROUP BY substr(u.occurred_at, 1, ?), u.model, u.resource_type, c.resolution
    ORDER BY period DESC, u.model COLLATE NOCASE, c.resolution
  `).all(length, length).map((row) => {
    const revenueMicros = row.credits_consumed * settings.credit_value_micros;
    return {
      ...row,
      estimated_revenue_micros: revenueMicros,
      estimated_profit_micros: revenueMicros - row.cost_micros,
    };
  });
  const summary = rows.reduce((total, row) => ({
    usage_count: total.usage_count + row.usage_count,
    credits_consumed: total.credits_consumed + row.credits_consumed,
    cost_micros: total.cost_micros + row.cost_micros,
    estimated_revenue_micros: total.estimated_revenue_micros + row.estimated_revenue_micros,
    estimated_profit_micros: total.estimated_profit_micros + row.estimated_profit_micros,
    uncosted_usage_count: total.uncosted_usage_count + row.uncosted_usage_count,
  }), {
    usage_count: 0,
    credits_consumed: 0,
    cost_micros: 0,
    estimated_revenue_micros: 0,
    estimated_profit_micros: 0,
    uncosted_usage_count: 0,
  });
  return {
    period,
    credit_value_micros: settings.credit_value_micros,
    summary,
    rows,
  };
}

module.exports = {
  ensureSchema,
  record,
  getSettings,
  updateSettings,
  report,
};
