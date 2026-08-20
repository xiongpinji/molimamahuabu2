const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const realAssetService = require('./assetService');
const aiClient = require('./aiClient');
const { normalizeSourceFacts } = require('./redrawAnalysisService');

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function safeSegment(value, name) {
  const raw = String(value || '').trim();
  if (!raw) throw codedError('REDRAW_NATIVE_INPUT_REQUIRED', `${name} 必须提供`);
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function realpathIfExists(target) {
  try {
    return fs.realpathSync.native(target);
  } catch (_) {
    return null;
  }
}

function assertInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveStorageRoot(storageRoot) {
  const root = path.resolve(storageRoot || path.join(process.cwd(), 'data', 'storage'));
  ensureDir(root);
  return fs.realpathSync.native(root);
}

function resolveSourcePath(storageRoot, localPath) {
  const raw = String(localPath || '');
  if (!raw || path.isAbsolute(raw)) throw codedError('SOURCE_PATH_UNSAFE', '源视频路径必须是 storage 内相对路径');
  const normalized = path.normalize(raw);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw codedError('SOURCE_PATH_UNSAFE', '源视频路径越界');
  }
  const absolute = path.resolve(storageRoot, normalized);
  if (!assertInside(absolute, storageRoot)) throw codedError('SOURCE_PATH_UNSAFE', '源视频路径越界');
  const real = realpathIfExists(absolute);
  if (!real || !assertInside(real, storageRoot)) throw codedError('SOURCE_PATH_UNSAFE', '源视频不可读取或越界');
  return { absolute: real, relative: normalized.replace(/\\/g, '/') };
}

function execFileChecked(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = codedError('MEDIA_TOOL_FAILED', `${command} 失败: ${(stderr || error.message || '').slice(0, 300)}`);
        wrapped.cause = error;
        reject(wrapped);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.on('error', (error) => reject(error));
  });
}

async function ffprobeVideo(sourcePath, timeoutMs) {
  const { stdout } = await execFileChecked('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    sourcePath,
  ], timeoutMs);
  const payload = JSON.parse(stdout);
  const video = (payload.streams || []).find((stream) => stream.codec_type === 'video') || {};
  const durationSeconds = Number(video.duration || payload.format?.duration || 0);
  return {
    duration_ms: Math.max(1, Math.round(durationSeconds * 1000)),
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    codec: video.codec_name || null,
  };
}

const SHEET_COLUMNS = 4;
const SHEET_FRAMES = 12;
const DEFAULT_FONT_CANDIDATES = process.platform === 'win32' ? ['/Windows/Fonts/arial.ttf'] : [];

function sheetPlan(durationMs, mode) {
  const sampleRate = mode === 'lower_third' ? 2 : 1;
  const windowSeconds = SHEET_FRAMES / sampleRate;
  const durationSeconds = durationMs / 1000;
  const pages = [];
  for (let startSeconds = 0; startSeconds < durationSeconds; startSeconds += windowSeconds) {
    const pageDurationSeconds = Math.min(windowSeconds, durationSeconds - startSeconds);
    pages.push({
      startSeconds,
      durationSeconds: pageDurationSeconds,
      sampleRate,
      frameCount: Math.max(1, Math.ceil(pageDurationSeconds * sampleRate)),
    });
  }
  return pages;
}

function filterPath(filePath) {
  return String(filePath).replace(/\\/g, '/');
}

function selectFontFile(candidates = DEFAULT_FONT_CANDIDATES) {
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch (_) {
      return false;
    }
  }) || null;
}

function sheetFilter(mode, page, options = {}) {
  const rows = Math.ceil(page.frameCount / SHEET_COLUMNS);
  const prefix = mode === 'lower_third' ? 'crop=iw:ih/3:0:ih*2/3,' : '';
  const offset = page.startSeconds.toFixed(3);
  const fontFile = selectFontFile(options.fontCandidates);
  const fontOption = fontFile ? `fontfile=${filterPath(fontFile)}:` : '';
  const timestamp = `drawtext=${fontOption}text='page+${offset}s %{pts\\:hms}':x=4:y=4:fontsize=12:fontcolor=white:box=1:boxcolor=black@0.75`;
  return `${prefix}fps=${page.sampleRate},scale=240:-1,${timestamp},tile=${SHEET_COLUMNS}x${rows}:nb_frames=${page.frameCount}:padding=4:margin=4:color=black`;
}

async function createSheet(sourcePath, outputPath, mode, page, timeoutMs) {
  await execFileChecked('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', page.startSeconds.toFixed(3),
    '-i', sourcePath,
    '-t', page.durationSeconds.toFixed(3),
    '-vf', sheetFilter(mode, page),
    '-frames:v', '1',
    outputPath,
  ], timeoutMs);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function atomicWriteJson(filePath, payload) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const parsed = JSON.parse(candidate);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw codedError('VISION_JSON_INVALID', '视觉分析结果必须是 JSON 对象');
  }
  return parsed;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getWork(db, input) {
  const tenantId = String(input.tenantId ?? input.tenant_id ?? '');
  const userId = String(input.userId ?? input.user_id ?? '');
  const workId = Number(input.workId ?? input.work_id);
  if (!tenantId || !userId || !Number.isSafeInteger(workId)) {
    throw codedError('REDRAW_NATIVE_INPUT_REQUIRED', 'workId/tenantId/userId 必须提供');
  }
  const work = db.prepare(`
    SELECT * FROM redraw_works
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(workId, tenantId, userId);
  if (!work) throw codedError('REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
  return work;
}

function getAsset(db, assetId) {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId));
  if (!asset) throw codedError('SOURCE_ASSET_NOT_FOUND', '源视频资产不存在');
  return asset;
}

function buildPrompt(probe) {
  return [
    'You are analyzing a short-drama source video for strict 1:1 redraw facts v2.',
    'Return ONLY JSON with one top-level key named source_facts.',
    'source_facts.schema_version MUST be "2.0". Do not add explanations or any keys outside the schema.',
    'The images cover the full source in chronological pages. Every tile is labeled with its page offset and relative timestamp.',
    'Do not invent characters, scenes, props, reversals, dialogue, or timing that is not visible.',
    'For dialogue, use only provided audio transcript evidence or visibly burned-in subtitles. No transcript evidence is provided here, so do not guess speech from mouths, faces, or contact-sheet context.',
    'When dialogue evidence is absent, set audio_contract.dialogue_mode to "silent", keep dialogue empty, and keep speaker_mapping confidence low.',
    'Every spoken dialogue turn MUST contain id, speaker_id, source_text, integer start_ms, and integer end_ms.',
    'Shots MUST be chronological, continuous, gap-free, non-overlapping, start at 0, and end at duration_ms.',
    'Each shot MUST include composition, camera_movement, opening_state, continuous_action, ending_state, visible_character_ids, dialogue, text_regions, audio_contract, and confidence.',
    'text_regions polygon coordinates MUST be normalized 0..1 points with at least 3 non-collinear points.',
    'Use this exact source_facts schema:',
    '{"schema_version":"2.0","duration_ms":1,"story":[""],"characters":[{"id":"c1","source_name":"","display_name":"","relationship":"","relationships":[]}],"scenes":[{"id":"s1","location":"","time":"","source_ranges":[{"start_ms":0,"end_ms":1}]}],"props":[{"id":"p1","name":"","evidence_ranges":[{"start_ms":0,"end_ms":1}]}],"shots":[{"id":"shot-1","index":1,"start_ms":0,"end_ms":1,"composition":"","camera_movement":"","opening_state":"","continuous_action":"","ending_state":"","visible_character_ids":["c1"],"dialogue":[],"text_regions":[{"id":"txt1","kind":"subtitle","source_text":"","polygon":[[0.1,0.8],[0.9,0.8],[0.9,0.9],[0.1,0.9]]}],"audio_contract":{"dialogue_mode":"silent","ambient_audio":"preserve_or_rebuild"},"confidence":{"character_mapping":0.5,"speaker_mapping":0.2,"text_regions":0.5,"shot_boundary":0.5}}],"causal_chain":[""],"locked_facts":[""],"reversals":[""],"episode_hook":""}',
    'Keep all required arrays non-empty only when supported by visible evidence; an unsupported clip must fail rather than be completed with invented facts.',
    `Measured video metadata: duration_ms=${probe.duration_ms}, width=${probe.width || 'unknown'}, height=${probe.height || 'unknown'}.`,
  ].join('\n');
}

function assertStrictNativeFacts(facts, probe) {
  if (Math.abs(Number(facts.duration_ms) - Number(probe.duration_ms)) > 250) {
    throw codedError('REDRAW_NATIVE_DURATION_MISMATCH', '视觉分析时长与 ffprobe 实测时长不一致');
  }
  let previousShotEnd = 0;
  for (const [shotIndex, shot] of facts.shots.entries()) {
    if (Number(shot.start_ms) !== previousShotEnd) {
      throw codedError('REDRAW_NATIVE_TIMELINE_INCOMPLETE', `shots[${shotIndex}] 未形成无缝时间轴`);
    }
    previousShotEnd = Number(shot.end_ms);
    let previousDialogueEnd = Number(shot.start_ms);
    let previousOverlapGroup = null;
    for (const [dialogueIndex, line] of shot.dialogue.entries()) {
      if (!String(line.source_text || '').trim()) continue;
      if (!Number.isSafeInteger(line.start_ms) || !Number.isSafeInteger(line.end_ms)) {
        throw codedError(
          'REDRAW_NATIVE_DIALOGUE_TIMING_REQUIRED',
          `shots[${shotIndex}].dialogue[${dialogueIndex}] 缺少严格时间码`,
        );
      }
      const overlapGroup = line.overlap_group || null;
      if (line.start_ms < previousDialogueEnd
        && (!overlapGroup || overlapGroup !== previousOverlapGroup)) {
        throw codedError(
          'REDRAW_NATIVE_DIALOGUE_TIMING_INVALID',
          `shots[${shotIndex}].dialogue[${dialogueIndex}] 时间码重叠`,
        );
      }
      previousDialogueEnd = Math.max(previousDialogueEnd, line.end_ms);
      previousOverlapGroup = overlapGroup;
    }
  }
  if (previousShotEnd !== Number(facts.duration_ms)) {
    throw codedError('REDRAW_NATIVE_TIMELINE_INCOMPLETE', '分镜时间轴未覆盖完整源片');
  }
}

function relativeToStorage(storageRoot, absolutePath) {
  return path.relative(storageRoot, absolutePath).replace(/\\/g, '/');
}

function safeMediaProbeMetadata(probe, sheetCount) {
  return {
    duration_ms: Number(probe.duration_ms) || 0,
    width: Number(probe.width) || 0,
    height: Number(probe.height) || 0,
    codec: probe.codec ? String(probe.codec) : 'unknown',
    sheet_count: Number(sheetCount) || 0,
  };
}

function hasVisibleDialogueTextEvidence(shot) {
  return Array.isArray(shot.text_regions) && shot.text_regions.some((region) => (
    region
    && ['subtitle', 'screen_text'].includes(region.kind)
    && typeof region.source_text === 'string'
    && region.source_text.trim()
  ));
}

function applyNoTranscriptEvidencePolicy(rawFacts) {
  const facts = cloneJson(rawFacts);
  const shots = Array.isArray(facts.shots) ? facts.shots : [];
  for (const [index, shot] of shots.entries()) {
    const dialogue = Array.isArray(shot.dialogue) ? shot.dialogue : [];
    const mode = shot.audio_contract && shot.audio_contract.dialogue_mode;
    if ((mode === 'spoken' || dialogue.length > 0) && !hasVisibleDialogueTextEvidence(shot)) {
      throw codedError(
        'REDRAW_NATIVE_DIALOGUE_TEXT_EVIDENCE_REQUIRED',
        `shots[${index}] 无音频转写时 spoken dialogue 必须有可见字幕文本证据`,
      );
    }
    if (shot.confidence && typeof shot.confidence === 'object' && !Array.isArray(shot.confidence)) {
      shot.confidence.speaker_mapping = 0;
    }
  }
  return facts;
}

async function analyzeNativeSource(ctx = {}, input = {}) {
  const db = ctx.db;
  if (!db) throw codedError('REDRAW_NATIVE_DB_REQUIRED', '缺少数据库');
  const log = ctx.log || { info() {}, warn() {}, error() {} };
  const assetService = ctx.assetService || realAssetService;
  const visionDetailed = ctx.visionDetailed || ((payload) => aiClient.generateTextWithVisionDetailed(
    db,
    log,
    ctx.serviceType || 'video_understanding',
    payload.userPrompt,
    payload.systemPrompt,
    { imageSources: payload.imageSources },
    payload.options,
  ));
  const storageRoot = resolveStorageRoot(ctx.storageRoot);
  const taskId = safeSegment(input.taskId || input.task_id, 'taskId');
  const workDir = path.join(storageRoot, 'redraw-analysis', taskId);
  const sheetDir = fs.mkdtempSync(path.join(os.tmpdir(), `redraw-native-${taskId}-`));
  const createdWorkDir = !fs.existsSync(workDir);
  const createdPaths = [];

  try {
    const work = getWork(db, input);
    const sourceAsset = getAsset(db, work.source_asset_id);
    const source = resolveSourcePath(storageRoot, sourceAsset.local_path);
    ensureDir(workDir);
    const probe = await ffprobeVideo(source.absolute, Number(input.probeTimeoutMs || 15000));
    const sheets = [];
    for (const mode of ['full', 'lower_third']) {
      const pages = sheetPlan(probe.duration_ms, mode);
      for (const [index, page] of pages.entries()) {
        const sheetPath = path.join(sheetDir, `contact-sheet-${mode}-${index + 1}.jpg`);
        await createSheet(
          source.absolute,
          sheetPath,
          mode,
          page,
          Number(input.ffmpegTimeoutMs || 30000),
        );
        sheets.push({ mode, path: sheetPath, sha256: sha256File(sheetPath) });
      }
    }

    const vision = await visionDetailed({
      userPrompt: buildPrompt(probe),
      systemPrompt: 'Return strict JSON only for short-drama source analysis.',
      imageSources: sheets.map((sheet) => ({ localAbsPath: sheet.path })),
      options: { model: input.model || undefined, max_tokens: Number(input.maxTokens || 8000), temperature: 0.1 },
      source: { work_id: Number(work.id), source_asset_id: Number(sourceAsset.id) },
    });
    if (!vision?.provider_task_id) {
      throw codedError('VISION_PROVIDER_RESPONSE_ID_MISSING', '视觉分析缺少真实 provider response id');
    }
    const parsed = parseJsonObject(vision.text);
    const facts = normalizeSourceFacts(applyNoTranscriptEvidencePolicy(parsed.source_facts || parsed));
    assertStrictNativeFacts(facts, probe);
    const mediaProbe = safeMediaProbeMetadata(probe, sheets.length);
    const output = {
      schema_version: '2.0',
      work_id: Number(work.id),
      source_asset_id: Number(sourceAsset.id),
      provider_task_id: String(vision.provider_task_id),
      model: vision.model || input.model || null,
      usage: vision.usage || null,
      raw_hash: vision.raw_hash || null,
      facts,
      diagnostics: {
        source: {
          relative_path_hash: crypto.createHash('sha256').update(source.relative).digest('hex'),
          duration_ms: probe.duration_ms,
          width: probe.width,
          height: probe.height,
          codec: probe.codec,
        },
        sheets: sheets.map((sheet) => ({ mode: sheet.mode, sha256: sheet.sha256 })),
      },
    };
    const resultPath = path.join(workDir, 'source-analysis.json');
    atomicWriteJson(resultPath, output);
    createdPaths.push(resultPath);
    const resultHash = sha256File(resultPath);
    const stats = fs.statSync(resultPath);
    const resultAsset = assetService.create(db, log, {
      name: `转绘源片分析 ${work.id}`,
      type: 'json',
      category: 'redraw_source_analysis',
      local_path: relativeToStorage(storageRoot, resultPath),
      file_size: stats.size,
      mime_type: 'application/json',
      metadata: {
        tenant_id: String(input.tenantId ?? input.tenant_id),
        user_id: String(input.userId ?? input.user_id),
        work_id: Number(work.id),
        source_asset_id: Number(sourceAsset.id),
        provider_task_id: String(vision.provider_task_id),
        schema_version: '2.0',
        media_probe: mediaProbe,
        sha256: resultHash,
        facts_hash: facts.facts_hash,
      },
    });
    return {
      status: 'completed',
      provider_task_id: String(vision.provider_task_id),
      result_asset_id: resultAsset.id,
      facts,
      sha256: resultHash,
      diagnostics: {
        duration_ms: probe.duration_ms,
        width: probe.width,
        height: probe.height,
        sheet_count: sheets.length,
        raw_hash: vision.raw_hash || null,
      },
    };
  } catch (error) {
    if (createdWorkDir) {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } else {
      for (const createdPath of createdPaths.reverse()) {
        fs.rmSync(createdPath, { force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
    throw error;
  } finally {
    fs.rmSync(sheetDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

module.exports = {
  analyzeNativeSource,
  buildPrompt,
  sheetFilter,
  parseJsonObject,
};
