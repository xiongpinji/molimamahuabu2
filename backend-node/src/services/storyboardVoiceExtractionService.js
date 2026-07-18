const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');

const MAX_REMOTE_VIDEO_BYTES = 200 * 1024 * 1024;

function resolveStoragePath(cfg) {
  const raw = cfg?.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function normalizeRelativePath(value) {
  return String(value || '').trim().replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

function resolveLocalStorageFile(storageRoot, localPath) {
  const rel = normalizeRelativePath(localPath);
  if (!rel) return null;
  const root = path.resolve(storageRoot);
  const candidate = path.resolve(root, rel);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveVideoLocalFile(storageRoot, video) {
  const direct = resolveLocalStorageFile(storageRoot, video?.local_path);
  if (direct) return direct;
  const rawUrl = String(video?.video_url || '').trim();
  const marker = '/static/';
  const index = rawUrl.toLowerCase().indexOf(marker);
  if (index < 0) return null;
  const relative = rawUrl.slice(index + marker.length).split('?')[0];
  try {
    return resolveLocalStorageFile(storageRoot, decodeURIComponent(relative));
  } catch (_) {
    return null;
  }
}

async function downloadRemoteVideo(videoUrl, tempDir) {
  if (!/^https?:\/\//i.test(String(videoUrl || '').trim())) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(String(videoUrl).trim(), { signal: controller.signal });
    if (!response.ok) throw new Error(`视频下载失败（HTTP ${response.status}）`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_REMOTE_VIDEO_BYTES) throw new Error('远程视频超过 200MB，无法提取音色');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_REMOTE_VIDEO_BYTES) throw new Error('远程视频超过 200MB，无法提取音色');
    const file = path.join(tempDir, `source-${randomUUID()}.mp4`);
    fs.writeFileSync(file, buffer);
    return file;
  } finally {
    clearTimeout(timer);
  }
}

function buildExtractArgs(inputPath, outputPath, durationSeconds = 10) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vn', '-t', String(durationSeconds),
    '-ac', '1', '-ar', '16000',
    '-codec:a', 'libmp3lame', '-b:a', '96k',
    outputPath,
  ];
}

function runFfmpeg(inputPath, outputPath, options = {}) {
  const bin = options.ffmpegPath || getFfmpegPath();
  const runner = options.spawnSync || spawnSync;
  const result = runner(bin, buildExtractArgs(inputPath, outputPath, options.durationSeconds || 10), {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: String(result.stderr || '').trim() || 'ffmpeg 提取音频失败' };
  return { ok: true };
}

function parseStoryboardCharacterIds(raw) {
  if (raw == null || raw === '') return [];
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch (_) { return []; }
  }
  if (!Array.isArray(value)) value = [value];
  return value
    .map((item) => Number(item && typeof item === 'object' ? item.id : item))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function resolveTargetCharacter(db, storyboard, requestedCharacterId) {
  let ids = [...new Set(parseStoryboardCharacterIds(storyboard.characters))];
  if (!ids.length) {
    try {
      ids = db.prepare(
        'SELECT character_id FROM storyboard_characters WHERE storyboard_id = ? ORDER BY id ASC'
      ).all(Number(storyboard.id))
        .map((row) => Number(row.character_id))
        .filter((id) => Number.isInteger(id) && id > 0);
    } catch (_) {}
  }
  const rows = ids.length
    ? db.prepare(
      `SELECT id, drama_id, name FROM characters
       WHERE id IN (${ids.map(() => '?').join(',')}) AND drama_id = ? AND deleted_at IS NULL
       ORDER BY id ASC`
    ).all(...ids, Number(storyboard.drama_id))
    : [];
  const candidates = rows.map((row) => ({ id: row.id, name: row.name || `角色${row.id}` }));
  if (requestedCharacterId != null && requestedCharacterId !== '') {
    const id = Number(requestedCharacterId);
    const selected = rows.find((row) => Number(row.id) === id);
    if (!selected) return { ok: false, code: 'CHARACTER_NOT_IN_STORYBOARD', candidates };
    return { ok: true, character: selected, candidates };
  }
  if (rows.length === 1) return { ok: true, character: rows[0], candidates };
  if (rows.length > 1) return { ok: false, code: 'MULTIPLE_CHARACTERS', candidates };
  return { ok: false, code: 'NO_CHARACTER_IN_STORYBOARD', candidates: [] };
}

function buildVoiceAsset({ url, localPath, videoId, storyboardId, durationSeconds = 10 }) {
  const now = new Date().toISOString();
  return {
    status: 'active',
    url,
    local_path: localPath,
    certified_at: now,
    extracted_at: now,
    duration: durationSeconds,
    format: 'mp3',
    source: 'storyboard_video',
    source_video_id: Number(videoId),
    source_storyboard_id: Number(storyboardId),
  };
}

async function extractStoryboardVoice({ db, cfg, log, storyboardId, videoId, characterId, ffmpegOptions = {} }) {
  const sid = Number(storyboardId);
  const vid = Number(videoId);
  if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(vid) || vid <= 0) {
    return { ok: false, status: 400, code: 'INVALID_INPUT', error: 'storyboard_id 和 video_id 必须为正整数' };
  }
  const storyboard = db.prepare(
    `SELECT s.id, s.characters, e.drama_id
     FROM storyboards s JOIN episodes e ON e.id = s.episode_id
     WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`
  ).get(sid);
  if (!storyboard) return { ok: false, status: 404, code: 'STORYBOARD_NOT_FOUND', error: '分镜不存在' };

  const target = resolveTargetCharacter(db, storyboard, characterId);
  if (!target.ok) {
    return {
      ok: false,
      status: target.code === 'CHARACTER_NOT_IN_STORYBOARD' ? 400 : 409,
      code: target.code,
      error: target.code === 'MULTIPLE_CHARACTERS'
        ? '本分镜包含多个角色，请先选择要绑定音色的角色'
        : target.code === 'NO_CHARACTER_IN_STORYBOARD'
          ? '本分镜没有可绑定的角色'
          : '所选角色不属于本分镜',
      details: { candidates: target.candidates },
    };
  }

  const video = db.prepare(
    `SELECT id, storyboard_id, drama_id, status, video_url, local_path
     FROM video_generations
     WHERE id = ? AND storyboard_id = ? AND drama_id = ?
       AND status = 'completed' AND deleted_at IS NULL`
  ).get(vid, sid, Number(storyboard.drama_id));
  if (!video) return { ok: false, status: 404, code: 'VIDEO_NOT_FOUND', error: '已完成的分镜视频不存在' };

  const storageRoot = resolveStoragePath(cfg || {});
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-voice-'));
  let sourcePath = resolveVideoLocalFile(storageRoot, video);
  let generatedPath = null;
  try {
    if (!sourcePath) sourcePath = await downloadRemoteVideo(video.video_url, tempDir);
    if (!sourcePath) return { ok: false, status: 400, code: 'VIDEO_FILE_UNAVAILABLE', error: '视频没有可用的本地文件或远程地址' };
    if (!hasLocalFfmpeg() && !ffmpegOptions.ffmpegPath) {
      return { ok: false, status: 503, code: 'FFMPEG_UNAVAILABLE', error: '服务器未安装 ffmpeg，无法提取音色' };
    }

    const projectSubdir = storageLayout.getProjectStorageSubdir(db, Number(storyboard.drama_id));
    const relDir = path.join(projectSubdir, 'characters', 'voice').replace(/\\/g, '/');
    const absDir = path.join(storageRoot, relDir);
    fs.mkdirSync(absDir, { recursive: true });
    const safeName = `char_${target.character.id}_voice_extract_${Date.now()}_${randomUUID().slice(0, 8)}.mp3`;
    generatedPath = path.join(absDir, safeName);
    const ffmpeg = runFfmpeg(sourcePath, generatedPath, ffmpegOptions);
    if (!ffmpeg.ok || !fs.existsSync(generatedPath) || fs.statSync(generatedPath).size === 0) {
      return { ok: false, status: 422, code: 'VOICE_EXTRACTION_FAILED', error: ffmpeg.error || '视频没有可提取的音频轨道' };
    }

    const localPath = `${relDir}/${safeName}`;
    const url = `/static/${localPath}`;
    const asset = buildVoiceAsset({ url, localPath, videoId: vid, storyboardId: sid, durationSeconds: ffmpegOptions.durationSeconds || 10 });
    const now = new Date().toISOString();
    db.prepare('UPDATE characters SET seedance2_voice_asset = ?, updated_at = ? WHERE id = ? AND drama_id = ? AND deleted_at IS NULL')
      .run(JSON.stringify(asset), now, target.character.id, Number(storyboard.drama_id));
    log?.info?.('[音色提取] 已从分镜视频提取角色音色', {
      storyboard_id: sid, video_id: vid, character_id: target.character.id, local_path: localPath,
    });
    return { ok: true, character_id: target.character.id, character_name: target.character.name, video_id: vid, asset };
  } catch (error) {
    try { if (generatedPath && fs.existsSync(generatedPath)) fs.unlinkSync(generatedPath); } catch (_) {}
    log?.error?.('[音色提取] 失败', { storyboard_id: sid, video_id: vid, error: error.message });
    return { ok: false, status: 500, code: 'VOICE_EXTRACTION_FAILED', error: error.message || '提取音色失败' };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  MAX_REMOTE_VIDEO_BYTES,
  buildExtractArgs,
  resolveVideoLocalFile,
  parseStoryboardCharacterIds,
  resolveTargetCharacter,
  buildVoiceAsset,
  extractStoryboardVoice,
};
