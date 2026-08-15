const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  MANIFEST_FILENAME,
  EXPECTED_SHOT_IDS,
  parseArgs,
  probeMedia,
  runLocalPreparation,
  validateCaseManifest,
} = require('../scripts/run-redraw-full-episode-reference-local');
const {
  getFfmpegPath,
  hasLocalFfmpeg,
  hasLocalFfprobe,
} = require('../src/utils/ffmpegPath');

const SCRIPT_PATH = path.resolve(__dirname, '../scripts/run-redraw-full-episode-reference-local.js');
const TIMELINE = [0, 8000, 16000, 24000, 32000, 40000, 48000, 56000, 64000, 68733];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validCase(source = {}) {
  return {
    case_id: 'full-episode-local-test',
    reference_bundle_required: true,
    target: { language: 'en', locale: 'en-US', market: 'US' },
    source: {
      sha256: source.sha256 || 'a'.repeat(64),
      duration_ms: source.duration_ms || 68733,
      duration_tolerance_ms: source.duration_tolerance_ms ?? 80,
      video: source.video || { width: 64, height: 64, codec: 'h264', frame_rate: 10 },
      audio: source.audio || { codec: 'aac', channels: 1, sample_rate: 44100 },
    },
    shots: EXPECTED_SHOT_IDS.map((id, index) => {
      const silent = id === 'shot-3' || id === 'shot-8';
      return {
        id,
        start_ms: TIMELINE[index],
        end_ms: TIMELINE[index + 1],
        face_tracks: [{
          character_id: 'mateo',
          time_ranges: [[TIMELINE[index], TIMELINE[index + 1]]],
        }],
        face_track_review: {
          status: 'pending',
          unresolved_reason: 'full frame-by-frame review is not complete',
        },
        identity_packs: [{
          character_id: 'mateo',
          status: 'approved',
          sha256: 'b'.repeat(64),
        }],
        text_regions: silent ? [] : [{
          region_key: `${id}-subtitle-1`,
          kind: 'text_subtitle',
          time_ranges: [[TIMELINE[index], TIMELINE[index + 1]]],
          clean_plate_status: 'pending',
          clean_plate_sha256: null,
        }],
        text_region_review: {
          status: 'pending',
          unresolved_reason: 'full text-region review is not complete',
        },
        motion_reference: {
          review_status: 'pending',
          evidence_sha256: null,
        },
        dialogue: silent ? {
          kind: 'silent',
          target_locale: 'en-US',
          turns: [],
        } : {
          kind: 'spoken',
          target_locale: 'en-US',
          turns: [{
            speaker_id: 'mateo',
            text: `English line for ${id}.`,
            start_ms: TIMELINE[index],
            end_ms: TIMELINE[index + 1],
          }],
        },
      };
    }),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRealSource(directory) {
  const sourcePath = path.join(directory, 'source.mp4');
  const result = spawnSync(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=68.733',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=68.733',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '1', '-shortest', sourcePath,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  return sourcePath;
}

test('CLI 只接受固定参数并支持 help', () => {
  assert.deepEqual(parseArgs(['--source', 'a.mp4', '--case-manifest', 'case.json', '--output-dir', 'out']), {
    source: path.resolve('a.mp4'),
    caseManifest: path.resolve('case.json'),
    outputDir: path.resolve('out'),
    help: false,
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--unknown']), (error) => error.code === 'REDRAW_FULL_EPISODE_CLI_INVALID');
  assert.throws(
    () => parseArgs(['--source', 'a.mp4', '--case-manifest', 'case.json']),
    (error) => error.code === 'REDRAW_FULL_EPISODE_CLI_INVALID',
  );
});

test('case manifest 锁定 en-US/US、required=true、九镜顺序和 0..68733 连续时间轴', () => {
  const normalized = validateCaseManifest(validCase());
  assert.deepEqual(normalized.shots.map((shot) => shot.id), EXPECTED_SHOT_IDS);

  const invalidCases = [
    ['required false', (value) => { value.reference_bundle_required = false; }],
    ['wrong locale', (value) => { value.target.locale = 'zh-CN'; }],
    ['missing shot', (value) => { value.shots.pop(); }],
    ['duplicate shot', (value) => { value.shots[8].id = 'shot-8'; }],
    ['extra shot', (value) => { value.shots.push(clone(value.shots[8])); value.shots[9].id = 'shot-10'; }],
    ['gap', (value) => { value.shots[1].start_ms += 1; }],
    ['overlap', (value) => { value.shots[1].start_ms -= 1; }],
    ['wrong end', (value) => { value.shots[8].end_ms = 68732; }],
  ];
  for (const [name, mutate] of invalidCases) {
    const value = validCase();
    mutate(value);
    assert.throws(
      () => validateCaseManifest(value),
      (error) => error.code === 'REDRAW_FULL_EPISODE_CASE_INVALID',
      name,
    );
  }
});

test('case manifest 拒绝绝对路径、穿越引用、公网 URL、凭据字段和未知字段', () => {
  const invalidCases = [
    ['absolute', (value) => { value.shots[0].note = 'C:\\secret\\source.mp4'; }],
    ['traversal', (value) => { value.shots[0].note = '../secret/source.mp4'; }],
    ['url', (value) => { value.url = 'https://example.com/reference.mp4'; }],
    ['key', (value) => { value.api_key = 'sk-local-only'; }],
    ['auth', (value) => { value.authorization = 'Bearer secret'; }],
    ['unknown', (value) => { value.provider = 'some-provider'; }],
  ];
  for (const [name, mutate] of invalidCases) {
    const value = validCase();
    mutate(value);
    assert.throws(
      () => validateCaseManifest(value),
      (error) => error.code === 'REDRAW_FULL_EPISODE_CASE_INVALID',
      name,
    );
  }
});

test('pending review 与静默镜头形成稳定 blockers，绝不构造供应商请求', async (t) => {
  if (!hasLocalFfmpeg() || !hasLocalFfprobe()) return t.skip('ffmpeg/ffprobe unavailable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-episode-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = makeRealSource(root);
  const sourceProbe = await probeMedia(sourcePath);
  const source = {
    sha256: sha256File(sourcePath),
    duration_ms: 68733,
    duration_tolerance_ms: 100,
    video: {
      width: sourceProbe.video.width,
      height: sourceProbe.video.height,
      codec: sourceProbe.video.codec,
      frame_rate: sourceProbe.video.frame_rate,
    },
    audio: {
      codec: sourceProbe.audio.codec,
      channels: sourceProbe.audio.channels,
      sample_rate: sourceProbe.audio.sample_rate,
    },
  };
  const casePath = path.join(root, 'case.json');
  fs.writeFileSync(casePath, JSON.stringify(validCase(source)));
  const outputDir = path.join(root, 'output');
  const sourceHashBefore = sha256File(sourcePath);

  const result = await runLocalPreparation({ source: sourcePath, caseManifest: casePath, outputDir });
  assert.equal(result.manifestPath, path.join(outputDir, MANIFEST_FILENAME));
  assert.equal(sha256File(sourcePath), sourceHashBefore, 'source is read-only');

  const output = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(output.source.sha256, sourceHashBefore);
  assert.equal(output.timeline_contiguous, true);
  assert.equal(output.provider_request_constructed, false);
  assert.equal(output.supplier_call_performed, false);
  assert.equal(output.shots.length, 9);
  assert.deepEqual(output.shots.map((shot) => shot.id), EXPECTED_SHOT_IDS);
  assert.equal(output.summary.ready_count, 0);
  assert.equal(output.summary.blocked_count, 9);

  for (const shot of output.shots) {
    assert.equal(path.isAbsolute(shot.motion_reference.artifact.path), false);
    assert.equal(path.isAbsolute(shot.representative_frame.path), false);
    assert.match(shot.motion_reference.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.match(shot.representative_frame.sha256, /^[a-f0-9]{64}$/);
    assert.equal(shot.motion_reference.artifact.probe.has_audio, false);
    assert.equal(shot.reference_bundle_ready, false);
    assert.ok(shot.blockers.includes('face_track_review_not_approved'));
    assert.ok(shot.blockers.includes('text_region_review_not_approved'));
    assert.ok(shot.blockers.includes('motion_reference_not_approved'));
    assert.ok(fs.existsSync(path.join(outputDir, shot.motion_reference.artifact.path)));
    assert.ok(fs.existsSync(path.join(outputDir, shot.representative_frame.path)));
  }
  for (const id of ['shot-3', 'shot-8']) {
    const shot = output.shots.find((entry) => entry.id === id);
    assert.equal(shot.dialogue.kind, 'silent');
    assert.equal(shot.dialogue.turns.length, 0);
    assert.ok(shot.blockers.includes('silent_dialogue_contract_unsupported'));
  }
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(root), false);
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(serialized, /authorization|api[_-]?key|bearer\s|sk-/i);
});

test('源 hash 或 ffprobe 合同不匹配时 fail closed 且不写 manifest', async (t) => {
  if (!hasLocalFfmpeg() || !hasLocalFfprobe()) return t.skip('ffmpeg/ffprobe unavailable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-episode-mismatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = makeRealSource(root);
  const sourceProbe = await probeMedia(sourcePath);
  const baseSource = {
    sha256: sha256File(sourcePath),
    duration_ms: 68733,
    duration_tolerance_ms: 100,
    video: sourceProbe.video,
    audio: sourceProbe.audio,
  };

  for (const [name, mutate] of [
    ['hash', (value) => { value.source.sha256 = 'f'.repeat(64); }],
    ['probe', (value) => { value.source.video.width += 1; }],
  ]) {
    const caseValue = validCase(baseSource);
    mutate(caseValue);
    const casePath = path.join(root, `${name}.json`);
    const outputDir = path.join(root, `${name}-output`);
    fs.writeFileSync(casePath, JSON.stringify(caseValue));
    await assert.rejects(
      runLocalPreparation({ source: sourcePath, caseManifest: casePath, outputDir }),
      (error) => error.code === 'REDRAW_FULL_EPISODE_SOURCE_MISMATCH',
      name,
    );
    assert.equal(fs.existsSync(path.join(outputDir, MANIFEST_FILENAME)), false);
  }
});

test('中文对白只形成 blocker，不会被当作英文对白 ready', () => {
  const value = validCase();
  value.shots[0].dialogue.turns[0].text = '这不是英文';
  const normalized = validateCaseManifest(value);
  assert.ok(normalized.shots[0].blockers.includes('dialogue_contains_chinese'));
  assert.equal(normalized.shots[0].reference_bundle_ready, false);
});

test('只有人物、身份、文字净景、运动和英文对白全批准的有声镜头才 ready', () => {
  const value = validCase();
  const spoken = value.shots[0];
  spoken.face_track_review = { status: 'approved', unresolved_reason: '' };
  spoken.text_region_review = { status: 'approved', unresolved_reason: '' };
  spoken.text_regions[0].clean_plate_status = 'approved';
  spoken.text_regions[0].clean_plate_sha256 = 'c'.repeat(64);
  spoken.motion_reference = { review_status: 'approved', evidence_sha256: 'd'.repeat(64) };
  const normalized = validateCaseManifest(value);
  assert.equal(normalized.shots[0].reference_bundle_ready, true);
  assert.deepEqual(normalized.shots[0].blockers, []);
  assert.equal(normalized.shots[2].reference_bundle_ready, false);
  assert.ok(normalized.shots[2].blockers.includes('silent_dialogue_contract_unsupported'));

  const missingIdentity = clone(value);
  missingIdentity.shots[0].identity_packs[0].status = 'pending';
  const identityBlocked = validateCaseManifest(missingIdentity).shots[0];
  assert.equal(identityBlocked.reference_bundle_ready, false);
  assert.ok(identityBlocked.blockers.includes('identity_pack_not_approved'));
});

test('CLI 未知参数与不可写输出使用稳定退出码', () => {
  const unknown = spawnSync(process.execPath, [SCRIPT_PATH, '--unknown'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /REDRAW_FULL_EPISODE_CLI_INVALID/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-full-episode-cli-'));
  try {
    const sourcePath = path.join(root, 'source.mp4');
    const casePath = path.join(root, 'case.json');
    const outputFile = path.join(root, 'not-a-directory');
    fs.writeFileSync(sourcePath, 'not read because output validation happens first');
    fs.writeFileSync(casePath, JSON.stringify(validCase()));
    fs.writeFileSync(outputFile, 'file');
    const unwritable = spawnSync(process.execPath, [
      SCRIPT_PATH,
      '--source', sourcePath,
      '--case-manifest', casePath,
      '--output-dir', outputFile,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(unwritable.status, 5);
    assert.match(unwritable.stderr, /REDRAW_FULL_EPISODE_OUTPUT_INVALID/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
