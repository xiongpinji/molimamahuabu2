const { createHash } = require('crypto');

const {
  normalizeEpisodeFactsV2,
  stableStringify,
} = require('./redrawEpisodeFactsService');

const BLUEPRINT_FIELDS = [
  'schema_version', 'source', 'evidence_manifest', 'story', 'characters',
  'scenes', 'props', 'shots', 'causal_chain', 'locked_facts', 'reversals',
  'episode_hook', 'review', 'blueprint_hash',
];

const SHOT_FIELDS = [
  'id', 'index', 'start_ms', 'end_ms', 'composition', 'camera_movement',
  'opening_state', 'continuous_action', 'ending_state', 'visible_character_ids',
  'dialogue', 'text_regions', 'audio_contract', 'confidence', 'evidence_refs',
];

const DIALOGUE_EVIDENCE_KINDS = new Set([
  'asr', 'audio', 'audio_transcript', 'subtitle', 'transcript',
]);

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function codedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function compareCodeUnit(left, right) {
  const a = String(left);
  const b = String(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${name} 不允许继承字段`);
  }
}

function assertExactKeys(value, allowed, required, name) {
  assertPlainObject(value, name);
  const allowedSet = new Set(allowed);
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${name}.${key} 继承字段`);
    }
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) throw new Error(`${name}.${key} 危险字段`);
    if (!allowedSet.has(key)) throw new Error(`${name}.${key} 未知字段`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${name}.${key} 必须提供`);
    }
  }
}

function assertArray(value, name, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
  if (nonEmpty && value.length === 0) throw new Error(`${name} 必须是非空数组`);
}

function safeText(value, name, maxLength = 500) {
  if (typeof value !== 'string') throw new Error(`${name} 必须是文本`);
  const text = value.trim();
  if (!text) throw new Error(`${name} 必须提供`);
  if (text.length > maxLength) throw new Error(`${name} 过长`);
  if (/(?:https?:\/\/|file:\/\/|^[a-zA-Z]:[\\/]|^\\\\|api[_-]?key|bearer\s+|prompt\s*:)/i.test(text)) {
    throw new Error(`${name} 包含危险路径、URL 或凭据`);
  }
  return text;
}

function optionalText(value, name, maxLength = 500) {
  if (value == null || value === '') return undefined;
  return safeText(value, name, maxLength);
}

function stableId(value, name) {
  const id = safeText(value, name, 96);
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`${name} id 不稳定`);
  return id;
}

function assetId(value, name) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  return stableId(value, name);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 时间码无效`);
  return value;
}

function probability(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} confidence 无效`);
  return value;
}

function normalizeSource(raw) {
  const fields = [
    'asset_id', 'sha256', 'duration_ms', 'width', 'height', 'fps',
    'video_codec', 'audio_codec', 'audio_sample_rate_hz', 'audio_channels',
  ];
  assertExactKeys(raw, fields, fields, 'source');
  if (!Number.isFinite(raw.fps) || raw.fps <= 0) throw new Error('source.fps 无效');
  return {
    asset_id: assetId(raw.asset_id, 'source.asset_id'),
    sha256: safeText(raw.sha256, 'source.sha256', 64),
    duration_ms: positiveInteger(raw.duration_ms, 'source.duration_ms'),
    width: positiveInteger(raw.width, 'source.width'),
    height: positiveInteger(raw.height, 'source.height'),
    fps: raw.fps,
    video_codec: safeText(raw.video_codec, 'source.video_codec', 64),
    audio_codec: safeText(raw.audio_codec, 'source.audio_codec', 64),
    audio_sample_rate_hz: positiveInteger(raw.audio_sample_rate_hz, 'source.audio_sample_rate_hz'),
    audio_channels: positiveInteger(raw.audio_channels, 'source.audio_channels'),
  };
}

function normalizeEvidenceManifest(raw) {
  assertExactKeys(raw, ['items'], ['items'], 'evidence_manifest');
  assertArray(raw.items, 'evidence_manifest.items', { nonEmpty: true });
  const seen = new Set();
  const items = raw.items.map((item, index) => {
    const name = `evidence_manifest.items[${index}]`;
    assertExactKeys(
      item,
      ['id', 'kind', 'asset_id', 'sha256', 'tool', 'tool_version'],
      ['id', 'kind', 'asset_id', 'sha256', 'tool', 'tool_version'],
      name,
    );
    const id = stableId(item.id, `${name}.id`);
    if (seen.has(id)) throw new Error(`${name}.id 重复`);
    seen.add(id);
    return {
      id,
      kind: stableId(item.kind, `${name}.kind`),
      asset_id: assetId(item.asset_id, `${name}.asset_id`),
      sha256: safeText(item.sha256, `${name}.sha256`, 64),
      tool: safeText(item.tool, `${name}.tool`, 120),
      tool_version: safeText(item.tool_version, `${name}.tool_version`, 120),
    };
  }).sort((a, b) => compareCodeUnit(a.id, b.id));
  return { items };
}

function evidenceIndex(manifest) {
  return new Map(manifest.items.map((item) => [item.id, item]));
}

function normalizeEvidenceRefs(value, name, evidence, { nonEmpty = true } = {}) {
  assertArray(value, name, { nonEmpty });
  const seen = new Set();
  return value.map((item, index) => {
    const id = stableId(item, `${name}[${index}]`);
    if (seen.has(id)) throw new Error(`${name} 重复`);
    if (!evidence.has(id)) throw new Error(`${name}[${index}] 未知证据`);
    seen.add(id);
    return id;
  }).sort(compareCodeUnit);
}

function normalizeStory(raw, evidence) {
  assertExactKeys(raw, ['summary', 'beats', 'evidence_refs', 'confidence'], ['summary', 'beats', 'evidence_refs', 'confidence'], 'story');
  assertArray(raw.beats, 'story.beats', { nonEmpty: true });
  return {
    summary: safeText(raw.summary, 'story.summary', 1_000),
    beats: raw.beats.map((item, index) => safeText(item, `story.beats[${index}]`, 500)),
    evidence_refs: normalizeEvidenceRefs(raw.evidence_refs, 'story.evidence_refs', evidence),
    confidence: probability(raw.confidence, 'story.confidence'),
  };
}

function normalizeStringList(value, name, { sort = false } = {}) {
  assertArray(value, name);
  const normalized = value.map((item, index) => safeText(item, `${name}[${index}]`, 500));
  return sort ? normalized.sort(compareCodeUnit) : normalized;
}

function normalizeCharacters(raw, evidence) {
  assertArray(raw, 'characters', { nonEmpty: true });
  const seen = new Set();
  return raw.map((character, index) => {
    const name = `characters[${index}]`;
    const fields = [
      'id', 'source_name', 'display_name', 'relationship', 'relationships',
      'face_track_ids', 'evidence_refs', 'confidence', 'review_status',
    ];
    assertExactKeys(character, fields, fields, name);
    const id = stableId(character.id, `${name}.id`);
    if (seen.has(id)) throw new Error(`${name}.id 重复`);
    seen.add(id);
    if (!['needs_review', 'approved'].includes(character.review_status)) {
      throw new Error(`${name}.review_status 无效`);
    }
    const faceTrackIds = normalizeStringList(character.face_track_ids, `${name}.face_track_ids`, { sort: true })
      .map((item, faceIndex) => stableId(item, `${name}.face_track_ids[${faceIndex}]`));
    if (new Set(faceTrackIds).size !== faceTrackIds.length) throw new Error(`${name}.face_track_ids 重复`);
    return {
      id,
      source_name: safeText(character.source_name, `${name}.source_name`, 120),
      display_name: safeText(character.display_name, `${name}.display_name`, 120),
      relationship: safeText(character.relationship, `${name}.relationship`, 200),
      relationships: normalizeStringList(character.relationships, `${name}.relationships`, { sort: true }),
      face_track_ids: faceTrackIds,
      evidence_refs: normalizeEvidenceRefs(character.evidence_refs, `${name}.evidence_refs`, evidence),
      confidence: probability(character.confidence, `${name}.confidence`),
      review_status: character.review_status,
    };
  }).sort((a, b) => compareCodeUnit(a.id, b.id));
}

function normalizeRanges(raw, name, durationMs) {
  assertArray(raw, name, { nonEmpty: true });
  let previousEnd = -1;
  return raw.map((range, index) => {
    const itemName = `${name}[${index}]`;
    assertExactKeys(range, ['start_ms', 'end_ms'], ['start_ms', 'end_ms'], itemName);
    const start = timestamp(range.start_ms, `${itemName}.start_ms`);
    const end = timestamp(range.end_ms, `${itemName}.end_ms`);
    if (end <= start || end > durationMs) throw new Error(`${itemName} 时间码越界`);
    return { start_ms: start, end_ms: end };
  }).sort((a, b) => (a.start_ms - b.start_ms) || (a.end_ms - b.end_ms)).map((range) => {
    if (range.start_ms < previousEnd) throw new Error(`${name} 时间码重叠`);
    previousEnd = range.end_ms;
    return range;
  });
}

function normalizeScenes(raw, durationMs, evidence) {
  assertArray(raw, 'scenes', { nonEmpty: true });
  const seen = new Set();
  return raw.map((scene, index) => {
    const name = `scenes[${index}]`;
    const fields = ['id', 'location', 'time', 'source_ranges', 'evidence_refs', 'confidence'];
    assertExactKeys(scene, fields, fields, name);
    const id = stableId(scene.id, `${name}.id`);
    if (seen.has(id)) throw new Error(`${name}.id 重复`);
    seen.add(id);
    return {
      id,
      location: safeText(scene.location, `${name}.location`, 200),
      time: safeText(scene.time, `${name}.time`, 120),
      source_ranges: normalizeRanges(scene.source_ranges, `${name}.source_ranges`, durationMs),
      evidence_refs: normalizeEvidenceRefs(scene.evidence_refs, `${name}.evidence_refs`, evidence),
      confidence: probability(scene.confidence, `${name}.confidence`),
    };
  }).sort((a, b) => compareCodeUnit(a.id, b.id));
}

function normalizeProps(raw, durationMs, evidence) {
  assertArray(raw, 'props', { nonEmpty: true });
  const seen = new Set();
  return raw.map((prop, index) => {
    const name = `props[${index}]`;
    const fields = ['id', 'name', 'evidence_ranges', 'evidence_refs', 'confidence'];
    assertExactKeys(prop, fields, fields, name);
    const id = stableId(prop.id, `${name}.id`);
    if (seen.has(id)) throw new Error(`${name}.id 重复`);
    seen.add(id);
    return {
      id,
      name: safeText(prop.name, `${name}.name`, 200),
      evidence_ranges: normalizeRanges(prop.evidence_ranges, `${name}.evidence_ranges`, durationMs),
      evidence_refs: normalizeEvidenceRefs(prop.evidence_refs, `${name}.evidence_refs`, evidence),
      confidence: probability(prop.confidence, `${name}.confidence`),
    };
  }).sort((a, b) => compareCodeUnit(a.id, b.id));
}

function normalizePolygon(raw, name) {
  assertArray(raw, name, { nonEmpty: true });
  if (raw.length < 3) throw new Error(`${name} polygon 点数不足`);
  const points = raw.map((point, index) => {
    assertArray(point, `${name}[${index}]`);
    if (point.length !== 2) throw new Error(`${name}[${index}] polygon 坐标无效`);
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      throw new Error(`${name}[${index}] polygon 坐标越界`);
    }
    return [x, y];
  });
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    area += (x1 * y2) - (x2 * y1);
  }
  if (Math.abs(area) / 2 <= 0.000001) throw new Error(`${name} polygon 面积无效`);
  return points;
}

function normalizeTextRegions(raw, name, evidence, seenIds) {
  assertArray(raw, name);
  return raw.map((region, index) => {
    const itemName = `${name}[${index}]`;
    const fields = ['id', 'kind', 'polygon', 'source_text', 'evidence_refs', 'confidence'];
    assertExactKeys(region, fields, fields, itemName);
    const id = stableId(region.id, `${itemName}.id`);
    if (seenIds.has(id)) throw new Error(`${itemName}.id 重复`);
    seenIds.add(id);
    if (!['subtitle', 'screen_text', 'sign', 'title', 'label'].includes(region.kind)) {
      throw new Error(`${itemName}.kind 无效`);
    }
    const normalized = {
      id,
      kind: region.kind,
      polygon: normalizePolygon(region.polygon, `${itemName}.polygon`),
      evidence_refs: normalizeEvidenceRefs(region.evidence_refs, `${itemName}.evidence_refs`, evidence),
      confidence: probability(region.confidence, `${itemName}.confidence`),
    };
    const sourceText = optionalText(region.source_text, `${itemName}.source_text`, 300);
    if (sourceText) normalized.source_text = sourceText;
    return normalized;
  }).sort((a, b) => compareCodeUnit(a.id, b.id));
}

function normalizeAudioContract(raw, name) {
  assertExactKeys(raw, ['dialogue_mode', 'ambient_audio'], ['dialogue_mode', 'ambient_audio'], name);
  if (!['spoken', 'silent'].includes(raw.dialogue_mode)) throw new Error(`${name}.dialogue_mode 无效`);
  if (raw.ambient_audio !== 'preserve_or_rebuild') throw new Error(`${name}.ambient_audio 无效`);
  return { dialogue_mode: raw.dialogue_mode, ambient_audio: raw.ambient_audio };
}

function normalizeShotConfidence(raw, name) {
  const fields = ['character_mapping', 'speaker_mapping', 'text_regions', 'shot_boundary'];
  assertExactKeys(raw, fields, fields, name);
  return {
    character_mapping: probability(raw.character_mapping, `${name}.character_mapping`),
    speaker_mapping: probability(raw.speaker_mapping, `${name}.speaker_mapping`),
    text_regions: probability(raw.text_regions, `${name}.text_regions`),
    shot_boundary: probability(raw.shot_boundary, `${name}.shot_boundary`),
  };
}

function dialogueEvidenceRequired(message) {
  throw codedError('DIALOGUE_EVIDENCE_REQUIRED', message);
}

function normalizeDialogue(raw, name, shot, characters, evidence, seenIds) {
  assertArray(raw, name);
  return raw.map((turn, index) => {
    const itemName = `${name}[${index}]`;
    const fields = [
      'id', 'speaker_id', 'speaker_kind', 'off_screen', 'start_ms', 'end_ms',
      'source_text', 'source_language', 'emotion', 'evidence_refs', 'confidence',
      'review_status',
    ];
    assertExactKeys(turn, fields, fields, itemName);
    const id = stableId(turn.id, `${itemName}.id`);
    if (seenIds.has(id)) throw new Error(`${itemName}.id 重复`);
    seenIds.add(id);
    const start = timestamp(turn.start_ms, `${itemName}.start_ms`);
    const end = timestamp(turn.end_ms, `${itemName}.end_ms`);
    if (end <= start || start < shot.start_ms || end > shot.end_ms) {
      throw new Error(`${itemName} dialogue 时间越界`);
    }
    const speakerId = stableId(turn.speaker_id, `${itemName}.speaker_id`);
    if (!['character', 'voice_cluster', 'off_screen'].includes(turn.speaker_kind)) {
      throw new Error(`${itemName}.speaker_kind 无效`);
    }
    if (typeof turn.off_screen !== 'boolean') throw new Error(`${itemName}.off_screen 必须是布尔值`);
    if (turn.speaker_kind === 'character' && !characters.has(speakerId)) {
      throw new Error(`${itemName}.speaker_id 未知角色`);
    }
    if (turn.speaker_kind === 'character' && !turn.off_screen && !shot.visible_character_ids.includes(speakerId)) {
      throw new Error(`${itemName}.speaker_id 画内角色必须可见`);
    }
    if (turn.speaker_kind === 'voice_cluster' && !/^speaker-cluster-[1-9][0-9]*$/.test(speakerId)) {
      throw new Error(`${itemName}.speaker_id 声音聚类 id 无效`);
    }
    if (turn.speaker_kind === 'off_screen' && turn.off_screen !== true) {
      throw new Error(`${itemName}.off_screen 画外角色必须标记为 true`);
    }
    if (!['needs_review', 'approved'].includes(turn.review_status)) {
      throw new Error(`${itemName}.review_status 无效`);
    }
    let evidenceRefs;
    try {
      evidenceRefs = normalizeEvidenceRefs(turn.evidence_refs, `${itemName}.evidence_refs`, evidence);
    } catch (error) {
      dialogueEvidenceRequired(error.message);
    }
    if (!evidenceRefs.some((ref) => DIALOGUE_EVIDENCE_KINDS.has(evidence.get(ref).kind))) {
      dialogueEvidenceRequired(`${itemName} 缺少音频或字幕证据`);
    }
    return {
      id,
      speaker_id: speakerId,
      speaker_kind: turn.speaker_kind,
      off_screen: turn.off_screen,
      start_ms: start,
      end_ms: end,
      source_text: safeText(turn.source_text, `${itemName}.source_text`, 500),
      source_language: safeText(turn.source_language, `${itemName}.source_language`, 35),
      emotion: safeText(turn.emotion, `${itemName}.emotion`, 120),
      evidence_refs: evidenceRefs,
      confidence: probability(turn.confidence, `${itemName}.confidence`),
      review_status: turn.speaker_kind === 'voice_cluster' ? 'needs_review' : turn.review_status,
    };
  }).sort((a, b) => (a.start_ms - b.start_ms) || compareCodeUnit(a.id, b.id));
}

function normalizeVisibleCharacters(raw, name, characters) {
  assertArray(raw, name);
  const seen = new Set();
  return raw.map((item, index) => {
    const id = stableId(item, `${name}[${index}]`);
    if (!characters.has(id)) throw new Error(`${name}[${index}] 未知角色`);
    if (seen.has(id)) throw new Error(`${name} 重复`);
    seen.add(id);
    return id;
  }).sort(compareCodeUnit);
}

function normalizeShots(raw, durationMs, characterIds, evidence) {
  assertArray(raw, 'shots', { nonEmpty: true });
  const seenShotIds = new Set();
  const seenDialogueIds = new Set();
  const seenTextRegionIds = new Set();
  let previousEnd = 0;
  return [...raw].sort((a, b) => Number(a.index) - Number(b.index)).map((shot, index) => {
    const name = `shots[${index}]`;
    assertExactKeys(shot, SHOT_FIELDS, SHOT_FIELDS, name);
    if (shot.index !== index + 1) throw new Error(`${name}.index 必须连续`);
    const id = stableId(shot.id, `${name}.id`);
    if (seenShotIds.has(id)) throw new Error(`${name}.id 重复`);
    seenShotIds.add(id);
    const start = timestamp(shot.start_ms, `${name}.start_ms`);
    const end = timestamp(shot.end_ms, `${name}.end_ms`);
    if (start !== previousEnd) throw codedError('BLUEPRINT_TIMELINE_INCOMPLETE', 'shots 必须从 0 连续覆盖且不能有间隙或重叠');
    if (end <= start || end > durationMs) throw codedError('BLUEPRINT_TIMELINE_INCOMPLETE', `${name} 时间码越界`);
    previousEnd = end;
    const normalized = {
      id,
      index: shot.index,
      start_ms: start,
      end_ms: end,
      composition: safeText(shot.composition, `${name}.composition`, 500),
      camera_movement: safeText(shot.camera_movement, `${name}.camera_movement`, 300),
      opening_state: safeText(shot.opening_state, `${name}.opening_state`, 500),
      continuous_action: safeText(shot.continuous_action, `${name}.continuous_action`, 500),
      ending_state: safeText(shot.ending_state, `${name}.ending_state`, 500),
      visible_character_ids: normalizeVisibleCharacters(shot.visible_character_ids, `${name}.visible_character_ids`, characterIds),
      dialogue: [],
      text_regions: normalizeTextRegions(shot.text_regions, `${name}.text_regions`, evidence, seenTextRegionIds),
      audio_contract: normalizeAudioContract(shot.audio_contract, `${name}.audio_contract`),
      confidence: normalizeShotConfidence(shot.confidence, `${name}.confidence`),
      evidence_refs: normalizeEvidenceRefs(shot.evidence_refs, `${name}.evidence_refs`, evidence),
    };
    normalized.dialogue = normalizeDialogue(shot.dialogue, `${name}.dialogue`, normalized, characterIds, evidence, seenDialogueIds);
    if (normalized.audio_contract.dialogue_mode === 'silent' && normalized.dialogue.length > 0) {
      throw new Error(`${name} silent 不能包含 dialogue`);
    }
    if (normalized.audio_contract.dialogue_mode === 'spoken' && normalized.dialogue.length === 0) {
      throw new Error(`${name} spoken 必须包含 dialogue`);
    }
    return normalized;
  }).map((shot, index, shots) => {
    if (index === shots.length - 1 && shot.end_ms !== durationMs) {
      throw codedError('BLUEPRINT_TIMELINE_INCOMPLETE', 'shots 必须覆盖到 source.duration_ms');
    }
    return shot;
  });
}

function normalizeCausalChain(raw, evidence) {
  assertArray(raw, 'causal_chain', { nonEmpty: true });
  const seen = new Set();
  return raw.map((item, index) => {
    const name = `causal_chain[${index}]`;
    const fields = ['id', 'cause', 'effect', 'evidence_refs', 'confidence'];
    assertExactKeys(item, fields, fields, name);
    const id = stableId(item.id, `${name}.id`);
    if (seen.has(id)) throw new Error(`${name}.id 重复`);
    seen.add(id);
    return {
      id,
      cause: safeText(item.cause, `${name}.cause`, 500),
      effect: safeText(item.effect, `${name}.effect`, 500),
      evidence_refs: normalizeEvidenceRefs(item.evidence_refs, `${name}.evidence_refs`, evidence),
      confidence: probability(item.confidence, `${name}.confidence`),
    };
  }).sort((a, b) => compareCodeUnit(a.id, b.id));
}

function normalizeEvidenceStatements(raw, name, evidence) {
  assertArray(raw, name, { nonEmpty: true });
  const seen = new Set();
  return raw.map((item, index) => {
    const itemName = `${name}[${index}]`;
    const fields = ['id', 'text', 'evidence_refs', 'confidence'];
    assertExactKeys(item, fields, fields, itemName);
    const id = stableId(item.id, `${itemName}.id`);
    if (seen.has(id)) throw new Error(`${itemName}.id 重复`);
    seen.add(id);
    return {
      id,
      text: safeText(item.text, `${itemName}.text`, 500),
      evidence_refs: normalizeEvidenceRefs(item.evidence_refs, `${itemName}.evidence_refs`, evidence),
      confidence: probability(item.confidence, `${itemName}.confidence`),
    };
  }).sort((a, b) => compareCodeUnit(a.id, b.id));
}

function normalizeHook(raw, evidence) {
  const fields = ['text', 'evidence_refs', 'confidence'];
  assertExactKeys(raw, fields, fields, 'episode_hook');
  return {
    text: safeText(raw.text, 'episode_hook.text', 500),
    evidence_refs: normalizeEvidenceRefs(raw.evidence_refs, 'episode_hook.evidence_refs', evidence),
    confidence: probability(raw.confidence, 'episode_hook.confidence'),
  };
}

function normalizeReview(raw) {
  assertExactKeys(raw, ['status', 'reviewer'], ['status'], 'review');
  if (!['needs_review', 'approved', 'locked'].includes(raw.status)) throw new Error('review.status 无效');
  const normalized = { status: raw.status };
  const reviewer = optionalText(raw.reviewer, 'review.reviewer', 120);
  if (reviewer) normalized.reviewer = reviewer;
  if (['approved', 'locked'].includes(normalized.status) && !normalized.reviewer) {
    throw new Error('review.reviewer 必须提供');
  }
  return normalized;
}

function blueprintSha256(blueprint) {
  const { blueprint_hash: ignored, ...canonical } = blueprint;
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

function normalizeEpisodeBlueprint(raw) {
  assertExactKeys(raw, BLUEPRINT_FIELDS, BLUEPRINT_FIELDS.filter((field) => field !== 'blueprint_hash'), 'episode_blueprint');
  if (raw.schema_version !== 'episode-blueprint-v1') {
    throw new Error('schema_version 必须是 episode-blueprint-v1');
  }
  const source = normalizeSource(raw.source);
  const evidenceManifest = normalizeEvidenceManifest(raw.evidence_manifest);
  const evidence = evidenceIndex(evidenceManifest);
  const characters = normalizeCharacters(raw.characters, evidence);
  const characterIds = new Set(characters.map((character) => character.id));
  const shots = normalizeShots(raw.shots, source.duration_ms, characterIds, evidence);
  const review = normalizeReview(raw.review);
  if (characters.some((character) => character.review_status === 'needs_review')
    || shots.some((shot) => shot.dialogue.some((turn) => turn.review_status === 'needs_review'))) {
    review.status = 'needs_review';
  }
  const normalized = {
    schema_version: 'episode-blueprint-v1',
    source,
    evidence_manifest: evidenceManifest,
    story: normalizeStory(raw.story, evidence),
    characters,
    scenes: normalizeScenes(raw.scenes, source.duration_ms, evidence),
    props: normalizeProps(raw.props, source.duration_ms, evidence),
    shots,
    causal_chain: normalizeCausalChain(raw.causal_chain, evidence),
    locked_facts: normalizeEvidenceStatements(raw.locked_facts, 'locked_facts', evidence),
    reversals: normalizeEvidenceStatements(raw.reversals, 'reversals', evidence),
    episode_hook: normalizeHook(raw.episode_hook, evidence),
    review,
  };
  normalized.blueprint_hash = blueprintSha256(normalized);
  return normalized;
}

function assertDialogueEvidence(turn, evidence, name) {
  if (!Array.isArray(turn.evidence_refs) || turn.evidence_refs.length === 0) {
    dialogueEvidenceRequired(`${name} 缺少证据`);
  }
  for (const ref of turn.evidence_refs) {
    if (!evidence.has(ref)) dialogueEvidenceRequired(`${name} 引用未知证据`);
  }
  if (!turn.evidence_refs.some((ref) => DIALOGUE_EVIDENCE_KINDS.has(evidence.get(ref).kind))) {
    dialogueEvidenceRequired(`${name} 缺少音频或字幕证据`);
  }
}

function assertBlueprintLockable(blueprint) {
  if (!blueprint || blueprint.schema_version !== 'episode-blueprint-v1') {
    throw codedError('BLUEPRINT_SCHEMA_INVALID', '蓝图版本无效');
  }
  const durationMs = blueprint.source && blueprint.source.duration_ms;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || !Array.isArray(blueprint.shots) || blueprint.shots.length === 0) {
    throw codedError('BLUEPRINT_TIMELINE_INCOMPLETE', '蓝图时间轴无效');
  }
  let previousEnd = 0;
  for (const [index, shot] of blueprint.shots.entries()) {
    if (shot.index !== index + 1 || shot.start_ms !== previousEnd || !Number.isSafeInteger(shot.end_ms)
      || shot.end_ms <= shot.start_ms || shot.end_ms > durationMs) {
      throw codedError('BLUEPRINT_TIMELINE_INCOMPLETE', 'shots 存在间隙、重叠或越界');
    }
    previousEnd = shot.end_ms;
  }
  if (previousEnd !== durationMs) {
    throw codedError('BLUEPRINT_TIMELINE_INCOMPLETE', 'shots 未覆盖完整母本');
  }

  const evidenceItems = blueprint.evidence_manifest && blueprint.evidence_manifest.items;
  if (!/^[a-f0-9]{64}$/.test(String(blueprint.source.sha256 || '')) || !Array.isArray(evidenceItems) || evidenceItems.length === 0
    || evidenceItems.some((item) => !/^[a-f0-9]{64}$/.test(String(item.sha256 || '')))) {
    throw codedError('BLUEPRINT_EVIDENCE_SHA_INVALID', '源资产或证据 SHA-256 无效');
  }
  const evidence = new Map(evidenceItems.map((item) => [item.id, item]));
  const characterIds = new Set((blueprint.characters || []).map((character) => character.id));
  for (const [shotIndex, shot] of blueprint.shots.entries()) {
    for (const [turnIndex, turn] of (shot.dialogue || []).entries()) {
      const name = `shots[${shotIndex}].dialogue[${turnIndex}]`;
      assertDialogueEvidence(turn, evidence, name);
      if (turn.review_status !== 'approved' || turn.speaker_kind === 'voice_cluster') {
        throw codedError('BLUEPRINT_SPEAKER_REVIEW_REQUIRED', `${name} 说话人尚未审核映射`);
      }
      if (turn.speaker_kind === 'character' && !characterIds.has(turn.speaker_id)) {
        throw codedError('BLUEPRINT_SPEAKER_REVIEW_REQUIRED', `${name} 未映射到已知角色`);
      }
      if (turn.speaker_kind === 'off_screen' && turn.off_screen !== true) {
        throw codedError('BLUEPRINT_SPEAKER_REVIEW_REQUIRED', `${name} 未明确为画外角色`);
      }
    }
  }
  if (!['approved', 'locked'].includes(blueprint.review && blueprint.review.status)) {
    throw codedError('BLUEPRINT_REVIEW_REQUIRED', '蓝图尚未审核通过');
  }
  if (!/^[a-f0-9]{64}$/.test(String(blueprint.blueprint_hash || '')) || blueprintSha256(blueprint) !== blueprint.blueprint_hash) {
    throw codedError('BLUEPRINT_HASH_MISMATCH', '蓝图哈希与规范内容不一致');
  }
  return blueprint;
}

function projectSourceFactsV2(blueprint) {
  assertBlueprintLockable(blueprint);
  return normalizeEpisodeFactsV2({
    schema_version: '2.0',
    duration_ms: blueprint.source.duration_ms,
    story: [blueprint.story.summary, ...blueprint.story.beats],
    characters: blueprint.characters.map((character) => ({
      id: character.id,
      source_name: character.source_name,
      display_name: character.display_name,
      relationship: character.relationship,
      relationships: character.relationships,
    })),
    scenes: blueprint.scenes.map((scene) => ({
      id: scene.id,
      location: scene.location,
      time: scene.time,
      source_ranges: scene.source_ranges,
    })),
    props: blueprint.props.map((prop) => ({
      id: prop.id,
      name: prop.name,
      evidence_ranges: prop.evidence_ranges,
    })),
    shots: blueprint.shots.map((shot) => ({
      id: shot.id,
      index: shot.index,
      start_ms: shot.start_ms,
      end_ms: shot.end_ms,
      composition: shot.composition,
      camera_movement: shot.camera_movement,
      opening_state: shot.opening_state,
      continuous_action: shot.continuous_action,
      ending_state: shot.ending_state,
      visible_character_ids: shot.visible_character_ids,
      dialogue: shot.dialogue.map((turn) => ({
        id: turn.id,
        speaker_id: turn.speaker_id,
        speaker_kind: turn.speaker_kind,
        off_screen: turn.off_screen,
        evidence_refs: turn.evidence_refs,
        start_ms: turn.start_ms,
        end_ms: turn.end_ms,
        source_text: turn.source_text,
      })),
      text_regions: shot.text_regions.map((region) => ({
        id: region.id,
        kind: region.kind,
        polygon: region.polygon,
        ...(region.source_text ? { source_text: region.source_text } : {}),
      })),
      audio_contract: shot.audio_contract,
      confidence: shot.confidence,
    })),
    causal_chain: blueprint.causal_chain.map((item) => `${item.cause} → ${item.effect}`),
    locked_facts: blueprint.locked_facts.map((item) => item.text),
    reversals: blueprint.reversals.map((item) => item.text),
    episode_hook: blueprint.episode_hook.text,
  });
}

module.exports = {
  assertBlueprintLockable,
  normalizeEpisodeBlueprint,
  projectSourceFactsV2,
};
