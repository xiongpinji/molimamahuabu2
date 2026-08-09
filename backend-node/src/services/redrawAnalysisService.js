const { createHash } = require('crypto');

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`);
  }
}

function assertNonEmptyArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} 必须是非空数组`);
  }
}

function numberMs(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} 时间码无效`);
  return n;
}

function validateRange(range, name, durationMs) {
  assertObject(range, name);
  const start = numberMs(range.start_ms, `${name}.start_ms`);
  const end = numberMs(range.end_ms, `${name}.end_ms`);
  if (end <= start) throw new Error(`${name} 时间码倒序`);
  if (end > durationMs) throw new Error(`${name} 时间码越界 duration`);
  return { start_ms: start, end_ms: end };
}

function normalizeRanges(value, name, durationMs) {
  assertNonEmptyArray(value, name);
  let previousEnd = 0;
  return value.map((range, index) => {
    const normalized = validateRange(range, `${name}[${index}]`, durationMs);
    if (index > 0 && normalized.start_ms < previousEnd) {
      throw new Error(`${name} 时间码必须单调且不能重叠`);
    }
    previousEnd = normalized.end_ms;
    return normalized;
  });
}

function normalizeDialogueLine(line, name, shotRange) {
  assertObject(line, name);
  if (!line.speaker_id) throw new Error(`${name}.speaker_id 必须提供`);

  const hasStart = line.start_ms != null;
  const hasEnd = line.end_ms != null;
  if (hasStart !== hasEnd) throw new Error(`${name} 时间码必须同时提供 start_ms 和 end_ms`);

  const normalized = {
    speaker_id: String(line.speaker_id),
    text: String(line.text || ''),
  };
  if (hasStart) {
    const range = validateRange(line, name, shotRange.end_ms);
    if (range.start_ms < shotRange.start_ms || range.end_ms > shotRange.end_ms) {
      throw new Error(`${name} 时间码必须位于所属分镜内`);
    }
    normalized.start_ms = range.start_ms;
    normalized.end_ms = range.end_ms;
  }
  if (line.emotion != null) normalized.emotion = String(line.emotion);
  if (line.overlap_group != null) normalized.overlap_group = String(line.overlap_group);
  return normalized;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeSourceFacts(raw) {
  assertObject(raw, 'source_facts');
  const durationMs = numberMs(raw.duration_ms, 'duration_ms');
  if (durationMs <= 0) throw new Error('duration_ms 必须大于 0');

  assertNonEmptyArray(raw.characters, 'characters');
  assertNonEmptyArray(raw.scenes, 'scenes');
  assertNonEmptyArray(raw.props, 'props');
  assertNonEmptyArray(raw.shots, 'shots');
  assertNonEmptyArray(raw.causal_chain, 'causal_chain');
  assertNonEmptyArray(raw.locked_facts, 'locked_facts');
  assertNonEmptyArray(raw.reversals, 'reversals');
  if (raw.episode_hook == null || String(raw.episode_hook).trim() === '') {
    throw new Error('episode_hook 必须提供');
  }

  const characters = raw.characters.map((character, index) => {
    assertObject(character, `characters[${index}]`);
    if (!character.id) throw new Error(`characters[${index}].id 必须提供`);
    if (!character.source_name) throw new Error(`characters[${index}].source_name 必须提供`);
    return {
      id: String(character.id),
      source_name: String(character.source_name),
      relationships: Array.isArray(character.relationships) ? character.relationships.map(String) : [],
    };
  });

  const scenes = raw.scenes.map((scene, index) => {
    assertObject(scene, `scenes[${index}]`);
    if (!scene.id) throw new Error(`scenes[${index}].id 必须提供`);
    if (!scene.location) throw new Error(`scenes[${index}].location 必须提供`);
    if (!scene.time) throw new Error(`scenes[${index}].time 必须提供`);
    return {
      id: String(scene.id),
      location: String(scene.location),
      time: String(scene.time),
      source_ranges: normalizeRanges(scene.source_ranges, `scenes[${index}].source_ranges`, durationMs),
    };
  });

  const props = raw.props.map((prop, index) => {
    assertObject(prop, `props[${index}]`);
    if (!prop.id) throw new Error(`props[${index}].id 必须提供`);
    if (!prop.name) throw new Error(`props[${index}].name 必须提供`);
    return {
      id: String(prop.id),
      name: String(prop.name),
      evidence_ranges: normalizeRanges(prop.evidence_ranges, `props[${index}].evidence_ranges`, durationMs),
    };
  });

  let previousEnd = 0;
  const shots = raw.shots.map((shot, index) => {
    assertObject(shot, `shots[${index}]`);
    if (!shot.id) throw new Error(`shots[${index}].id 必须提供`);
    const range = validateRange(shot, `shots[${index}]`, durationMs);
    if (index > 0 && range.start_ms < previousEnd) throw new Error('shots 时间码重叠');
    previousEnd = range.end_ms;
    const dialogue = Array.isArray(shot.dialogue) ? shot.dialogue : [];
    for (const field of ['opening_state', 'continuous_action', 'ending_state']) {
      if (shot[field] == null || String(shot[field]).trim() === '') throw new Error(`shots[${index}].${field} 必须提供`);
    }
    return {
      id: String(shot.id),
      start_ms: range.start_ms,
      end_ms: range.end_ms,
      dialogue: dialogue.map((line, dialogueIndex) => normalizeDialogueLine(
        line,
        `shots[${index}].dialogue[${dialogueIndex}]`,
        range,
      )),
      screen_text: String(shot.screen_text || ''),
      opening_state: String(shot.opening_state),
      continuous_action: String(shot.continuous_action),
      ending_state: String(shot.ending_state),
    };
  });

  const normalized = {
    schema_version: '1.0',
    duration_ms: durationMs,
    characters,
    scenes,
    props,
    shots,
    causal_chain: raw.causal_chain.map(String),
    locked_facts: raw.locked_facts.map(String),
    reversals: raw.reversals.map(String),
    episode_hook: typeof raw.episode_hook === 'object' ? raw.episode_hook : String(raw.episode_hook),
  };
  normalized.facts_hash = createHash('sha256').update(stableStringify(normalized)).digest('hex');
  return normalized;
}

module.exports = { normalizeSourceFacts, stableStringify };
