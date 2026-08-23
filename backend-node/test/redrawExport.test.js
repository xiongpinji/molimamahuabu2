const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { calculateReleaseHash } = require('../src/services/redrawEpisodeReleaseService');
const {
  buildJianyingManifest,
  getDownloadDescriptor,
  resolveDownloadArtifact,
  validateJianyingImport,
} = require('../src/services/redrawExportService');

const NOW = '2026-08-07T00:00:00.000Z';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-export-'));
  const insertProject = db.prepare(`
    INSERT INTO redraw_projects (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '导出项目', ?, ?)
  `).run(NOW, NOW);
  const insertWork = db.prepare(`
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '导出作品', 1, 'source-hash', 15000, ?, ?)
  `).run(insertProject.lastInsertRowid, NOW, NOW);
  const insertVersion = db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, style_snapshot_json,
       status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 2, 'en-US', 'US',
      '{"stable_key":"redraw-live-action-style-001","version":1}',
      'ready_to_generate', ?, ?)
  `).run(insertWork.lastInsertRowid, NOW, NOW);
  return { db, root, versionId: Number(insertVersion.lastInsertRowid) };
}

function cleanup(state) {
  state.db.close();
  fs.rmSync(state.root, { recursive: true, force: true });
}

function writeAsset(state, { id, relative, type, mimeType, kind, body }) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const absolute = path.join(state.root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  state.db.prepare(`
    INSERT INTO assets
      (id, name, type, category, local_path, mime_type, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'redraw_composition', ?, ?, ?, ?, ?)
  `).run(
    id,
    path.basename(relative),
    type,
    relative.replace(/\\/g, '/'),
    mimeType,
    JSON.stringify({
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      version_id: state.versionId,
      export_id: 501,
      kind,
    }),
    NOW,
    NOW,
  );
  return { absolute, bytes, hash: sha256(bytes) };
}

function seedCompletedExport(state) {
  const mp4 = writeAsset(state, {
    id: 601,
    relative: 'redraw/version-1/exports/export-501/composition.mp4',
    type: 'video',
    mimeType: 'video/mp4',
    kind: 'composition_video',
    body: Buffer.from('real-mp4-bytes'),
  });
  const srt = writeAsset(state, {
    id: 602,
    relative: 'redraw/version-1/exports/export-501/composition.srt',
    type: 'subtitle',
    mimeType: 'application/x-subrip',
    kind: 'subtitle_srt',
    body: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHello\n'),
  });
  const vtt = writeAsset(state, {
    id: 603,
    relative: 'redraw/version-1/exports/export-501/composition.vtt',
    type: 'subtitle',
    mimeType: 'text/vtt',
    kind: 'subtitle_vtt',
    body: Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n'),
  });
  const episodeReleaseUnsigned = {
    schema_version: 'redraw-episode-release-v1',
    project_id: 1,
    work_id: 1,
    version_id: state.versionId,
    locale: 'en-US',
    market: 'US',
    shots: [
      {
        shot_id: 11, shot_index: 1, start_ms: 0, end_ms: 1000, candidate_review_id: 41,
        candidate_sha256: '1'.repeat(64), audio_sha256: '2'.repeat(64),
        subtitle_sha256: '3'.repeat(64), dependency_hash: '4'.repeat(64),
      },
      {
        shot_id: 12, shot_index: 2, start_ms: 1000, end_ms: 3000, candidate_review_id: 42,
        candidate_sha256: '5'.repeat(64), audio_sha256: '6'.repeat(64),
        subtitle_sha256: '7'.repeat(64), dependency_hash: '8'.repeat(64),
      },
    ],
    quality_summary: {
      decision: 'approved', approved_shot_count: 2, automatic_review_count: 2, human_review_count: 0,
    },
  };
  const episodeRelease = {
    ...episodeReleaseUnsigned,
    release_hash: calculateReleaseHash(episodeReleaseUnsigned),
  };
  const manifest = {
    episode_release: episodeRelease,
    inputs: {
      input_hash: 'input-hash',
      shot_ids: [11, 12],
      video_generation_ids: [21, 22],
      audio_asset_ids: [31, 32],
      timeline: [
        { shot_id: 11, start_ms: 0, end_ms: 1000, duration_ms: 1000 },
        { shot_id: 12, start_ms: 1000, end_ms: 3000, duration_ms: 2000 },
      ],
    },
    outputs: {
      mp4_asset_id: 601,
      srt_asset_id: 602,
      vtt_asset_id: 603,
      hash: mp4.hash,
      hashes: { mp4: mp4.hash, srt: srt.hash, vtt: vtt.hash },
    },
  };
  state.db.prepare(`
    INSERT INTO redraw_exports
      (id, version_id, tenant_id, user_id, export_type, asset_id, subtitle_asset_id,
       version_number, manifest_json, release_hash, quality_summary_json, status, created_at, updated_at)
    VALUES (501, ?, 'tenant-a', 'user-a', 'video', 601, 602,
      3, ?, ?, ?, 'completed', ?, ?)
  `).run(
    state.versionId,
    JSON.stringify(manifest),
    episodeRelease.release_hash,
    JSON.stringify(episodeRelease.quality_summary),
    NOW,
    NOW,
  );
  return { mp4, srt, vtt, manifest };
}

function context(state, overrides = {}) {
  return {
    db: state.db,
    tenantId: overrides.tenantId || 'tenant-a',
    userId: overrides.userId || 'user-a',
    storageRoot: state.root,
    episodeReleaseBuilder: overrides.episodeReleaseBuilder || (async () => (
      JSON.parse(state.db.prepare('SELECT manifest_json FROM redraw_exports WHERE id = 501').get().manifest_json).episode_release
    )),
  };
}

test('MP4/SRT/VTT 只返回受控相对下载 URL 和真实校验和', async (t) => {
  const state = setup();
  t.after(() => cleanup(state));
  seedCompletedExport(state);

  for (const [kind, mimeType] of [
    ['mp4', 'video/mp4'],
    ['srt', 'application/x-subrip'],
    ['vtt', 'text/vtt'],
  ]) {
    const result = await getDownloadDescriptor(context(state), { exportId: 501, kind });
    assert.equal(result.kind, kind);
    assert.equal(result.mime_type, mimeType);
    assert.match(result.download_url, /^\/api\/redraw\/exports\/501\/download\/(mp4|srt|vtt)$/);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(result).includes(state.root), false);
    assert.equal(Object.hasOwn(result, 'local_path'), false);
    assert.equal(Object.hasOwn(result, 'absolute_path'), false);
  }
});

test('下载解析要求完成态、精确归属、版本绑定和文件真实可读', async (t) => {
  const state = setup();
  t.after(() => cleanup(state));
  seedCompletedExport(state);

  const resolved = await resolveDownloadArtifact(context(state), { exportId: 501, kind: 'mp4' });
  assert.equal(resolved.asset_id, 601);
  assert.equal(resolved.absolute_path, path.join(state.root, 'redraw/version-1/exports/export-501/composition.mp4'));

  await assert.rejects(
    resolveDownloadArtifact(context(state, { userId: 'user-b' }), { exportId: 501, kind: 'mp4' }),
    (error) => error.code === 'REDRAW_EXPORT_NOT_FOUND',
  );
  state.db.prepare("UPDATE redraw_exports SET status = 'failed' WHERE id = 501").run();
  await assert.rejects(
    resolveDownloadArtifact(context(state), { exportId: 501, kind: 'mp4' }),
    (error) => error.code === 'REDRAW_EXPORT_NOT_READY',
  );
});

test('下载拒绝路径穿越和任一产物被替换后的哈希不一致', async (t) => {
  const state = setup();
  t.after(() => cleanup(state));
  const { mp4, srt, vtt } = seedCompletedExport(state);

  fs.writeFileSync(srt.absolute, 'tampered-srt');
  await assert.rejects(
    resolveDownloadArtifact(context(state), { exportId: 501, kind: 'srt' }),
    (error) => error.code === 'REDRAW_EXPORT_CHECKSUM_MISMATCH',
  );
  fs.writeFileSync(srt.absolute, srt.bytes);

  fs.writeFileSync(vtt.absolute, 'tampered-vtt');
  await assert.rejects(
    resolveDownloadArtifact(context(state), { exportId: 501, kind: 'vtt' }),
    (error) => error.code === 'REDRAW_EXPORT_CHECKSUM_MISMATCH',
  );
  fs.writeFileSync(vtt.absolute, vtt.bytes);

  fs.writeFileSync(mp4.absolute, 'tampered');
  await assert.rejects(
    resolveDownloadArtifact(context(state), { exportId: 501, kind: 'mp4' }),
    (error) => error.code === 'REDRAW_EXPORT_CHECKSUM_MISMATCH',
  );

  state.db.prepare("UPDATE assets SET local_path = '../../outside.mp4' WHERE id = 601").run();
  await assert.rejects(
    resolveDownloadArtifact(context(state), { exportId: 501, kind: 'mp4' }),
    (error) => error.code === 'REDRAW_EXPORT_PATH_INVALID',
  );
});

test('MP4 不得用旧 outputs.hash 掩盖缺失的统一 hashes 合同', async (t) => {
  const state = setup();
  t.after(() => cleanup(state));
  seedCompletedExport(state);
  const manifest = JSON.parse(state.db.prepare('SELECT manifest_json FROM redraw_exports WHERE id = 501').get().manifest_json);
  delete manifest.outputs.hashes.mp4;
  state.db.prepare('UPDATE redraw_exports SET manifest_json = ? WHERE id = 501').run(JSON.stringify(manifest));

  await assert.rejects(
    resolveDownloadArtifact(context(state), { exportId: 501, kind: 'mp4' }),
    (error) => error.code === 'REDRAW_EXPORT_CHECKSUM_MISMATCH',
  );
});

test('下载前重算当前 release 并拒绝嵌入、数据库或依赖哈希漂移', async (t) => {
  const state = setup();
  t.after(() => cleanup(state));
  const { manifest } = seedCompletedExport(state);

  state.db.prepare("UPDATE redraw_exports SET release_hash = ? WHERE id = 501").run('a'.repeat(64));
  await assert.rejects(resolveDownloadArtifact(context(state), { exportId: 501, kind: 'mp4' }), {
    code: 'REDRAW_EXPORT_RELEASE_HASH_MISMATCH',
  });
  state.db.prepare('UPDATE redraw_exports SET release_hash = ? WHERE id = 501').run(manifest.episode_release.release_hash);

  const tampered = structuredClone(manifest);
  tampered.episode_release.shots[0].dependency_hash = 'f'.repeat(64);
  state.db.prepare('UPDATE redraw_exports SET manifest_json = ? WHERE id = 501').run(JSON.stringify(tampered));
  await assert.rejects(resolveDownloadArtifact(context(state), { exportId: 501, kind: 'mp4' }), {
    code: 'REDRAW_EXPORT_RELEASE_HASH_MISMATCH',
  });
  state.db.prepare('UPDATE redraw_exports SET manifest_json = ? WHERE id = 501').run(JSON.stringify(manifest));

  const current = structuredClone(manifest.episode_release);
  current.shots[0].candidate_sha256 = 'e'.repeat(64);
  current.release_hash = calculateReleaseHash(current);
  await assert.rejects(resolveDownloadArtifact(context(state, {
    episodeReleaseBuilder: async () => current,
  }), { exportId: 501, kind: 'mp4' }), {
    code: 'REDRAW_EXPORT_RELEASE_HASH_MISMATCH',
  });
});

test('旧 completed export 无 release_hash 时不能下载', async (t) => {
  const state = setup();
  t.after(() => cleanup(state));
  seedCompletedExport(state);
  state.db.prepare("UPDATE redraw_exports SET release_hash = NULL, manifest_json = '{}' WHERE id = 501").run();
  await assert.rejects(resolveDownloadArtifact(context(state), { exportId: 501, kind: 'mp4' }), {
    code: 'REDRAW_EXPORT_MANIFEST_INVALID',
  });
});

test('下载拒绝 Windows junction 或符号链接转向存储根外文件', async (t) => {
  const state = setup();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-export-outside-'));
  t.after(() => {
    cleanup(state);
    fs.rmSync(external, { recursive: true, force: true });
  });
  seedCompletedExport(state);
  const outsideBytes = Buffer.from('outside-mp4');
  fs.writeFileSync(path.join(external, 'composition.mp4'), outsideBytes);
  const linkDir = path.join(state.root, 'redraw', 'linked-output');
  fs.mkdirSync(path.dirname(linkDir), { recursive: true });
  try {
    fs.symlinkSync(external, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return t.skip(`link creation unavailable: ${error.code}`);
    throw error;
  }
  state.db.prepare("UPDATE assets SET local_path = 'redraw/linked-output/composition.mp4' WHERE id = 601").run();
  const manifest = JSON.parse(state.db.prepare('SELECT manifest_json FROM redraw_exports WHERE id = 501').get().manifest_json);
  manifest.outputs.hash = sha256(outsideBytes);
  manifest.outputs.hashes.mp4 = sha256(outsideBytes);
  state.db.prepare('UPDATE redraw_exports SET manifest_json = ? WHERE id = 501').run(JSON.stringify(manifest));

  await assert.rejects(
    resolveDownloadArtifact(context(state), { exportId: 501, kind: 'mp4' }),
    (error) => error.code === 'REDRAW_EXPORT_PATH_INVALID',
  );
});

test('剪映 manifest 固定版本并保留镜头、配音、字幕、时间码和风格快照', () => {
  const manifest = buildJianyingManifest({
    version: { id: 7, version: 2, locale: 'en-US', market: 'US' },
    exportRecord: { id: 501, version_number: 3 },
    composition: {
      inputs: {
        input_hash: 'input-hash',
        timeline: [
          { shot_id: 11, start_ms: 0, end_ms: 1000, duration_ms: 1000 },
          { shot_id: 12, start_ms: 1000, end_ms: 3000, duration_ms: 2000 },
        ],
        video_generation_ids: [21, 22],
        audio_asset_ids: [31, 32],
      },
      outputs: { mp4_asset_id: 601, srt_asset_id: 602, vtt_asset_id: 603 },
    },
    styleSnapshot: { stable_key: 'redraw-live-action-style-001', version: 1 },
  });

  assert.equal(manifest.schema_version, 'redraw-jianying-1.0');
  assert.deepEqual(manifest.tracks.map((track) => track.type), ['video', 'audio', 'subtitle']);
  assert.deepEqual(manifest.timeline.map((clip) => clip.shot_id), [11, 12]);
  assert.deepEqual(manifest.locale, { language: 'en-US', market: 'US' });
  assert.deepEqual(manifest.style_snapshot, { stable_key: 'redraw-live-action-style-001', version: 1 });
  assert.equal(manifest.source.version_id, 7);
  assert.equal(manifest.source.export_id, 501);
  assert.equal(JSON.stringify(manifest).includes('absolute_path'), false);
});

test('剪映 manifest 清除各种本地路径和 URL 字段', () => {
  const manifest = buildJianyingManifest({
    version: { id: 7, version: 2, locale: 'en-US', market: 'US' },
    exportRecord: { id: 501, version_number: 3 },
    composition: {
      inputs: {
        input_hash: 'input-hash',
        timeline: [{ shot_id: 11, start_ms: 0, end_ms: 1000, duration_ms: 1000 }],
        video_generation_ids: [21],
        audio_asset_ids: [31],
      },
      outputs: { mp4_asset_id: 601, srt_asset_id: 602, vtt_asset_id: 603 },
    },
    styleSnapshot: {
      stable_key: 'redraw-live-action-style-001',
      absolutePath: 'C:/secret/source.mp4',
      localPath: 'D:/private/a.png',
      file_path: '/srv/private/file',
      storage_path: '/opt/storage/file',
      reference: { url: 'https://signed.invalid/private', source_path: '/secret/ref.png', asset_id: 9 },
      description: 'C:/secret/source.mp4',
      note: '/srv/private/file',
      reference_hint: 'file:///D:/private/ref.png',
      signed_reference: 'https://signed.invalid/private?token=secret',
    },
  });

  assert.deepEqual(manifest.style_snapshot, {
    stable_key: 'redraw-live-action-style-001',
    reference: { asset_id: 9 },
  });
});

test('剪映只有服务端可信验证记录证明实际导入打开且逐项核验后才能标记 verified', () => {
  const manifestHash = 'a'.repeat(64);
  assert.deepEqual(validateJianyingImport({
    manifestSha256: manifestHash,
    expectedDesktopVersion: '7.9.0',
  }), {
    status: 'unavailable',
    reason: 'desktop_import_not_verified',
  });
  assert.deepEqual(validateJianyingImport({
    manifestSha256: manifestHash,
    expectedDesktopVersion: '7.9.0',
    evidence: {
      run_id: 'forged-run',
      desktop_version: 'unknown',
      manifest_sha256: manifestHash,
      imported: true,
      opened: true,
      shot_order_ok: true,
      audio_ok: true,
      subtitles_ok: true,
      timecodes_ok: true,
    },
  }), {
    status: 'unavailable',
    reason: 'desktop_version_unknown',
  });
  assert.deepEqual(validateJianyingImport({
    manifestSha256: manifestHash,
    expectedDesktopVersion: '7.9.0',
    evidence: {
      run_id: 'forged-run',
      desktop_version: '7.9.0',
      manifest_sha256: manifestHash,
      imported: true,
      opened: true,
      shot_order_ok: true,
      audio_ok: true,
      subtitles_ok: true,
      timecodes_ok: true,
    },
  }), {
    status: 'unavailable',
    reason: 'untrusted_verification_evidence',
  });
  assert.deepEqual(validateJianyingImport({
    manifestSha256: manifestHash,
    expectedDesktopVersion: '7.9.0',
    evidence: {
      run_id: 'desktop-run-1',
      desktop_version: '7.9.0',
      manifest_sha256: manifestHash,
      imported: true,
      opened: true,
      shot_order_ok: true,
      audio_ok: true,
      subtitles_ok: true,
      timecodes_ok: true,
    },
    verifyEvidence: (record) => record.run_id === 'desktop-run-1',
  }), {
    status: 'verified',
    desktop_version: '7.9.0',
  });
});
