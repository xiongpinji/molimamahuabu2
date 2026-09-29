'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const voiceAutoBind = require('../src/services/redrawVoiceAutoBindService');

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function seedDrama(db, { autoBind = true } = {}) {
  const now = new Date().toISOString();
  const metadata = autoBind ? { redraw_import: { import_key: 'k' }, voice_auto_bind: true } : { project_type: 'factory' };
  const dramaId = Number(db.prepare(`INSERT INTO dramas (title, status, metadata, created_at, updated_at)
    VALUES ('转绘', 'draft', ?, ?, ?)`).run(JSON.stringify(metadata), now, now).lastInsertRowid);
  const episodeId = Number(db.prepare(`INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at)
    VALUES (?, 1, '第 1 集', ?, ?)`).run(dramaId, now, now).lastInsertRowid);
  const character = (name) => Number(db.prepare(`INSERT INTO characters (drama_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(dramaId, name, now, now).lastInsertRowid);
  const ids = { diego: character('Diego'), mateo: character('Mateo'), mama: character('Mamá') };
  const storyboard = (number, characters, dialogue) => Number(db.prepare(`INSERT INTO storyboards
    (episode_id, storyboard_number, title, dialogue, characters, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`).run(episodeId, number, `镜头 ${number}`, dialogue, JSON.stringify(characters), now, now).lastInsertRowid);
  const sb = {
    mixed: storyboard(1, [ids.diego, ids.mateo], 'Diego：Oye, güey.\nMateo：¿Qué quieres?'),
    unlabeled: storyboard(2, [ids.diego], '¿Tú quién eres?'),
    diegoSolo: storyboard(3, [ids.diego, ids.mateo], 'Diego：Ya me voy.\nDiego：Nos vemos.'),
    mamaOffscreen: storyboard(4, [ids.mateo], 'Mamá：Lávate las manos.'),
    mateoSolo: storyboard(5, [ids.mateo], 'Mateo：Gracias, mamá.'),
    mateoLater: storyboard(6, [ids.mateo], 'Mateo：El Mundial es mi capital.'),
  };
  const video = (storyboardId) => Number(db.prepare(`INSERT INTO video_generations
    (storyboard_id, drama_id, provider, prompt, status, completed_at, created_at, updated_at)
    VALUES (?, ?, 'km', 'p', 'completed', ?, ?, ?)`).run(storyboardId, dramaId, now, now, now).lastInsertRowid);
  const videos = Object.fromEntries(Object.entries(sb).map(([key, id]) => [key, video(id)]));
  return { dramaId, ids, sb, videos };
}

function fakeExtract(db, calls, { failVideos = new Set() } = {}) {
  return async ({ storyboardId, videoId, characterId }) => {
    calls.push({ storyboardId, videoId, characterId });
    if (failVideos.has(videoId)) return { ok: false, code: 'NO_SPEECH_SEGMENT', error: 'x' };
    const asset = { status: 'active', url: `/static/voice/${characterId}.mp3`, source: 'storyboard_video' };
    db.prepare('UPDATE characters SET seedance2_voice_asset = ? WHERE id = ?').run(JSON.stringify(asset), characterId);
    return { ok: true, asset };
  };
}

test('the first shot where a character speaks alone is used for his voice; mixed, unlabeled and off-screen lines are skipped', async () => {
  const db = createDb();
  try {
    const { dramaId, ids, sb, videos } = seedDrama(db);
    const candidates = voiceAutoBind.findCandidates(db, dramaId);
    assert.deepEqual(
      candidates.map((c) => [c.name, c.shots.map((s) => s.storyboardId)]),
      [['Diego', [sb.diegoSolo]], ['Mateo', [sb.mateoSolo, sb.mateoLater]]],
      'Mamá speaks off-screen in shot 4, so she has no candidate',
    );
    const calls = [];
    const results = await voiceAutoBind.runOnce(db, null, { extract: fakeExtract(db, calls) });
    assert.deepEqual(calls.map((c) => [c.characterId, c.videoId]), [[ids.diego, videos.diegoSolo], [ids.mateo, videos.mateoSolo]]);
    assert.ok(results.every((r) => r.ok));
    const snapshot = JSON.parse(db.prepare('SELECT voice_snapshot FROM storyboards WHERE id = ?').get(sb.mateoLater).voice_snapshot);
    assert.deepEqual(snapshot.characters.map((c) => [c.id, c.url]), [[ids.mateo, `/static/voice/${ids.mateo}.mp3`]],
      'later shots of the character carry the bound voice');

    const again = [];
    await voiceAutoBind.runOnce(db, null, { extract: fakeExtract(db, again) });
    assert.deepEqual(again, [], 'characters that already have a voice are left alone');
  } finally {
    db.close();
  }
});

test('a failed extraction moves on to the character\'s next solo shot and is not retried on the same video', async () => {
  const db = createDb();
  try {
    const { ids, videos } = seedDrama(db);
    const attempted = new Set();
    const calls = [];
    const extract = fakeExtract(db, calls, { failVideos: new Set([videos.mateoSolo]) });
    const first = await voiceAutoBind.runOnce(db, null, { attempted, extract });
    assert.deepEqual(first.filter((r) => !r.ok).map((r) => r.code), ['NO_SPEECH_SEGMENT']);
    await voiceAutoBind.runOnce(db, null, { attempted, extract });
    assert.deepEqual(calls.filter((c) => c.characterId === ids.mateo).map((c) => c.videoId), [videos.mateoSolo, videos.mateoLater]);
  } finally {
    db.close();
  }
});

test('factory projects that are not redraw imports are never touched', async () => {
  const db = createDb();
  try {
    seedDrama(db, { autoBind: false });
    const calls = [];
    const results = await voiceAutoBind.runOnce(db, null, { extract: fakeExtract(db, calls) });
    assert.deepEqual([results, calls], [[], []]);
  } finally {
    db.close();
  }
});

test('the scheduler starts once, can be switched off with interval 0 and stops cleanly', () => {
  assert.equal(voiceAutoBind.startRedrawVoiceAutoBind({}, null, { intervalMs: 0 }), false);
  assert.equal(voiceAutoBind.startRedrawVoiceAutoBind({}, null, { intervalMs: 60_000 }), true);
  assert.equal(voiceAutoBind.startRedrawVoiceAutoBind({}, null, { intervalMs: 60_000 }), false);
  assert.equal(voiceAutoBind.stopRedrawVoiceAutoBind(), true);
  assert.equal(voiceAutoBind.stopRedrawVoiceAutoBind(), false);
});
