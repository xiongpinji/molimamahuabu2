const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const realAssetService = require('./assetService');
const aiClient = require('./aiClient');
const { normalizeSourceFacts } = require('./redrawAnalysisService');
const { enrichSourceFacts } = require('./redrawSourceEnrichmentService');
const {
  assertSourceDurationAllowed,
  planSegments,
  segmentCountForDuration,
} = require('./redrawAnalysisSegmentation');
const { knownCastFrom, mergeSegmentFacts } = require('./redrawSegmentFactsMerge');

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
const DEFAULT_FONT_CANDIDATES = process.platform === 'win32'
  ? [
      path.join(__dirname, '..', '..', 'data', 'fonts', 'arial.ttf'),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts', 'arial.ttf'),
    ]
  : [];

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
  // ffmpeg filter options use ':' as a separator, so absolute Windows paths
  // (D:/foo/bar.ttf) must have ':' escaped and be quoted for the graph parser.
  const escaped = String(filePath)
    .replace(/\\/g, '/')
    .replace(/'/g, "'\\''")
    .replace(/:/g, '\\:');
  return `'${escaped}'`;
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

function buildPrompt(probe, options = {}) {
  const knownCast = Array.isArray(options.knownCast) ? options.knownCast : [];
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
    'characters[].source_name is the name written or addressed in the subtitles (for example a name someone calls out); if a character is never named, use a short Chinese descriptor such as 母亲. Never leave source_name empty.',
    'characters[].relationships is an array of plain strings such as "c2: 嘲笑他的同学", never objects.',
    'Write every free-text field in Simplified Chinese: story, display_name, relationship, relationships, scene location and time, prop names, composition, camera_movement, opening_state, continuous_action, ending_state, causal_chain, locked_facts, reversals, and episode_hook. Keep ids, enum values (kind, dialogue_mode, ambient_audio) and subtitle or dialogue source_text exactly as they appear.',
    'Inside those free-text fields refer to people by their source_name (for example 林江), never by ids such as c1 or c2.',
    'Use this exact source_facts schema:',
    '{"schema_version":"2.0","duration_ms":1,"story":[""],"characters":[{"id":"c1","source_name":"","display_name":"","relationship":"","relationships":[]}],"scenes":[{"id":"s1","location":"","time":"","source_ranges":[{"start_ms":0,"end_ms":1}]}],"props":[{"id":"p1","name":"","evidence_ranges":[{"start_ms":0,"end_ms":1}]}],"shots":[{"id":"shot-1","index":1,"start_ms":0,"end_ms":1,"composition":"","camera_movement":"","opening_state":"","continuous_action":"","ending_state":"","visible_character_ids":["c1"],"dialogue":[],"text_regions":[{"id":"txt1","kind":"subtitle","source_text":"","polygon":[[0.1,0.8],[0.9,0.8],[0.9,0.9],[0.1,0.9]]}],"audio_contract":{"dialogue_mode":"silent","ambient_audio":"preserve_or_rebuild"},"confidence":{"character_mapping":0.5,"speaker_mapping":0.2,"text_regions":0.5,"shot_boundary":0.5}}],"causal_chain":[""],"locked_facts":[""],"reversals":[""],"episode_hook":""}',
    'Keep all required arrays non-empty only when supported by visible evidence; an unsupported clip must fail rather than be completed with invented facts.',
    ...(knownCast.length
      ? [
        'This clip is one part of a longer episode. Characters already identified in earlier parts are listed below; when the same person appears, reuse the exact source_name. Add a new character only for a new person.',
        JSON.stringify(knownCast),
      ]
      : []),
    `Measured video metadata: duration_ms=${probe.duration_ms}, width=${probe.width || 'unknown'}, height=${probe.height || 'unknown'}.`,
  ].filter((line) => line !== undefined).join('\n');
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

// 模型偶尔把角色关系写成对象、或漏掉 source_name：就地转成文本 / 用显示名补上，不让格式小偏差作废整次付费分析。
function coerceCharacterFields(rawFacts) {
  const facts = cloneJson(rawFacts);
  for (const character of Array.isArray(facts.characters) ? facts.characters : []) {
    if (!character || typeof character !== 'object') continue;
    if (Array.isArray(character.relationships)) {
      character.relationships = character.relationships.map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const target = String(item.character_id || item.id || '').trim();
        const relation = String(item.relationship || item.description || item.relation || '').trim();
        return [target, relation].filter(Boolean).join(': ');
      }).filter(Boolean);
    }
    if (!String(character.source_name || '').trim() && String(character.display_name || '').trim()) {
      character.source_name = String(character.display_name).trim();
    }
  }
  return facts;
}

// 台词常跨剪辑点，模型会把时间码写到相邻分镜里：夹到所属分镜范围内，与分镜不相交的条目丢弃（字幕仍在 text_regions 里）；
// 夹紧后与前一句重叠且不属于同一 overlap_group 的，起点顺延到前一句结束，顺延后为空的丢弃。与分段拼接时的处理一致。
function clampShotDialogueTimecodes(shot) {
  const shotStart = Number(shot.start_ms);
  const shotEnd = Number(shot.end_ms);
  if (!Array.isArray(shot.dialogue) || !Number.isSafeInteger(shotStart) || !Number.isSafeInteger(shotEnd) || shotEnd <= shotStart) return;
  let previousEnd = shotStart;
  let previousGroup = null;
  shot.dialogue = shot.dialogue.filter((turn) => {
    if (turn.start_ms == null || turn.end_ms == null) return true;
    const rawStart = Number(turn.start_ms);
    const rawEnd = Number(turn.end_ms);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return true;
    let start = Math.min(shotEnd, Math.max(shotStart, Math.round(rawStart)));
    const end = Math.min(shotEnd, Math.max(shotStart, Math.round(rawEnd)));
    const group = turn.overlap_group || null;
    if (start < previousEnd && (!group || group !== previousGroup)) start = previousEnd;
    if (end <= start) return false;
    turn.start_ms = start;
    turn.end_ms = end;
    previousEnd = Math.max(previousEnd, end);
    previousGroup = group;
    return true;
  });
}

// 模型偶尔自创 dialogue_mode（如 subtitle_only），或把画外音写成台词条目。
// 说话人不在画面里的台词条目丢弃（对应字幕仍在 text_regions 里）；dialogue_mode 按剩余台词归为 spoken / silent。
function coerceShotAudioContracts(rawFacts) {
  const facts = cloneJson(rawFacts);
  for (const shot of Array.isArray(facts.shots) ? facts.shots : []) {
    if (!shot || typeof shot !== 'object') continue;
    if (Array.isArray(shot.dialogue)) shot.dialogue = shot.dialogue.filter((turn) => turn && typeof turn === 'object');
    if (Array.isArray(shot.dialogue) && Array.isArray(shot.visible_character_ids)) {
      const visible = new Set(shot.visible_character_ids.map(String));
      shot.dialogue = shot.dialogue.filter((turn) => visible.has(String(turn.speaker_id)));
    }
    clampShotDialogueTimecodes(shot);
    const contract = shot.audio_contract;
    if (!contract || typeof contract !== 'object') continue;
    const hasDialogue = Array.isArray(shot.dialogue) && shot.dialogue.length > 0;
    if (!['spoken', 'silent'].includes(contract.dialogue_mode)
      || (contract.dialogue_mode === 'spoken' && !hasDialogue)
      || (contract.dialogue_mode === 'silent' && hasDialogue)) {
      contract.dialogue_mode = hasDialogue ? 'spoken' : 'silent';
    }
  }
  return facts;
}

const KNOWN_TEXT_REGION_KINDS = new Set(['subtitle', 'screen_text', 'sign', 'title', 'label']);

function uniqueWithinFacts(seen, id, shotId, fallback) {
  const base = String(id || fallback);
  let candidate = seen.has(base) ? `${base}-${shotId}` : base;
  for (let suffix = 2; seen.has(candidate); suffix += 1) candidate = `${base}-${shotId}-${suffix}`;
  seen.add(candidate);
  return candidate;
}

function coerceTextRegionKinds(rawFacts) {
  const facts = cloneJson(rawFacts);
  const regionIds = new Set();
  const turnIds = new Set();
  for (const shot of Array.isArray(facts.shots) ? facts.shots : []) {
    const shotId = String(shot?.id || '');
    for (const [index, region] of (Array.isArray(shot?.text_regions) ? shot.text_regions : []).entries()) {
      if (!region || typeof region !== 'object') continue;
      if (!KNOWN_TEXT_REGION_KINDS.has(region.kind)) region.kind = 'screen_text';
      region.id = uniqueWithinFacts(regionIds, region.id, shotId, `txt${index + 1}`);
    }
    for (const [index, turn] of (Array.isArray(shot?.dialogue) ? shot.dialogue : []).entries()) {
      if (turn && typeof turn === 'object') turn.id = uniqueWithinFacts(turnIds, turn.id, shotId, `t${index + 1}`);
    }
  }
  return facts;
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

// 镜头切换检测（尽力而为）：失败时返回空数组，分段边界退回均分。
async function detectSceneCuts(sourcePath, timeoutMs) {
  try {
    const { stderr } = await execFileChecked('ffmpeg', [
      '-hide_banner', '-nostats', '-i', sourcePath, '-an', '-sn',
      '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-',
    ], timeoutMs);
    return [...String(stderr).matchAll(/pts_time:([0-9.]+)/g)].map((match) => Math.round(Number(match[1]) * 1000));
  } catch (_) {
    return [];
  }
}

async function cutSegmentClip(sourcePath, outputPath, segment, timeoutMs) {
  await execFileChecked('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', (segment.start_ms / 1000).toFixed(3),
    '-i', sourcePath,
    '-t', ((segment.end_ms - segment.start_ms) / 1000).toFixed(3),
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    outputPath,
  ], timeoutMs);
}

/**
 * 对一段视频做两段式分析：拼图 → 第一段（拆镜、字幕、名字）→ 校验 → 第二段补外观。
 * 返回已合并补充信息的原始事实；第一段校验不过时直接抛错，不再付第二段的钱。
 */
async function analyzeClip(ctx) {
  const { sourcePath, probe, sheetDir, input, visionDetailed, visionOptions, visionSource, log } = ctx;
  ensureDir(sheetDir);
  const sheets = [];
  for (const mode of ['full', 'lower_third']) {
    const pages = sheetPlan(probe.duration_ms, mode);
    for (const [index, page] of pages.entries()) {
      const sheetPath = path.join(sheetDir, `contact-sheet-${mode}-${index + 1}.jpg`);
      await createSheet(sourcePath, sheetPath, mode, page, Number(input.ffmpegTimeoutMs || 30000));
      sheets.push({ mode, path: sheetPath, sha256: sha256File(sheetPath) });
    }
  }
  const imageSources = sheets.map((sheet) => ({ localAbsPath: sheet.path }));
  const vision = await visionDetailed({
    userPrompt: buildPrompt(probe, { knownCast: ctx.knownCast }),
    systemPrompt: 'Return strict JSON only for short-drama source analysis.',
    imageSources,
    options: { ...visionOptions, max_tokens: Number(input.maxTokens || 16000) },
    source: visionSource,
  });
  if (!vision?.provider_task_id) {
    throw codedError('VISION_PROVIDER_RESPONSE_ID_MISSING', '视觉分析缺少真实 provider response id');
  }
  const parsed = parseJsonObject(vision.text);
  const firstPass = coerceTextRegionKinds(coerceShotAudioContracts(coerceCharacterFields(parsed.source_facts || parsed)));
  assertStrictNativeFacts(normalizeSourceFacts(applyNoTranscriptEvidencePolicy(firstPass)), probe);
  const { facts, enrichment } = await enrichSourceFacts({
    visionDetailed,
    parseJsonObject,
    imageSources,
    options: visionOptions,
    source: visionSource,
    log,
  }, firstPass);
  return { facts, enrichment, vision, sheets };
}

// 服务商偶发卡住（同类调用通常 1~2 分钟返回，偶尔 9 分钟无响应）：某一段超时只把这一段重跑一次，其它错误照常失败。
function isProviderTimeout(error) {
  const code = String(error?.code || error?.routeMeta?.transportCode || '');
  return /TIMEOUT/.test(code) || /request timeout after|silence timeout after/i.test(String(error?.message || ''));
}

async function analyzeClipWithRetry(clipArgs, label) {
  try {
    return await analyzeClip(clipArgs);
  } catch (error) {
    if (!isProviderTimeout(error)) throw error;
    clipArgs.log?.warn?.('redraw native analysis timed out, retrying this part once', { part: label, message: error.message });
    return analyzeClip(clipArgs);
  }
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
    assertSourceDurationAllowed(probe.duration_ms);
    // 整集样片的逐镜分析输出很长，推理模型常超过通用视觉调用的 120 秒；单次调用放宽到 9 分钟。
    const visionOptions = {
      model: input.model || undefined,
      temperature: 0.1,
      timeout_ms: Number(input.visionTimeoutMs || 540000),
    };
    const visionSource = { work_id: Number(work.id), source_asset_id: Number(sourceAsset.id) };
    const segmentCount = Number(input.segmentCount) || segmentCountForDuration(probe.duration_ms);
    const clipCtx = { input, visionDetailed, visionOptions, visionSource, log };
    let enrichedFacts;
    let enrichment;
    let vision;
    let sheets;
    let segmentsReport = null;
    if (segmentCount <= 1) {
      const clip = await analyzeClipWithRetry({ ...clipCtx, sourcePath: source.absolute, probe, sheetDir }, 'whole');
      ({ facts: enrichedFacts, enrichment, vision, sheets } = clip);
    } else {
      // 长样片按段依次分析：每段输出小、不易超时；后面的段带上前面已识别的角色名单。
      const cuts = await detectSceneCuts(source.absolute, Number(input.sceneDetectTimeoutMs || 120000));
      const plan = planSegments(probe.duration_ms, segmentCount, cuts);
      const analyzed = [];
      segmentsReport = [];
      sheets = [];
      for (const [index, segment] of plan.entries()) {
        const segmentDir = path.join(sheetDir, `segment-${index + 1}`);
        ensureDir(segmentDir);
        const clipPath = path.join(segmentDir, 'clip.mp4');
        await cutSegmentClip(source.absolute, clipPath, segment, Number(input.ffmpegTimeoutMs || 30000) * 4);
        const clipProbe = await ffprobeVideo(clipPath, Number(input.probeTimeoutMs || 15000));
        const clip = await analyzeClipWithRetry({
          ...clipCtx,
          sourcePath: clipPath,
          probe: clipProbe,
          sheetDir: segmentDir,
          knownCast: knownCastFrom(mergeSegmentFacts(analyzed, analyzed.length ? analyzed[analyzed.length - 1].end_ms : 0)),
        }, `segment ${index + 1}/${plan.length}`);
        analyzed.push({ ...segment, facts: clip.facts });
        sheets.push(...clip.sheets);
        vision = vision || clip.vision;
        segmentsReport.push({
          start_ms: segment.start_ms,
          end_ms: segment.end_ms,
          provider_task_id: String(clip.vision.provider_task_id),
          usage: clip.vision.usage || null,
          enrichment: clip.enrichment,
        });
        if (typeof ctx.onProgress === 'function') ctx.onProgress({ completed: index + 1, total: plan.length });
      }
      enrichedFacts = mergeSegmentFacts(analyzed, probe.duration_ms);
      const enrichmentStatuses = segmentsReport.map((item) => item.enrichment?.status);
      enrichment = {
        status: enrichmentStatuses.every((status) => status === 'completed') ? 'completed'
          : enrichmentStatuses.some((status) => status === 'completed') ? 'partial' : 'failed',
      };
    }
    const facts = normalizeSourceFacts(applyNoTranscriptEvidencePolicy(enrichedFacts));
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
      enrichment,
      segments: segmentsReport,
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
  coerceCharacterFields,
  coerceShotAudioContracts,
  coerceTextRegionKinds,
  buildPrompt,
  sheetFilter,
  parseJsonObject,
};
