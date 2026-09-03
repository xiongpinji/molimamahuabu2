const { createHash } = require('node:crypto');

const { normalizeEpisodeBlueprint } = require('./redrawEpisodeBlueprintService');

const AUDIO_EVIDENCE_KINDS = new Set(['asr', 'audio', 'audio_transcript', 'transcript']);
const VISUAL_EVIDENCE_KINDS = new Set(['contact_sheet', 'video', 'visual', 'visual_analysis']);

function codedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function fail(code, message) {
  throw codedError(code, message);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,96}$/.test(value);
}

function sha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function probability(value, fallback) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function normalizeEvidenceAssets(value) {
  const rawItems = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    fail('EVIDENCE_FUSION_EVIDENCE_INVALID', 'evidenceAssets 必须包含证据清单');
  }
  const ids = new Set();
  return rawItems.map((item, index) => {
    if (!plainObject(item)
      || !stableId(item.id)
      || !stableId(item.kind)
      || !(Number.isSafeInteger(item.asset_id) ? item.asset_id > 0 : stableId(item.asset_id))
      || !sha256(item.sha256)
      || typeof item.tool !== 'string'
      || !item.tool.trim()
      || typeof item.tool_version !== 'string'
      || !item.tool_version.trim()
      || ids.has(item.id)) {
      fail('EVIDENCE_FUSION_EVIDENCE_INVALID', `evidenceAssets[${index}] 无效`);
    }
    ids.add(item.id);
    return {
      id: item.id,
      kind: item.kind,
      asset_id: item.asset_id,
      sha256: item.sha256,
      tool: item.tool.trim(),
      tool_version: item.tool_version.trim(),
    };
  });
}

function sameAssetId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function resolveEvidence(items, payload, allowedKinds, label) {
  const explicitRef = payload?.evidence_ref || payload?.evidence_id;
  if (explicitRef) {
    const explicit = items.find((item) => item.id === explicitRef);
    if (!explicit || !allowedKinds.has(explicit.kind)) {
      fail('EVIDENCE_FUSION_EVIDENCE_INVALID', `${label} evidence_ref 未知或类型无效`);
    }
    return explicit;
  }
  const assetId = payload?.result_asset_id || payload?.evidence_asset_id;
  const assetSha = payload?.evidence_sha256 || payload?.sha256;
  const matches = items.filter((item) => allowedKinds.has(item.kind)
    && (!assetId || sameAssetId(item.asset_id, assetId))
    && (!assetSha || item.sha256 === assetSha));
  if (matches.length !== 1) {
    fail('EVIDENCE_FUSION_EVIDENCE_INVALID', `${label} 证据不能唯一绑定 manifest`);
  }
  return matches[0];
}

function normalizeSource(raw) {
  if (!plainObject(raw) || !sha256(raw.sha256) || !Number.isSafeInteger(raw.duration_ms) || raw.duration_ms <= 0) {
    fail('EVIDENCE_FUSION_INPUT_INVALID', 'source 无效');
  }
  return {
    asset_id: raw.asset_id,
    sha256: raw.sha256,
    duration_ms: raw.duration_ms,
    width: raw.width,
    height: raw.height,
    fps: raw.fps,
    video_codec: raw.video_codec,
    audio_codec: raw.audio_codec,
    audio_sample_rate_hz: raw.audio_sample_rate_hz,
    audio_channels: raw.audio_channels,
  };
}

function normalizeVisualShots(visualFacts, durationMs) {
  if (!plainObject(visualFacts)
    || !Number.isSafeInteger(visualFacts.duration_ms)
    || visualFacts.duration_ms !== durationMs) {
    fail('EVIDENCE_FUSION_DURATION_MISMATCH', '视觉证据时长必须与 source.duration_ms 完全一致');
  }
  if (!Array.isArray(visualFacts.shots) || visualFacts.shots.length === 0) {
    fail('EVIDENCE_FUSION_TIMELINE_INVALID', '视觉镜头时间轴不能为空');
  }
  const shots = [...visualFacts.shots].sort((left, right) => Number(left.index) - Number(right.index));
  let previousEnd = 0;
  for (const [index, shot] of shots.entries()) {
    if (!plainObject(shot)
      || shot.index !== index + 1
      || !Number.isSafeInteger(shot.start_ms)
      || !Number.isSafeInteger(shot.end_ms)
      || shot.start_ms !== previousEnd
      || shot.end_ms <= shot.start_ms
      || shot.end_ms > durationMs) {
      fail('EVIDENCE_FUSION_TIMELINE_INVALID', `shots[${index}] 存在 gap、overlap 或越界`);
    }
    previousEnd = shot.end_ms;
  }
  if (previousEnd !== durationMs) {
    fail('EVIDENCE_FUSION_TIMELINE_INVALID', '视觉镜头未完整覆盖 source.duration_ms');
  }
  return shots;
}

function segmentId(segment, evidenceRef, sourceLanguage) {
  if (segment.id != null) {
    if (!stableId(segment.id)) fail('EVIDENCE_FUSION_AUDIO_INVALID', '音频 segment id 无效');
    return segment.id;
  }
  const canonical = JSON.stringify([
    evidenceRef,
    segment.start_ms,
    segment.end_ms,
    segment.source_text,
    segment.speaker_cluster_id,
    sourceLanguage,
  ]);
  return `audio-segment-${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

function normalizeAudioEvidence(raw, sourceValue, evidenceItems, defaultEvidence) {
  if (!plainObject(raw)
    || !['spoken', 'silent'].includes(raw.dialogue_mode)
    || !Array.isArray(raw.segments)
    || (raw.source_asset_id != null && !sameAssetId(raw.source_asset_id, sourceValue.asset_id))
    || (raw.source_video_sha256 != null && raw.source_video_sha256 !== sourceValue.sha256)
    || (raw.evidence_sha256 != null && raw.evidence_sha256 !== defaultEvidence.sha256)) {
    fail('EVIDENCE_FUSION_AUDIO_INVALID', '音频证据与源资产绑定无效');
  }
  if ((raw.dialogue_mode === 'silent' && raw.segments.length > 0)
    || (raw.dialogue_mode === 'spoken' && raw.segments.length === 0)) {
    fail('EVIDENCE_FUSION_AUDIO_INVALID', 'dialogue_mode 与 transcript segments 冲突');
  }
  if (raw.dialogue_mode === 'spoken' && (typeof raw.source_language !== 'string' || !raw.source_language.trim())) {
    fail('EVIDENCE_FUSION_AUDIO_INVALID', 'spoken 音频缺少 source_language');
  }

  const manifest = new Map(evidenceItems.map((item) => [item.id, item]));
  const ids = new Set();
  let previousEnd = 0;
  const segments = raw.segments.map((segment, index) => {
    const evidenceRef = segment?.evidence_ref || defaultEvidence.id;
    const evidence = manifest.get(evidenceRef);
    if (!evidence || !AUDIO_EVIDENCE_KINDS.has(evidence.kind)) {
      fail('EVIDENCE_FUSION_EVIDENCE_INVALID', `segments[${index}] 引用未知音频证据`);
    }
    if (Number.isSafeInteger(segment?.start_ms)
      && Number.isSafeInteger(segment?.end_ms)
      && (segment.start_ms >= sourceValue.duration_ms || segment.end_ms > sourceValue.duration_ms)) {
      fail('EVIDENCE_FUSION_SEGMENT_UNASSIGNED', `segments[${index}] 超出 source.duration_ms`);
    }
    if (!plainObject(segment)
      || !Number.isSafeInteger(segment.start_ms)
      || !Number.isSafeInteger(segment.end_ms)
      || segment.start_ms < 0
      || segment.end_ms <= segment.start_ms
      || segment.start_ms < previousEnd
      || typeof segment.source_text !== 'string'
      || !segment.source_text.trim()
      || !/^speaker-cluster-[1-9][0-9]*$/.test(String(segment.speaker_cluster_id || ''))) {
      fail('EVIDENCE_FUSION_AUDIO_INVALID', `segments[${index}] 无效`);
    }
    const id = segmentId(segment, evidenceRef, raw.source_language);
    if (ids.has(id)) fail('EVIDENCE_FUSION_AUDIO_INVALID', `segments[${index}] id 重复`);
    ids.add(id);
    previousEnd = segment.end_ms;
    return {
      id,
      evidence_ref: evidenceRef,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      source_text: segment.source_text.trim(),
      speaker_cluster_id: segment.speaker_cluster_id,
      confidence: probability(segment.confidence, probability(raw.language_probability, 0)),
    };
  });
  return {
    dialogue_mode: raw.dialogue_mode,
    source_language: raw.source_language || 'und',
    segments,
  };
}

function visualRefs(rawRefs, evidenceMap, visualEvidence) {
  if (rawRefs == null) return [visualEvidence.id];
  if (!Array.isArray(rawRefs) || rawRefs.length === 0) {
    fail('EVIDENCE_FUSION_EVIDENCE_INVALID', '视觉事实 evidence_refs 无效');
  }
  const refs = rawRefs.map((ref) => {
    const item = evidenceMap.get(ref);
    if (!item || !VISUAL_EVIDENCE_KINDS.has(item.kind)) {
      fail('EVIDENCE_FUSION_EVIDENCE_INVALID', '视觉事实引用未知或非视觉证据');
    }
    return ref;
  });
  return [...new Set(refs)];
}

function midpointShot(shots, segment) {
  const midpoint = segment.start_ms + ((segment.end_ms - segment.start_ms) / 2);
  return shots.find((shot, index) => midpoint >= shot.start_ms
    && (midpoint < shot.end_ms || (index === shots.length - 1 && midpoint === shot.end_ms))) || null;
}

function segmentOwner(shots, segment) {
  const overlaps = shots.map((shot) => ({
    shot,
    overlap: Math.max(0, Math.min(segment.end_ms, shot.end_ms) - Math.max(segment.start_ms, shot.start_ms)),
  })).filter((item) => item.overlap > 0);
  if (overlaps.length === 0) {
    fail('EVIDENCE_FUSION_SEGMENT_UNASSIGNED', `segment ${segment.id} 未与任何镜头重叠`);
  }
  if (overlaps.length === 1) return overlaps[0].shot;
  const midpoint = midpointShot(shots, segment);
  overlaps.sort((left, right) => (right.overlap - left.overlap)
    || (left.shot === midpoint ? -1 : right.shot === midpoint ? 1 : left.shot.index - right.shot.index));
  return overlaps[0].shot;
}

function sourceText(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail('EVIDENCE_FUSION_INPUT_INVALID', `${name} 必须提供`);
  return value.trim();
}

function statementId(prefix, index, text) {
  const digest = createHash('sha256').update(`${prefix}\0${index}\0${text}`).digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
}

function statementValue(item, field, name) {
  return sourceText(plainObject(item) ? item[field] : item, name);
}

function fuseEpisodeEvidence({ source, visualFacts, audioEvidence, evidenceAssets } = {}) {
  const sourceValue = normalizeSource(source);
  const evidenceItems = normalizeEvidenceAssets(evidenceAssets);
  const evidenceMap = new Map(evidenceItems.map((item) => [item.id, item]));
  const visualEvidence = resolveEvidence(evidenceItems, visualFacts, VISUAL_EVIDENCE_KINDS, 'visualFacts');
  const audioEvidenceAsset = resolveEvidence(evidenceItems, audioEvidence, AUDIO_EVIDENCE_KINDS, 'audioEvidence');
  const visualShots = normalizeVisualShots(visualFacts, sourceValue.duration_ms);
  const audio = normalizeAudioEvidence(audioEvidence, sourceValue, evidenceItems, audioEvidenceAsset);

  const dialogueByShot = new Map(visualShots.map((shot) => [shot.id, []]));
  for (const segment of audio.segments) {
    const owner = segmentOwner(visualShots, segment);
    dialogueByShot.get(owner.id).push({
      id: segment.id,
      speaker_id: segment.speaker_cluster_id,
      speaker_kind: 'voice_cluster',
      off_screen: false,
      start_ms: Math.max(segment.start_ms, owner.start_ms),
      end_ms: Math.min(segment.end_ms, owner.end_ms),
      source_text: segment.source_text,
      source_language: audio.source_language,
      emotion: 'unresolved',
      evidence_refs: [segment.evidence_ref],
      confidence: segment.confidence,
      review_status: 'needs_review',
    });
  }

  const storyItems = Array.isArray(visualFacts.story) ? visualFacts.story : [];
  if (storyItems.length === 0) fail('EVIDENCE_FUSION_INPUT_INVALID', 'visualFacts.story 必须提供');
  const summary = statementValue(storyItems[0], 'summary', 'story.summary');
  const beats = storyItems.slice(1).map((item, index) => statementValue(item, 'text', `story.beats[${index}]`));
  if (beats.length === 0) beats.push(summary);
  const visualReference = (item) => visualRefs(item?.evidence_refs, evidenceMap, visualEvidence);

  const blueprint = {
    schema_version: 'episode-blueprint-v1',
    source: sourceValue,
    evidence_manifest: { items: evidenceItems },
    story: {
      summary,
      beats,
      evidence_refs: visualReference(plainObject(storyItems[0]) ? storyItems[0] : null),
      confidence: probability(visualFacts.story_confidence, 0.5),
    },
    characters: (visualFacts.characters || []).map((character, index) => ({
      id: character.id,
      source_name: sourceText(character.source_name || character.display_name, `characters[${index}].source_name`),
      display_name: sourceText(character.display_name || character.source_name, `characters[${index}].display_name`),
      relationship: sourceText(character.relationship || 'unresolved', `characters[${index}].relationship`),
      relationships: Array.isArray(character.relationships) ? character.relationships : [],
      face_track_ids: Array.isArray(character.face_track_ids) ? character.face_track_ids : [],
      evidence_refs: visualReference(character),
      confidence: probability(character.confidence, 0.5),
      review_status: 'needs_review',
    })),
    scenes: (visualFacts.scenes || []).map((scene, index) => ({
      id: scene.id,
      location: sourceText(scene.location, `scenes[${index}].location`),
      time: sourceText(scene.time, `scenes[${index}].time`),
      source_ranges: scene.source_ranges,
      evidence_refs: visualReference(scene),
      confidence: probability(scene.confidence, 0.5),
    })),
    props: (visualFacts.props || []).map((prop, index) => ({
      id: prop.id,
      name: sourceText(prop.name, `props[${index}].name`),
      evidence_ranges: prop.evidence_ranges,
      evidence_refs: visualReference(prop),
      confidence: probability(prop.confidence, 0.5),
    })),
    shots: visualShots.map((shot, index) => {
      const dialogue = dialogueByShot.get(shot.id);
      const refs = [...new Set([...visualReference(shot), audioEvidenceAsset.id])];
      return {
        id: shot.id,
        index: index + 1,
        start_ms: shot.start_ms,
        end_ms: shot.end_ms,
        composition: sourceText(shot.composition, `shots[${index}].composition`),
        camera_movement: sourceText(shot.camera_movement, `shots[${index}].camera_movement`),
        opening_state: sourceText(shot.opening_state, `shots[${index}].opening_state`),
        continuous_action: sourceText(shot.continuous_action, `shots[${index}].continuous_action`),
        ending_state: sourceText(shot.ending_state, `shots[${index}].ending_state`),
        visible_character_ids: Array.isArray(shot.visible_character_ids) ? shot.visible_character_ids : [],
        dialogue,
        text_regions: (shot.text_regions || []).map((region) => ({
          id: region.id,
          kind: region.kind,
          polygon: region.polygon,
          ...(typeof region.source_text === 'string' && region.source_text.trim()
            ? { source_text: region.source_text.trim() }
            : {}),
          evidence_refs: visualReference(region),
          confidence: probability(region.confidence, probability(shot.confidence?.text_regions, 0.5)),
        })),
        audio_contract: {
          dialogue_mode: dialogue.length > 0 ? 'spoken' : 'silent',
          ambient_audio: 'preserve_or_rebuild',
        },
        confidence: {
          character_mapping: probability(shot.confidence?.character_mapping, 0.5),
          speaker_mapping: 0,
          text_regions: probability(shot.confidence?.text_regions, 0.5),
          shot_boundary: probability(shot.confidence?.shot_boundary, 0.5),
        },
        evidence_refs: refs,
      };
    }),
    causal_chain: (visualFacts.causal_chain || []).map((item, index) => {
      const cause = statementValue(item, 'cause', `causal_chain[${index}].cause`);
      const effect = plainObject(item) && item.effect
        ? sourceText(item.effect, `causal_chain[${index}].effect`)
        : cause;
      return {
        id: plainObject(item) && stableId(item.id) ? item.id : statementId('causal', index, `${cause}\0${effect}`),
        cause,
        effect,
        evidence_refs: visualReference(plainObject(item) ? item : null),
        confidence: probability(item?.confidence, 0.5),
      };
    }),
    locked_facts: (visualFacts.locked_facts || []).map((item, index) => {
      const text = statementValue(item, 'text', `locked_facts[${index}].text`);
      return {
        id: plainObject(item) && stableId(item.id) ? item.id : statementId('fact', index, text),
        text,
        evidence_refs: visualReference(plainObject(item) ? item : null),
        confidence: probability(item?.confidence, 0.5),
      };
    }),
    reversals: (visualFacts.reversals || []).map((item, index) => {
      const text = statementValue(item, 'text', `reversals[${index}].text`);
      return {
        id: plainObject(item) && stableId(item.id) ? item.id : statementId('reversal', index, text),
        text,
        evidence_refs: visualReference(plainObject(item) ? item : null),
        confidence: probability(item?.confidence, 0.5),
      };
    }),
    episode_hook: {
      text: statementValue(visualFacts.episode_hook, 'text', 'episode_hook.text'),
      evidence_refs: visualReference(plainObject(visualFacts.episode_hook) ? visualFacts.episode_hook : null),
      confidence: probability(visualFacts.episode_hook?.confidence, 0.5),
    },
    review: { status: 'needs_review' },
  };

  return normalizeEpisodeBlueprint(blueprint);
}

module.exports = {
  fuseEpisodeEvidence,
};
