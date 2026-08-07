const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const redrawRoutes = require('../src/routes/redraw');
const { setupRouter } = require('../src/routes');

const NOW = '2026-08-07T00:00:00.000Z';

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function captureResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    sentFile: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    write(chunk) {
      this.written = Buffer.concat([this.written || Buffer.alloc(0), Buffer.from(chunk)]);
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.ended = true;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return false;
    },
    sendFile(filePath, callback) {
      this.sentFile = filePath;
      this.headersSent = true;
      if (callback) callback();
      return this;
    },
    destroy(error) {
      this.destroyed = true;
      this.destroyError = error;
    },
  };
}

function request({ id, tenantId = 'tenant-a', userId = 'user-a', body = {}, kind } = {}) {
  return {
    params: {
      ...(id !== undefined ? { id: String(id) } : {}),
      ...(kind !== undefined ? { kind: String(kind) } : {}),
    },
    tenant: { id: tenantId },
    user: { id: userId },
    body,
  };
}

function insertProject(db, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, default_locale, default_market, localization_level, status, created_at, updated_at, deleted_at)
    VALUES
      (@tenant_id, @user_id, @title, @default_locale, @default_market, @localization_level, @status, @created_at, @updated_at, @deleted_at)
  `).run({
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    title: '转绘项目',
    default_locale: 'en-US',
    default_market: 'US',
    localization_level: 'faithful',
    status: 'draft',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...values,
  }).lastInsertRowid;
}

function insertWork(db, projectId, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
       current_version, current_step, status, created_at, updated_at, deleted_at)
    VALUES
      (@project_id, @tenant_id, @user_id, @title, @source_asset_id, @source_fingerprint, @duration_ms,
       @current_version, @current_step, @status, @created_at, @updated_at, @deleted_at)
  `).run({
    project_id: projectId,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    title: '源片',
    source_asset_id: 101,
    source_fingerprint: 'f'.repeat(64),
    duration_ms: 15000,
    current_version: 1,
    current_step: 4,
    status: 'ready_to_generate',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...values,
  }).lastInsertRowid;
}

function insertVersion(db, workId, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       style_snapshot_json, status, created_at, updated_at, deleted_at)
    VALUES
      (@work_id, @tenant_id, @user_id, @version, @locale, @market, @localization_level,
       @style_snapshot_json, @status, @created_at, @updated_at, @deleted_at)
  `).run({
    work_id: workId,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    version: 1,
    locale: 'en-US',
    market: 'US',
    localization_level: 'faithful',
    style_snapshot_json: '{}',
    status: 'ready_to_generate',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...values,
  }).lastInsertRowid;
}

function insertExport(db, versionId, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_exports
      (version_id, tenant_id, user_id, export_type, asset_id, subtitle_asset_id,
       version_number, manifest_json, status, error_code, error_message, created_at, updated_at, deleted_at)
    VALUES
      (@version_id, @tenant_id, @user_id, @export_type, @asset_id, @subtitle_asset_id,
       @version_number, @manifest_json, @status, @error_code, @error_message, @created_at, @updated_at, @deleted_at)
  `).run({
    version_id: versionId,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    export_type: 'video',
    asset_id: 701,
    subtitle_asset_id: 702,
    version_number: 1,
    manifest_json: JSON.stringify({
      idempotency_key: 'idem-export',
      request_hash: 'hash-export',
      audio_mode: 'replace',
      plan: {
        input_hash: 'input-hash',
        timeline: [{ shot_id: 1, start_ms: 0, end_ms: 1000, local_path: 'secret.mp4' }],
        video_generation_ids: [501],
        audio_asset_ids: [601],
        video_inputs: [{ absolute_path: 'C:/secret/source.mp4' }],
      },
      outputs: {
        mp4_path: 'redraw/version-1/export-1/composition.mp4',
        mp4_asset_id: 701,
        srt_asset_id: 702,
        vtt_asset_id: 703,
        hashes: { mp4: 'a'.repeat(64), srt: 'b'.repeat(64), vtt: 'c'.repeat(64) },
        probe: { width: 320, height: 180, duration_ms: 1000, absolute_path: 'C:/secret/out.mp4' },
      },
    }),
    status: 'completed',
    error_code: null,
    error_message: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...values,
  }).lastInsertRowid;
}

function fixture(db) {
  const projectId = insertProject(db);
  const workId = insertWork(db, projectId);
  const versionId = insertVersion(db, workId);
  return { projectId, workId, versionId };
}

test('compose route schedules only newly-created owner-scoped export', async () => {
  const db = createDb();
  try {
    const { versionId } = fixture(db);
    let createCalls = 0;
    let scheduled = 0;
    const compositionService = {
      createComposition: async () => {
        createCalls += 1;
        return {
          id: 900,
          version_id: versionId,
          version_number: 2,
          status: 'pending',
          created: createCalls === 1,
        };
      },
      runComposition: async (_ctx, exportId) => {
        assert.equal(typeof exportId, 'number');
      },
    };
    const handlers = redrawRoutes(db, { error() {} }, {
      cfg: { storage: { local_path: path.join(process.cwd(), 'data', 'storage') } },
      compositionService,
      compositionSchedule: (job) => {
        scheduled += 1;
        assert.equal(typeof job, 'function');
        return job();
      },
    });

    const first = captureResponse();
    await handlers.composeVersion(request({
      id: versionId,
      body: { idempotency_key: 'idem-compose', audio_mode: 'replace' },
    }), first);
    assert.equal(first.statusCode, 202);
    assert.equal(first.body.data.export_id, 900);
    assert.equal(first.body.data.created, true);
    assert.equal(scheduled, 1);

    const second = captureResponse();
    await handlers.composeVersion(request({
      id: versionId,
      body: { idempotency_key: 'idem-compose', audio_mode: 'replace' },
    }), second);
    assert.equal(second.statusCode, 202);
    assert.equal(second.body.data.created, false);
    assert.equal(scheduled, 1);

    const attacker = captureResponse();
    await handlers.composeVersion(request({
      id: versionId,
      tenantId: 'tenant-b',
      body: { idempotency_key: 'idem-compose', audio_mode: 'replace' },
    }), attacker);
    assert.equal(attacker.statusCode, 404);

    const bad = captureResponse();
    await handlers.composeVersion(request({
      id: versionId,
      body: { idempotency_key: 'idem-compose', audio_mode: 'mix' },
    }), bad);
    assert.equal(bad.statusCode, 400);
  } finally {
    db.close();
  }
});

test('compose route marks created export failed if injected scheduler throws synchronously', async () => {
  const db = createDb();
  try {
    const { versionId } = fixture(db);
    const exportId = insertExport(db, versionId, {
      asset_id: null,
      subtitle_asset_id: null,
      status: 'pending',
      manifest_json: JSON.stringify({ idempotency_key: 'idem-schedule', request_hash: 'hash', audio_mode: 'replace' }),
    });
    const handlers = redrawRoutes(db, { error() {} }, {
      compositionService: {
        createComposition: async () => ({
          id: exportId,
          version_id: versionId,
          version_number: 1,
          status: 'pending',
          created: true,
        }),
        runComposition: async () => {},
      },
      compositionSchedule: () => {
        throw new Error('scheduler unavailable');
      },
    });

    const res = captureResponse();
    await handlers.composeVersion(request({
      id: versionId,
      body: { idempotency_key: 'idem-schedule', audio_mode: 'replace' },
    }), res);

    assert.equal(res.statusCode, 500);
    const row = db.prepare('SELECT status, error_code, error_message FROM redraw_exports WHERE id = ?').get(exportId);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_code, 'REDRAW_COMPOSITION_SCHEDULE_FAILED');
    assert.equal(row.error_message, 'composition scheduler failed');
  } finally {
    db.close();
  }
});

test('compose route catches rejected scheduler promise and marks created export failed without unhandled rejection', async () => {
  const db = createDb();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { versionId } = fixture(db);
    const exportId = insertExport(db, versionId, {
      asset_id: null,
      subtitle_asset_id: null,
      status: 'pending',
      manifest_json: JSON.stringify({ idempotency_key: 'idem-rejected-schedule', request_hash: 'hash', audio_mode: 'replace' }),
    });
    const handlers = redrawRoutes(db, { error() {} }, {
      compositionService: {
        createComposition: async () => ({
          id: exportId,
          version_id: versionId,
          version_number: 1,
          status: 'pending',
          created: true,
        }),
        runComposition: async () => {},
      },
      compositionSchedule: () => Promise.reject(new Error('C:\\private\\scheduler.log')),
    });

    const res = captureResponse();
    await handlers.composeVersion(request({
      id: versionId,
      body: { idempotency_key: 'idem-rejected-schedule', audio_mode: 'replace' },
    }), res);
    assert.equal(res.statusCode, 202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const row = db.prepare('SELECT status, error_code, error_message FROM redraw_exports WHERE id = ?').get(exportId);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_code, 'REDRAW_COMPOSITION_SCHEDULE_FAILED');
    assert.equal(row.error_message, 'composition scheduler failed');
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    db.close();
  }
});

test('export list/detail routes are owner-scoped and strip manifest paths', () => {
  const db = createDb();
  try {
    const { versionId } = fixture(db);
    const exportId = insertExport(db, versionId);
    insertExport(db, versionId, {
      tenant_id: 'tenant-b',
      user_id: 'user-a',
      version_number: 99,
      asset_id: 801,
      subtitle_asset_id: 802,
    });
    const handlers = redrawRoutes(db, { error() {} }, {});

    const list = captureResponse();
    handlers.listVersionExports(request({ id: versionId }), list);
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].id, exportId);
    assert.equal(list.body.data[0].timeline[0].local_path, undefined);
    assert.equal(list.body.data[0].probe.absolute_path, undefined);
    assert.equal(JSON.stringify(list.body.data), JSON.stringify(list.body.data).replace(/C:\\/g, ''));
    assert.equal(JSON.stringify(list.body.data).includes('manifest_json'), false);
    assert.equal(JSON.stringify(list.body.data).includes('mp4_path'), false);

    const detail = captureResponse();
    handlers.getExport(request({ id: exportId }), detail);
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.body.data.output_asset_ids, { mp4: 701, srt: 702, vtt: 703 });

    const crossTenant = captureResponse();
    handlers.getExport(request({ id: exportId, tenantId: 'tenant-b' }), crossTenant);
    assert.equal(crossTenant.statusCode, 404);

    const crossTenantList = captureResponse();
    handlers.listVersionExports(request({ id: versionId, tenantId: 'tenant-b' }), crossTenantList);
    assert.equal(crossTenantList.statusCode, 404);
  } finally {
    db.close();
  }
});

test('export list/detail returns generic safe error messages for embedded Windows Linux and URL paths', () => {
  const db = createDb();
  try {
    const { versionId } = fixture(db);
    const exportIds = [
      insertExport(db, versionId, { status: 'failed', error_code: 'E_WIN', error_message: 'failed at C:\\private\\clip.mp4' }),
      insertExport(db, versionId, { status: 'failed', error_code: 'E_LINUX', error_message: 'failed at /srv/private/clip.mp4' }),
      insertExport(db, versionId, { status: 'failed', error_code: 'E_URL', error_message: 'failed at https://example.com/secret.mp4' }),
    ];
    const handlers = redrawRoutes(db, { error() {} }, {});

    const list = captureResponse();
    handlers.listVersionExports(request({ id: versionId }), list);
    assert.equal(list.statusCode, 200);
    const text = JSON.stringify(list.body);
    assert.equal(text.includes('C:\\private'), false);
    assert.equal(text.includes('/srv/private'), false);
    assert.equal(text.includes('https://example.com'), false);
    for (const item of list.body.data) {
      if (exportIds.includes(item.id)) {
        assert.match(item.error_code, /^E_/);
        assert.equal(item.error_message, 'export failed');
      }
    }

    const detail = captureResponse();
    handlers.getExport(request({ id: exportIds[0] }), detail);
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.data.error_code, 'E_WIN');
    assert.equal(detail.body.data.error_message, 'export failed');
  } finally {
    db.close();
  }
});

test('download route uses controlled artifact descriptor and maps unsafe states without leaking paths', async () => {
  const db = createDb();
  try {
    fixture(db);
    const descriptor = {
      export_id: 5,
      version_id: 1,
      asset_id: 701,
      kind: 'mp4',
      mime_type: 'video/mp4',
      filename: 'redraw-export-5.mp4',
      absolute_path: 'C:\\private\\redraw-export-5.mp4',
      sha256: 'd'.repeat(64),
      size: 123,
    };
    const handlers = redrawRoutes(db, { error() {} }, {
      exportService: {
        resolveDownloadArtifact: async (_ctx, input) => {
          if (input.exportId === '404') {
            const error = new Error('C:\\private\\missing.mp4');
            error.code = 'REDRAW_EXPORT_NOT_FOUND';
            throw error;
          }
          if (input.exportId === '409') {
            const error = new Error('C:\\private\\pending.mp4');
            error.code = 'REDRAW_EXPORT_NOT_READY';
            throw error;
          }
          if (input.exportId === '422') {
            const error = new Error('C:\\private\\tampered.mp4');
            error.code = 'REDRAW_EXPORT_CHECKSUM_MISMATCH';
            throw error;
          }
          return descriptor;
        },
      },
    });

    const ok = captureResponse();
    await handlers.downloadExport(request({ id: 5, kind: 'mp4' }), ok);
    assert.equal(ok.headers['Content-Type'], 'video/mp4');
    assert.equal(ok.headers['Content-Length'], '123');
    assert.equal(ok.headers['X-Content-SHA256'], 'd'.repeat(64));
    assert.match(ok.headers['Content-Disposition'], /redraw-export-5\.mp4/);
    assert.equal(ok.sentFile, descriptor.absolute_path);

    for (const [id, expectedStatus] of [['404', 404], ['409', 409], ['422', 422]]) {
      const res = captureResponse();
      await handlers.downloadExport(request({ id, kind: 'mp4' }), res);
      assert.equal(res.statusCode, expectedStatus);
      assert.equal(JSON.stringify(res.body).includes('C:\\private'), false);
    }
  } finally {
    db.close();
  }
});

test('download stream fallback maps pre-header file race to safe error body', async () => {
  const db = createDb();
  const originalCreateReadStream = fs.createReadStream;
  try {
    fixture(db);
    const stream = new PassThrough();
    fs.createReadStream = () => stream;
    const handlers = redrawRoutes(db, { error() {} }, {
      exportService: {
        resolveDownloadArtifact: async () => ({
          export_id: 6,
          version_id: 1,
          asset_id: 701,
          kind: 'mp4',
          mime_type: 'video/mp4',
          filename: 'redraw-export-6.mp4',
          absolute_path: 'C:\\private\\raced.mp4',
          sha256: 'e'.repeat(64),
          size: 456,
        }),
      },
    });

    const res = captureResponse();
    delete res.sendFile;
    const done = handlers.downloadExport(request({ id: 6, kind: 'mp4' }), res);
    await Promise.resolve();
    stream.emit('error', new Error('C:\\private\\raced.mp4 disappeared'));
    await done;

    assert.equal(res.statusCode, 500);
    assert.equal(JSON.stringify(res.body).includes('C:\\private'), false);
    assert.equal(res.headers['Content-Type'], undefined);
  } finally {
    fs.createReadStream = originalCreateReadStream;
    db.close();
  }
});

test('download stream fallback safely destroys response on post-header stream error', async () => {
  const db = createDb();
  const originalCreateReadStream = fs.createReadStream;
  try {
    fixture(db);
    const stream = new PassThrough();
    fs.createReadStream = () => stream;
    const handlers = redrawRoutes(db, { error() {} }, {
      exportService: {
        resolveDownloadArtifact: async () => ({
          export_id: 7,
          version_id: 1,
          asset_id: 701,
          kind: 'mp4',
          mime_type: 'video/mp4',
          filename: 'redraw-export-7.mp4',
          absolute_path: 'C:\\private\\late.mp4',
          sha256: 'f'.repeat(64),
          size: 789,
        }),
      },
    });

    const res = captureResponse();
    delete res.sendFile;
    const done = handlers.downloadExport(request({ id: 7, kind: 'mp4' }), res);
    await Promise.resolve();
    stream.emit('open', 1);
    await done;
    assert.equal(res.headers['Content-Type'], 'video/mp4');

    stream.emit('error', new Error('C:\\private\\late.mp4 read failed'));
    assert.equal(res.destroyed, true);
    assert.equal(JSON.stringify(res.body || {}).includes('C:\\private'), false);
  } finally {
    fs.createReadStream = originalCreateReadStream;
    db.close();
  }
});

test('composition export routes are registered on setupRouter', () => {
  const db = createDb();
  try {
    const router = setupRouter({}, db, { error() {}, warn() {}, info() {} }, {
      localizationProvider: async () => ({}),
      assetGenerationProvider: async () => ({}),
      dialogueProvider: async () => ({}),
    });
    const routes = new Set(router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods)
        .map((method) => `${method.toUpperCase()} ${layer.route.path}`)));
    assert.equal(routes.has('POST /redraw/versions/:id/compose'), true);
    assert.equal(routes.has('GET /redraw/versions/:id/exports'), true);
    assert.equal(routes.has('GET /redraw/exports/:id'), true);
    assert.equal(routes.has('GET /redraw/exports/:id/download/:kind'), true);
  } finally {
    db.close();
  }
});
