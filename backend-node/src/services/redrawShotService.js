'use strict';

function deepClone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return deepClone(value);
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function readName(asset) {
  return asset?.name || asset?.display_name || asset?.localized_name || '';
}

function normalizeAsset(asset) {
  return {
    asset_id: asset.asset_id ?? asset.assetId ?? asset.id,
    kind: asset.kind,
    version_number: asset.version_number ?? asset.versionNumber,
    approval_status: asset.approval_status ?? asset.approvalStatus,
    name: readName(asset),
  };
}

function parseShotReferences(text = '', approvedAssets = []) {
  const assetsByName = new Map();
  for (const asset of approvedAssets || []) {
    for (const name of [asset?.name, asset?.display_name, asset?.localized_name]) {
      if (name) assetsByName.set(String(name), asset);
    }
  }

  const references = [];
  const seenAssets = new Set();
  for (const match of String(text || '').matchAll(/@([^\s@,，。；;：:、!?！？()[\]{}"'“”‘’]+)/g)) {
    const name = match[1];
    const asset = assetsByName.get(name);
    if (!asset) throw new Error(`未知资产: ${name}`);
    const normalized = normalizeAsset(asset);
    if (normalized.approval_status !== 'approved') throw new Error(`资产未审批/未批准: ${name}`);
    const key = `${normalized.kind}:${normalized.asset_id}`;
    if (seenAssets.has(key)) continue;
    seenAssets.add(key);
    references.push(normalized);
  }
  return references;
}

function readInteger(input, camel, snake) {
  return input[snake] ?? input[camel];
}

function assertValidTime(startMs, endMs) {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0 || endMs <= startMs) {
    throw new Error('非法时间码');
  }
}

function normalizeShot(input = {}, context = {}) {
  const startMs = readInteger(input, 'startMs', 'start_ms');
  const endMs = readInteger(input, 'endMs', 'end_ms');
  assertValidTime(startMs, endMs);

  const shot = {
    start_ms: startMs,
    end_ms: endMs,
    duration_ms: endMs - startMs,
  };
  for (const key of [
    'opening_state',
    'continuous_action',
    'ending_state',
    'shot_type',
    'camera_movement',
    'composition',
    'lighting',
    'atmosphere',
    'source_dialogue',
    'localized_dialogue',
    'speaker',
    'speakable_duration_ms',
    'prompt',
    'negative_prompt',
    'compiled_prompt',
    'source_video',
    'source_video_ref',
    'new_video',
    'new_video_ref',
    'audio',
    'audio_ref',
    'subtitle',
    'subtitle_ref',
  ]) {
    if (input[key] !== undefined) shot[key] = deepClone(input[key]);
  }
  if (input.original_video_ref !== undefined && shot.source_video_ref === undefined) {
    shot.source_video_ref = deepClone(input.original_video_ref);
  }
  shot.references = parseShotReferences(shot.prompt || '', context.approvedAssets || []);
  return deepClone(shot);
}

function positiveDuration(shot) {
  const duration = Number(shot?.duration_ms ?? shot?.durationMs);
  if (!Number.isInteger(duration) || duration <= 0) throw new Error('非法镜头时长');
  return duration;
}

function makeBatch(batchIndex, shots) {
  return {
    batch_index: batchIndex,
    duration_ms: shots.reduce((total, shot) => total + positiveDuration(shot), 0),
    shots,
  };
}

function hasManualBatches(shots) {
  return shots.length > 0 && shots.every((shot) => Number.isInteger(shot.batch_index) && shot.batch_index > 0);
}

function groupShotsIntoBatches(shots = [], minDurationMs = 10_000, maxDurationMs = 15_000) {
  if (hasManualBatches(shots)) {
    const batches = [];
    for (const shot of shots) {
      const last = batches[batches.length - 1];
      if (!last || last.batch_index !== shot.batch_index) {
        batches.push({ batch_index: shot.batch_index, shots: [shot] });
      } else {
        last.shots.push(shot);
      }
    }
    return batches.map((batch) => makeBatch(batch.batch_index, batch.shots));
  }

  const batches = [];
  let current = [];
  let currentDuration = 0;
  for (const shot of shots) {
    const duration = positiveDuration(shot);
    if (duration > maxDurationMs) {
      if (current.length) {
        batches.push(makeBatch(batches.length + 1, current));
        current = [];
        currentDuration = 0;
      }
      batches.push(makeBatch(batches.length + 1, [shot]));
      continue;
    }
    if (current.length && (currentDuration >= minDurationMs || currentDuration + duration > maxDurationMs)) {
      batches.push(makeBatch(batches.length + 1, current));
      current = [];
      currentDuration = 0;
    }
    current.push(shot);
    currentDuration += duration;
  }
  if (current.length) batches.push(makeBatch(batches.length + 1, current));
  return batches;
}

function snapshotShots(db, versionId) {
  const rows = db.prepare(`
    SELECT *
    FROM redraw_shots
    WHERE version_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(versionId);

  return deepClone(rows.map((row) => {
    const draft = parseJson(row.draft_json, {});
    const compiledPrompt = parseJson(row.compiled_prompt_json, {});
    return {
      id: row.id,
      version_id: row.version_id,
      batch_index: row.batch_index,
      shot_index: row.shot_index,
      start_ms: row.start_ms,
      end_ms: row.end_ms,
      duration_ms: row.duration_ms,
      opening_state: row.opening_state,
      continuous_action: row.continuous_action,
      ending_state: row.ending_state,
      shot_type: draft.shot_type ?? compiledPrompt.shot_type,
      camera_movement: draft.camera_movement ?? compiledPrompt.camera_movement,
      composition: draft.composition ?? compiledPrompt.composition,
      lighting: draft.lighting ?? compiledPrompt.lighting,
      atmosphere: draft.atmosphere ?? compiledPrompt.atmosphere,
      source_dialogue: parseJson(row.source_dialogue_json, []),
      localized_dialogue: parseJson(row.localized_dialogue_json, []),
      speaker: draft.speaker ?? compiledPrompt.speaker,
      speakable_duration_ms: draft.speakable_duration_ms ?? compiledPrompt.speakable_duration_ms,
      prompt: row.prompt,
      negative_prompt: row.negative_prompt,
      compiled_prompt: compiledPrompt,
      references: parseJson(row.references_json, []),
      model: draft.model ?? compiledPrompt.model,
      duration: draft.duration ?? compiledPrompt.duration,
      resolution: draft.resolution ?? compiledPrompt.resolution,
      count: draft.count ?? compiledPrompt.count,
      quote_snapshot: draft.quote_snapshot ?? compiledPrompt.quote_snapshot,
      source_video: draft.source_video ?? compiledPrompt.source_video,
      source_video_ref: draft.source_video_ref ?? draft.original_video_ref ?? compiledPrompt.source_video_ref,
      new_video: draft.new_video ?? compiledPrompt.new_video,
      new_video_ref: draft.new_video_ref ?? compiledPrompt.new_video_ref,
      audio: draft.audio ?? compiledPrompt.audio,
      audio_ref: draft.audio_ref ?? compiledPrompt.audio_ref,
      subtitle: draft.subtitle ?? compiledPrompt.subtitle,
      subtitle_ref: draft.subtitle_ref ?? compiledPrompt.subtitle_ref,
      draft,
    };
  }));
}

module.exports = {
  normalizeShot,
  parseShotReferences,
  groupShotsIntoBatches,
  snapshotShots,
};
