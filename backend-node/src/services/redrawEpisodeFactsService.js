const { createHash } = require('crypto');

const TOP_LEVEL_FIELDS = [
  'schema_version', 'duration_ms', 'story', 'characters',
  'scenes', 'props', 'shots', 'causal_chain', 'locked_facts',
  'reversals', 'episode_hook',
];

const SHOT_FIELDS = [
  'id', 'index', 'start_ms', 'end_ms', 'composition', 'camera_movement',
  'opening_state', 'continuous_action', 'ending_state', 'visible_character_ids',
  'dialogue', 'text_regions', 'audio_contract', 'confidence',
];

const DANGEROUS_KEYS = new Set([
  '__proto__', 'prototype', 'constructor',
]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${name} 不允许继承字段`);
  }
}

function assertAllowedKeys(value, name, allowed) {
  assertPlainObject(value, name);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`${name}.${key} 危险字段`);
    }
    if (!allowedSet.has(key)) {
      if (/(?:url|path|key|auth|token|secret|prompt|request|response|model|explanation|reasoning)/i.test(key)) {
        throw new Error(`${name}.${key} 危险字段`);
      }
      throw new Error(`${name}.${key} 未知字段`);
    }
  }
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
}

function assertNonEmptyArray(value, name) {
  assertArray(value, name);
  if (value.length === 0) throw new Error(`${name} 必须是非空数组`);
}

function numberMs(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 时间码无效`);
  return value;
}

function safeText(value, name, maxLength = 500) {
  if (typeof value !== 'string') throw new Error(`${name} 必须是文本`);
  const text = value.trim();
  if (!text) throw new Error(`${name} 必须提供`);
  if (text.length > maxLength) throw new Error(`${name} 过长`);
  if (/(?:https?:\/\/|www\.|file:\/\/|[a-zA-Z]:\\|\\\\|\/(?:tmp|var|opt|home|users|mnt|etc)\/|\.mp4\b|\.mov\b|api[_-]?key|bearer\s+|prompt\s*:)/i.test(text)) {
    throw new Error(`${name} 包含危险路径或URL`);
  }
  return text;
}

function optionalSafeText(value, name, maxLength = 500) {
  if (value == null || value === '') return undefined;
  return safeText(value, name, maxLength);
}

function confidence(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} confidence 无效`);
  return value;
}

function rangeObject(value, name, durationMs) {
  assertAllowedKeys(value, name, ['start_ms', 'end_ms']);
  const start = numberMs(value.start_ms, `${name}.start_ms`);
  const end = numberMs(value.end_ms, `${name}.end_ms`);
  if (end <= start || end > durationMs) throw new Error(`${name} 时间码越界`);
  return { start_ms: start, end_ms: end };
}

function normalizeRanges(value, name, durationMs) {
  assertNonEmptyArray(value, name);
  let previousEnd = -1;
  return value.map((item, index) => {
    const range = rangeObject(item, `${name}[${index}]`, durationMs);
    if (range.start_ms < previousEnd) throw new Error(`${name} 时间码必须单调且不能重叠`);
    previousEnd = range.end_ms;
    return range;
  });
}

function uniqueId(id, name, seen) {
  const value = safeText(id, name, 96);
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`${name} id 不稳定`);
  if (seen.has(value)) throw new Error(`${name} id 重复`);
  seen.add(value);
  return value;
}

function normalizeStringArray(value, name) {
  assertNonEmptyArray(value, name);
  return value.map((item, index) => safeText(String(item), `${name}[${index}]`, 500)).sort();
}

function normalizeCharacters(value) {
  assertNonEmptyArray(value, 'characters');
  const seen = new Set();
  return value.map((character, index) => {
    assertAllowedKeys(character, `characters[${index}]`, ['id', 'source_name', 'display_name', 'relationship', 'relationships']);
    const normalized = {
      id: uniqueId(character.id, `characters[${index}].id`, seen),
    };
    if (character.source_name != null) normalized.source_name = safeText(character.source_name, `characters[${index}].source_name`, 120);
    if (character.display_name != null) normalized.display_name = safeText(character.display_name, `characters[${index}].display_name`, 120);
    if (!normalized.source_name && !normalized.display_name) throw new Error(`characters[${index}] 必须包含可显示名称`);
    if (character.relationship != null) normalized.relationship = safeText(character.relationship, `characters[${index}].relationship`, 200);
    if (character.relationships != null) {
      assertArray(character.relationships, `characters[${index}].relationships`);
      normalized.relationships = character.relationships.map((item, relIndex) => safeText(String(item), `characters[${index}].relationships[${relIndex}]`, 200)).sort();
    } else {
      normalized.relationships = [];
    }
    return normalized;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeScenes(value, durationMs) {
  assertNonEmptyArray(value, 'scenes');
  const seen = new Set();
  return value.map((scene, index) => {
    assertAllowedKeys(scene, `scenes[${index}]`, ['id', 'location', 'time', 'source_ranges']);
    return {
      id: uniqueId(scene.id, `scenes[${index}].id`, seen),
      location: safeText(scene.location, `scenes[${index}].location`, 200),
      time: safeText(scene.time, `scenes[${index}].time`, 120),
      source_ranges: normalizeRanges(scene.source_ranges, `scenes[${index}].source_ranges`, durationMs),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeProps(value, durationMs) {
  assertNonEmptyArray(value, 'props');
  const seen = new Set();
  return value.map((prop, index) => {
    assertAllowedKeys(prop, `props[${index}]`, ['id', 'name', 'evidence_ranges']);
    return {
      id: uniqueId(prop.id, `props[${index}].id`, seen),
      name: safeText(prop.name, `props[${index}].name`, 200),
      evidence_ranges: normalizeRanges(prop.evidence_ranges, `props[${index}].evidence_ranges`, durationMs),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeAudioContract(value, name) {
  assertAllowedKeys(value, name, ['dialogue_mode', 'ambient_audio']);
  if (!['spoken', 'silent'].includes(value.dialogue_mode)) throw new Error(`${name}.dialogue_mode 无效`);
  if (value.ambient_audio !== 'preserve_or_rebuild') throw new Error(`${name}.ambient_audio 无效`);
  return { dialogue_mode: value.dialogue_mode, ambient_audio: 'preserve_or_rebuild' };
}

function normalizeConfidence(value, name) {
  assertAllowedKeys(value, name, ['character_mapping', 'speaker_mapping', 'text_regions', 'shot_boundary']);
  return {
    character_mapping: confidence(value.character_mapping, `${name}.character_mapping`),
    speaker_mapping: confidence(value.speaker_mapping, `${name}.speaker_mapping`),
    text_regions: confidence(value.text_regions, `${name}.text_regions`),
    shot_boundary: confidence(value.shot_boundary, `${name}.shot_boundary`),
  };
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    area += (x1 * y2) - (x2 * y1);
  }
  return Math.abs(area) / 2;
}

function normalizePolygon(value, name) {
  assertArray(value, name);
  if (value.length < 3) throw new Error(`${name} polygon 点数不足`);
  const points = value.map((point, index) => {
    assertArray(point, `${name}[${index}]`);
    if (point.length !== 2) throw new Error(`${name}[${index}] polygon 坐标无效`);
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      throw new Error(`${name}[${index}] polygon 坐标越界`);
    }
    return [x, y];
  });
  if (polygonArea(points) <= 0.000001) throw new Error(`${name} polygon 面积无效`);
  return points;
}

function normalizeTextRegions(value, name, seenTextRegionIds) {
  assertArray(value, name);
  const allowedKinds = new Set(['subtitle', 'screen_text', 'sign', 'title', 'label']);
  return value.map((region, index) => {
    assertAllowedKeys(region, `${name}[${index}]`, ['id', 'kind', 'polygon', 'source_text']);
    const id = uniqueId(region.id, `${name}[${index}].id`, seenTextRegionIds);
    if (!allowedKinds.has(region.kind)) throw new Error(`${name}[${index}].kind 未知`);
    const normalized = {
      id,
      kind: region.kind,
      polygon: normalizePolygon(region.polygon, `${name}[${index}].polygon`),
    };
    const text = optionalSafeText(region.source_text, `${name}[${index}].source_text`, 300);
    if (text) normalized.source_text = text;
    return normalized;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeDialogue(value, name, shot, visibleIds, seenTurnIds) {
  assertArray(value, name);
  return value.map((turn, index) => {
    assertAllowedKeys(turn, `${name}[${index}]`, ['id', 'speaker_id', 'start_ms', 'end_ms', 'source_text']);
    const start = numberMs(turn.start_ms, `${name}[${index}].start_ms`);
    const end = numberMs(turn.end_ms, `${name}[${index}].end_ms`);
    if (end <= start || start < shot.start_ms || end > shot.end_ms) throw new Error(`${name}[${index}] dialogue 时间越界`);
    const speakerId = safeText(turn.speaker_id, `${name}[${index}].speaker_id`, 96);
    if (!visibleIds.has(speakerId)) throw new Error(`${name}[${index}] speaker 必须可见`);
    return {
      id: uniqueId(turn.id, `${name}[${index}].id`, seenTurnIds),
      speaker_id: speakerId,
      start_ms: start,
      end_ms: end,
      source_text: safeText(turn.source_text, `${name}[${index}].source_text`, 300),
    };
  }).sort((a, b) => (a.start_ms - b.start_ms) || a.id.localeCompare(b.id));
}

function normalizeVisibleCharacters(value, name, knownCharacters) {
  assertArray(value, name);
  const seen = new Set();
  return value.map((id, index) => {
    const valueId = safeText(id, `${name}[${index}]`, 96);
    if (!knownCharacters.has(valueId)) throw new Error(`${name}[${index}] 未知角色`);
    if (seen.has(valueId)) throw new Error(`${name} 重复`);
    seen.add(valueId);
    return valueId;
  }).sort();
}

function normalizeShots(value, durationMs, knownCharacters) {
  assertNonEmptyArray(value, 'shots');
  const seenShotIds = new Set();
  const seenTurnIds = new Set();
  const seenTextRegionIds = new Set();
  const sorted = [...value].sort((a, b) => Number(a.index) - Number(b.index));
  let previousEnd = 0;
  return sorted.map((shot, index) => {
    assertAllowedKeys(shot, `shots[${index}]`, SHOT_FIELDS);
    const expectedIndex = index + 1;
    if (shot.index !== expectedIndex) throw new Error(`shots[${index}].index 必须连续`);
    const start = numberMs(shot.start_ms, `shots[${index}].start_ms`);
    const end = numberMs(shot.end_ms, `shots[${index}].end_ms`);
    if (start !== previousEnd) throw new Error('shots 必须连续覆盖，不能 gap 或重叠');
    if (end <= start || end > durationMs) throw new Error(`shots[${index}] 时间码越界 duration`);
    previousEnd = end;
    const visibleCharacterIds = normalizeVisibleCharacters(shot.visible_character_ids, `shots[${index}].visible_character_ids`, knownCharacters);
    const normalizedShot = {
      id: uniqueId(shot.id, `shots[${index}].id`, seenShotIds),
      index: shot.index,
      start_ms: start,
      end_ms: end,
      composition: safeText(shot.composition, `shots[${index}].composition`, 500),
      camera_movement: safeText(shot.camera_movement, `shots[${index}].camera_movement`, 300),
      opening_state: safeText(shot.opening_state, `shots[${index}].opening_state`, 500),
      continuous_action: safeText(shot.continuous_action, `shots[${index}].continuous_action`, 500),
      ending_state: safeText(shot.ending_state, `shots[${index}].ending_state`, 500),
      visible_character_ids: visibleCharacterIds,
      dialogue: [],
      text_regions: normalizeTextRegions(shot.text_regions, `shots[${index}].text_regions`, seenTextRegionIds),
      audio_contract: normalizeAudioContract(shot.audio_contract, `shots[${index}].audio_contract`),
      confidence: normalizeConfidence(shot.confidence, `shots[${index}].confidence`),
    };
    normalizedShot.dialogue = normalizeDialogue(
      shot.dialogue,
      `shots[${index}].dialogue`,
      normalizedShot,
      new Set(visibleCharacterIds),
      seenTurnIds,
    );
    if (normalizedShot.audio_contract.dialogue_mode === 'silent' && normalizedShot.dialogue.length > 0) {
      throw new Error(`shots[${index}] silent 不能包含 dialogue`);
    }
    if (normalizedShot.audio_contract.dialogue_mode === 'spoken' && normalizedShot.dialogue.length === 0) {
      throw new Error(`shots[${index}] spoken 必须包含 dialogue`);
    }
    return normalizedShot;
  }).map((shot, index, shots) => {
    if (index === shots.length - 1 && shot.end_ms !== durationMs) {
      throw new Error('shots 必须覆盖到 duration_ms');
    }
    return shot;
  });
}

function normalizeEpisodeFactsV2(raw) {
  assertAllowedKeys(raw, 'source_facts', TOP_LEVEL_FIELDS);
  if (raw.schema_version !== '2.0') throw new Error('schema_version 必须是 2.0');
  const durationMs = numberMs(raw.duration_ms, 'duration_ms');
  if (durationMs <= 0) throw new Error('duration_ms 必须大于 0');

  const characters = normalizeCharacters(raw.characters);
  const characterIds = new Set(characters.map((character) => character.id));
  const normalized = {
    schema_version: '2.0',
    duration_ms: durationMs,
    story: normalizeStringArray(raw.story, 'story'),
    characters,
    scenes: normalizeScenes(raw.scenes, durationMs),
    props: normalizeProps(raw.props, durationMs),
    shots: normalizeShots(raw.shots, durationMs, characterIds),
    causal_chain: normalizeStringArray(raw.causal_chain, 'causal_chain'),
    locked_facts: normalizeStringArray(raw.locked_facts, 'locked_facts'),
    reversals: normalizeStringArray(raw.reversals, 'reversals'),
    episode_hook: safeText(raw.episode_hook, 'episode_hook', 500),
  };
  normalized.facts_hash = createHash('sha256').update(stableStringify(normalized)).digest('hex');
  return normalized;
}

module.exports = {
  TOP_LEVEL_FIELDS,
  normalizeEpisodeFactsV2,
  stableStringify,
};
