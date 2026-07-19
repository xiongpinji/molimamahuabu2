const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');
const assetService = require('./assetService');

const MAX_REMOTE_VIDEO_BYTES = 200 * 1024 * 1024;
const MIN_SPEECH_SEGMENT_SECONDS = 0.25;
const VOICE_FILTER_CHAIN = [
  // 混合视频通常把对白放在中间声道；先取中心并做语音频段/噪声抑制，避免把整条立体声伴奏直接写入角色音色。
  'pan=mono|c0=0.5*c0+0.5*c1',
  'highpass=f=80',
  'lowpass=f=12000',
  'afftdn=nr=12:nf=-45',
  'acompressor=threshold=-24dB:ratio=3:attack=20:release=250',
].join(',');

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

function normalizeSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => ({ start: Number(segment?.start), end: Number(segment?.end) }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end)
      && segment.start >= 0 && segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
}

function buildExtractArgs(inputPath, outputPath, durationSeconds = 10, options = {}) {
  const opts = { ...(typeof durationSeconds === 'object' ? durationSeconds : options) };
  if (typeof durationSeconds !== 'object') opts.durationSeconds = durationSeconds;
  const segments = normalizeSegments(opts.segments);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
  ];
  if (segments.length) {
    const chains = segments.map((segment, index) =>
      `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS,${VOICE_FILTER_CHAIN}[voice${index}]`
    );
    const concatInputs = segments.map((_, index) => `[voice${index}]`).join('');
    chains.push(`${concatInputs}concat=n=${segments.length}:v=0:a=1[out]`);
    args.push('-filter_complex', chains.join(';'), '-map', '[out]');
  } else {
    args.push('-vn', '-t', String(Number(opts.durationSeconds) || 10), '-af', VOICE_FILTER_CHAIN);
  }
  args.push(
    '-ac', '1', '-ar', '16000',
    '-codec:a', 'libmp3lame', '-b:a', '96k',
    '-map_metadata', '-1',
    outputPath,
  );
  return args;
}

function runFfmpeg(inputPath, outputPath, options = {}) {
  const bin = options.ffmpegPath || getFfmpegPath();
  const runner = options.spawnSync || spawnSync;
  const result = runner(bin, buildExtractArgs(inputPath, outputPath, options.durationSeconds || 10, options), {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: String(result.stderr || '').trim() || 'ffmpeg 提取音频失败' };
  return { ok: true };
}

function parseSilenceDetectOutput(output, durationSeconds) {
  const events = [];
  const text = String(output || '').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
  const eventRe = /silence_(start|end):\s*([0-9]+(?:\.[0-9]+)?)/g;
  let match;
  while ((match = eventRe.exec(text))) events.push({ type: match[1], time: Number(match[2]) });
  const duration = Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : 0;
  const segments = [];
  let cursor = 0;
  for (const event of events) {
    if (!Number.isFinite(event.time)) continue;
    if (event.type === 'start') {
      if (event.time - cursor >= MIN_SPEECH_SEGMENT_SECONDS) {
        segments.push({ start: cursor, end: event.time });
      }
    } else {
      cursor = Math.max(cursor, event.time);
    }
  }
  if (duration - cursor >= MIN_SPEECH_SEGMENT_SECONDS) segments.push({ start: cursor, end: duration });
  if (!segments.length && duration >= MIN_SPEECH_SEGMENT_SECONDS && !events.some((event) => event.type === 'start')) {
    segments.push({ start: 0, end: duration });
  }
  return normalizeSegments(segments);
}

function probeDurationSeconds(inputPath, options = {}) {
  const runner = options.spawnSync || spawnSync;
  const result = runner(options.ffprobePath || getFfprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) return 0;
  const duration = Number(String(result.stdout || '').trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function detectSpeechSegments(inputPath, options = {}) {
  const runner = options.spawnSync || spawnSync;
  const result = runner(options.ffmpegPath || getFfmpegPath(), [
    '-hide_banner', '-nostats', '-i', inputPath, '-vn',
    '-af', 'silencedetect=noise=-34dB:d=0.18', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error) return { ok: false, error: result.error.message };
  const durationSeconds = probeDurationSeconds(inputPath, options);
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  const segments = parseSilenceDetectOutput(output, durationSeconds);
  if (result.status !== 0 && !segments.length) {
    return { ok: false, error: String(result.stderr || '').trim() || '视频没有可检测的音频轨道' };
  }
  return { ok: true, durationSeconds, segments };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDialogueSpeakerEntries(raw, speakerNames = []) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const names = [...new Set((speakerNames || []).map((name) => String(name || '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const entries = [];
  for (const block of text.split(/[\/\n；;]+/)) {
    const line = block.trim();
    if (!line) continue;
    const labelRe = names.length
      ? new RegExp(`(${names.map(escapeRegExp).join('|')})\\s*[:：]`, 'g')
      : /([^:：]{1,30})\s*[:：]/g;
    const labels = [...line.matchAll(labelRe)];
    if (!labels.length) continue;
    labels.forEach((label, index) => {
      const speaker = String(label[1] || '').trim();
      const start = label.index + label[0].length;
      const end = index + 1 < labels.length ? labels[index + 1].index : line.length;
      const value = line.slice(start, end).replace(/^[\s"“‘「『]+|[\s"”’」』]+$/g, '').trim();
      if (speaker && value) entries.push({ speaker, text: value });
    });
  }
  return entries;
}

function matchDialogueSpeaker(speaker, candidates) {
  const normalized = String(speaker || '').trim();
  const exact = candidates.find((candidate) => candidate.name === normalized);
  if (exact) return exact;
  return candidates.find((candidate) => normalized.length >= 2
    && candidate.name.length >= 2
    && (normalized.includes(candidate.name) || candidate.name.includes(normalized)));
}

function buildRoleExtractionPlan({ dialogue, targetCharacter, candidates, speechSegments }) {
  const entries = parseDialogueSpeakerEntries(dialogue, candidates.map((candidate) => candidate.name));
  if (!entries.length) return { ok: false, code: 'NO_DIALOGUE_SCRIPT', error: '分镜没有可识别的角色对白，无法安全提取单角色音色' };
  const mapped = entries.map((entry) => ({ ...entry, character: matchDialogueSpeaker(entry.speaker, candidates) }));
  const unmapped = mapped.filter((entry) => !entry.character);
  if (unmapped.length) {
    return {
      ok: false,
      code: 'DIALOGUE_SPEAKER_NOT_MAPPED',
      error: `对白角色“${unmapped[0].speaker}”未绑定到本分镜角色，已阻止混合音色写入`,
      details: { speakers: unmapped.map((entry) => entry.speaker) },
    };
  }
  const segments = normalizeSegments(speechSegments);
  if (!segments.length) return { ok: false, code: 'NO_SPEECH_SEGMENT', error: '视频中未检测到可用的人声片段' };
  const distinctCharacters = new Set(mapped.map((entry) => Number(entry.character.id)));
  if (segments.length < mapped.length && distinctCharacters.size > 1) {
    return {
      ok: false,
      code: 'VOICE_ROLE_SEPARATION_UNAVAILABLE',
      error: '视频对白之间没有足够的静音切点，无法可靠区分角色；未写入混合音色',
      details: { dialogue_count: mapped.length, speech_segment_count: segments.length },
    };
  }
  const assigned = [];
  if (segments.length < mapped.length) {
    // 同一角色连续说话无需硬切；保留经过去噪的人声段即可。
    mapped.forEach((entry) => assigned.push({ ...entry, segments }));
  } else {
    mapped.forEach((entry, index) => {
      const start = Math.floor(index * segments.length / mapped.length);
      const end = Math.max(start + 1, Math.floor((index + 1) * segments.length / mapped.length));
      assigned.push({ ...entry, segments: segments.slice(start, Math.min(end, segments.length)) });
    });
  }
  const targetEntries = assigned.filter((entry) => Number(entry.character.id) === Number(targetCharacter.id));
  const targetSegments = normalizeSegments(targetEntries.flatMap((entry) => entry.segments));
  if (!targetSegments.length) return { ok: false, code: 'CHARACTER_VOICE_NOT_FOUND', error: `视频中未检测到角色“${targetCharacter.name}”可用对白` };
  return {
    ok: true,
    targetSegments,
    durationSeconds: targetSegments.reduce((sum, segment) => sum + segment.end - segment.start, 0),
    entries: assigned.map((entry) => ({
      speaker: entry.speaker,
      character_id: Number(entry.character.id),
      segments: entry.segments,
    })),
  };
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

function buildVoiceAsset({ url, localPath, videoId, storyboardId, durationSeconds = 10, separation }) {
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
    extraction_method: 'script_ordered_voice_segments',
    background_suppression: 'center_mix_denoise',
    role_segments: separation?.entries || [],
  };
}

async function extractStoryboardVoice({ db, cfg, log, storyboardId, videoId, characterId, ffmpegOptions = {} }) {
  const sid = Number(storyboardId);
  const vid = Number(videoId);
  if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(vid) || vid <= 0) {
    return { ok: false, status: 400, code: 'INVALID_INPUT', error: 'storyboard_id 和 video_id 必须为正整数' };
  }
  const storyboard = db.prepare(
    `SELECT s.id, s.characters, s.dialogue, e.drama_id
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

    const speech = detectSpeechSegments(sourcePath, ffmpegOptions);
    if (!speech.ok) {
      return { ok: false, status: 422, code: 'VOICE_EXTRACTION_FAILED', error: speech.error || '无法检测视频人声片段' };
    }
    const plan = buildRoleExtractionPlan({
      dialogue: storyboard.dialogue,
      targetCharacter: target.character,
      candidates: target.candidates,
      speechSegments: speech.segments,
    });
    if (!plan.ok) {
      return { ok: false, status: 422, code: plan.code, error: plan.error, details: plan.details };
    }

    const projectSubdir = storageLayout.getProjectStorageSubdir(db, Number(storyboard.drama_id));
    const relDir = path.join(projectSubdir, 'characters', 'voice').replace(/\\/g, '/');
    const absDir = path.join(storageRoot, relDir);
    fs.mkdirSync(absDir, { recursive: true });
    const safeName = `char_${target.character.id}_voice_extract_${Date.now()}_${randomUUID().slice(0, 8)}.mp3`;
    generatedPath = path.join(absDir, safeName);
    const ffmpeg = runFfmpeg(sourcePath, generatedPath, {
      ...ffmpegOptions,
      segments: plan.targetSegments,
      durationSeconds: plan.durationSeconds,
    });
    if (!ffmpeg.ok || !fs.existsSync(generatedPath) || fs.statSync(generatedPath).size === 0) {
      return { ok: false, status: 422, code: 'VOICE_EXTRACTION_FAILED', error: ffmpeg.error || '视频没有可提取的音频轨道' };
    }

    const localPath = `${relDir}/${safeName}`;
    const url = `/static/${localPath}`;
    const asset = buildVoiceAsset({
      url,
      localPath,
      videoId: vid,
      storyboardId: sid,
      durationSeconds: plan.durationSeconds,
      separation: plan,
    });
    const now = new Date().toISOString();
    db.prepare('UPDATE characters SET seedance2_voice_asset = ?, updated_at = ? WHERE id = ? AND drama_id = ? AND deleted_at IS NULL')
      .run(JSON.stringify(asset), now, target.character.id, Number(storyboard.drama_id));
    const libraryAsset = assetService.saveExtractedVoice(db, log, {
      dramaId: storyboard.drama_id,
      characterId: target.character.id,
      characterName: target.character.name,
      storyboardId: sid,
      videoId: vid,
      voiceAsset: asset,
    });
    log?.info?.('[音色提取] 已从分镜视频提取角色音色', {
      storyboard_id: sid,
      video_id: vid,
      character_id: target.character.id,
      local_path: localPath,
      segment_count: plan.targetSegments.length,
      separation_method: asset.extraction_method,
    });
    return {
      ok: true,
      character_id: target.character.id,
      character_name: target.character.name,
      video_id: vid,
      asset,
      library_asset: libraryAsset,
    };
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
  VOICE_FILTER_CHAIN,
  buildExtractArgs,
  parseSilenceDetectOutput,
  parseDialogueSpeakerEntries,
  buildRoleExtractionPlan,
  detectSpeechSegments,
  resolveVideoLocalFile,
  parseStoryboardCharacterIds,
  resolveTargetCharacter,
  buildVoiceAsset,
  extractStoryboardVoice,
};
