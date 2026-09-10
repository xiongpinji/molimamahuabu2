'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assetService = require('../src/services/assetService');
const creditLedger = require('../src/services/creditLedgerService');
const { stableStringify } = require('../src/services/redrawAnalysisService');
const sourceAudio = require('../src/services/redrawSourceAudioEvidenceService');
const userAuth = require('../src/services/userAuthService');
const tenantService = require('../src/services/tenantService');
const { createUserAuthMiddleware } = require('../src/middleware/userAuth');
const { createTenantContextMiddleware } = require('../src/middleware/tenantContext');
const response = require('../src/response');

// Local synthetic receipts and tiny source bytes only. No ASR, provider, Worker,
// FFmpeg, default database, production, model-readiness or media-quality claim.
// Rebuilding proves internal consistency, not cryptographic authenticity of an
// entirely forged but internally consistent set of original Worker receipts.
const log = { info() {}, warn() {}, error() {} };
const INVALID = 'SOURCE_AUDIO_EVIDENCE_INVALID';
const INPUT = 'SOURCE_AUDIO_SEAM_REVIEW_INPUT_INVALID';
const NOT_FOUND = 'SOURCE_AUDIO_SEAM_REVIEW_NOT_FOUND';
const STALE = 'SOURCE_AUDIO_SEAM_REVIEW_STALE';
const REVIEW = 'SOURCE_AUDIO_SEAM_REVIEW_REQUIRED';
const DURATION = 2100000;
const NOW = '2026-09-09T00:00:00.000Z';
const LATER = '2026-09-09T00:00:01.000Z';
const TASK_ID = 'actual-redraw-analysis-task';
const AUDIO_TASK_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_BYTES = Buffer.from('G2.SEAM_READ local synthetic source video bytes');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const PLAN = [
  { window_id: 'aw000001', index: 0, analysis_range_ms: { start_ms: 0, end_ms: 1530000 },
    commit_range_ms: { start_ms: 0, end_ms: 1500000 } },
  { window_id: 'aw000002', index: 1, analysis_range_ms: { start_ms: 1470000, end_ms: DURATION },
    commit_range_ms: { start_ms: 1500000, end_ms: DURATION } },
];

function aggregateInput(mixedLanguage = false, conflict = true) {
  return { audioDurationMs: DURATION, audioSha256: hash('synthetic complete PCM receipt'),
    windows: PLAN.map((plan, index) => {
      const raw = { audio_sha256: hash(`synthetic window audio ${index}`),
        transcript_sha256: hash(`synthetic raw transcript receipt ${index}`),
        source_language: mixedLanguage && index === 1 ? 'zh' : 'en',
        language_probability: index === 0 ? 0.98 : 0.87,
        segments: [{ start: index === 0 ? 1499.0004 : 29.0004,
          end: index === 0 ? 1502.0006 : 32.0006,
          text: index === 1 && conflict ? '  不同原文 — preserve the complete alternative. \n'
            : '  Preserve this entire original sentence. \n',
          speaker_cluster_id: 'speaker-cluster-1' }] };
      const requestId = `${AUDIO_TASK_ID}-${plan.window_id}`;
      return { ...clone(plan), request_id: requestId, audio_sha256: raw.audio_sha256,
        workerEvidence: { requestId, audioSha256: raw.audio_sha256, transcriptSha256: raw.transcript_sha256,
          sourceLanguage: raw.source_language, languageProbability: raw.language_probability,
          segments: raw.segments.map(segment => ({ startMs: Math.round(segment.start * 1000),
            endMs: Math.round(segment.end * 1000), text: segment.text.trim(),
            speakerClusterId: segment.speaker_cluster_id })), rawSourceEvidence: raw } };
    }) };
}

function resign(candidate) {
  const { candidate_sha256: ignored, ...unsigned } = candidate;
  candidate.candidate_sha256 = hash(stableStringify(unsigned));
  return candidate;
}

function makeCandidate(mixedLanguage = false, binding = {}) {
  let diagnostic;
  assert.throws(() => sourceAudio.aggregateSourceAudioWindows(aggregateInput(mixedLanguage)), error => {
    diagnostic = error.diagnostic;
    return error.code === REVIEW;
  });
  assert.equal(diagnostic.reason, mixedLanguage ? 'language_conflict' : 'seam_conflict');
  return resign({ ...diagnostic, work_id: 1, tenant_id: 'tenant-1', user_id: 'user-1',
    source_asset_id: 1, source_video_sha256: hash(SOURCE_BYTES), source_audio_task_id: AUDIO_TASK_ID,
    analysis_task_id: TASK_ID, ...binding });
}

test('SourceAudio exports the persisted seam validator and asynchronous review reader', () => {
  assert.equal(typeof sourceAudio.validatePersistedSourceAudioSeamCandidate, 'function');
  assert.equal(typeof sourceAudio.getSourceAudioSeamReview, 'function');
});

for (const mixedLanguage of [false, true]) {
  test(`persisted ${mixedLanguage ? 'language' : 'seam'} candidate reconstructs the complete original diagnostic as a copy`, () => {
    const candidate = makeCandidate(mixedLanguage);
    const before = clone(candidate);
    const verified = sourceAudio.validatePersistedSourceAudioSeamCandidate(candidate);
    assert.deepEqual(verified, before);
    assert.notEqual(verified, candidate);
    assert.notEqual(verified.windows, candidate.windows);
    assert.equal(verified.windows[0].raw_source_evidence.segments[0].start, 1499.0004);
    assert.equal(verified.windows[1].raw_source_evidence.segments[0].end, 32.0006);
    assert.match(verified.windows[0].raw_source_evidence.segments[0].text, /^  .* \n$/);
    verified.windows[0].raw_source_evidence.segments[0].text = 'caller edited returned text';
    verified.windows[1].analysis_range_ms.start_ms = 1;
    assert.deepEqual(candidate, before);
  });
}

const candidateMutations = [
  ['schema downgrade', c => { c.schema_version = 'redraw-source-audio-evidence-v2'; }],
  ['completed status', c => { c.status = 'completed'; }],
  ['zero work id', c => { c.work_id = 0; }],
  ['string work id', c => { c.work_id = '1'; }],
  ['unsafe source id', c => { c.source_asset_id = Number.MAX_SAFE_INTEGER + 1; }],
  ['negative source id', c => { c.source_asset_id = -1; }],
  ['missing tenant', c => { delete c.tenant_id; }],
  ['empty user', c => { c.user_id = ' '; }],
  ['invalid analysis id', c => { c.analysis_task_id = null; }],
  ['invalid audio task id', c => { c.source_audio_task_id = 'bad\0task'; }],
  ['same source-audio and actual analysis task id', c => { c.source_audio_task_id = c.analysis_task_id; }],
  ['invalid source SHA', c => { c.source_video_sha256 = 'not-a-sha256'; }],
  ['invalid full audio SHA', c => { c.audio_sha256 = 'not-a-sha256'; }],
  ['wrong duration for the persisted plan', c => { c.audio_duration_ms += 1; }],
  ['contradictory conflict reason', c => { c.reason = 'language_conflict'; }],
  ['unknown reason', c => { c.reason = 'automatically_selected'; }],
  ['missing window', c => { c.windows.pop(); }],
  ['reordered windows', c => { c.windows.reverse(); }],
  ['wrong window id', c => { c.windows[0].window_id = 'aw000099'; }],
  ['wrong window index', c => { c.windows[0].index = 1; }],
  ['trimmed analysis range', c => { c.windows[0].analysis_range_ms.end_ms -= 1; }],
  ['shifted commit range', c => { c.windows[1].commit_range_ms.start_ms += 1; }],
  ['duplicate request id', c => { c.windows[1].request_id = c.windows[0].request_id; }],
  ['changed window audio hash only', c => { c.windows[0].audio_sha256 = hash('other window audio'); }],
  ['changed window transcript hash only', c => { c.windows[0].transcript_sha256 = hash('other transcript'); }],
  ['pending worker status', c => { c.windows[0].worker_status = 'pending'; }],
  ['wrong segment count', c => { c.windows[0].segment_count += 1; }],
  ['raw receipt audio mismatch', c => { c.windows[0].raw_source_evidence.audio_sha256 = hash('other raw audio'); }],
  ['raw transcript mismatch', c => { c.windows[0].raw_source_evidence.transcript_sha256 = hash('other raw transcript'); }],
  ['language now requires a different reason', c => { c.windows[1].raw_source_evidence.source_language = 'zh'; }],
  ['invalid language probability', c => { c.windows[0].raw_source_evidence.language_probability = 1.1; }],
  ['negative original start', c => { c.windows[0].raw_source_evidence.segments[0].start = -1; }],
  ['original end outside analysis window', c => { c.windows[0].raw_source_evidence.segments[0].end = 1531; }],
  ['empty original text', c => { c.windows[0].raw_source_evidence.segments[0].text = ' \n'; }],
  ['invalid original speaker cluster', c => { c.windows[0].raw_source_evidence.segments[0].speaker_cluster_id = 'global-1'; }],
  ['success disguised as a conflict', c => {
    c.windows[1].raw_source_evidence.segments[0].text = c.windows[0].raw_source_evidence.segments[0].text;
  }],
];
for (const [label, mutate] of candidateMutations) {
  test(`persisted candidate rejects ${label}, even after its candidate SHA is recomputed`, () => {
    const candidate = makeCandidate();
    mutate(candidate); resign(candidate);
    const before = clone(candidate);
    assert.throws(() => sourceAudio.validatePersistedSourceAudioSeamCandidate(candidate), { code: INVALID });
    assert.deepEqual(candidate, before);
  });
}

for (const [label, target] of [
  ['candidate', c => c], ['window', c => c.windows[0]],
  ['analysis range', c => c.windows[0].analysis_range_ms],
  ['commit range', c => c.windows[0].commit_range_ms],
  ['raw receipt', c => c.windows[0].raw_source_evidence],
  ['original segment', c => c.windows[0].raw_source_evidence.segments[0]],
]) {
  test(`persisted candidate rejects an extra field on ${label} with a self-consistent candidate SHA`, () => {
    const candidate = makeCandidate(); target(candidate).selected = true; resign(candidate);
    assert.throws(() => sourceAudio.validatePersistedSourceAudioSeamCandidate(candidate), { code: INVALID });
  });
  test(`persisted candidate never executes an accessor on ${label}`, () => {
    const candidate = makeCandidate(); const object = target(candidate);
    const key = Object.keys(object)[0]; let calls = 0;
    Object.defineProperty(object, key, { enumerable: true, configurable: true,
      get() { calls += 1; throw Error('getter must not execute'); } });
    assert.throws(() => sourceAudio.validatePersistedSourceAudioSeamCandidate(candidate), { code: INVALID });
    assert.equal(calls, 0);
    assert.equal(typeof Object.getOwnPropertyDescriptor(object, key).get, 'function');
  });
}

const nonJsonCandidates = [
  ['null', () => null], ['array', () => []], ['Date', () => new Date(NOW)],
  ['null prototype', c => Object.assign(Object.create(null), c)],
  ['inherited candidate', c => Object.create(c)],
  ['symbol field', c => { c[Symbol('hidden')] = 1; return c; }],
  ['non-enumerable field', c => { Object.defineProperty(c, 'hidden', { value: 1 }); return c; }],
  ['undefined field', c => { c.extra = undefined; return c; }],
  ['function field', c => { c.extra = () => {}; return c; }],
  ['bigint field', c => { c.extra = 1n; return c; }],
  ['infinite time', c => { c.windows[0].raw_source_evidence.segments[0].start = Infinity; return c; }],
  ['cycle', c => { c.extra = c; return c; }],
  ['sparse windows', c => { delete c.windows[0]; return c; }],
  ['array extra property', c => { c.windows.extra = true; return c; }],
];
for (const [label, make] of nonJsonCandidates) {
  test(`persisted candidate rejects non-ordinary JSON: ${label}`, () => {
    assert.throws(() => sourceAudio.validatePersistedSourceAudioSeamCandidate(make(makeCandidate())), { code: INVALID });
  });
}

test('persisted candidate rejects a changed original sentence without a new candidate SHA', () => {
  const candidate = makeCandidate();
  candidate.windows[0].raw_source_evidence.segments[0].text += ' changed';
  assert.throws(() => sourceAudio.validatePersistedSourceAudioSeamCandidate(candidate), { code: INVALID });
});

for (const digest of [undefined, '', 'invalid', 'f'.repeat(64)]) {
  test(`persisted candidate rejects missing, malformed or mismatched digest ${String(digest)}`, () => {
    const candidate = makeCandidate();
    if (digest === undefined) delete candidate.candidate_sha256;
    else candidate.candidate_sha256 = digest;
    assert.throws(() => sourceAudio.validatePersistedSourceAudioSeamCandidate(candidate), { code: INVALID });
  });
}

test('persisted candidate rejects custom serialization without calling toJSON', () => {
  const candidate = makeCandidate(); let calls = 0;
  candidate.toJSON = () => { calls += 1; return {}; };
  assert.throws(() => sourceAudio.validatePersistedSourceAudioSeamCandidate(candidate), { code: INVALID });
  assert.equal(calls, 0);
});

test('persisted candidate rejects an accessor at a window array index without executing it', () => {
  const candidate = makeCandidate(); let calls = 0;
  Object.defineProperty(candidate.windows, '0', { enumerable: true, configurable: true,
    get() { calls += 1; throw Error('array getter must not execute'); } });
  assert.throws(() => sourceAudio.validatePersistedSourceAudioSeamCandidate(candidate), { code: INVALID });
  assert.equal(calls, 0);
});

test('persisted candidate rejects a genuine successful v2 aggregate', () => {
  const evidence = sourceAudio.aggregateSourceAudioWindows(aggregateInput(false, false));
  assert.equal(evidence.schema_version, 'redraw-source-audio-evidence-v2');
  assert.throws(() => sourceAudio.validatePersistedSourceAudioSeamCandidate(evidence), { code: INVALID });
});

function databaseSnapshot(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
  return Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
    .all().sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))]));
}

function fileSnapshot(root) {
  const result = {};
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name); const stat = fs.lstatSync(file);
      const relative = path.relative(root, file);
      if (stat.isSymbolicLink()) result[relative] = { link: fs.readlinkSync(file) };
      else if (stat.isDirectory()) { result[relative] = { directory: true }; visit(file); }
      else result[relative] = { bytes: fs.readFileSync(file).toString('base64') };
    }
  }
  visit(root); return result;
}

function totalChanges(db) { return db.prepare('SELECT total_changes() AS n').get().n; }

function checkpoint(h) {
  h.expectedDb = databaseSnapshot(h.db); h.expectedFiles = fileSnapshot(h.root);
  h.changesBefore = totalChanges(h.db); h.injectedChanges = 0;
}

function assertReadOnly(h) {
  assert.deepEqual(databaseSnapshot(h.db), h.expectedDb, 'all business tables remain unchanged by the read');
  assert.deepEqual(fileSnapshot(h.root), h.expectedFiles, 'no files or directories are created, changed or removed by the read');
  assert.equal(totalChanges(h.db), h.changesBefore + h.injectedChanges, 'no transient or no-op database writes');
  assert.deepEqual(h.writeAttempts, [], 'no filesystem mutation was attempted');
  assert.equal(h.openDescriptors.size, 0, 'all read descriptors close on success and rejection');
}

function instrumentReadFs(h, afterHash) {
  const api = Object.create(fs);
  for (const name of ['writeFile', 'appendFile', 'copyFile', 'mkdir', 'mkdtemp', 'rename', 'unlink',
    'rm', 'rmdir', 'truncate', 'ftruncate', 'write', 'chmod', 'fchmod', 'symlink', 'link']) {
    for (const method of [name, `${name}Sync`]) api[method] = () => {
      h.writeAttempts.push(method); throw Error(`read attempted filesystem mutation: ${method}`);
    };
  }
  api.createWriteStream = () => { h.writeAttempts.push('createWriteStream'); throw Error('read attempted a writable stream'); };
  api.openSync = (file, flags, ...args) => {
    const readonly = flags === 'r' || (Number.isInteger(flags)
      && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) === 0);
    if (!readonly) h.writeAttempts.push(`openSync:${flags}`);
    assert.equal(readonly, true, 'source descriptor must be opened read-only');
    const descriptor = fs.openSync(file, flags, ...args); h.openDescriptors.add(descriptor); return descriptor;
  };
  api.closeSync = descriptor => { fs.closeSync(descriptor); h.openDescriptors.delete(descriptor); };
  api.fstatSync = (...args) => {
    if (h.hashEnded) h.io.descriptorAfter += 1; else h.io.descriptorBefore += 1;
    return fs.fstatSync(...args);
  };
  api.statSync = (...args) => {
    if (h.hashEnded && path.resolve(String(args[0])) === h.sourcePath) h.io.pathAfter += 1;
    return fs.statSync(...args);
  };
  api.createReadStream = (file, options = {}) => {
    const descriptor = Number.isInteger(options.fd) ? options.fd : file;
    assert.equal(Number.isInteger(descriptor), true, 'hash the already verified descriptor, not a newly opened path');
    assert.equal(h.openDescriptors.has(descriptor), true);
    assert.ok(h.io.descriptorBefore > 0, 'descriptor identity is checked before hashing');
    h.io.hashes += 1;
    const stream = fs.createReadStream(file, options);
    stream.once('end', () => {
      h.hashEnded = true;
      if (afterHash && !h.raceReached) {
        h.raceReached = true;
        const before = totalChanges(h.db); afterHash(h);
        h.injectedChanges += totalChanges(h.db) - before;
        h.expectedDb = databaseSnapshot(h.db); h.expectedFiles = fileSnapshot(h.root);
      }
    });
    return stream;
  };
  return api;
}

function createFixture(t, { mixedLanguage = false, free = false, afterHash } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-seam-review-read-'));
  const ownedRoot = fs.realpathSync.native(root);
  const storageRoot = path.join(root, 'storage'); fs.mkdirSync(storageRoot);
  const sourcePath = path.join(storageRoot, 'source.mp4'); fs.writeFileSync(sourcePath, SOURCE_BYTES);
  const db = new Database(':memory:', {
    nativeBinding: path.resolve(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  });
  runMigrationsAndEnsure(db);
  t.after(() => {
    db.close();
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    assert.equal(fs.realpathSync.native(root), ownedRoot);
    assert.equal(path.dirname(ownedRoot), fs.realpathSync.native(os.tmpdir()));
    assert.match(path.basename(ownedRoot), /^g2-seam-review-read-/);
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  });
  const source = assetService.create(db, log, { name: 'synthetic source', type: 'video', category: 'redraw_source',
    local_path: 'source.mp4', mime_type: 'video/mp4', file_size: SOURCE_BYTES.length,
    metadata: { tenant_id: 'tenant-1', user_id: 'user-1', sha256: hash(SOURCE_BYTES), source_fingerprint: hash(SOURCE_BYTES) } });
  const candidate = makeCandidate(mixedLanguage, { source_asset_id: source.id });
  creditLedger.setTenantAccountBalance(db, 'tenant-1', 100);
  const reservation = free ? null : creditLedger.reserve(db, { tenantId: 'tenant-1', userId: 'user-1',
    actorUserId: 'user-1', operationKey: 'redraw_analysis:1:synthetic-source', model: 'GPT-5.5',
    resourceType: 'redraw_analysis', resourceId: 1, amount: 6, now: NOW });
  db.prepare(`INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (1, 'tenant-1', 'user-1', 'G2 seam review read', 'draft', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
     status, current_step, task_id, credit_reservation_id, created_at, updated_at)
    VALUES (1, 1, 'tenant-1', 'user-1', 'G2 seam review read', ?, ?, ?, 'needs_attention', 1, ?, ?, ?, ?)`)
    .run(source.id, hash(SOURCE_BYTES), DURATION, TASK_ID, reservation?.id || null, NOW, NOW);
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, tenant_id, user_id, model, credit_reservation_id,
     result, metadata, created_at, updated_at, completed_at, provider_task_id)
    VALUES (?, 'redraw_analysis', 'needs_attention', 10, ?, '1', 'tenant-1', 'user-1', 'GPT-5.5', ?, ?, ?, ?, ?, NULL, NULL)`)
    .run(TASK_ID, REVIEW, reservation?.id || null,
      JSON.stringify({ status: 'needs_review', source_audio_seam_review: candidate }),
      JSON.stringify({ redraw_analysis: {} }), NOW, NOW);
  const h = { root, storageRoot, sourcePath, source, candidate, reservation, db, writeAttempts: [],
    openDescriptors: new Set(), io: { descriptorBefore: 0, descriptorAfter: 0, pathAfter: 0, hashes: 0 },
    work() { return db.prepare('SELECT * FROM redraw_works WHERE id = 1').get(); },
    task() { return db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(TASK_ID); },
    setCandidate(value) {
      db.prepare('UPDATE async_tasks SET result = ? WHERE id = ?')
        .run(JSON.stringify({ status: 'needs_review', source_audio_seam_review: value }), TASK_ID);
    },
    setMetadata(change) {
      const row = db.prepare('SELECT metadata FROM assets WHERE id = ?').get(source.id);
      const metadata = JSON.parse(row.metadata); change(metadata);
      db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), source.id);
    },
  };
  h.ctx = { db, log, storageRoot, tenantId: 'tenant-1', userId: 'user-1', fs: instrumentReadFs(h, afterHash) };
  return h;
}

function expectedDto(h) {
  const c = h.candidate;
  return { schema_version: 'redraw-source-audio-seam-review-v1', status: 'needs_review',
    work_id: 1, analysis_task_id: TASK_ID, source_asset_id: h.source.id, source_fingerprint: hash(SOURCE_BYTES),
    expected_work_updated_at: h.work().updated_at, expected_task_updated_at: h.task().updated_at,
    candidate_sha256: c.candidate_sha256, reason: c.reason, audio_duration_ms: c.audio_duration_ms,
    audio_sha256: c.audio_sha256, windows: clone(c.windows) };
}

async function readAndAssert(h, code, input = { workId: 1 }, ctx = h.ctx) {
  checkpoint(h);
  try {
    if (code) await assert.rejects(async () => sourceAudio.getSourceAudioSeamReview(ctx, input), { code });
    else return await sourceAudio.getSourceAudioSeamReview(ctx, input);
  } finally { assertReadOnly(h); }
}

for (const mixedLanguage of [false, true]) for (const free of [false, true]) {
  test(`read returns complete ${mixedLanguage ? 'language' : 'seam'} windows for ${free ? 'free' : 'held'} analysis without mutation`, async t => {
    const h = createFixture(t, { mixedLanguage, free });
    const dto = await readAndAssert(h);
    assert.deepEqual(dto, expectedDto(h), 'strict DTO contains only review data and future CAS tokens');
    assert.ok(h.io.hashes > 0); assert.ok(h.io.descriptorAfter > 0); assert.ok(h.io.pathAfter > 0);
    assert.equal(dto.windows.length, 2);
    assert.notEqual(dto.windows, h.candidate.windows);
    assert.doesNotMatch(JSON.stringify(dto), /tenant_id|user_id|local_path|storageRoot|source_audio_task_id|selected|default|result_asset_id|success/);
    dto.windows[0].raw_source_evidence.segments[0].text = 'caller mutation';
    dto.windows[1].commit_range_ms.start_ms = -1;
    assert.deepEqual(await readAndAssert(h), expectedDto(h));
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM tenant_usage_reservations').get().n, free ? 0 : 1);
    if (!free) assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
  });
}

const invalidInputs = [undefined, null, [], {}, { workId: 0 }, { workId: -1 }, { workId: 1.5 },
  { workId: Number.MAX_SAFE_INTEGER + 1 }, { workId: true }, { workId: [] }, { workId: {} },
  { workId: '1junk' }, { workId: ' ' }, { workId: 1, tenantId: 'tenant-2' },
  { workId: 1, userId: 'user-2' }, { workId: 1, sourceAssetId: 99 },
  { workId: 1, candidate: {} }];
for (const [index, input] of invalidInputs.entries()) {
  test(`read rejects invalid or replacement input ${index + 1} without side effects`, async t => {
    const h = createFixture(t);
    checkpoint(h);
    try { await assert.rejects(async () => sourceAudio.getSourceAudioSeamReview(h.ctx, input), { code: INPUT }); }
    finally { assertReadOnly(h); }
  });
}

for (const field of ['db', 'storageRoot', 'tenantId', 'userId']) {
  test(`read requires explicit context ${field}`, async t => {
    const h = createFixture(t); const ctx = { ...h.ctx }; delete ctx[field];
    await readAndAssert(h, INPUT, { workId: 1 }, ctx);
  });
}

test('read rejects an input getter without executing it', async t => {
  const h = createFixture(t); let calls = 0;
  const input = {};
  Object.defineProperty(input, 'workId', { enumerable: true,
    get() { calls += 1; throw Error('input getter must not execute'); } });
  await readAndAssert(h, INPUT, input);
  assert.equal(calls, 0);
});

const bindingMutations = [
  ['work missing', h => h.db.prepare('DELETE FROM redraw_works WHERE id = 1').run(), NOT_FOUND],
  ['work deleted', h => h.db.prepare('UPDATE redraw_works SET deleted_at = ? WHERE id = 1').run(NOW), NOT_FOUND],
  ['work tenant changed', h => h.db.prepare("UPDATE redraw_works SET tenant_id = 'tenant-2' WHERE id = 1").run(), NOT_FOUND],
  ['work user changed', h => h.db.prepare("UPDATE redraw_works SET user_id = 'user-2' WHERE id = 1").run(), NOT_FOUND],
  ['work not needs_attention', h => h.db.prepare("UPDATE redraw_works SET status = 'analyzing' WHERE id = 1").run()],
  ['work without bound task', h => h.db.prepare('UPDATE redraw_works SET task_id = NULL WHERE id = 1').run()],
  ['work bound to another task', h => h.db.prepare("UPDATE redraw_works SET task_id = 'other-task' WHERE id = 1").run()],
  ['work source changed', h => h.db.prepare('UPDATE redraw_works SET source_asset_id = 999 WHERE id = 1').run()],
  ['work source fingerprint changed', h => h.db.prepare('UPDATE redraw_works SET source_fingerprint = ? WHERE id = 1').run(hash('different source'))],
  ['work source fingerprint malformed', h => h.db.prepare("UPDATE redraw_works SET source_fingerprint = 'invalid' WHERE id = 1").run()],
  ['task missing', h => h.db.prepare('DELETE FROM async_tasks WHERE id = ?').run(TASK_ID)],
  ['task deleted', h => h.db.prepare('UPDATE async_tasks SET deleted_at = ? WHERE id = ?').run(NOW, TASK_ID)],
  ['task wrong type', h => h.db.prepare("UPDATE async_tasks SET type = 'redraw_localization' WHERE id = ?").run(TASK_ID)],
  ['task wrong resource', h => h.db.prepare("UPDATE async_tasks SET resource_id = '2' WHERE id = ?").run(TASK_ID)],
  ['task wrong tenant', h => h.db.prepare("UPDATE async_tasks SET tenant_id = 'tenant-2' WHERE id = ?").run(TASK_ID)],
  ['task wrong user', h => h.db.prepare("UPDATE async_tasks SET user_id = 'user-2' WHERE id = ?").run(TASK_ID)],
  ['task processing', h => h.db.prepare("UPDATE async_tasks SET status = 'processing' WHERE id = ?").run(TASK_ID)],
  ['task completed', h => h.db.prepare("UPDATE async_tasks SET status = 'completed' WHERE id = ?").run(TASK_ID)],
  ['task has completed_at', h => h.db.prepare('UPDATE async_tasks SET completed_at = ? WHERE id = ?').run(NOW, TASK_ID)],
  ['task has provider id', h => h.db.prepare("UPDATE async_tasks SET provider_task_id = 'unknown-provider-task' WHERE id = ?").run(TASK_ID)],
  ['source asset missing', h => h.db.prepare('DELETE FROM assets WHERE id = ?').run(h.source.id)],
  ['source asset deleted', h => h.db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ?').run(NOW, h.source.id)],
  ['source asset wrong type', h => h.db.prepare("UPDATE assets SET type = 'audio' WHERE id = ?").run(h.source.id)],
  ['source asset wrong category', h => h.db.prepare("UPDATE assets SET category = 'redraw_source_audio_evidence' WHERE id = ?").run(h.source.id)],
  ['source asset wrong tenant', h => h.setMetadata(m => { m.tenant_id = 'tenant-2'; })],
  ['source asset wrong user', h => h.setMetadata(m => { m.user_id = 'user-2'; })],
  ['source asset invalid metadata', h => h.db.prepare("UPDATE assets SET metadata = '{' WHERE id = ?").run(h.source.id)],
  ['source asset SHA differs', h => h.setMetadata(m => { m.sha256 = hash('wrong source'); })],
  ['source asset fingerprint differs', h => h.setMetadata(m => { m.source_fingerprint = hash('wrong source'); })],
  ['source asset SHA malformed', h => h.setMetadata(m => { m.sha256 = 'invalid'; })],
  ['source asset declared size differs', h => h.db.prepare('UPDATE assets SET file_size = ? WHERE id = ?').run(SOURCE_BYTES.length + 1, h.source.id)],
  ['work reservation absent only', h => h.db.prepare('UPDATE redraw_works SET credit_reservation_id = NULL WHERE id = 1').run()],
  ['task reservation absent only', h => h.db.prepare('UPDATE async_tasks SET credit_reservation_id = NULL WHERE id = ?').run(TASK_ID)],
  ['different reservation ids', h => h.db.prepare("UPDATE async_tasks SET credit_reservation_id = 'other-reservation' WHERE id = ?").run(TASK_ID)],
  ['reservation missing', h => h.db.prepare('DELETE FROM tenant_usage_reservations WHERE id = ?').run(h.reservation.id)],
];
for (const [label, mutate, code = STALE] of bindingMutations) {
  test(`read rejects ${label} without changing current business or file state`, async t => {
    const h = createFixture(t); mutate(h); await readAndAssert(h, code);
  });
}

for (const [column, value] of [['tenant_id', 'tenant-2'], ['actor_user_id', 'user-2'],
  ['resource_type', 'redraw_localization'], ['resource_id', '2'], ['model', 'wrong-model'],
  ['status', 'confirmed'], ['status', 'refunded']]) {
  test(`read rejects reservation ${column}=${value} without settling it`, async t => {
    const h = createFixture(t);
    h.db.prepare(`UPDATE tenant_usage_reservations SET ${column} = ? WHERE id = ?`).run(value, h.reservation.id);
    await readAndAssert(h, STALE);
  });
}

const candidateBindingMutations = [
  ['another work', c => { c.work_id = 2; }], ['another tenant', c => { c.tenant_id = 'tenant-2'; }],
  ['another user', c => { c.user_id = 'user-2'; }], ['another source', c => { c.source_asset_id = 999; }],
  ['another source SHA', c => { c.source_video_sha256 = hash('candidate source replacement'); }],
  ['another actual analysis task', c => { c.analysis_task_id = 'other-analysis-task'; }],
  ['audio id used as the DB task id', c => { c.analysis_task_id = c.source_audio_task_id; }],
];
for (const [label, mutate] of candidateBindingMutations) {
  test(`read rejects an internally re-signed candidate bound to ${label}`, async t => {
    const h = createFixture(t); const candidate = clone(h.candidate); mutate(candidate);
    h.setCandidate(resign(candidate)); await readAndAssert(h, STALE);
  });
}

const invalidResults = [
  ['null result', () => null], ['invalid JSON', () => '{'], ['JSON null', () => 'null'],
  ['ordinary unknown', () => JSON.stringify({ status: 'needs_attention', error: 'TEXT_RESULT_UNKNOWN' })],
  ['no candidate', () => JSON.stringify({ status: 'needs_review' })],
  ['success result wrapper', c => JSON.stringify({ status: 'completed', source_audio_seam_review: c })],
  ['extra result field', c => JSON.stringify({ status: 'needs_review', source_audio_seam_review: c, selected: 0 })],
  ['empty candidate', () => JSON.stringify({ status: 'needs_review', source_audio_seam_review: {} })],
  ['invalid candidate SHA', c => JSON.stringify({ status: 'needs_review', source_audio_seam_review: { ...c, candidate_sha256: '0'.repeat(64) } })],
  ['re-signed contradictory reason', c => JSON.stringify({ status: 'needs_review', source_audio_seam_review: resign({ ...c, reason: 'language_conflict' }) })],
];
for (const [label, result] of invalidResults) {
  test(`read keeps ${label} frozen instead of admitting manual review`, async t => {
    const h = createFixture(t);
    h.db.prepare('UPDATE async_tasks SET result = ? WHERE id = ?').run(result(clone(h.candidate)), TASK_ID);
    await readAndAssert(h, STALE);
  });
}

test('an ordinary unknown result on the original free path cannot become a review or a new reservation', async t => {
  const h = createFixture(t, { free: true });
  h.db.prepare('UPDATE async_tasks SET result = NULL WHERE id = ?').run(TASK_ID);
  await readAndAssert(h, STALE);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM tenant_usage_reservations').get().n, 0);
});

const fileMutations = [
  ['changed source bytes', h => fs.writeFileSync(h.sourcePath, Buffer.alloc(SOURCE_BYTES.length, 120))],
  ['source missing', h => fs.unlinkSync(h.sourcePath)],
  ['source is a directory', h => { fs.unlinkSync(h.sourcePath); fs.mkdirSync(h.sourcePath); }],
  ['absolute source path', h => h.db.prepare('UPDATE assets SET local_path = ? WHERE id = ?').run(h.sourcePath, h.source.id)],
  ['relative source escape', h => {
    fs.writeFileSync(path.join(h.root, 'outside.mp4'), SOURCE_BYTES);
    h.db.prepare("UPDATE assets SET local_path = '../outside.mp4' WHERE id = ?").run(h.source.id);
  }],
  ['linked source directory escape', h => {
    const outside = path.join(h.root, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'source.mp4'), SOURCE_BYTES);
    fs.symlinkSync(outside, path.join(h.storageRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    h.db.prepare("UPDATE assets SET local_path = 'linked/source.mp4' WHERE id = ?").run(h.source.id);
  }],
];
for (const [label, mutate] of fileMutations) {
  test(`read rejects ${label} without copying, extracting or changing files`, async t => {
    const h = createFixture(t); mutate(h); await readAndAssert(h, STALE);
  });
}

test('read detects a same-byte source replacement between path resolution and descriptor opening before hashing', async t => {
  const h = createFixture(t); const open = h.ctx.fs.openSync;
  let replaced = false;
  h.ctx.fs.openSync = (file, ...args) => {
    if (!replaced && path.resolve(String(file)) === h.sourcePath) {
      replaced = true;
      const replacement = path.join(h.storageRoot, 'before-open.mp4');
      fs.writeFileSync(replacement, SOURCE_BYTES);
      fs.renameSync(h.sourcePath, path.join(h.storageRoot, 'original-before-open.mp4'));
      fs.renameSync(replacement, h.sourcePath);
      h.expectedFiles = fileSnapshot(h.root);
    }
    return open(file, ...args);
  };
  await readAndAssert(h, STALE);
  assert.equal(replaced, true);
  assert.equal(h.io.hashes, 0, 'descriptor identity must be checked against the resolved source before reading bytes');
});

const hashRaces = [
  ['work timestamp', h => h.db.prepare('UPDATE redraw_works SET updated_at = ? WHERE id = 1').run(LATER)],
  ['task timestamp', h => h.db.prepare('UPDATE async_tasks SET updated_at = ? WHERE id = ?').run(LATER, TASK_ID)],
  ['work owner', h => h.db.prepare("UPDATE redraw_works SET user_id = 'user-2' WHERE id = 1").run()],
  ['work deletion', h => h.db.prepare('UPDATE redraw_works SET deleted_at = ? WHERE id = 1').run(LATER)],
  ['work task binding', h => h.db.prepare("UPDATE redraw_works SET task_id = 'replacement' WHERE id = 1").run()],
  ['work source binding', h => h.db.prepare('UPDATE redraw_works SET source_asset_id = 999 WHERE id = 1').run()],
  ['work fingerprint', h => h.db.prepare('UPDATE redraw_works SET source_fingerprint = ? WHERE id = 1').run(hash('replacement'))],
  ['task status', h => h.db.prepare("UPDATE async_tasks SET status = 'completed' WHERE id = ?").run(TASK_ID)],
  ['task owner', h => h.db.prepare("UPDATE async_tasks SET tenant_id = 'tenant-2' WHERE id = ?").run(TASK_ID)],
  ['task provider id', h => h.db.prepare("UPDATE async_tasks SET provider_task_id = 'now-submitted' WHERE id = ?").run(TASK_ID)],
  ['task result removed', h => h.db.prepare('UPDATE async_tasks SET result = NULL WHERE id = ?').run(TASK_ID)],
  ['task result replaced by another valid candidate', h => {
    const replacement = clone(h.candidate); replacement.windows[0].raw_source_evidence.segments[0].text += ' changed';
    h.setCandidate(resign(replacement));
  }],
  ['source metadata owner', h => h.setMetadata(m => { m.user_id = 'user-2'; })],
  ['source metadata hash', h => h.setMetadata(m => { m.sha256 = hash('new declaration'); })],
  ['source asset timestamp', h => h.db.prepare('UPDATE assets SET updated_at = ? WHERE id = ?').run(LATER, h.source.id)],
  ['source path', h => {
    fs.writeFileSync(path.join(h.storageRoot, 'other.mp4'), SOURCE_BYTES);
    h.db.prepare("UPDATE assets SET local_path = 'other.mp4' WHERE id = ?").run(h.source.id);
  }],
  ['reservation status', h => h.db.prepare("UPDATE tenant_usage_reservations SET status = 'refunded' WHERE id = ?").run(h.reservation.id)],
  ['reservation owner', h => h.db.prepare("UPDATE tenant_usage_reservations SET actor_user_id = 'user-2' WHERE id = ?").run(h.reservation.id)],
  ['reservation model', h => h.db.prepare("UPDATE tenant_usage_reservations SET model = 'other-model' WHERE id = ?").run(h.reservation.id)],
  ['reservation timestamp', h => h.db.prepare('UPDATE tenant_usage_reservations SET updated_at = ? WHERE id = ?').run(LATER, h.reservation.id)],
  ['source bytes after stream end', h => fs.writeFileSync(h.sourcePath, Buffer.alloc(SOURCE_BYTES.length, 121))],
  ['same bytes at a different source inode', h => {
    const replacement = path.join(h.storageRoot, 'replacement.mp4'); fs.writeFileSync(replacement, SOURCE_BYTES);
    fs.renameSync(h.sourcePath, path.join(h.storageRoot, 'old-source.mp4')); fs.renameSync(replacement, h.sourcePath);
  }],
];
for (const [label, mutate] of hashRaces) {
  test(`read rechecks and rejects ${label} changed during the source hash await`, async t => {
    const h = createFixture(t, { afterHash: mutate });
    await readAndAssert(h, STALE);
    assert.equal(h.raceReached, true, 'race must happen during the real source hash, not before initial validation');
    assert.equal(h.io.hashes, 1, 'stale read does not retry, reserve or submit work');
  });
}

function routeHandlers(h) {
  return require('../src/routes/redraw')(h.db, log, { cfg: { storage: { local_path: h.storageRoot } },
    referenceArtifactTempRoot: path.join(h.root, 'reference-imports') });
}

async function requestReview(h, request = {}) {
  const handlers = routeHandlers(h);
  const res = { statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  checkpoint(h);
  try {
    await handlers.getSourceAudioSeamReview({ params: { id: '1' }, tenant: { id: 'tenant-1' },
      user: { id: 'user-1' }, query: {}, body: {}, ...request }, res);
    return res;
  } finally { assertReadOnly(h); }
}

test('real review handler returns 200 with the strict DTO and ignores caller-supplied replacement bindings', async t => {
  const h = createFixture(t);
  const replacement = { tenant_id: 'tenant-2', user_id: 'user-2', source_asset_id: 999, candidate: { selected: true } };
  const res = await requestReview(h, { query: replacement, body: replacement });
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data, expectedDto(h));
});

for (const id of ['0', '-1', '1.5', '1junk', '', ' ', 'NaN', '9007199254740992']) {
  test(`real review handler returns safe 400 for invalid id ${JSON.stringify(id)}`, async t => {
    const h = createFixture(t); const res = await requestReview(h, { params: { id } });
    assert.equal(res.statusCode, 400); assert.equal(res.body.success, false); assert.equal(res.body.error.code, INPUT);
  });
}

for (const [label, request] of [
  ['nonexistent work', { params: { id: '999' } }],
  ['cross-tenant request', { tenant: { id: 'tenant-2' } }],
  ['cross-user request', { user: { id: 'user-2' } }],
  ['cross-user request attempting body and query owner replacement', { user: { id: 'user-2' },
    query: { user_id: 'user-1', userId: 'user-1', tenant_id: 'tenant-1' },
    body: { user_id: 'user-1', userId: 'user-1', tenant_id: 'tenant-1' } }],
]) {
  test(`real review handler returns non-disclosing 404 for ${label}`, async t => {
    const h = createFixture(t); const res = await requestReview(h, request);
    assert.equal(res.statusCode, 404); assert.equal(res.body.success, false); assert.equal(res.body.error.code, NOT_FOUND);
    assert.doesNotMatch(JSON.stringify(res.body), /tenant-1|user-1|actual-redraw-analysis-task|source\.mp4|g2-seam-review-read-/);
  });
}

for (const [label, mutate] of [
  ['ordinary unknown', h => h.db.prepare('UPDATE async_tasks SET result = NULL WHERE id = ?').run(TASK_ID)],
  ['stale task status', h => h.db.prepare("UPDATE async_tasks SET status = 'completed' WHERE id = ?").run(TASK_ID)],
  ['tampered candidate', h => h.setCandidate(resign({ ...h.candidate, reason: 'language_conflict' }))],
  ['invalid source path', h => h.db.prepare("UPDATE assets SET local_path = '../private-owner-file' WHERE id = ?").run(h.source.id)],
  ['invalid source owner', h => h.setMetadata(m => { m.tenant_id = 'private-other-tenant'; })],
  ['released reservation', h => h.db.prepare("UPDATE tenant_usage_reservations SET status = 'refunded' WHERE id = ?").run(h.reservation.id)],
]) {
  test(`real review handler returns safe 409 for ${label}`, async t => {
    const h = createFixture(t); mutate(h); const res = await requestReview(h);
    assert.equal(res.statusCode, 409); assert.equal(res.body.success, false); assert.equal(res.body.error.code, STALE);
    assert.doesNotMatch(JSON.stringify(res.body), /INTERNAL_ERROR|private-owner-file|private-other-tenant|tenant-1|user-1|local_path|g2-seam-review-read-|[A-Za-z]:[\\/]/);
  });
}

test('real review handler returns a safe 500 for an unexpected database failure', async t => {
  const h = createFixture(t); h.db.exec('DROP TABLE async_tasks');
  const res = await requestReview(h);
  assert.equal(res.statusCode, 500); assert.equal(res.body.success, false); assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(res.body), /no such table|async_tasks|SELECT|tenant-1|user-1|g2-seam-review-read-|[A-Za-z]:[\\/]/);
});

test('the production router registers exactly the seam review GET after authentication and before tenant initialization', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/routes/index.js'), 'utf8');
  const registration = /r\.get\(\s*['"]\/redraw\/works\/:id\/source-audio-seam-review['"]\s*,/g;
  assert.equal([...source.matchAll(registration)].length, 1);
  const decisionPost = /r\.post\(\s*['"]\/redraw\/works\/:id\/source-audio-seam-review['"]\s*,\s*redraw\.recordSourceAudioSeamDecision\s*\)/g;
  assert.equal([...source.matchAll(decisionPost)].length, 1, 'the reviewed write is a separate exact POST');
  assert.doesNotMatch(source, /r\.(?:put|patch|delete)\(\s*['"]\/redraw\/works\/:id\/source-audio-seam-review['"]/);
  assert.match(extractGetRegistration(source, '/redraw/works/:id/source-audio-seam-review').code,
    /redraw\.getSourceAudioSeamReview\b/);
  const authentication = source.indexOf('r.use(requireUser);');
  const tenantInitializer = source.indexOf('r.use(createTenantContextMiddleware(');
  const review = source.indexOf('/redraw/works/:id/source-audio-seam-review');
  const decision = source.indexOf("r.post('/redraw/works/:id/source-audio-seam-review'");
  assert.ok(authentication >= 0 && tenantInitializer > authentication
    && review > authentication && review < tenantInitializer,
  'read-only review must be authenticated but must never enter the tenant-writing initializer');
  assert.ok(decision > tenantInitializer, 'the state-changing decision POST must use authenticated tenant context');
});

// Exercise only the real authentication/tenant middleware and the actual GET
// registration block, in their actual source order. This is not a full Express
// HTTP test: no listener and no broad setupRouter initialization are executed.
const SEAM_REVIEW_GET = '/redraw/works/:id/source-audio-seam-review';
const SYNTHETIC_AUTH_SECRET = 'G2.SEAM_READ synthetic local authentication secret only';

function extractGetRegistration(source, route) {
  const marker = `r.get('${route}',`;
  const offset = source.indexOf(marker);
  assert.ok(offset >= 0, `actual GET registration must exist: ${route}`);
  assert.equal(source.indexOf(marker, offset + marker.length), -1, 'registration must not be duplicated');
  const firstLineEnd = source.indexOf('\n', offset);
  const firstLine = source.slice(offset, firstLineEnd).trimEnd();
  if (firstLine.endsWith(');')) return { offset, code: firstLine };
  const close = source.indexOf('\n  });', firstLineEnd);
  assert.ok(close >= 0, 'multi-line GET registration must have its own closing statement');
  return { offset, code: source.slice(offset, close + '\n  });'.length) };
}

function createAuthenticatedFixture(t) {
  const h = createFixture(t, { free: true });
  userAuth.ensureSchema(h.db); tenantService.ensureSchema(h.db);
  h.db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, role, platform_role, status, token_version)
    VALUES ('user-1', 'seam-review-user@example.test', 'synthetic-unused-password-hash',
      'synthetic-unused-password-salt', 'user', 'user', 'active', 0)`).run();
  h.authToken = userAuth.issueToken({ id: 'user-1', email: 'seam-review-user@example.test', role: 'user' },
    SYNTHETIC_AUTH_SECRET, 0);
  return h;
}

function seedTenantMembership(h, tenantId, { memberUserId = 'user-1', memberStatus = 'active', tenantStatus = 'active' } = {}) {
  h.db.prepare(`INSERT INTO tenants (id, name, slug, status, created_by, created_at, updated_at)
    VALUES (?, 'Synthetic review tenant', ?, ?, ?, ?, ?)`)
    .run(tenantId, `seam-${Buffer.from(tenantId).toString('hex')}`, tenantStatus, memberUserId, NOW, NOW);
  h.db.prepare(`INSERT INTO tenant_members (tenant_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, 'owner', ?, ?, ?)`).run(tenantId, memberUserId, memberStatus, NOW, NOW);
}

function bindReviewToTenant(h, tenantId) {
  assert.equal(h.reservation, null, 'authentication fixtures use the original free analysis path');
  h.db.prepare('UPDATE redraw_projects SET tenant_id = ? WHERE id = 1').run(tenantId);
  h.db.prepare('UPDATE redraw_works SET tenant_id = ? WHERE id = 1').run(tenantId);
  h.db.prepare('UPDATE async_tasks SET tenant_id = ? WHERE id = ?').run(tenantId, TASK_ID);
  h.setMetadata(metadata => { metadata.tenant_id = tenantId; });
  h.candidate = resign({ ...h.candidate, tenant_id: tenantId }); h.setCandidate(h.candidate);
}

async function requestRegisteredGet(h, { route = SEAM_REVIEW_GET, tenantId, id = '1', authenticated = true } = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/routes/index.js'), 'utf8');
  const requireUser = createUserAuthMiddleware({ enabled: true, secret: SYNTHETIC_AUTH_SECRET, db: h.db });
  const authenticationCode = 'r.use(requireUser);';
  const tenantCode = 'r.use(createTenantContextMiddleware({ db, enabled: publicPlatformEnabled }));';
  const fragments = [
    { offset: source.indexOf(authenticationCode), code: authenticationCode },
    { offset: source.indexOf(tenantCode), code: tenantCode },
    extractGetRegistration(source, route),
  ].sort((left, right) => left.offset - right.offset);
  assert.ok(fragments.every(fragment => fragment.offset >= 0), 'execute the actual middleware mount statements');
  const layers = [];
  const context = { db: h.db, log, response, redraw: routeHandlers(h), requireUser,
    createTenantContextMiddleware, publicPlatformEnabled: true,
    r: {
      use(handler) { layers.push({ name: handler === requireUser ? 'requireUser' : 'tenantContext', handler }); },
      get(actualRoute, ...handlers) {
        assert.equal(actualRoute, route);
        for (const handler of handlers) layers.push({ name: 'GET', handler });
      },
    } };
  for (const fragment of fragments) vm.runInNewContext(fragment.code, context,
    { timeout: 1000, filename: 'actual-index-seam-review-registration.js' });
  const headers = { ...(authenticated ? { authorization: `Bearer ${h.authToken}` } : {}),
    ...(tenantId === undefined ? {} : { 'x-tenant-id': tenantId }) };
  const req = { params: { id }, query: {}, body: {}, get(name) { return headers[String(name).toLowerCase()]; } };
  const res = { statusCode: null, body: null, cookies: [], trace: [],
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; },
    cookie(name) { this.cookies.push(name); return this; } };
  checkpoint(h);
  async function dispatch(index) {
    if (index >= layers.length || res.body !== null) return;
    const layer = layers[index]; res.trace.push(layer.name);
    let following;
    const returned = layer.handler(req, res, error => {
      if (error) throw error;
      following = dispatch(index + 1); return following;
    });
    await returned;
    if (following) await following;
  }
  try {
    await dispatch(0);
    return { req, res };
  } catch (error) {
    if (route === SEAM_REVIEW_GET) assertReadOnly(h);
    throw error;
  }
}

const registeredTenantCases = [
  ['first authenticated user without any personal tenant', undefined, () => {}, 404],
  ['deleted personal membership', undefined, h => {
    seedTenantMembership(h, 'personal:user-1'); bindReviewToTenant(h, 'personal:user-1');
    h.db.prepare("DELETE FROM tenant_members WHERE tenant_id = 'personal:user-1' AND user_id = 'user-1'").run();
  }, 404],
  ['disabled personal membership', undefined, h => {
    seedTenantMembership(h, 'personal:user-1', { memberStatus: 'disabled' }); bindReviewToTenant(h, 'personal:user-1');
  }, 404],
  ['disabled personal tenant', undefined, h => {
    seedTenantMembership(h, 'personal:user-1', { tenantStatus: 'disabled' }); bindReviewToTenant(h, 'personal:user-1');
  }, 404],
  ['unauthorized requested tenant', 'foreign-team', h => {
    seedTenantMembership(h, 'foreign-team', { memberUserId: 'other-user' });
  }, 404],
  ['existing default personal tenant', undefined, h => {
    seedTenantMembership(h, 'personal:user-1'); bindReviewToTenant(h, 'personal:user-1');
  }, 200],
  ['existing team tenant with no personal tenant', ' tenant-1 ', h => { seedTenantMembership(h, 'tenant-1'); }, 200],
];
for (const [label, tenantId, prepare, statusCode] of registeredTenantCases) {
  test(`actual authentication, middleware order and GET block preserve zero database writes for ${label}`, async t => {
    const h = createAuthenticatedFixture(t); prepare(h);
    const { req, res } = await requestRegisteredGet(h, { tenantId });
    try {
      assert.equal(req.user.id, 'user-1', 'the real bearer middleware must authenticate against platform_users');
      assert.deepEqual(res.cookies, ['moli_media_session']);
      assert.equal(res.statusCode, statusCode);
      assert.deepEqual(res.trace, ['requireUser', 'GET'], 'this GET must terminate before tenant initialization');
      if (statusCode === 200) {
        assert.equal(res.body.success, true); assert.deepEqual(res.body.data, expectedDto(h));
      } else {
        assert.equal(res.body.success, false); assert.equal(res.body.error.code, NOT_FOUND);
        assert.doesNotMatch(JSON.stringify(res.body), /personal:user-1|foreign-team|tenant_members|SELECT|local_path/);
      }
    } finally { assertReadOnly(h); }
  });
}

test('actual registered seam GET keeps an authenticated invalid-id request read-only', async t => {
  const h = createAuthenticatedFixture(t); seedTenantMembership(h, 'tenant-1');
  const { res } = await requestRegisteredGet(h, { tenantId: 'tenant-1', id: '1junk' });
  try {
    assert.equal(res.statusCode, 400); assert.equal(res.body.error.code, INPUT);
    assert.deepEqual(res.trace, ['requireUser', 'GET']);
  } finally { assertReadOnly(h); }
});

test('actual registered seam GET still requires the real bearer authentication before tenant or work access', async t => {
  const h = createAuthenticatedFixture(t);
  const { req, res } = await requestRegisteredGet(h, { authenticated: false });
  try {
    assert.equal(req.user, undefined); assert.equal(res.statusCode, 401); assert.equal(res.body.error.code, 'UNAUTHORIZED');
    assert.deepEqual(res.trace, ['requireUser']);
  } finally { assertReadOnly(h); }
});

test('actual registered seam GET handles an unexpected tenant lookup error with a safe 500 and no schema repair', async t => {
  const h = createAuthenticatedFixture(t); h.db.exec('DROP TABLE tenant_members');
  const { res } = await requestRegisteredGet(h);
  try {
    assert.equal(res.statusCode, 500); assert.equal(res.body.success, false); assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    assert.deepEqual(res.trace, ['requireUser', 'GET']);
    assert.doesNotMatch(JSON.stringify(res.body), /no such table|tenant_members|SELECT|personal:user-1|local_path|[A-Za-z]:[\\/]/);
  } finally { assertReadOnly(h); }
});

test('the actual neighboring blueprint GET retains the original tenant initializer for a first authenticated user', async t => {
  const h = createAuthenticatedFixture(t);
  assert.equal(h.db.prepare("SELECT id FROM tenants WHERE id = 'personal:user-1'").get(), undefined);
  const { res } = await requestRegisteredGet(h, { route: '/redraw/works/:id/blueprint' });
  assert.deepEqual(res.trace, ['requireUser', 'tenantContext', 'GET']);
  assert.equal(res.statusCode, 404); assert.equal(res.body.error.code, 'REDRAW_BLUEPRINT_NOT_FOUND');
  assert.equal(totalChanges(h.db), h.changesBefore + 2, 'ordinary route must retain its original two tenant/member inserts');
  assert.deepEqual(h.db.prepare("SELECT id, status FROM tenants WHERE id = 'personal:user-1'").get(),
    { id: 'personal:user-1', status: 'active' });
  assert.deepEqual(h.db.prepare("SELECT tenant_id, user_id, role, status FROM tenant_members WHERE tenant_id = 'personal:user-1'").get(),
    { tenant_id: 'personal:user-1', user_id: 'user-1', role: 'owner', status: 'active' });
  const after = databaseSnapshot(h.db);
  for (const table of Object.keys(h.expectedDb)) {
    if (!['tenants', 'tenant_members'].includes(table)) assert.deepEqual(after[table], h.expectedDb[table], `${table} remains unchanged`);
  }
  assert.deepEqual(fileSnapshot(h.root), h.expectedFiles);
});
