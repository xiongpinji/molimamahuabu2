const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function registerSourceDialogueEvidence(t, db, blueprint, { crossShot = false } = {}) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-source-dialogue-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const sourceSha = hash('localization-source-video');
  const segments = [];
  blueprint.shots.forEach((shot, index) => {
    shot.start_ms ??= index * 6500;
    shot.end_ms ??= (index + 1) * 6500;
    for (const turn of shot.dialogue || []) {
      turn.source_language = 'zh';
      turn.evidence_refs = ['audio-source'];
      segments.push({ id: turn.id, start_ms: turn.start_ms, end_ms: turn.end_ms,
        source_text: turn.source_text, speaker_cluster_id: 'speaker-cluster-1' });
    }
  });
  if (crossShot) {
    const first = blueprint.shots.find((shot) => shot.dialogue?.length);
    first.start_ms = first.dialogue[0].end_ms - 500;
    first.dialogue[0].start_ms = first.start_ms;
  }
  const duration = Math.max(...blueprint.shots.map((shot) => shot.end_ms));
  blueprint.source = { asset_id: 91, sha256: sourceSha, duration_ms: duration };
  db.prepare('UPDATE redraw_works SET source_asset_id = 91, source_fingerprint = ?, duration_ms = ? WHERE id = 1')
    .run(sourceSha, duration);
  db.exec(`CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY, type TEXT, category TEXT, local_path TEXT, metadata TEXT, deleted_at TEXT
  )`);
  const evidence = {
    schema_version: 'redraw-source-audio-evidence-v1', task_id: 'localization-original-audio',
    work_id: 1, tenant_id: 'tenant-a', user_id: 'user-a', source_asset_id: 91,
    source_video_sha256: sourceSha, audio_sha256: hash('audio'), transcript_sha256: hash('transcript'),
    source_language: 'zh', language_probability: 0.98, dialogue_mode: 'spoken',
    created_at: '2026-09-05T00:00:00.000Z', segments,
  };
  const evidencePath = path.join(storageRoot, 'evidence.json');
  const bytes = JSON.stringify(evidence);
  fs.writeFileSync(evidencePath, bytes);
  const evidenceSha = hash(bytes);
  const metadata = { ...evidence, evidence_sha256: evidenceSha };
  delete metadata.segments;
  db.prepare(`INSERT INTO assets (id, type, category, local_path, metadata)
    VALUES (92, 'json', 'redraw_source_audio_evidence', 'evidence.json', ?)`)
    .run(JSON.stringify(metadata));
  blueprint.evidence_manifest = { items: [{ id: 'audio-source', kind: 'audio_transcript', asset_id: 92,
    sha256: evidenceSha }] };
  db.prepare('UPDATE redraw_episode_blueprints SET blueprint_json = ? WHERE work_id = 1')
    .run(JSON.stringify(blueprint));
  return { storageRoot, evidencePath, evidence, evidenceSha };
}

module.exports = { registerSourceDialogueEvidence };
