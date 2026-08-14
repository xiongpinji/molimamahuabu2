#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const {
  canonicalBundleHash,
  loadCurrentReferenceBundle,
  saveReferenceBundle,
} = require('../src/services/redrawReferenceBundleService');

const execFileAsync = promisify(execFile);
const DEFAULT_OUTPUT_DIR = path.join(os.tmpdir(), 'redraw-reference-bundle-local');
const MANIFEST_FILENAME = 'redraw-reference-bundle-local-manifest.json';
const MOTION_FILENAME = 'redraw-reference-bundle-motion.mp4';
const CONTACT_SHEET_FILENAME = 'redraw-reference-bundle-contact-sheet.jpg';
const LOCK_FILENAME = '.redraw-reference-bundle-local.lock';
const HEX_64 = /^[a-f0-9]{64}$/;
const REVIEWED_AT = '2026-08-14T00:05:00.000Z';
const UPDATED_AT = '2026-08-14T00:00:00.000Z';
const SOURCE_FACTS = Object.freeze({
  script_sha256: '5'.repeat(64),
  dialogue_sha256: '7'.repeat(64),
});

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function localError(code, message) {
  throw codedError(code, message);
}

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || String(value).startsWith('--')) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_CLI_INVALID', `${flag} missing value`);
  }
  return String(value);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { fixture: false, manifest: null, outputDir: DEFAULT_OUTPUT_DIR, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') {
      options.fixture = true;
    } else if (arg === '--manifest') {
      options.manifest = path.resolve(readFlagValue(argv, index, arg));
      index += 1;
    } else if (arg === '--output-dir') {
      options.outputDir = path.resolve(readFlagValue(argv, index, arg));
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      localError('REDRAW_REFERENCE_BUNDLE_LOCAL_CLI_INVALID', `unknown argument: ${arg}`);
    }
  }
  if (!options.help && options.fixture && options.manifest) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_CLI_INVALID', '--fixture and --manifest are mutually exclusive');
  }
  if (!options.help && !options.fixture && !options.manifest) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_CLI_INVALID', 'provide --fixture or --manifest');
  }
  return options;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

async function ensureOutputDirectory(outputDir) {
  try {
    if (fs.existsSync(outputDir) && !fs.statSync(outputDir).isDirectory()) {
      localError('REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_INVALID', 'output-dir is not a directory');
    }
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.access(outputDir, fs.constants.W_OK);
  } catch (error) {
    if (error?.code === 'REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_INVALID') throw error;
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_INVALID', 'output-dir is not writable');
  }
}

async function writeAtomic(filePath, content, options = {}) {
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, content, options);
    await fsp.rename(tmp, filePath);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_INVALID', 'atomic output failed');
  }
}

async function renameAtomic(sourcePath, finalPath) {
  const tmp = `${finalPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.copyFile(sourcePath, tmp, fs.constants.COPYFILE_EXCL);
    await fsp.rename(tmp, finalPath);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_INVALID', 'atomic media output failed');
  }
}

function viewLayout() {
  return {
    view_count: 3,
    view_layout: {
      rows: 1,
      columns: 3,
      panel_width: 288,
      panel_height: 1296,
      views: ['front', 'profile', 'full_body'],
    },
  };
}

function actorSheetSvg(title, palette) {
  const [front, profile, fullBody, ink] = palette;
  const views = [
    ['front', front, 'circle'],
    ['profile', profile, 'triangle'],
    ['full_body', fullBody, 'rect'],
  ];
  const panels = views.map(([label, color, shape], index) => {
    const x = index * 288;
    const body = shape === 'circle'
      ? `<circle cx="${x + 144}" cy="360" r="92" fill="${ink}"/><rect x="${x + 92}" y="510" width="104" height="420" rx="44" fill="${ink}"/>`
      : shape === 'triangle'
        ? `<path d="M${x + 144} 250 L${x + 235} 470 L${x + 53} 470 Z" fill="${ink}"/><rect x="${x + 110}" y="540" width="68" height="390" rx="28" fill="${ink}"/>`
        : `<rect x="${x + 79}" y="260" width="130" height="170" rx="46" fill="${ink}"/><rect x="${x + 66}" y="500" width="156" height="520" rx="40" fill="${ink}"/>`;
    return `
      <rect x="${x}" y="0" width="288" height="1296" fill="${color}"/>
      ${body}
      <text x="${x + 28}" y="1160" font-family="Arial" font-size="34" fill="${ink}">${label}</text>`;
  }).join('');
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="864" height="1296">
  ${panels}
  <text x="28" y="80" font-family="Arial" font-size="42" fill="${ink}">${title}</text>
</svg>`);
}

function svg(width, height, title, palette) {
  const [bg, fg, accent] = palette;
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="${bg}"/>
  <circle cx="${Math.round(width * 0.5)}" cy="${Math.round(height * 0.26)}" r="${Math.round(width * 0.16)}" fill="${fg}"/>
  <rect x="${Math.round(width * 0.28)}" y="${Math.round(height * 0.43)}" width="${Math.round(width * 0.44)}" height="${Math.round(height * 0.42)}" rx="24" fill="${fg}"/>
  <rect x="${Math.round(width * 0.18)}" y="${Math.round(height * 0.78)}" width="${Math.round(width * 0.64)}" height="18" fill="${accent}"/>
  <text x="40" y="${height - 40}" font-family="Arial" font-size="42" fill="${accent}">${title}</text>
</svg>`);
}

async function writeImage(filePath, width, height, title, palette) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await sharp(svg(width, height, title, palette)).png().toFile(filePath);
  return {
    path: path.relative(path.dirname(path.dirname(filePath)), filePath).replace(/\\/g, '/'),
    sha256: sha256File(filePath),
    width,
    height,
    mime_type: 'image/png',
  };
}

async function writeActorSheet(filePath, title, palette) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await sharp(actorSheetSvg(title, palette)).png().toFile(filePath);
  return {
    sha256: sha256File(filePath),
    width: 864,
    height: 1296,
    mime_type: 'image/png',
    ...viewLayout(),
  };
}

async function run(execRunner, bin, args, options, code) {
  try {
    await execRunner(bin, args, options);
  } catch (_) {
    localError(code, 'local ffmpeg step failed');
  }
}

async function generateVideo(execRunner, outputPath, seconds, pattern) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await run(execRunner, getFfmpegPath(), [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', `${pattern}=size=864x496:rate=25`,
    '-t', String(seconds),
    '-an',
    '-map_metadata', '-1',
    '-fflags', '+bitexact',
    '-flags:v', '+bitexact',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ], { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, 'REDRAW_REFERENCE_BUNDLE_LOCAL_FFMPEG_FAILED');
}

async function probeVideo(filePath, execRunner = execFileAsync) {
  let result;
  try {
    result = await execRunner(getFfprobePath(), [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      filePath,
    ], { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  } catch (_) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_FFPROBE_FAILED', 'local ffprobe step failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (_) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_FFPROBE_FAILED', 'local ffprobe returned invalid JSON');
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  return {
    duration_ms: Math.round(Number(parsed.format?.duration || video?.duration) * 1000),
    width: Number(video?.width),
    height: Number(video?.height),
    video_codec: video?.codec_name,
    audio_stream_count: streams.filter((stream) => stream.codec_type === 'audio').length,
  };
}

function identityPack(input) {
  const pack = {
    schema_version: 'target-actor-identity-v1',
    source_character_key: input.sourceCharacterKey,
    target_actor_label: input.targetActorLabel,
    artifact: input.artifact,
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    persona_origin: 'fictional_ai_generated',
    target_country: 'US',
    ready: true,
    reviewed_by: 'user-a',
    reviewed_at: REVIEWED_AT,
  };
  pack.pack_sha256 = sha256(stableJson(pack));
  return pack;
}

function textPack(input) {
  const pack = {
    schema_version: 'text-clean-plate-reference-v1',
    region_key: input.regionKey,
    kind: input.kind,
    artifact: input.artifact,
    source_fingerprint: input.sourceFingerprint,
    ready: true,
    reviewed_by: 'user-a',
    reviewed_at: REVIEWED_AT,
  };
  pack.pack_sha256 = sha256(stableJson(pack));
  return pack;
}

function insertAsset(db, input) {
  db.prepare(`INSERT INTO assets
    (id, name, type, category, url, local_path, mime_type, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'redraw', '', ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.name,
      input.type,
      input.localPath,
      input.mimeType,
      JSON.stringify(input.metadata || {
        sha256: input.sha256,
        width: input.width,
        height: input.height,
      }),
      UPDATED_AT,
      UPDATED_AT,
    );
  return input.id;
}

async function createFixture(deps = {}) {
  const execRunner = deps.execFile || execFileAsync;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'redraw-reference-bundle-fixture-'));
  const dbPath = path.join(root, 'fixture.sqlite');
  const db = new Database(dbPath);
  try {
    runMigrationsAndEnsure(db);
    await fsp.mkdir(path.join(root, 'source'), { recursive: true });
    await fsp.mkdir(path.join(root, 'redraw'), { recursive: true });
    await fsp.mkdir(path.join(root, 'redraw-conditioning'), { recursive: true });

    const sourcePath = path.join(root, 'source', 'source.mp4');
    const motionDraftPath = path.join(root, 'redraw-conditioning', 'motion-draft.mp4');
    await generateVideo(execRunner, sourcePath, 15, 'testsrc2');
    await generateVideo(execRunner, motionDraftPath, 5, 'smptebars');
    const sourceFingerprint = sha256File(sourcePath);
    const motionSha = sha256File(motionDraftPath);
    const motionRelativePath = `redraw-conditioning/${motionSha}.mp4`;
    const motionPath = path.join(root, motionRelativePath);
    await fsp.rename(motionDraftPath, motionPath);

    const ethan = await writeActorSheet(path.join(root, 'redraw', 'identity-301.png'), 'Ethan AI adult', ['#dbeafe', '#bfdbfe', '#93c5fd', '#1f2937']);
    const maya = await writeActorSheet(path.join(root, 'redraw', 'identity-302.png'), 'Maya AI adult', ['#fce7f3', '#fbcfe8', '#f9a8d4', '#111827']);
    const subtitle = await writeImage(path.join(root, 'redraw', 'text-clean-303.png'), 864, 496, 'subtitle clean plate', ['#f8fafc', '#dbeafe', '#2563eb']);
    const screen = await writeImage(path.join(root, 'redraw', 'text-clean-304.png'), 864, 496, 'screen clean plate', ['#f9fafb', '#dcfce7', '#16a34a']);

    const nameMap = { 'character-001': 'Ethan', 'character-002': 'Maya' };
    const sourceFacts = {
      ...SOURCE_FACTS,
      name_map_source_sha256: sha256(stableJson(nameMap)),
    };
    const faceTracks = [
      { track_key: 'face-001', source_character_key: 'character-001', time_ranges: [[0, 5000]], identity_redraw_asset_id: 201 },
      { track_key: 'face-002', source_character_key: 'character-002', time_ranges: [[2500, 5000]], identity_redraw_asset_id: 202 },
    ];
    const textRegions = [
      { region_key: 'text-001', kind: 'text_subtitle', time_ranges: [[0, 2500]], text_clean_redraw_asset_id: 203 },
      { region_key: 'text-002', kind: 'text_screen', time_ranges: [[2500, 5000]], text_clean_redraw_asset_id: 204 },
    ];
    const faceCoverageSha256 = sha256(stableJson(faceTracks));
    const textCoverageSha256 = sha256(stableJson(textRegions));

    insertAsset(db, { id: 101, name: 'source', type: 'video', localPath: 'source/source.mp4', mimeType: 'video/mp4', sha256: sourceFingerprint, width: 864, height: 496 });
    db.prepare(`INSERT INTO redraw_projects
      (tenant_id, user_id, title, default_locale, default_market, created_at, updated_at)
      VALUES ('tenant-a', 'user-a', 'reference bundle local project', 'en-US', 'US', ?, ?)`).run(UPDATED_AT, UPDATED_AT);
    const projectId = Number(db.prepare('SELECT id FROM redraw_projects LIMIT 1').get().id);
    db.prepare(`INSERT INTO redraw_works
      (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
      VALUES (1, ?, 'tenant-a', 'user-a', 'reference bundle local work', 101, ?, 15000, ?, ?)`)
      .run(projectId, sourceFingerprint, UPDATED_AT, UPDATED_AT);
    const versionId = Number(db.prepare(`INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, name_map_json, source_facts_json,
       facts_hash, reference_bundle_required, status, created_at, updated_at)
      VALUES (1, 'tenant-a', 'user-a', 1, 'en-US', 'US', ?, ?, ?, 1, 'asset_review', ?, ?)`)
      .run(JSON.stringify(nameMap), JSON.stringify(sourceFacts), sha256(stableJson(sourceFacts)), UPDATED_AT, UPDATED_AT).lastInsertRowid);
    const shotId = Number(db.prepare(`INSERT INTO redraw_shots
      (work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index, start_ms, end_ms,
       duration_ms, source_dialogue_json, localized_dialogue_json, references_json, reference_bundle_json,
       created_at, updated_at)
      VALUES (1, ?, 'tenant-a', 'user-a', 'shot-001', 1, 1, 0, 5000, 5000, ?, ?, '[]', '{}', ?, ?)`)
      .run(
        versionId,
        JSON.stringify([{ speaker_id: 'character-001', text: 'source dialogue redacted', start_ms: 0, end_ms: 2400 }]),
        JSON.stringify([
          { speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 0, end_ms: 2400 },
          { speaker_id: 'character-002', localized_text: 'Not without proof.', start_ms: 2500, end_ms: 5000 },
        ]),
        UPDATED_AT,
        UPDATED_AT,
      ).lastInsertRowid);

    const identityA = identityPack({ sourceCharacterKey: 'character-001', targetActorLabel: 'Actor Ethan', artifact: { asset_id: 301, sha256: ethan.sha256, width: 864, height: 1296, mime_type: 'image/png', view_count: ethan.view_count, view_layout: ethan.view_layout } });
    const identityB = identityPack({ sourceCharacterKey: 'character-002', targetActorLabel: 'Actor Maya', artifact: { asset_id: 302, sha256: maya.sha256, width: 864, height: 1296, mime_type: 'image/png', view_count: maya.view_count, view_layout: maya.view_layout } });
    for (const asset of [
      { id: 301, name: 'identity-ethan', localPath: 'redraw/identity-301.png', sha256: ethan.sha256, width: 864, height: 1296 },
      { id: 302, name: 'identity-maya', localPath: 'redraw/identity-302.png', sha256: maya.sha256, width: 864, height: 1296 },
      { id: 303, name: 'text-clean-subtitle', localPath: 'redraw/text-clean-303.png', sha256: subtitle.sha256, width: 864, height: 496 },
      { id: 304, name: 'text-clean-screen', localPath: 'redraw/text-clean-304.png', sha256: screen.sha256, width: 864, height: 496 },
    ]) {
      insertAsset(db, { ...asset, type: 'image', mimeType: 'image/png' });
    }
    insertAsset(db, {
      id: 305,
      name: 'motion-reference',
      type: 'video',
      localPath: motionRelativePath,
      mimeType: 'video/mp4',
      sha256: motionSha,
      width: 864,
      height: 496,
      metadata: {
        sha256: motionSha,
        redraw_motion_reference: {
          schema_version: 'redraw-motion-reference-v1',
          tenant_id: 'tenant-a',
          user_id: 'user-a',
          version_id: versionId,
          shot_id: shotId,
          source_asset_id: 101,
          source_fingerprint: sourceFingerprint,
          clip_start_ms: 0,
          clip_end_ms: 5000,
          face_coverage_sha256: faceCoverageSha256,
          text_coverage_sha256: textCoverageSha256,
        },
      },
    });

    db.prepare(`INSERT INTO redraw_assets
      (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name, localized_description,
       prompt, asset_id, version_number, approval_status, approved_by, approved_at, status, created_at, updated_at)
      VALUES (?, ?, 'tenant-a', 'user-a', 'character', ?, ?, 'fictional adult target actor',
       'identity redraw prompt', ?, 1, 'approved', 'user-a', ?, 'generated', ?, ?)`)
      .run(201, versionId, JSON.stringify({ source_ref: { stable_id: 'character-001' }, identity_pack: identityA }), 'Actor Ethan', 301, REVIEWED_AT, UPDATED_AT, UPDATED_AT);
    db.prepare(`INSERT INTO redraw_assets
      (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name, localized_description,
       prompt, asset_id, version_number, approval_status, approved_by, approved_at, status, created_at, updated_at)
      VALUES (?, ?, 'tenant-a', 'user-a', 'character', ?, ?, 'fictional adult target actor',
       'identity redraw prompt', ?, 1, 'approved', 'user-a', ?, 'generated', ?, ?)`)
      .run(202, versionId, JSON.stringify({ source_ref: { stable_id: 'character-002' }, identity_pack: identityB }), 'Actor Maya', 302, REVIEWED_AT, UPDATED_AT, UPDATED_AT);

    const textA = textPack({ regionKey: 'text-001', kind: 'text_subtitle', artifact: { asset_id: 303, sha256: subtitle.sha256, width: 864, height: 496, mime_type: 'image/png' }, sourceFingerprint });
    const textB = textPack({ regionKey: 'text-002', kind: 'text_screen', artifact: { asset_id: 304, sha256: screen.sha256, width: 864, height: 496, mime_type: 'image/png' }, sourceFingerprint });
    for (const entry of [
      { id: 203, region: 'text-001', kind: 'text_subtitle', assetId: 303, pack: textA },
      { id: 204, region: 'text-002', kind: 'text_screen', assetId: 304, pack: textB },
    ]) {
      db.prepare(`INSERT INTO redraw_assets
        (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name, localized_description,
         prompt, clean_plate_asset_id, version_number, approval_status, approved_by, approved_at, status, created_at, updated_at)
        VALUES (?, ?, 'tenant-a', 'user-a', 'scene', ?, ?, 'text clean plate',
         'remove localized text only', ?, 1, 'approved', 'user-a', ?, 'generated', ?, ?)`)
        .run(entry.id, versionId, JSON.stringify({
          source_ref: { stable_id: entry.region, kind: entry.kind },
          snapshot: { mode: 'text_clean_plate' },
          text_clean_plate_pack: entry.pack,
        }), entry.region, entry.assetId, REVIEWED_AT, UPDATED_AT, UPDATED_AT);
    }

    const saved = await saveReferenceBundle({
      db,
      tenantId: 'tenant-a',
      userId: 'user-a',
      versionId,
      storageRoot: root,
      now: REVIEWED_AT,
    }, {
      shot_id: shotId,
      expected_updated_at: UPDATED_AT,
      motion_reference_asset_id: 305,
      face_tracks: faceTracks,
      text_regions: textRegions,
      coverage_review: {
        recognizable_face_count: 2,
        mapped_face_count: 2,
        unresolved_face_count: 0,
        recognizable_text_region_count: 2,
        mapped_text_region_count: 2,
        unresolved_text_region_count: 0,
        status: 'approved',
      },
    });
    const loaded = await loadCurrentReferenceBundle({ db, tenantId: 'tenant-a', userId: 'user-a', versionId, storageRoot: root }, shotId);
    const motionProbe = await probeVideo(motionPath);
    return {
      root,
      db,
      versionId,
      shotId,
      sourceFingerprint,
      motionPath,
      identityImages: [path.join(root, 'redraw', 'identity-301.png'), path.join(root, 'redraw', 'identity-302.png')],
      textImages: [path.join(root, 'redraw', 'text-clean-303.png'), path.join(root, 'redraw', 'text-clean-304.png')],
      motion: { sha256: motionSha, ...motionProbe },
      bundle: loaded.bundle,
      referenceBundleHash: saved.reference_bundle_hash,
    };
  } catch (error) {
    db.close();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function writeContactSheet(fixture, outputPath) {
  const motionCell = await sharp({
    create: { width: 320, height: 180, channels: 3, background: '#111827' },
  }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#111827"/><rect x="40" y="40" width="240" height="100" fill="#38bdf8"/><text x="42" y="100" font-family="Arial" font-size="28" fill="#ffffff">motion 5s</text></svg>') }]).png().toBuffer();
  const faceCell = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#f8fafc"/><circle cx="105" cy="82" r="45" fill="#64748b"/><circle cx="215" cy="82" r="45" fill="#94a3b8"/><text x="44" y="150" font-family="Arial" font-size="22" fill="#0f172a">face coverage</text></svg>')).png().toBuffer();
  const textCell = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#ffffff"/><rect x="30" y="55" width="260" height="28" fill="#bfdbfe"/><rect x="30" y="102" width="190" height="28" fill="#bbf7d0"/><text x="45" y="150" font-family="Arial" font-size="22" fill="#0f172a">text coverage</text></svg>')).png().toBuffer();
  const cells = [
    motionCell,
    faceCell,
    textCell,
    await sharp(fixture.identityImages[0]).resize(320, 180, { fit: 'cover' }).png().toBuffer(),
    await sharp(fixture.identityImages[1]).resize(320, 180, { fit: 'cover' }).png().toBuffer(),
    await sharp(fixture.textImages[0]).resize(160, 180, { fit: 'cover' }).extend({ right: 160, background: '#f9fafb' }).composite([
      { input: await sharp(fixture.textImages[1]).resize(160, 180, { fit: 'cover' }).png().toBuffer(), left: 160, top: 0 },
    ]).png().toBuffer(),
  ];
  const tmp = `${outputPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await sharp({ create: { width: 960, height: 360, channels: 3, background: '#ffffff' } })
      .composite(cells.map((input, index) => ({ input, left: (index % 3) * 320, top: Math.floor(index / 3) * 180 })))
      .jpeg({ quality: 90 })
      .toFile(tmp);
    await fsp.rename(tmp, outputPath);
  } catch (_) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_CONTACT_SHEET_FAILED', 'contact sheet output failed');
  }
}

async function writeContactSheetChecked(writer, fixture, outputPath) {
  try {
    await writer(fixture, outputPath);
  } catch (error) {
    if (error?.code === 'REDRAW_REFERENCE_BUNDLE_LOCAL_CONTACT_SHEET_FAILED') throw error;
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_CONTACT_SHEET_FAILED', 'contact sheet output failed');
  }
}

async function contactSheetEvidence(filePath) {
  let metadata;
  try {
    metadata = await sharp(filePath).metadata();
  } catch (_) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'contact sheet is unreadable');
  }
  if (metadata.format !== 'jpeg' || metadata.width !== 960 || metadata.height !== 360) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'contact sheet media mismatch');
  }
  return {
    sha256: sha256File(filePath),
    width: 960,
    height: 360,
    mime_type: 'image/jpeg',
  };
}

function buildManifest(fixture, contactSheet) {
  const bundle = fixture.bundle;
  return {
    schema_version: 'redraw-reference-bundle-local-manifest-v1',
    reference_gate: 'ready',
    locale: 'en-US',
    market: 'US',
    motion: {
      filename: MOTION_FILENAME,
      sha256: fixture.motion.sha256,
      duration_ms: fixture.motion.duration_ms,
      width: fixture.motion.width,
      height: fixture.motion.height,
      video_codec: fixture.motion.video_codec,
      audio_stream_count: fixture.motion.audio_stream_count,
    },
    contact_sheet: {
      filename: CONTACT_SHEET_FILENAME,
      sha256: contactSheet.sha256,
      width: contactSheet.width,
      height: contactSheet.height,
      mime_type: contactSheet.mime_type,
    },
    coverage_sha256: bundle.coverage_sha256,
    reference_bundle_hash: fixture.referenceBundleHash,
    characters: bundle.face_tracks.map((track) => ({
      source_character_key: track.source_character_key,
      target_character_name: track.identity.target_character_name,
      target_actor_label: track.identity.target_actor_label,
      persona_origin: 'fictional_ai_generated',
      target_country: 'US',
      adult_status: 'verified_18_plus',
      approval_status: 'approved',
      artifact_sha256: track.identity.artifact.sha256,
      view_count: track.identity.artifact.view_count,
      view_layout: track.identity.artifact.view_layout,
      pack_sha256: track.identity.pack_sha256,
    })),
    text_regions: bundle.text_regions.map((region) => ({
      region_key: region.region_key,
      kind: region.kind,
      artifact_sha256: region.clean_plate.artifact.sha256,
      pack_sha256: region.clean_plate.pack_sha256,
    })),
    bundle,
  };
}

function assertFinalManifest(manifest) {
  if (!manifest || manifest.schema_version !== 'redraw-reference-bundle-local-manifest-v1'
    || manifest.reference_gate !== 'ready'
    || manifest.locale !== 'en-US'
    || manifest.market !== 'US'
    || manifest.motion?.filename !== MOTION_FILENAME
    || manifest.contact_sheet?.filename !== CONTACT_SHEET_FILENAME
    || !HEX_64.test(String(manifest.contact_sheet?.sha256 || ''))
    || manifest.contact_sheet?.width !== 960
    || manifest.contact_sheet?.height !== 360
    || manifest.contact_sheet?.mime_type !== 'image/jpeg'
    || manifest.motion?.video_codec !== 'h264'
    || manifest.motion?.audio_stream_count !== 0
    || canonicalBundleHash(manifest.bundle) !== manifest.reference_bundle_hash) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'manifest validation failed');
  }
  if (!Array.isArray(manifest.characters)
    || manifest.characters.some((entry) => entry?.view_count !== 3
      || entry?.view_layout?.columns !== 3
      || entry?.view_layout?.rows !== 1
      || JSON.stringify(entry?.view_layout?.views) !== JSON.stringify(['front', 'profile', 'full_body']))) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'identity view evidence missing');
  }
  const serialized = JSON.stringify(manifest);
  if (/[A-Za-z]:[\\/]/.test(serialized)
    || serialized.includes('sk-')
    || serialized.includes('Authorization')
    || serialized.includes('http://')
    || serialized.includes('https://')
    || /[\u3400-\u9fff]/.test(serialized)) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'manifest contains disallowed content');
  }
}

async function readInputManifest(manifestPath) {
  try {
    const payload = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    assertFinalManifest(payload);
    return { root: path.dirname(manifestPath), manifest: payload };
  } catch (error) {
    if (error?.code === 'REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID') throw error;
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'manifest is unreadable');
  }
}

async function createStagingDir(outputDir) {
  return fsp.mkdtemp(path.join(outputDir, `.redraw-reference-bundle-local-${process.pid}-`));
}

function finalOutputNames() {
  return [MANIFEST_FILENAME, MOTION_FILENAME, CONTACT_SHEET_FILENAME];
}

function assertMotionProbeMatchesManifest(probe, manifest) {
  if (Math.abs(Number(probe.duration_ms) - 5000) > 100
    || Number(probe.width) !== 864
    || Number(probe.height) !== 496
    || probe.video_codec !== 'h264'
    || Number(probe.audio_stream_count) !== 0
    || Number(probe.duration_ms) !== Number(manifest.motion.duration_ms)
    || Number(probe.width) !== Number(manifest.motion.width)
    || Number(probe.height) !== Number(manifest.motion.height)
    || probe.video_codec !== manifest.motion.video_codec
    || Number(probe.audio_stream_count) !== Number(manifest.motion.audio_stream_count)
    || manifest.bundle?.motion_reference?.sha256 !== manifest.motion.sha256
    || canonicalBundleHash(manifest.bundle) !== manifest.reference_bundle_hash) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'motion media mismatch');
  }
}

async function validateStagedOutputs(root, manifest) {
  assertFinalManifest(manifest);
  const motionPath = path.join(root, MOTION_FILENAME);
  const contactSheetPath = path.join(root, CONTACT_SHEET_FILENAME);
  if (sha256File(motionPath) !== manifest.motion.sha256) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'motion hash mismatch');
  }
  assertMotionProbeMatchesManifest(await probeVideo(motionPath), manifest);
  const contact = await contactSheetEvidence(contactSheetPath);
  if (contact.sha256 !== manifest.contact_sheet.sha256) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'contact sheet hash mismatch');
  }
}

async function acquireOutputLock(outputDir) {
  const lockPath = path.join(outputDir, LOCK_FILENAME);
  const owner = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  let handle;
  try {
    handle = await fsp.open(lockPath, 'wx');
    await handle.writeFile(owner, 'utf8');
    return {
      async release() {
        await handle.close().catch(() => {});
        try {
          if (await fsp.readFile(lockPath, 'utf8') === owner) {
            await fsp.rm(lockPath, { force: true });
          }
        } catch (_) {}
      },
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === 'EEXIST') {
      localError('REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_LOCKED', 'output directory is locked');
    }
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_INVALID', 'output lock failed');
  }
}

async function commitStagedOutputs(outputDir, stagingDir) {
  const backups = [];
  const installed = [];
  try {
    for (const name of finalOutputNames()) {
      const finalPath = path.join(outputDir, name);
      const stagedPath = path.join(stagingDir, name);
      const backupPath = `${finalPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.bak`;
      if (fs.existsSync(finalPath)) {
        await fsp.rename(finalPath, backupPath);
        backups.push({ finalPath, backupPath });
      }
      await fsp.rename(stagedPath, finalPath);
      installed.push({ finalPath, backupPath: fs.existsSync(backupPath) ? backupPath : null });
    }
    for (const backup of backups) {
      await fsp.rm(backup.backupPath, { force: true }).catch(() => {});
    }
  } catch (error) {
    for (const item of installed.reverse()) {
      await fsp.rm(item.finalPath, { force: true }).catch(() => {});
    }
    for (const backup of backups.reverse()) {
      if (fs.existsSync(backup.backupPath) && !fs.existsSync(backup.finalPath)) {
        await fsp.rename(backup.backupPath, backup.finalPath).catch(() => {});
      }
    }
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_INVALID', 'final output commit failed');
  }
}

async function outputFixture(options, deps) {
  let fixture;
  let stagingDir;
  let lock;
  try {
    fixture = await createFixture(deps);
    stagingDir = await createStagingDir(options.outputDir);
    await renameAtomic(fixture.motionPath, path.join(stagingDir, MOTION_FILENAME));
    const contactSheetPath = path.join(stagingDir, CONTACT_SHEET_FILENAME);
    await writeContactSheetChecked(deps.writeContactSheet || writeContactSheet, fixture, contactSheetPath);
    const manifest = buildManifest(fixture, await contactSheetEvidence(contactSheetPath));
    await writeAtomic(path.join(stagingDir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' });
    lock = await acquireOutputLock(options.outputDir);
    await validateStagedOutputs(stagingDir, manifest);
    if (typeof deps.beforeCommit === 'function') await deps.beforeCommit();
    await commitStagedOutputs(options.outputDir, stagingDir);
  } finally {
    if (lock) await lock.release();
    if (stagingDir) await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (fixture) {
      fixture.db.close();
      await fsp.rm(fixture.root, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function assertInsideRoot(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function outputManifest(options, deps = {}) {
  const { root, manifest } = await readInputManifest(options.manifest);
  const motionPath = path.resolve(root, manifest.motion.filename);
  const contactSheetPath = path.resolve(root, manifest.contact_sheet.filename);
  if (!assertInsideRoot(root, motionPath) || !assertInsideRoot(root, contactSheetPath)) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'manifest file references must stay inside root');
  }
  if (sha256File(motionPath) !== manifest.motion.sha256) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'manifest motion hash mismatch');
  }
  assertMotionProbeMatchesManifest(await probeVideo(motionPath), manifest);
  const contact = await contactSheetEvidence(contactSheetPath);
  if (contact.sha256 !== manifest.contact_sheet.sha256) {
    localError('REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID', 'manifest contact sheet hash mismatch');
  }
  let stagingDir;
  let lock;
  try {
    stagingDir = await createStagingDir(options.outputDir);
    await fsp.copyFile(motionPath, path.join(stagingDir, MOTION_FILENAME));
    await fsp.copyFile(contactSheetPath, path.join(stagingDir, CONTACT_SHEET_FILENAME));
    await writeAtomic(path.join(stagingDir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' });
    lock = await acquireOutputLock(options.outputDir);
    await validateStagedOutputs(stagingDir, manifest);
    if (typeof deps.beforeCommit === 'function') await deps.beforeCommit();
    await commitStagedOutputs(options.outputDir, stagingDir);
  } finally {
    if (lock) await lock.release();
    if (stagingDir) await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

function helpText() {
  return [
    'Usage: node scripts/run-redraw-reference-bundle-local-case.js --fixture [--output-dir <dir>]',
    '       node scripts/run-redraw-reference-bundle-local-case.js --manifest <path> [--output-dir <dir>]',
  ].join('\n');
}

async function runCase(options, deps = {}) {
  await ensureOutputDirectory(options.outputDir);
  if (options.fixture) {
    await outputFixture(options, deps);
  } else {
    await outputManifest(options, deps);
  }
}

function sanitizedMessage(error) {
  const code = error?.code || 'REDRAW_REFERENCE_BUNDLE_LOCAL_FAILED';
  const safeCodes = new Set([
    'REDRAW_REFERENCE_BUNDLE_LOCAL_CLI_INVALID',
    'REDRAW_REFERENCE_BUNDLE_LOCAL_MANIFEST_INVALID',
    'REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_INVALID',
    'REDRAW_REFERENCE_BUNDLE_LOCAL_FFMPEG_FAILED',
    'REDRAW_REFERENCE_BUNDLE_LOCAL_FFPROBE_FAILED',
    'REDRAW_REFERENCE_BUNDLE_LOCAL_CONTACT_SHEET_FAILED',
    'REDRAW_REFERENCE_BUNDLE_LOCAL_OUTPUT_LOCKED',
  ]);
  return safeCodes.has(code) ? code : 'REDRAW_REFERENCE_BUNDLE_LOCAL_FAILED';
}

async function main(argv = process.argv.slice(2), streams = {}, deps = {}) {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(`${helpText()}\n`);
      return 0;
    }
    await runCase(options, deps);
    stdout.write('REDRAW_REFERENCE_BUNDLE_LOCAL_OK\n');
    return 0;
  } catch (error) {
    const code = sanitizedMessage(error);
    stderr.write(`error_code=${code}\n`);
    return code === 'REDRAW_REFERENCE_BUNDLE_LOCAL_CLI_INVALID' ? 2 : 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  CONTACT_SHEET_FILENAME,
  DEFAULT_OUTPUT_DIR,
  MANIFEST_FILENAME,
  MOTION_FILENAME,
  createFixture,
  main,
  parseArgs,
  probeVideo,
  runCase,
};
