'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const modelPriceService = require('../src/services/modelPriceService');
const { buildReleaseEvidence } = require('../scripts/verify-lingjing-video-model');
const {
  applyConfiguration,
  loadVerifiedEvidence,
  planConfiguration,
  rollbackConfiguration,
  verifyConfiguration,
} = require('../../deploy/apply-lingjing-video-model-config');

const MODEL = 'lingjing-video-v1';
const REFERENCE_SHA = 'b'.repeat(64);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingjing-config-'));
  const publicDir = path.join(root, 'public');
  const evidencePath = path.join(root, 'lingjing-video-verification.json');
  const receiptPath = path.join(root, 'receipt.json');
  const backupPath = path.join(root, 'backup.db');
  fs.mkdirSync(publicDir);
  const db = new Database(path.join(root, 'drama.db'));
  runMigrationsAndEnsure(db);
  modelPriceService.ensureSchema(db);
  const now = new Date().toISOString();
  const configId = Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     endpoint, query_endpoint, is_active, is_default, priority, verification_status,
     verified_capabilities, settings, created_at, updated_at)
    VALUES ('video', 'xai', 'xai', '旧灵境配置', 'https://seed.alimyun.xyz/api/open/v1',
      'existing-lingjing-secret', ?, ?, '/videos', '/videos/{taskId}', 0, 0, 7,
      'pending', '{}', '{}', ?, ?)`)
    .run(JSON.stringify([MODEL]), MODEL, now, now).lastInsertRowid);
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     is_active, is_default, priority, verification_status, verified_capabilities, settings, created_at, updated_at)
    VALUES ('video', 'token6688', 'token6688_media', '受保护旧模型', 'https://api.tokengo.love/v1',
      'other-secret', '["gpt-image-2"]', 'gpt-image-2', 1, 0, 1, 'verified', '{}', '{}', ?, ?)`)
    .run(now, now);
  modelPriceService.set(db, MODEL, 69, {
    category: 'video', status: 'enabled', displayName: '灵境旧展示名', publicNote: '管理员原备注',
    billingUnit: 'second', costUnit: 'second', cost_micros_per_unit: 180000,
    resolution_prices: {
      '480p': { credits: 69, cost_micros_per_second: 180000 },
      '720p': { credits: 60, cost_micros_per_second: 180000 },
    },
  });
  modelPriceService.set(db, 'protected-existing-model', 88, {
    category: 'video', status: 'enabled', displayName: '其他模型', publicNote: '不得修改',
    billingUnit: 'second', costUnit: 'second', cost_micros_per_unit: 100000, resolution_prices: {},
  });
  db.prepare("INSERT INTO platform_users (id, email, password_hash, password_salt, status, created_at, updated_at) VALUES ('protected-user', 'protected@example.com', 'hash', 'salt', 'active', ?, ?)")
    .run(now, now);
  const asset = Buffer.alloc(4096, 7);
  const outputFile = 'relay-image-4s-19502.mp4';
  fs.writeFileSync(path.join(publicDir, outputFile), asset);
  const started = new Date(Date.now() - 62_000);
  const completed = new Date(Date.now());
  const result = {
    id: 'relay-image-4s', model: MODEL, upstream_model: 'relay', mode: 'omni',
    requested_duration: 4, requested_aspect_ratio: '16:9', requested_resolution: null,
    reference_count: 1, request_id: '69be7d12-f993-4ad9-bfc9-7f3201231119',
    request: { model_key: 'relay', duration: 4, ratio: '16:9', reference_count: 1, request_id: '69be7d12-f993-4ad9-bfc9-7f3201231119' },
    status: 'completed', submission_state: 'accepted', provider_task_id: '19502',
    provider_audit: {
      request_body_sha256: '1'.repeat(64), creation_response_sha256: '2'.repeat(64), creation_http_status: 200,
      terminal_response_sha256: '3'.repeat(64), terminal_http_status: 200,
      uploads: [{ reference_sha256: REFERENCE_SHA, upload_path: 'uploads/reference.png', upload_response_sha256: '4'.repeat(64), upload_http_status: 200 }],
      supplier_cost_unavailable: true, supplier_cost_fields: [],
    },
    started_at: started.toISOString(), completed_at: completed.toISOString(),
    speed: { submit_latency_ms: 100, generation_elapsed_seconds: 62, download_latency_ms: 50, total_elapsed_seconds: 62.05 },
    artifact: {
      public_url: `https://molimama.vip/verification-assets/lingjing/${outputFile}`,
      output_file: outputFile, content_type: 'video/mp4', bytes: asset.length, sha256: sha256(asset),
      ffprobe: { format: 'mov,mp4', width: 1280, height: 720, duration_seconds: 4.1, video_codec: 'h264', has_audio: false, audio_codec: null },
    },
  };
  const pricing = {
    provider_settings_url: 'https://seed.alimyun.xyz/api/public/settings', response_sha256: 'a'.repeat(64),
    captured_at: completed.toISOString(), model_key: 'relay', public_model: MODEL,
    billing_mode: 'per_second', price_per_second_credits: 1, rmb_per_credit: 0.17,
    cost_yuan_per_second: 0.17, credits_per_second: 149, reviewed: true,
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(buildReleaseEvidence([result], pricing, completed, REFERENCE_SHA), null, 2)}\n`);
  return { root, db, configId, publicDir, evidencePath, receiptPath, backupPath };
}

function protectedSnapshot(db) {
  return {
    otherConfig: db.prepare("SELECT * FROM ai_service_configs WHERE name = '受保护旧模型'").get(),
    otherPrice: db.prepare("SELECT * FROM model_credit_prices WHERE model = 'protected-existing-model'").get(),
    otherTiers: db.prepare('SELECT * FROM model_resolution_prices WHERE model <> ? ORDER BY model, resolution').all(MODEL),
    users: db.prepare('SELECT * FROM platform_users ORDER BY id').all(),
    tasks: db.prepare('SELECT * FROM async_tasks ORDER BY id').all(),
  };
}

function lingjingSnapshot(db, configId) {
  return {
    config: db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(configId),
    price: db.prepare('SELECT * FROM model_credit_prices WHERE model = ?').get(MODEL),
    tiers: db.prepare('SELECT * FROM model_resolution_prices WHERE model = ? ORDER BY resolution').all(MODEL),
  };
}

function close(current) {
  current.db.close();
  fs.rmSync(current.root, { recursive: true, force: true });
}

test('Lingjing transaction upgrades the inactive legacy row and exact old pricing, then rolls everything back without touching other models', async () => {
  const current = fixture();
  try {
    const evidence = loadVerifiedEvidence(current.evidencePath, current.publicDir);
    const protectedBefore = protectedSnapshot(current.db);
    const lingjingBefore = lingjingSnapshot(current.db, current.configId);
    assert.equal(planConfiguration(current.db, evidence).operation, 'upgrade');
    const applied = await applyConfiguration(current.db, evidence, {
      backupPath: current.backupPath, receiptPath: current.receiptPath,
    });
    assert.equal(applied.updated, true);
    assert.equal(verifyConfiguration(current.db, evidence).ok, true);
    const row = current.db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(current.configId);
    assert.equal(row.provider, 'lingjing');
    assert.equal(row.api_protocol, 'lingjing_open');
    assert.equal(row.api_key, 'existing-lingjing-secret');
    assert.equal(row.name, '灵境 Seedance 2.0 Fast（9 图参考）');
    assert.equal(row.is_active, 1);
    assert.equal(row.verification_status, 'verified');
    assert.deepEqual(JSON.parse(row.verified_capabilities)[MODEL].durations, [4, 5, 6, 8, 10, 11, 15]);
    assert.deepEqual(JSON.parse(row.verified_capabilities)[MODEL].resolutions, []);
    assert.equal(JSON.parse(row.verified_capabilities)[MODEL].maxImageReferences, 9);
    assert.deepEqual(protectedSnapshot(current.db), protectedBefore);
    const price = current.db.prepare('SELECT * FROM model_credit_prices WHERE model = ?').get(MODEL);
    assert.equal(price.display_name, '灵境 Seedance 2.0 Fast（9 图参考）');
    assert.equal(price.credits, 149);
    assert.equal(price.cost_micros_per_unit, 170000);
    assert.equal(current.db.prepare('SELECT COUNT(*) AS count FROM model_resolution_prices WHERE model = ?').get(MODEL).count, 0);
    const noop = await applyConfiguration(current.db, evidence, {
      backupPath: current.backupPath, receiptPath: current.receiptPath,
    });
    assert.deepEqual(noop, { updated: false, configId: current.configId });
    assert.equal(rollbackConfiguration(current.db, current.receiptPath).restored, true);
    assert.equal(planConfiguration(current.db, evidence).operation, 'upgrade');
    assert.deepEqual(protectedSnapshot(current.db), protectedBefore);
    assert.deepEqual(lingjingSnapshot(current.db, current.configId), lingjingBefore);
  } finally { close(current); }
});

test('Lingjing transaction rejects missing, duplicate or administrator-drifted source configurations', () => {
  for (const mutate of [
    (current) => current.db.prepare('DELETE FROM ai_service_configs WHERE id = ?').run(current.configId),
    (current) => current.db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, name, base_url, api_key, model, default_model, is_active, verification_status, created_at, updated_at)
      SELECT service_type, provider, '重复灵境', base_url, api_key, model, default_model, is_active, verification_status, created_at, updated_at
      FROM ai_service_configs WHERE id = ?`).run(current.configId),
    (current) => current.db.prepare("UPDATE ai_service_configs SET base_url = 'https://evil.example/v1' WHERE id = ?").run(current.configId),
    (current) => current.db.prepare("UPDATE ai_service_configs SET api_key = '' WHERE id = ?").run(current.configId),
  ]) {
    const current = fixture();
    try {
      const evidence = loadVerifiedEvidence(current.evidencePath, current.publicDir);
      mutate(current);
      assert.throws(() => planConfiguration(current.db, evidence), /唯一|数量|Base URL|凭据/);
    } finally { close(current); }
  }
});

test('Lingjing transaction rejects stale/tampered evidence and never changes the database', () => {
  const current = fixture();
  try {
    const before = protectedSnapshot(current.db);
    const value = JSON.parse(fs.readFileSync(current.evidencePath, 'utf8'));
    value.results[0].provider_audit.terminal_response_sha256 = '';
    fs.writeFileSync(current.evidencePath, `${JSON.stringify(value, null, 2)}\n`);
    assert.throws(() => loadVerifiedEvidence(current.evidencePath, current.publicDir), /证据|不完整/);
    assert.deepEqual(protectedSnapshot(current.db), before);
    value.results[0].provider_audit.terminal_response_sha256 = '3'.repeat(64);
    value.generated_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(current.evidencePath, `${JSON.stringify(value, null, 2)}\n`);
    assert.throws(() => loadVerifiedEvidence(current.evidencePath, current.publicDir), /过期|时间/);
  } finally { close(current); }
});

test('Lingjing transaction only accepts the exact reviewed legacy price shape before replacing it', () => {
  for (const mutate of [
    (current) => current.db.prepare('DELETE FROM model_credit_prices WHERE model = ?').run(MODEL),
    (current) => current.db.prepare("UPDATE model_credit_prices SET status = 'disabled' WHERE model = ?").run(MODEL),
    (current) => current.db.prepare("UPDATE model_credit_prices SET billing_unit = 'request' WHERE model = ?").run(MODEL),
    (current) => current.db.prepare('UPDATE model_credit_prices SET cost_micros_per_unit = 0 WHERE model = ?').run(MODEL),
    (current) => current.db.prepare('UPDATE model_credit_prices SET credits = 70 WHERE model = ?').run(MODEL),
    (current) => current.db.prepare("DELETE FROM model_resolution_prices WHERE model = ? AND resolution = '720p'").run(MODEL),
  ]) {
    const current = fixture();
    try {
      const evidence = loadVerifiedEvidence(current.evidencePath, current.publicDir);
      mutate(current);
      assert.throws(() => planConfiguration(current.db, evidence), /价格|按秒|成本/);
    } finally { close(current); }
  }
});

test('Lingjing rollback refuses a mismatched receipt or post-apply administrator changes', async () => {
  const current = fixture();
  try {
    const evidence = loadVerifiedEvidence(current.evidencePath, current.publicDir);
    await applyConfiguration(current.db, evidence, { backupPath: current.backupPath, receiptPath: current.receiptPath });
    const receipt = JSON.parse(fs.readFileSync(current.receiptPath, 'utf8'));
    receipt.evidence_sha256 = 'f'.repeat(64);
    fs.writeFileSync(current.receiptPath, JSON.stringify(receipt));
    assert.throws(() => rollbackConfiguration(current.db, current.receiptPath), /回执|匹配/);
    receipt.evidence_sha256 = JSON.parse(current.db.prepare('SELECT settings FROM ai_service_configs WHERE id = ?').get(current.configId).settings).evidence_sha256;
    fs.writeFileSync(current.receiptPath, JSON.stringify(receipt));
    current.db.prepare("UPDATE ai_service_configs SET name = '管理员新名称' WHERE id = ?").run(current.configId);
    assert.throws(() => rollbackConfiguration(current.db, current.receiptPath), /已被修改|禁止/);
  } finally { close(current); }
});
