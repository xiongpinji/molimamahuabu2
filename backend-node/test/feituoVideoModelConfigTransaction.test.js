const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const modelPriceService = require('../src/services/modelPriceService');
const { buildRequiredMatrix, buildReleaseEvidence } = require('../scripts/verify-feituo-video-models');
const {
  applyConfiguration,
  loadVerifiedEvidence,
  rollbackConfiguration,
  verifyConfiguration,
} = require('../../deploy/apply-feituo-video-model-config');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feituo-config-transaction-'));
  const dbPath = path.join(root, 'drama.db');
  const publicDir = path.join(root, 'public');
  const receiptPath = path.join(root, 'receipt.json');
  const evidencePath = path.join(root, 'evidence.json');
  fs.mkdirSync(publicDir);
  const db = new Database(dbPath);
  runMigrationsAndEnsure(db);
  modelPriceService.ensureSchema(db);
  const now = new Date().toISOString();
  const sourceId = Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     endpoint, query_endpoint, is_active, is_default, priority, verification_status,
     verified_capabilities, settings, created_at, updated_at)
    VALUES ('video', 'feituo', 'feituo_open', '旧飞拓配置', 'https://feituokuajing.com',
      'existing-secret-key', '["sdas-lm-hailuo-h3-2k"]', 'sdas-lm-hailuo-h3-2k',
      '/api/open/v1/video/generate', '/api/open/v1/video/status?jobId={taskId}',
      1, 0, 0, 'verified', '{}', '{}', ?, ?)`)
    .run(now, now).lastInsertRowid);
  const results = buildRequiredMatrix().map((item, index) => {
    const content = Buffer.alloc(2048 + index, index + 1);
    const fileName = `${item.id}.mp4`;
    fs.writeFileSync(path.join(publicDir, fileName), content);
    const ffprobe = item.resolution === '2k'
      ? { width: 2048, height: 1152, duration_seconds: item.duration, video_codec: 'h264' }
      : item.resolution === '720p'
        ? { width: 1280, height: 720, duration_seconds: item.duration, video_codec: 'h264' }
        : { width: 864, height: 480, duration_seconds: item.duration, video_codec: 'h264' };
    return {
      id: item.id,
      model: item.model,
      requested_resolution: item.resolution,
      requested_duration: item.duration,
      status: 'completed',
      submission_state: 'accepted',
      provider_task_id: `provider-${index + 1}`,
      started_at: '2026-08-08T01:00:00.000Z',
      completed_at: '2026-08-08T01:02:00.000Z',
      speed: { submit_latency_ms: 100, generation_elapsed_seconds: 120, download_latency_ms: 50, total_elapsed_seconds: 120.05 },
      artifact: {
        public_url: `https://molimama.vip/verification-assets/feituo/${fileName}`,
        output_file: fileName,
        bytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        ffprobe,
      },
    };
  });
  fs.writeFileSync(evidencePath, `${JSON.stringify(buildReleaseEvidence(results, new Date()), null, 2)}\n`);
  return { root, db, dbPath, publicDir, receiptPath, evidencePath, sourceId };
}

test('transaction creates a new exact Feituo config, reuses the secret without exposing it, and applies approved prices', async () => {
  const current = fixture();
  try {
    const evidence = loadVerifiedEvidence(current.evidencePath, current.publicDir);
    const result = await applyConfiguration(current.db, evidence, {
      evidencePath: current.evidencePath,
      receiptPath: current.receiptPath,
      backupPath: path.join(current.root, 'backup.db'),
    });
    assert.equal(result.created, true);
    const rows = current.db.prepare(`SELECT * FROM ai_service_configs WHERE deleted_at IS NULL AND provider = 'feituo' ORDER BY id`).all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, current.sourceId);
    assert.equal(rows[0].model, '["sdas-lm-hailuo-h3-2k"]');
    assert.equal(rows[1].api_key, 'existing-secret-key');
    assert.equal(rows[1].verification_status, 'verified');
    assert.deepEqual(JSON.parse(rows[1].model), ['xuan-video-v1-6e7b4763634e6206', 'xuan-seedance-2.5']);
    assert.ok(!rows[1].model.includes('"seedance-2.5"'));
    const caps = JSON.parse(rows[1].verified_capabilities);
    assert.deepEqual(caps['xuan-video-v1-6e7b4763634e6206'].resolutions, ['2k']);
    assert.deepEqual(caps['xuan-video-v1-6e7b4763634e6206'].durations, [15]);
    assert.deepEqual(caps['xuan-seedance-2.5'].resolutions, ['480p', '720p']);
    assert.deepEqual(caps['xuan-seedance-2.5'].durations, [4]);
    assert.equal(caps['xuan-seedance-2.5'].supportsImageReference, false);

    const h3 = current.db.prepare('SELECT * FROM model_credit_prices WHERE model = ?').get('xuan-video-v1-6e7b4763634e6206');
    assert.equal(h3.credits, 1313);
    assert.equal(h3.billing_unit, 'request');
    assert.equal(h3.cost_micros_per_unit, 1500000);
    const seedance = current.db.prepare('SELECT * FROM model_credit_prices WHERE model = ?').get('xuan-seedance-2.5');
    assert.equal(seedance.credits, 350);
    assert.equal(seedance.billing_unit, 'second');
    const tiers = current.db.prepare('SELECT resolution, credits, cost_micros_per_second FROM model_resolution_prices WHERE model = ? ORDER BY resolution').all('xuan-seedance-2.5');
    assert.deepEqual(tiers, [
      { resolution: '480p', credits: 350, cost_micros_per_second: 400000 },
      { resolution: '720p', credits: 350, cost_micros_per_second: 400000 },
    ]);
    assert.equal(verifyConfiguration(current.db, evidence).ok, true);
    assert.ok(fs.existsSync(current.receiptPath));
  } finally {
    current.db.close();
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('rollback only removes the exact transaction rows and preserves the old Feituo config', async () => {
  const current = fixture();
  try {
    const evidence = loadVerifiedEvidence(current.evidencePath, current.publicDir);
    await applyConfiguration(current.db, evidence, {
      evidencePath: current.evidencePath,
      receiptPath: current.receiptPath,
      backupPath: path.join(current.root, 'backup.db'),
    });
    rollbackConfiguration(current.db, current.receiptPath);
    assert.equal(current.db.prepare('SELECT COUNT(*) count FROM ai_service_configs').get().count, 1);
    assert.equal(current.db.prepare('SELECT id FROM ai_service_configs').get().id, current.sourceId);
    assert.equal(current.db.prepare('SELECT COUNT(*) count FROM model_credit_prices WHERE model LIKE ?').get('xuan-%').count, 0);
    assert.equal(current.db.prepare('SELECT COUNT(*) count FROM model_resolution_prices WHERE model = ?').get('xuan-seedance-2.5').count, 0);
  } finally {
    current.db.close();
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('missing or tampered artifacts reject before database side effects', () => {
  const current = fixture();
  try {
    fs.writeFileSync(path.join(current.publicDir, 'h3-2k.mp4'), Buffer.alloc(2048, 9));
    assert.throws(() => loadVerifiedEvidence(current.evidencePath, current.publicDir), /哈希不匹配/);
    assert.equal(current.db.prepare('SELECT COUNT(*) count FROM ai_service_configs').get().count, 1);
    assert.equal(current.db.prepare('SELECT COUNT(*) count FROM model_credit_prices').get().count, 0);
  } finally {
    current.db.close();
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});
