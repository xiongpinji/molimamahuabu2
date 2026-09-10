'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const prices = require('../src/services/modelPriceService');
const { hashPlanValue } = require('../src/services/redrawExecutionPlanService');
const servicePath = path.join(__dirname, '../src/services/redrawExecutionQuoteService.js');
const service = fs.existsSync(servicePath) ? require(servicePath) : {};

const schema = 'redraw-execution-unit-quote-v1';
const code = (suffix) => `EXECUTION_QUOTE_${suffix}`;
const hashContent = (value, field) => {
  const { [field]: ignored, ...body } = value;
  return hashPlanValue(body);
};

function seal(plan) {
  plan.capability.capability_hash = hashContent(plan.capability, 'capability_hash');
  plan.bindings.capability_hash = plan.capability.capability_hash;
  plan.plan_hash = hashContent(plan, 'plan_hash');
  return plan;
}

function input() {
  const plan = { schema_version: 'redraw-execution-plan-preview-v1', status: 'ready', executable: false,
    blocking_reasons: [], bindings: { tenant_id: 'synthetic-tenant', user_id: 'synthetic-user',
      work_id: 1, version_id: 2, source_sha256: 'a'.repeat(64), locale: 'en', market: '' },
    capability: { config_id: 41, config_updated_at: '2026-09-07T00:00:00.000Z',
      provider: 'synthetic', protocol: 'synthetic_video', model: 'Synthetic-Video',
      durations_ms: [4000, 7000], resolutions: ['720p', '1080p'], aspect_ratios: ['16:9', '1:1'],
      max_references: { image: 0, video: 0, audio: 0 }, audio_mode: 'not_required',
      audio_verification: { mode: 'not_required', locale_verified: false },
      locale: 'en', market: '', credential_readiness: 'not_checked',
      evidence_hash: 'b'.repeat(64), adapter_hash: 'c'.repeat(64) },
    units: [{ id: 'unit-1', source_start_ms: 0, source_end_ms: 3000, retained_duration_ms: 3000,
      generated_duration_ms: 4000, padding_ms: 1000, parent_shots: [{ id: 'parent-A', contract_hash: 'd'.repeat(64) }],
      dialogues: [], reference_requirements: [] },
    { id: 'unit-2', source_start_ms: 3000, source_end_ms: 9500, retained_duration_ms: 6500,
      generated_duration_ms: 7000, padding_ms: 500, parent_shots: [{ id: 'parent-A', contract_hash: 'd'.repeat(64) }],
      dialogues: [], reference_requirements: [] }] };
  return { plan: seal(plan), output_parameters: { resolution: '720p', aspect_ratio: '16:9' } };
}

// Only synthetic prices are seeded. No configuration, account or reservation tables exist.
function fixture(t, options = {}) {
  const queries = []; const h = { queries, onSql: null };
  const dbFile = options.wal ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g4-unit-quote-wal-')), 'prices.sqlite') : ':memory:';
  const db = new Database(dbFile, { verbose(sql) { queries.push(sql); h.onSql?.(sql); } });
  h.db = db; h.dbFile = dbFile;
  t.after(() => db.close());
  if (options.wal) assert.equal(db.pragma('journal_mode = WAL', { simple: true }), 'wal');
  db.exec(`CREATE TABLE model_credit_prices (
    model TEXT PRIMARY KEY, display_name TEXT, public_note TEXT, category TEXT, credits,
    pricing_mode TEXT, status TEXT, billing_unit TEXT, cost_unit TEXT, cost_micros_per_unit INTEGER,
    input_cost_micros_per_1k INTEGER, output_cost_micros_per_1k INTEGER, updated_at TEXT
  );
  CREATE TABLE model_resolution_prices (
    model TEXT, resolution TEXT, credits, cost_micros_per_second INTEGER, PRIMARY KEY (model, resolution)
  );
  CREATE TABLE model_image_resolution_prices (
    model TEXT, resolution TEXT, credits, cost_micros_per_unit INTEGER, PRIMARY KEY (model, resolution)
  );`);
  if (!options.missing) db.prepare(`INSERT INTO model_credit_prices VALUES
    (?, 'synthetic-private-display', 'https://synthetic-private.invalid', ?, ?, ?, ?, ?, 'second', 0, 0, 0, 'synthetic-revision')`)
    .run('synthetic-video', options.category ?? 'video', options.credits ?? 3,
      options.mode ?? 'paid', options.status ?? 'enabled', options.billingUnit ?? 'second');
  for (const [resolution, amount] of Object.entries(options.tiers ?? {})) {
    db.prepare('INSERT INTO model_resolution_prices VALUES (?, ?, ?, 0)').run('synthetic-video', resolution, amount);
  }
  db.pragma('query_only = ON');
  return h;
}

function invoke(ctx, value) {
  assert.equal(typeof service.quoteExecutionUnits, 'function', 'read-only execution unit quote must exist');
  return service.quoteExecutionUnits(ctx, value);
}

function quote(h, value = input()) {
  const before = h.db.prepare('SELECT total_changes() AS count').get().count;
  const beforeSchema = h.db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all();
  h.queries.length = 0;
  try { return invoke({ db: h.db }, value); }
  finally {
    const queries = [...h.queries];
    assert.ok(queries.every((sql) => /^(?:SELECT|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)), JSON.stringify(queries));
    assert.ok(queries.every((sql) => !/ai_service_configs|api_key|credit_reservations|ledger|settings|\b(?:UPDATE|INSERT|DELETE|CREATE|ALTER)\b/i.test(sql)));
    assert.equal(h.db.prepare('SELECT total_changes() AS count').get().count, before, 'service performs zero DML');
    assert.deepEqual(h.db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all(), beforeSchema, 'service performs zero schema writes');
    assert.equal(h.db.pragma('query_only', { simple: true }), 1);
  }
}

function blocked(result, reason) {
  assert.deepEqual(result, { schema_version: schema, status: 'blocked', executable: false, reason_codes: [reason] });
}

function quoted(result, value, amounts, mode = 'paid') {
  const expected = { schema_version: schema, status: 'quoted', executable: false, reason_codes: [],
    plan_hash: value.plan.plan_hash, capability_hash: value.plan.capability.capability_hash,
    output_parameters: value.output_parameters, pricing_mode: mode, count: value.plan.units.length,
    units: value.plan.units.map((unit, ordinal) => ({ unit_id: unit.id, ordinal,
      unit_hash: hashPlanValue(unit), generated_duration_ms: unit.generated_duration_ms, amount: amounts[ordinal] })),
    amount: amounts.reduce((sum, amount) => sum + amount, 0) };
  assert.deepEqual(result, { ...expected, quote_hash: hashPlanValue(expected) });
}

test('prices each actual generated duration including padding with the real per-second calculator', (t) => {
  const h = fixture(t); const value = input();
  quoted(quote(h, value), value, [12, 21]);
  assert.equal(prices.calculateCharge(h.db, 'synthetic-video', { duration: 4, allowedDurations: [4, 7], resolution: '720p' }), 12);
});

test('preserves actual request billing instead of forcing all prices to per-second', (t) => {
  const h = fixture(t, { billingUnit: 'request' }); const value = input();
  quoted(quote(h, value), value, [3, 3]);
});

test('uses the explicitly chosen real resolution tier for every variable-length unit', (t) => {
  const h = fixture(t, { tiers: { '720p': 7, '1080p': 11 } }); const value = input();
  const first = quote(h, value); quoted(first, value, [28, 49]);
  value.output_parameters.resolution = '1080p';
  const next = quote(h, value); quoted(next, value, [44, 77]);
  assert.notEqual(next.quote_hash, first.quote_hash);
});

test('canonical model lookup matches the existing case-insensitive price contract', (t) => {
  const h = fixture(t); const value = input(); value.plan.capability.model = ' SYNTHETIC-VIDEO '; seal(value.plan);
  quoted(quote(h, value), value, [12, 21]);
});

test('explicit free zero is a quote without reservation or charge claims', (t) => {
  const h = fixture(t, { mode: 'free', credits: 0 }); const value = input();
  const result = quote(h, value); quoted(result, value, [0, 0], 'free');
  assert.doesNotMatch(JSON.stringify(result), /reservation|held|confirmed|credential|settings|https?:|synthetic-private/);
});

for (const [name, options, reason] of [
  ['missing price', { missing: true }, 'MODEL_PRICE_NOT_CONFIGURED'],
  ['disabled price', { status: 'disabled' }, 'MODEL_DISABLED'],
  ['disabled even with bad mode', { status: 'disabled', mode: 'unknown' }, 'MODEL_DISABLED'],
  ['missing selected tier', { tiers: { '1080p': 11 } }, 'MODEL_RESOLUTION_PRICE_REQUIRED'],
  ['missing selected tier even for free', { mode: 'free', credits: 0, tiers: { '1080p': 11 } }, 'MODEL_RESOLUTION_PRICE_REQUIRED'],
]) test(`${name} remains a safe blocked result, never free`, (t) => blocked(quote(fixture(t, options)), reason));

for (const [name, options] of [
  ['unknown mode', { mode: 'unknown' }], ['absent mode', { mode: '' }],
  ['nonvideo category', { category: 'text' }],
]) test(`${name} cannot produce a quote`, (t) => blocked(quote(fixture(t, options)), code('PRICE_CHECK_FAILED')));

for (const [name, options] of [
  ['paid zero', { credits: 0 }], ['negative amount', { credits: -1 }],
  ['fractional amount', { credits: 0.1 }], ['infinite amount', { credits: Infinity }],
  ['per-unit overflow', { credits: Number.MAX_SAFE_INTEGER }],
  ['total overflow', { credits: Number.MAX_SAFE_INTEGER, billingUnit: 'request' }],
]) test(`${name} cannot be returned as an amount`, (t) => blocked(quote(fixture(t, options)), code('AMOUNT_INVALID')));

test('output choices must both be explicit and cannot gain defaults from the capability array', (t) => {
  const h = fixture(t);
  for (const params of [undefined, null, {}, { resolution: '720p' }, { aspect_ratio: '16:9' },
    { resolution: '', aspect_ratio: '16:9' }]) {
    const value = input(); value.output_parameters = params;
    blocked(quote(h, value), code('OUTPUT_PARAMETERS_REQUIRED'));
  }
});

test('resolution and aspect ratio must exactly match the capability without normalization', (t) => {
  const h = fixture(t);
  for (const params of [{ resolution: '480p', aspect_ratio: '16:9' }, { resolution: '720p', aspect_ratio: '9:16' },
    { resolution: '720P', aspect_ratio: '16:9' }, { resolution: '720p', aspect_ratio: '16 / 9' },
    { resolution: 720, aspect_ratio: '16:9' }]) {
    blocked(quote(h, { ...input(), output_parameters: params }), code('OUTPUT_PARAMETERS_UNSUPPORTED'));
  }
});

test('rejects extra request/output fields and never accepts model units keys urls or private bindings', (t) => {
  const h = fixture(t);
  for (const key of ['units', 'model', 'api_key', 'base_url', 'private_binding']) {
    const value = input(); value[key] = 'synthetic-secret';
    blocked(quote(h, value), code('INPUT_INVALID'));
    delete value[key]; value.output_parameters[key] = 'synthetic-secret';
    blocked(quote(h, value), code('INPUT_INVALID'));
  }
  for (const value of [null, [], 'invalid']) blocked(quote(h, value), code('INPUT_INVALID'));
  blocked(invoke({}, input()), code('INPUT_INVALID'));
});

test('plan readiness and canonical hash must match the supplied full content', (t) => {
  const h = fixture(t);
  for (const mutate of [
    (plan) => { plan.status = 'blocked'; seal(plan); },
    (plan) => { plan.schema_version = 'other'; seal(plan); },
    (plan) => { plan.plan_hash = 'e'.repeat(64); },
    (plan) => { plan.units[0].padding_ms += 1; },
  ]) { const value = input(); mutate(value.plan); blocked(quote(h, value), code('PLAN_INVALID')); }
});

test('capability full-content hash and plan binding must match independently', (t) => {
  const h = fixture(t);
  for (const mutate of [
    (plan) => { plan.capability.resolutions.push('480p'); },
    (plan) => { plan.bindings.capability_hash = 'f'.repeat(64); },
    (plan) => { plan.capability.model = ''; seal(plan); },
    (plan) => { plan.capability.resolutions = []; seal(plan); },
    (plan) => { plan.capability.aspect_ratios = []; seal(plan); },
  ]) {
    const value = input(); mutate(value.plan); value.plan.plan_hash = hashContent(value.plan, 'plan_hash');
    blocked(quote(h, value), code('CAPABILITY_INVALID'));
  }
});

test('empty malformed or duplicate unit identities are rejected before pricing', (t) => {
  const h = fixture(t);
  for (const units of [[], [null], [{ ...input().plan.units[0], id: '' }],
    [input().plan.units[0], input().plan.units[0]]]) {
    const value = input(); value.plan.units = units; seal(value.plan);
    blocked(quote(h, value), code('UNIT_INVALID'));
  }
});

test('all unit durations must be positive safe whole seconds in the verified set even for free', (t) => {
  const h = fixture(t, { mode: 'free', credits: 0 });
  for (const duration of [0, -1000, 4000.5, 4500, 5000, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '4000']) {
    const value = input(); value.plan.units[1].generated_duration_ms = duration; seal(value.plan);
    blocked(quote(h, value), code('DURATION_INVALID'));
  }
});

test('the entire capability duration set must consist of valid positive integer seconds', (t) => {
  const h = fixture(t);
  for (const durations of [[], [4000, 7000, 0], [4000, 7000, 4500], [4000, 7000, Infinity], ['4000', 7000]]) {
    const value = input(); value.plan.capability.durations_ms = durations; seal(value.plan);
    blocked(quote(h, value), code('DURATION_INVALID'));
  }
});

test('repeating a quote is deterministic and neither mutates nor freezes the input', (t) => {
  const h = fixture(t); const value = input(); const before = structuredClone(value);
  const first = quote(h, value); const second = quote(h, value);
  quoted(first, value, [12, 21]); assert.deepEqual(second, first); assert.deepEqual(value, before);
  first.output_parameters.resolution = '1080p';
  assert.deepEqual(value, before, 'public output parameters must not alias the caller input');
});

test('quote hash binds unit order full unit content plan content and the chosen aspect ratio', (t) => {
  const h = fixture(t); const original = quote(h);
  for (const mutate of [
    (value) => value.plan.units.reverse(),
    (value) => { value.plan.units[0].parent_shots[0].contract_hash = 'e'.repeat(64); },
    (value) => { value.plan.bindings.source_sha256 = 'f'.repeat(64); },
    (value) => { value.plan.capability.evidence_hash = 'd'.repeat(64); },
    (value) => { value.output_parameters.aspect_ratio = '1:1'; },
  ]) {
    const value = input(); mutate(value); seal(value.plan);
    const result = quote(h, value); assert.equal(result.status, 'quoted');
    assert.notEqual(result.quote_hash, original.quote_hash);
    assert.deepEqual(result.units.map((unit) => unit.unit_id), value.plan.units.map((unit) => unit.id));
    assert.equal(result.quote_hash, hashContent(result, 'quote_hash'));
  }
});

test('a later real price change produces a new amount and quote hash', (t) => {
  const h = fixture(t); const value = input(); const before = quote(h, value);
  h.db.pragma('query_only = OFF');
  h.db.prepare('UPDATE model_credit_prices SET credits = 9 WHERE model = ?').run('synthetic-video');
  h.db.pragma('query_only = ON');
  const after = quote(h, value); quoted(after, value, [36, 63]);
  assert.notEqual(after.quote_hash, before.quote_hash);
});

test('WAL reader keeps one price snapshot when a second connection commits between metadata and charges', (t) => {
  const h = fixture(t, { wal: true, tiers: { '720p': 7 } }); const value = input();
  const writer = new Database(h.dbFile); t.after(() => writer.close());
  let commits = 0; let sawMetadata = false;
  h.onSql = (sql) => {
    if (/SELECT category, pricing_mode\s+FROM model_credit_prices/i.test(sql)) sawMetadata = true;
    if (!commits && /SELECT model, display_name/i.test(sql)) {
      assert.equal(sawMetadata, true, 'the reader metadata query establishes its snapshot first');
      writer.transaction(() => {
        writer.prepare("UPDATE model_credit_prices SET credits = 0, pricing_mode = 'free' WHERE model = ?").run('synthetic-video');
        writer.prepare('DELETE FROM model_resolution_prices WHERE model = ?').run('synthetic-video');
      })();
      commits += 1;
    }
  };
  const first = quote(h, value); quoted(first, value, [28, 49]); assert.equal(commits, 1);
  h.onSql = null;
  const next = quote(h, value); quoted(next, value, [0, 0], 'free');
  assert.notEqual(next.quote_hash, first.quote_hash);
  t.diagnostic(`synthetic WAL database retained: ${h.dbFile}; writer commits=${commits}; reader DML=0; old total=77; next total=0`);
});

test('nested caller transaction uses a read-only savepoint without committing caller work', (t) => {
  const h = fixture(t); const value = input();
  h.db.transaction(() => {
    assert.equal(h.db.inTransaction, true);
    quoted(quote(h, value), value, [12, 21]);
    assert.equal(h.db.inTransaction, true);
  })();
  assert.equal(h.db.inTransaction, false);
});

test('unknown SQLite failure is sanitized and cannot leak paths or become free', (t) => {
  const h = fixture(t);
  h.db.pragma('query_only = OFF'); h.db.exec('DROP TABLE model_resolution_prices'); h.db.pragma('query_only = ON');
  blocked(quote(h), code('PRICE_CHECK_FAILED'));
});

test('does not call schema repair price lists default selectors ledgers or providers', (t) => {
  const h = fixture(t); const value = input();
  for (const name of ['ensureSchema', 'requirePrice', 'list', 'listPublic', 'set', 'quoteCost']) {
    t.mock.method(prices, name, () => { assert.fail(`forbidden price API: ${name}`); });
  }
  const result = quote(h, value); quoted(result, value, [12, 21]);
  assert.doesNotMatch(JSON.stringify(result), /api_key|settings|credential|private_binding|https?:|synthetic-private|reservation/);
  const source = fs.readFileSync(servicePath, 'utf8');
  assert.doesNotMatch(source, /require\([^\n]*(?:aiConfig|videoClient|ttsService|Ledger|Billing|\/db|\/config)|requirePrice|ensureSchema|\.list\(|fetch\(/);
  assert.deepEqual(Object.keys(service), ['quoteExecutionUnits']);
});
