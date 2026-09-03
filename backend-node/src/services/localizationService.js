const { createHash, randomUUID } = require('node:crypto');

const SHA256 = /^[a-f0-9]{64}$/;
const V2_RESULT_FIELDS = new Set([
  'facts_hash',
  'locale',
  'market',
  'name_map',
  'culture_map',
  'glossary',
  'dialogue',
  'text_map',
  'confidence',
]);
const EPISODE_RESULT_FIELDS = new Set([
  'blueprint_hash',
  'locale',
  'market',
  'name_map',
  'dialogue',
  'text_map',
  'culture_map',
  'glossary',
  'locked_terms',
]);
const CONFIDENCE_KEYS = ['names', 'dialogue_semantics', 'dialogue_timing', 'culture', 'screen_text'];
const UNSAFE_KEY = /(?:^|_|\b)(?:key|api_key|access_key|secret_key|private_key|auth|authorization|token|secret|password|credential|provider|model|generation|raw|prompt|url|path)(?:$|_|\b)/i;
const TARGET_INJECTION_KEYS = new Set(['locale', 'market', 'region', 'country', 'language', 'target_locale', 'target_market']);
const V2_DIALOGUE_ROW_FIELDS = new Set(['shot_id', 'shotId', 'turns']);
const V2_DIALOGUE_TURN_FIELDS = new Set(['id', 'turn_id', 'speaker_id', 'start_ms', 'end_ms', 'overlap_group', 'target_text', 'localized_text', 'text']);
const EPISODE_DIALOGUE_TURN_FIELDS = new Set([
  'id', 'turn_id', 'speaker_id', 'target_text', 'localized_text', 'text', 'pronunciation_hint',
]);
const CULTURAL_ADAPTATION_FIELDS = new Set(['id', 'source', 'target', 'note']);
const GLOSSARY_FIELDS = new Set(['source_term', 'target_term', 'note']);
const EPISODE_LOCALIZATION_FIELDS = new Set([
  'schema_version', 'blueprint_hash', 'locale', 'market', 'character_name_map',
  'dialogue_map', 'text_region_map', 'cultural_adaptations', 'glossary',
  'locked_terms', 'review', 'localization_hash',
]);
const EPISODE_DIALOGUE_FIELDS = new Set([
  'source_dialogue_id', 'shot_id', 'speaker_id', 'speaker_kind', 'source_text',
  'target_text', 'start_ms', 'end_ms', 'estimated_duration_ms',
  'estimated_speech_rate', 'emotion', 'pronunciation_hint',
]);
const EPISODE_TEXT_REGION_FIELDS = new Set([
  'text_region_id', 'shot_id', 'source_text', 'target_text',
]);
const EPISODE_REVIEW_FIELDS = new Set([
  'status', 'updated_at', 'character_name_map', 'dialogue_map', 'text_region_map',
  'cultural_adaptations', 'glossary', 'locked_terms',
]);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error(`${name} 必须是对象`), { code: 'LOCALIZATION_INVALID_INPUT' });
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function factsHash(sourceFacts) {
  if (sourceFacts?.schema_version === '2.0' && SHA256.test(String(sourceFacts.facts_hash || ''))) {
    return String(sourceFacts.facts_hash);
  }
  const hashable = clone(sourceFacts);
  if (hashable && typeof hashable === 'object') delete hashable.facts_hash;
  return createHash('sha256').update(stableStringify(hashable)).digest('hex');
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeOwner(owner = {}) {
  return {
    tenantId: owner.tenantId ?? owner.tenant_id ?? null,
    userId: owner.userId ?? owner.user_id ?? null,
  };
}

function assertLocale(locale) {
  const value = String(locale || '').trim();
  if (!value) throw Object.assign(new Error('locale 必须提供'), { code: 'LOCALIZATION_LOCALE_REQUIRED' });
  return value;
}

function canonical(value) {
  return stableStringify(value);
}

function firstConflict(sourceValue, localizedValue, path) {
  if (canonical(sourceValue) === canonical(localizedValue)) return null;
  return { path, source_value: clone(sourceValue), localized_value: clone(localizedValue) };
}

function compareProtected(sourceFacts, localizedFacts, conflicts) {
  for (const path of ['causal_chain', 'reversals', 'locked_facts']) {
    const source = Array.isArray(sourceFacts[path]) ? sourceFacts[path] : [];
    const localized = Array.isArray(localizedFacts[path]) ? localizedFacts[path] : [];
    const length = Math.max(source.length, localized.length);
    for (let index = 0; index < length; index += 1) {
      const conflict = firstConflict(source[index], localized[index], `${path}[${index}]`);
      if (conflict) conflicts.push(conflict);
    }
  }
  const hookConflict = firstConflict(sourceFacts.episode_hook, localizedFacts.episode_hook, 'episode_hook');
  if (hookConflict) {
    conflicts.push(hookConflict);
  }

  const sourceCharacters = Array.isArray(sourceFacts.characters) ? sourceFacts.characters : [];
  const localizedCharacters = Array.isArray(localizedFacts.characters) ? localizedFacts.characters : [];
  const sourceRelations = sourceCharacters.map((character) => ({
    id: character?.id,
    relationships: character?.relationships || [],
  }));
  const localizedRelations = localizedCharacters.map((character) => ({
    id: character?.id,
    relationships: character?.relationships || [],
  }));
  const relationshipConflict = firstConflict(sourceRelations, localizedRelations, 'characters.relationships');
  if (relationshipConflict) conflicts.push(relationshipConflict);

  for (const path of ['scenes', 'props', 'shots']) {
    const source = Array.isArray(sourceFacts[path]) ? sourceFacts[path] : [];
    const localized = Array.isArray(localizedFacts[path]) ? localizedFacts[path] : [];
    const sourceIdentity = source.map((item) => ({
      id: item?.id,
      start_ms: item?.start_ms,
      end_ms: item?.end_ms,
      source_ranges: item?.source_ranges,
      evidence_ranges: item?.evidence_ranges,
    }));
    const localizedIdentity = localized.map((item) => ({
      id: item?.id,
      start_ms: item?.start_ms,
      end_ms: item?.end_ms,
      source_ranges: item?.source_ranges,
      evidence_ranges: item?.evidence_ranges,
    }));
    const conflict = firstConflict(sourceIdentity, localizedIdentity, path);
    if (conflict) conflicts.push(conflict);
  }
}

function validateLocalizedFacts(sourceFacts, localizedFacts) {
  assertObject(sourceFacts, 'source_facts');
  assertObject(localizedFacts, 'localized_facts');
  const conflicts = [];
  compareProtected(sourceFacts, localizedFacts, conflicts);
  return {
    ok: conflicts.length === 0,
    conflicts,
    value: conflicts.length === 0 ? clone(localizedFacts) : null,
  };
}

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function assertSafeJson(value, path = 'localized_result', seen = new WeakSet()) {
  if (value == null) return;
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw codedError('LOCALIZATION_INVALID_JSON', `${path} number invalid`);
    return;
  }
  if (type === 'string' || type === 'boolean') return;
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    throw codedError('LOCALIZATION_INVALID_JSON', `${path} JSON invalid`);
  }
  if (seen.has(value)) throw codedError('LOCALIZATION_INVALID_JSON', `${path} JSON cycle`);
  if (Buffer.isBuffer(value)
    || value instanceof Date
    || value instanceof Map
    || value instanceof Set
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)) {
    throw codedError('LOCALIZATION_INVALID_JSON', `${path} JSON invalid`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJson(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) throw codedError('LOCALIZATION_INVALID_JSON', `${path} JSON object invalid`);
  for (const key of Object.keys(value)) {
    const normalizedKey = key.normalize('NFKC');
    if (normalizedKey === '__proto__' || normalizedKey === 'constructor' || normalizedKey === 'prototype' || UNSAFE_KEY.test(normalizedKey)) {
      throw codedError('LOCALIZATION_UNKNOWN_FIELD', `${path}.${key} is not allowed`, { field: key });
    }
    assertSafeJson(value[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function compactComparableText(value) {
  return normalizeText(value).replace(/[\p{White_Space}\p{P}\p{S}]+/gu, '');
}

function v2SourceHash(sourceFacts) {
  const value = String(sourceFacts?.facts_hash || '').trim();
  if (!SHA256.test(value)) {
    throw codedError('LOCALIZATION_FACT_HASH_MISMATCH', 'v2 source facts_hash invalid');
  }
  return value;
}

function assertV2RootFields(raw) {
  for (const key of Object.keys(raw)) {
    if (!V2_RESULT_FIELDS.has(key)) {
      throw codedError('LOCALIZATION_UNKNOWN_FIELD', `v2 localization field not allowed: ${key}`, { field: key });
    }
  }
}

function assertOnlyKeys(value, allowed, code, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw codedError(code, `${name}.${key} is not allowed`, { field: key });
  }
}

function safeMap(value, name) {
  assertObject(value, name);
  assertSafeJson(value, name);
  return clone(value);
}

function safeStringMap(value, name, code) {
  const map = safeMap(value, name);
  for (const key of Object.keys(map)) {
    const normalizedKey = normalizeText(key);
    if (TARGET_INJECTION_KEYS.has(normalizedKey) || normalizedKey.startsWith('target_')) {
      throw codedError(code, `${name} target field invalid`);
    }
    if (typeof map[key] !== 'string') throw codedError(code, `${name} value invalid`);
    map[key] = map[key].trim();
  }
  return map;
}

function collectV2TextRegions(sourceFacts) {
  const regions = [];
  for (const shot of Array.isArray(sourceFacts.shots) ? sourceFacts.shots : []) {
    for (const region of Array.isArray(shot?.text_regions) ? shot.text_regions : []) {
      const key = `${String(shot.id)}:${String(region.id)}`;
      regions.push({ key, source_text: String(region.source_text ?? region.text ?? '') });
    }
  }
  return regions;
}

function normalizeV2NameMap(rawNameMap, sourceFacts) {
  const nameMap = safeMap(rawNameMap, 'name_map');
  const characters = Array.isArray(sourceFacts.characters) ? sourceFacts.characters : [];
  const expectedIds = characters.map((character) => String(character?.id || '').trim()).filter(Boolean);
  const actualIds = Object.keys(nameMap).sort();
  if (stableStringify(actualIds) !== stableStringify([...expectedIds].sort())) {
    throw codedError('LOCALIZATION_NAME_MAP_MISMATCH', 'v2 name_map must exactly cover source character ids');
  }
  const seenNames = new Set();
  for (const id of expectedIds) {
    if (typeof nameMap[id] !== 'string') throw codedError('LOCALIZATION_NAME_INVALID', 'v2 localized name invalid');
    const value = nameMap[id].trim();
    if (!value) throw codedError('LOCALIZATION_NAME_EMPTY', 'v2 localized name empty', { character_id: id });
    const normalized = normalizeText(value);
    if (seenNames.has(normalized)) throw codedError('LOCALIZATION_NAME_DUPLICATE', 'v2 localized names duplicate');
    seenNames.add(normalized);
    nameMap[id] = value;
  }
  return nameMap;
}

function assertNoSourceRemainder(targetText, sourceText, sourceFacts) {
  const normalizedTarget = normalizeText(targetText);
  const normalizedSource = normalizeText(sourceText);
  const compactTarget = compactComparableText(targetText);
  const compactSource = compactComparableText(sourceText);
  if (normalizedTarget === normalizedSource || (compactSource && compactTarget.includes(compactSource))) {
    throw codedError('LOCALIZATION_SOURCE_TEXT_REMAINS', 'target text equals source text');
  }
  for (const character of Array.isArray(sourceFacts.characters) ? sourceFacts.characters : []) {
    const sourceName = compactComparableText(character?.source_name ?? character?.display_name);
    if (sourceName && compactTarget.includes(sourceName)) {
      throw codedError('LOCALIZATION_SOURCE_TEXT_REMAINS', 'target text contains source character name');
    }
  }
}

function turnTargetText(turn) {
  return String(turn?.target_text ?? turn?.localized_text ?? turn?.text ?? '').trim();
}

function normalizeV2Dialogue(rawDialogue, sourceFacts, locale) {
  if (!Array.isArray(rawDialogue)) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 dialogue must be an array');
  const sourceShots = Array.isArray(sourceFacts.shots) ? sourceFacts.shots : [];
  const rows = new Map();
  for (const row of rawDialogue) {
    assertObject(row, 'dialogue[]');
    assertSafeJson(row, 'dialogue[]');
    assertOnlyKeys(row, V2_DIALOGUE_ROW_FIELDS, 'LOCALIZATION_UNKNOWN_FIELD', 'dialogue[]');
    const shotId = String(row.shot_id ?? row.shotId ?? '').trim();
    if (!shotId || rows.has(shotId)) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 dialogue shot invalid');
    rows.set(shotId, row);
  }
  const sourceShotIds = new Set(sourceShots.map((shot) => String(shot?.id || '')));
  for (const shotId of rows.keys()) {
    if (!sourceShotIds.has(shotId)) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 dialogue shot unknown');
  }

  return sourceShots.map((shot) => {
    const shotId = String(shot?.id || '');
    const sourceTurns = Array.isArray(shot?.dialogue) ? shot.dialogue : [];
    const row = rows.get(shotId);
    const turns = row ? row.turns : [];
    if (!Array.isArray(turns)) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 dialogue turns invalid');
    if (sourceTurns.length === 0) {
      if (turns.length !== 0) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 silent shot cannot add dialogue');
      return { shot_id: shotId, turns: [] };
    }
    if (!row || turns.length !== sourceTurns.length) {
      throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 dialogue turn count mismatch');
    }
    const normalizedTurns = [];
    for (let index = 0; index < sourceTurns.length; index += 1) {
      const source = sourceTurns[index] || {};
      const localized = turns[index] || {};
      assertObject(localized, 'dialogue[].turns[]');
      assertSafeJson(localized, 'dialogue[].turns[]');
      assertOnlyKeys(localized, V2_DIALOGUE_TURN_FIELDS, 'LOCALIZATION_UNKNOWN_FIELD', 'dialogue[].turns[]');
      const sourceId = String(source.id ?? source.turn_id ?? `turn-${index + 1}`);
      const localizedId = String(localized.id ?? localized.turn_id ?? '').trim();
      if (localizedId !== sourceId) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 dialogue turn id mismatch');
      if (localized.speaker_id != null && String(localized.speaker_id) !== String(source.speaker_id)) {
        throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 dialogue speaker mismatch');
      }
      if ((localized.start_ms != null && Number(localized.start_ms) !== Number(source.start_ms))
        || (localized.end_ms != null && Number(localized.end_ms) !== Number(source.end_ms))) {
        throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 dialogue timing mismatch');
      }
      if (localized.overlap_group != null && (localized.overlap_group || null) !== (source.overlap_group || null)) {
        throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 dialogue overlap mismatch');
      }
      const targetText = turnTargetText(localized);
      if (!targetText) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'v2 dialogue target text missing');
      assertNoSourceRemainder(targetText, source.source_text ?? source.text, sourceFacts);
      const availableMs = Number(source.end_ms) - Number(source.start_ms);
      const estimatedDurationMs = estimateSpeechMs(targetText, locale);
      if (!Number.isFinite(availableMs) || availableMs <= 0 || estimatedDurationMs > availableMs) {
        throw codedError('LOCALIZATION_DIALOGUE_DURATION_EXCEEDED', 'v2 dialogue duration exceeded');
      }
      normalizedTurns.push({
        id: sourceId,
        speaker_id: String(source.speaker_id),
        source_text: String(source.source_text ?? source.text ?? ''),
        target_text: targetText,
        start_ms: Number(source.start_ms),
        end_ms: Number(source.end_ms),
        emotion: source.emotion ?? null,
        overlap_group: source.overlap_group || null,
        estimated_duration_ms: estimatedDurationMs,
      });
    }
    return { shot_id: shotId, turns: normalizedTurns };
  });
}

function normalizeV2TextMap(rawTextMap, sourceFacts) {
  const textMap = safeMap(rawTextMap, 'text_map');
  const regions = collectV2TextRegions(sourceFacts);
  const expectedKeys = regions.map((region) => region.key).sort();
  const actualKeys = Object.keys(textMap).sort();
  if (stableStringify(expectedKeys) !== stableStringify(actualKeys)) {
    throw codedError('LOCALIZATION_TEXT_REGION_MISMATCH', 'v2 text_map must exactly cover source text regions');
  }
  for (const region of regions) {
    if (typeof textMap[region.key] !== 'string') {
      throw codedError('LOCALIZATION_TEXT_REGION_MISMATCH', 'v2 text_map target must be string');
    }
    const targetText = textMap[region.key].trim();
    if (!targetText) throw codedError('LOCALIZATION_TEXT_REGION_MISMATCH', 'v2 text_map target empty');
    assertNoSourceRemainder(targetText, region.source_text, sourceFacts);
    textMap[region.key] = targetText;
  }
  return textMap;
}

function normalizeV2Confidence(rawConfidence) {
  const confidence = safeMap(rawConfidence, 'confidence');
  const actualKeys = Object.keys(confidence).sort();
  if (stableStringify(actualKeys) !== stableStringify([...CONFIDENCE_KEYS].sort())) {
    throw codedError('LOCALIZATION_CONFIDENCE_INVALID', 'v2 confidence keys invalid');
  }
  for (const key of CONFIDENCE_KEYS) {
    const value = Number(confidence[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw codedError('LOCALIZATION_CONFIDENCE_INVALID', 'v2 confidence value invalid', { field: key });
    }
    confidence[key] = value;
  }
  return confidence;
}

function localeComparable(value, locale) {
  const normalized = String(value ?? '').normalize('NFKC').trim();
  let lowered;
  try {
    lowered = normalized.toLocaleLowerCase(locale);
  } catch (_) {
    lowered = normalized.toLowerCase();
  }
  return lowered.replace(/[\p{White_Space}\p{P}\p{S}]+/gu, '');
}

function assertEpisodeRootFields(raw) {
  for (const key of Object.keys(raw)) {
    if (!EPISODE_RESULT_FIELDS.has(key)) {
      throw codedError('LOCALIZATION_UNKNOWN_FIELD', `episode localization field not allowed: ${key}`, { field: key });
    }
  }
}

function assertEpisodeBlueprintHash(raw, blueprintFacts, options) {
  const blueprintHash = String(options.blueprintHash || '').trim();
  if (!SHA256.test(blueprintHash)
    || blueprintHash !== String(blueprintFacts?.blueprint_hash || '').trim()
    || blueprintHash !== String(raw.blueprint_hash || '').trim()) {
    throw codedError('BLUEPRINT_HASH_MISMATCH', 'localization blueprint_hash mismatch');
  }
  return blueprintHash;
}

function targetLanguageResultOk(result) {
  return result === true || result?.ok === true || result?.language_verified === true;
}

function assertTargetLanguage(text, options, details) {
  const validate = options.validateTargetText || options.languageGate;
  if (typeof validate !== 'function') {
    throw codedError('LOCALIZATION_LANGUAGE_GATE_REQUIRED', 'target language verifier required');
  }
  const result = validate({
    text,
    locale: options.locale,
    market: options.market,
    ...details,
  });
  if (result && typeof result.then === 'function') {
    throw codedError('LOCALIZATION_LANGUAGE_GATE_INVALID', 'target language verifier must be synchronous');
  }
  if (!targetLanguageResultOk(result)) {
    throw codedError('LOCALIZATION_TARGET_LANGUAGE_MISMATCH', 'target text language mismatch', details);
  }
}

function episodeNameMap(rawNameMap, blueprintFacts, locale, options) {
  const nameMap = safeMap(rawNameMap, 'name_map');
  const characters = Array.isArray(blueprintFacts.characters) ? blueprintFacts.characters : [];
  const expectedIds = characters.map((character) => String(character?.id || '').trim()).filter(Boolean);
  const actualIds = Object.keys(nameMap).sort();
  if (stableStringify(actualIds) !== stableStringify([...expectedIds].sort())) {
    throw codedError('LOCALIZATION_NAME_MAP_MISMATCH', 'name_map must exactly cover blueprint characters');
  }
  const seen = new Set();
  const normalized = {};
  for (const character of characters) {
    const id = String(character.id);
    if (typeof nameMap[id] !== 'string') {
      throw codedError('LOCALIZATION_NAME_INVALID', 'localized character name invalid', { character_id: id });
    }
    const value = nameMap[id].trim();
    if (!value) throw codedError('LOCALIZATION_NAME_EMPTY', 'localized character name empty', { character_id: id });
    const comparable = localeComparable(value, locale);
    if (!comparable) throw codedError('LOCALIZATION_NAME_EMPTY', 'localized character name empty', { character_id: id });
    if (seen.has(comparable)) throw codedError('LOCALIZATION_NAME_DUPLICATE', 'localized character names duplicate');
    seen.add(comparable);
    assertNoSourceRemainder(value, character.source_name ?? character.display_name, blueprintFacts);
    assertTargetLanguage(value, options, { kind: 'character_name', id });
    normalized[id] = value;
  }
  return normalized;
}

function episodeSourceDialogue(blueprintFacts) {
  const entries = [];
  for (const shot of Array.isArray(blueprintFacts.shots) ? blueprintFacts.shots : []) {
    for (const turn of Array.isArray(shot?.dialogue) ? shot.dialogue : []) {
      entries.push({ shot, turn });
    }
  }
  return entries;
}

function episodeProviderDialogue(rawDialogue) {
  if (!Array.isArray(rawDialogue)) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'dialogue must be an array');
  const turns = new Map();
  for (const row of rawDialogue) {
    assertObject(row, 'dialogue[]');
    assertSafeJson(row, 'dialogue[]');
    assertOnlyKeys(row, V2_DIALOGUE_ROW_FIELDS, 'LOCALIZATION_UNKNOWN_FIELD', 'dialogue[]');
    const shotId = String(row.shot_id ?? row.shotId ?? '').trim();
    if (!shotId || !Array.isArray(row.turns)) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'dialogue shot invalid');
    for (const rawTurn of row.turns) {
      assertObject(rawTurn, 'dialogue[].turns[]');
      assertSafeJson(rawTurn, 'dialogue[].turns[]');
      assertOnlyKeys(rawTurn, EPISODE_DIALOGUE_TURN_FIELDS, 'LOCALIZATION_UNKNOWN_FIELD', 'dialogue[].turns[]');
      const id = String(rawTurn.id ?? rawTurn.turn_id ?? '').trim();
      if (!id || turns.has(id)) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'dialogue id invalid or duplicate');
      turns.set(id, { shot_id: shotId, value: rawTurn });
    }
  }
  return turns;
}

function normalizeEpisodeDialogue(rawDialogue, blueprintFacts, locale, options) {
  const sourceEntries = episodeSourceDialogue(blueprintFacts);
  const provided = episodeProviderDialogue(rawDialogue);
  const expectedIds = sourceEntries.map(({ turn }) => String(turn?.id || '').trim());
  if (expectedIds.some((id) => !id)
    || stableStringify([...provided.keys()].sort()) !== stableStringify([...expectedIds].sort())) {
    throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'dialogue must exactly cover source dialogue ids');
  }
  return sourceEntries.map(({ shot, turn }) => {
    const id = String(turn.id);
    const providedTurn = provided.get(id);
    if (providedTurn.shot_id !== String(shot.id)
      || (providedTurn.value.speaker_id != null
        && String(providedTurn.value.speaker_id) !== String(turn.speaker_id))) {
      throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'dialogue shot or speaker mismatch', { source_dialogue_id: id });
    }
    const targetText = turnTargetText(providedTurn.value);
    if (!targetText) throw codedError('LOCALIZATION_DIALOGUE_INVALID', 'dialogue target text missing');
    assertNoSourceRemainder(targetText, turn.source_text, blueprintFacts);
    assertTargetLanguage(targetText, options, { kind: 'dialogue', id });
    const availableMs = Number(turn.end_ms) - Number(turn.start_ms);
    const estimatedDurationMs = estimateSpeechMs(targetText, locale);
    if (!Number.isFinite(availableMs) || availableMs <= 0 || estimatedDurationMs > availableMs) {
      throw codedError('LOCALIZATION_DIALOGUE_DURATION_EXCEEDED', 'dialogue duration exceeded', { source_dialogue_id: id });
    }
    return {
      source_dialogue_id: id,
      shot_id: String(shot.id),
      speaker_id: String(turn.speaker_id),
      speaker_kind: String(turn.speaker_kind || 'character'),
      source_text: String(turn.source_text || ''),
      target_text: targetText,
      start_ms: Number(turn.start_ms),
      end_ms: Number(turn.end_ms),
      estimated_duration_ms: estimatedDurationMs,
      estimated_speech_rate: Number((Array.from(targetText).length / (availableMs / 1000)).toFixed(2)),
      emotion: String(turn.emotion || ''),
      pronunciation_hint: String(providedTurn.value.pronunciation_hint || '').trim(),
    };
  });
}

function episodeTextRegions(blueprintFacts) {
  const regions = [];
  for (const shot of Array.isArray(blueprintFacts.shots) ? blueprintFacts.shots : []) {
    for (const region of Array.isArray(shot?.text_regions) ? shot.text_regions : []) {
      const sourceText = String(region?.source_text || '').trim();
      if (sourceText) regions.push({ shot_id: String(shot.id), region, source_text: sourceText });
    }
  }
  return regions;
}

function normalizeEpisodeTextMap(rawTextMap, blueprintFacts, options) {
  const textMap = safeMap(rawTextMap, 'text_map');
  const regions = episodeTextRegions(blueprintFacts);
  const expectedKeys = regions.map(({ shot_id: shotId, region }) => `${shotId}:${String(region.id)}`).sort();
  if (stableStringify(Object.keys(textMap).sort()) !== stableStringify(expectedKeys)) {
    throw codedError('LOCALIZATION_TEXT_REGION_MISMATCH', 'text_map must exactly cover source text regions');
  }
  return regions.map(({ shot_id: shotId, region, source_text: sourceText }) => {
    const key = `${shotId}:${String(region.id)}`;
    if (typeof textMap[key] !== 'string' || !textMap[key].trim()) {
      throw codedError('LOCALIZATION_TEXT_REGION_MISMATCH', 'text region target missing');
    }
    const targetText = textMap[key].trim();
    assertNoSourceRemainder(targetText, sourceText, blueprintFacts);
    assertTargetLanguage(targetText, options, { kind: 'text_region', id: String(region.id) });
    return {
      text_region_id: String(region.id),
      shot_id: shotId,
      source_text: sourceText,
      target_text: targetText,
    };
  });
}

function normalizeCulturalAdaptations(raw, options) {
  if (!Array.isArray(raw)) throw codedError('LOCALIZATION_CULTURE_MAP_INVALID', 'culture_map must be an array');
  const seen = new Set();
  return raw.map((item) => {
    assertObject(item, 'culture_map[]');
    assertSafeJson(item, 'culture_map[]');
    assertOnlyKeys(item, CULTURAL_ADAPTATION_FIELDS, 'LOCALIZATION_CULTURE_MAP_INVALID', 'culture_map[]');
    const id = String(item.id || '').trim();
    const source = String(item.source || '').trim();
    const target = String(item.target || '').trim();
    if (!id || seen.has(id) || !source || !target) throw codedError('LOCALIZATION_CULTURE_MAP_INVALID', 'culture adaptation invalid');
    seen.add(id);
    assertTargetLanguage(target, options, { kind: 'cultural_adaptation', id });
    return { id, source, target, note: String(item.note || '').trim() };
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

function normalizeEpisodeGlossary(raw, options) {
  if (!Array.isArray(raw)) throw codedError('LOCALIZATION_GLOSSARY_INVALID', 'glossary must be an array');
  const seen = new Set();
  return raw.map((item) => {
    assertObject(item, 'glossary[]');
    assertSafeJson(item, 'glossary[]');
    assertOnlyKeys(item, GLOSSARY_FIELDS, 'LOCALIZATION_GLOSSARY_INVALID', 'glossary[]');
    const sourceTerm = String(item.source_term || '').trim();
    const targetTerm = String(item.target_term || '').trim();
    if (!sourceTerm || !targetTerm || seen.has(sourceTerm)) throw codedError('LOCALIZATION_GLOSSARY_INVALID', 'glossary item invalid');
    seen.add(sourceTerm);
    assertTargetLanguage(targetTerm, options, { kind: 'glossary', id: sourceTerm });
    return { source_term: sourceTerm, target_term: targetTerm, note: String(item.note || '').trim() };
  }).sort((left, right) => left.source_term.localeCompare(right.source_term, 'en'));
}

function normalizeLockedTerms(raw, options) {
  if (!Array.isArray(raw)) throw codedError('LOCALIZATION_LOCKED_TERMS_INVALID', 'locked_terms must be an array');
  const seen = new Set();
  return raw.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw codedError('LOCALIZATION_LOCKED_TERMS_INVALID', 'locked term invalid');
    const value = item.trim();
    const comparable = localeComparable(value, options.locale);
    if (seen.has(comparable)) throw codedError('LOCALIZATION_LOCKED_TERMS_INVALID', 'locked term duplicate');
    seen.add(comparable);
    assertTargetLanguage(value, options, { kind: 'locked_term', id: value });
    return value;
  }).sort((left, right) => left.localeCompare(right, 'en'));
}

function uncheckedReview(localization) {
  return {
    status: 'review',
    character_name_map: Object.fromEntries(Object.keys(localization.character_name_map).map((id) => [id, false])),
    dialogue_map: Object.fromEntries(localization.dialogue_map.map((item) => [item.source_dialogue_id, false])),
    text_region_map: Object.fromEntries(localization.text_region_map.map((item) => [item.text_region_id, false])),
    cultural_adaptations: Object.fromEntries(localization.cultural_adaptations.map((item) => [item.id, false])),
    glossary: Object.fromEntries(localization.glossary.map((item) => [item.source_term, false])),
    locked_terms: Object.fromEntries(localization.locked_terms.map((item) => [item, false])),
  };
}

const REVIEW_AUDIT_TIME_FIELDS = new Set(['updated_at', 'reviewed_at']);

function withoutReviewAuditTimes(value) {
  if (Array.isArray(value)) return value.map(withoutReviewAuditTimes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !REVIEW_AUDIT_TIME_FIELDS.has(key))
    .map(([key, item]) => [key, withoutReviewAuditTimes(item)]));
}

function episodeLocalizationHash(localization) {
  const hashable = clone(localization);
  delete hashable.localization_hash;
  if (hashable.review) hashable.review = withoutReviewAuditTimes(hashable.review);
  return createHash('sha256').update(stableStringify(hashable)).digest('hex');
}

function normalizeEpisodeLocalizationResult(raw, blueprintFacts, options = {}) {
  assertObject(raw, 'localized_result');
  assertSafeJson(raw);
  assertEpisodeRootFields(raw);
  const blueprintHash = assertEpisodeBlueprintHash(raw, blueprintFacts, options);
  const locale = String(options.locale || '').trim();
  const market = String(options.market || '').trim();
  if (!locale || String(raw.locale || '').trim() !== locale) {
    throw codedError('LOCALIZATION_LOCALE_MISMATCH', 'episode locale mismatch');
  }
  if (!market || String(raw.market || '').trim() !== market) {
    throw codedError('LOCALIZATION_MARKET_MISMATCH', 'episode market mismatch');
  }
  const normalized = {
    schema_version: 'episode-localization-v1',
    blueprint_hash: blueprintHash,
    locale,
    market,
    character_name_map: episodeNameMap(raw.name_map, blueprintFacts, locale, options),
    dialogue_map: normalizeEpisodeDialogue(raw.dialogue, blueprintFacts, locale, options),
    text_region_map: normalizeEpisodeTextMap(raw.text_map, blueprintFacts, options),
    cultural_adaptations: normalizeCulturalAdaptations(raw.culture_map, options),
    glossary: normalizeEpisodeGlossary(raw.glossary, options),
    locked_terms: normalizeLockedTerms(raw.locked_terms, options),
  };
  normalized.review = uncheckedReview(normalized);
  normalized.localization_hash = episodeLocalizationHash(normalized);
  return normalized;
}

function assertSafeLocalizationString(value) {
  if (typeof value === 'string' && (/https?:\/\//i.test(value)
    || /^(?:[a-z]:[\\/]|\\\\|\/|file:\/\/)/i.test(value)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value))) {
    throw codedError('LOCALIZATION_INPUT_INVALID', 'localization cannot contain URL or path');
  }
  if (Array.isArray(value)) {
    value.forEach(assertSafeLocalizationString);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(assertSafeLocalizationString);
  }
}

function assertSafeLocalizationReviewValue(value) {
  assertSafeJson(value, 'localization');
  assertSafeLocalizationString(value);
}

function episodeReviewContext(db, owner, versionId) {
  const normalizedOwner = normalizeOwner(owner);
  const id = Number(versionId);
  if (!Number.isSafeInteger(id) || id <= 0 || !normalizedOwner.tenantId || !normalizedOwner.userId) {
    throw codedError('LOCALIZATION_INPUT_INVALID', 'localization owner or version invalid');
  }
  const version = db.prepare(`
    SELECT v.*, w.id AS owned_work_id
    FROM redraw_versions v
    JOIN redraw_works w
      ON w.id = v.work_id AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL
    LIMIT 1
  `).get(id, String(normalizedOwner.tenantId), String(normalizedOwner.userId));
  if (!version) throw codedError('LOCALIZATION_NOT_FOUND', 'localization version not found');
  const blueprintRow = db.prepare(`
    SELECT *
    FROM redraw_episode_blueprints
    WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND revision = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(version.work_id, String(normalizedOwner.tenantId), String(normalizedOwner.userId), Number(version.version));
  if (!blueprintRow || blueprintRow.status !== 'locked') {
    throw codedError('BLUEPRINT_NOT_LOCKED', 'localization requires locked blueprint');
  }
  const blueprint = parseJson(blueprintRow.blueprint_json, null);
  const blueprintHash = String(blueprintRow.blueprint_hash || '').trim();
  if (!blueprint || blueprint.schema_version !== 'episode-blueprint-v1'
    || !SHA256.test(blueprintHash)
    || blueprintHash !== String(blueprint.blueprint_hash || '').trim()
    || blueprintHash !== String(version.blueprint_hash || '').trim()) {
    throw codedError('BLUEPRINT_HASH_MISMATCH', 'localization blueprint binding changed');
  }
  return { owner: normalizedOwner, version, blueprint, blueprintRow, blueprintHash };
}

function parseStoredLocalization(version) {
  const localization = parseJson(version.localization_review_json, null);
  if (!localization || localization.schema_version !== 'episode-localization-v1') {
    throw codedError('LOCALIZATION_NOT_FOUND', 'localization review not found');
  }
  return localization;
}

function publicLocalizationReview(context, localization) {
  return {
    version_id: Number(context.version.id),
    work_id: Number(context.version.work_id),
    version: Number(context.version.version),
    status: localization.review?.status || 'review',
    blueprint_hash: context.blueprintHash,
    localization_hash: String(context.version.localization_hash || localization.localization_hash || ''),
    locale: localization.locale,
    market: localization.market,
    localization: clone(localization),
    updated_at: String(localization.review?.updated_at || context.version.updated_at || ''),
  };
}

function nextLocalizationTimestamp(previous, provided) {
  let millis = provided == null ? Date.now() : new Date(provided).getTime();
  if (!Number.isFinite(millis)) millis = Date.now();
  const previousMillis = Date.parse(String(previous || ''));
  if (Number.isFinite(previousMillis) && millis <= previousMillis) millis = previousMillis + 1;
  return new Date(millis).toISOString();
}

function getLocalizationReview(db, owner, versionId) {
  const context = episodeReviewContext(db, owner, versionId);
  return publicLocalizationReview(context, parseStoredLocalization(context.version));
}

function reviewMap(raw, expectedKeys, name) {
  assertObject(raw, `review.${name}`);
  assertOnlyKeys(raw, new Set(expectedKeys), 'LOCALIZATION_REVIEW_INVALID', `review.${name}`);
  if (Object.keys(raw).length !== expectedKeys.length) {
    throw codedError('LOCALIZATION_REVIEW_INVALID', `review.${name} must exactly cover items`);
  }
  return Object.fromEntries(expectedKeys.map((key) => {
    if (typeof raw[key] !== 'boolean') throw codedError('LOCALIZATION_REVIEW_INVALID', `review.${name}.${key} invalid`);
    return [key, raw[key]];
  }));
}

function normalizeReviewChecklist(raw, localization) {
  assertObject(raw, 'review');
  assertOnlyKeys(raw, EPISODE_REVIEW_FIELDS, 'LOCALIZATION_REVIEW_INVALID', 'review');
  if (raw.status !== 'review') throw codedError('LOCALIZATION_REVIEW_INVALID', 'review.status must be review');
  return {
    status: 'review',
    character_name_map: reviewMap(raw.character_name_map, Object.keys(localization.character_name_map), 'character_name_map'),
    dialogue_map: reviewMap(raw.dialogue_map, localization.dialogue_map.map((item) => item.source_dialogue_id), 'dialogue_map'),
    text_region_map: reviewMap(raw.text_region_map, localization.text_region_map.map((item) => item.text_region_id), 'text_region_map'),
    cultural_adaptations: reviewMap(raw.cultural_adaptations, localization.cultural_adaptations.map((item) => item.id), 'cultural_adaptations'),
    glossary: reviewMap(raw.glossary, localization.glossary.map((item) => item.source_term), 'glossary'),
    locked_terms: reviewMap(raw.locked_terms, localization.locked_terms, 'locked_terms'),
  };
}

function normalizeLocalizationReviewInput(input, context, options = {}) {
  assertObject(input, 'localization');
  assertSafeLocalizationReviewValue(input);
  assertOnlyKeys(input, EPISODE_LOCALIZATION_FIELDS, 'LOCALIZATION_UNKNOWN_FIELD', 'localization');
  const locale = String(input.locale || '').trim();
  const market = String(input.market || '').trim();
  if (input.schema_version !== 'episode-localization-v1'
    || String(input.blueprint_hash || '') !== context.blueprintHash
    || !locale
    || !market
    || (options.expectedLocale && locale !== options.expectedLocale)
    || (options.expectedMarket && market !== options.expectedMarket)) {
    throw codedError('LOCALIZATION_INPUT_INVALID', 'localization contract binding invalid');
  }
  if (!Array.isArray(input.dialogue_map) || !Array.isArray(input.text_region_map)
    || !Array.isArray(input.cultural_adaptations) || !Array.isArray(input.glossary)
    || !Array.isArray(input.locked_terms)) {
    throw codedError('LOCALIZATION_INPUT_INVALID', 'localization collections invalid');
  }
  const dialogueByShot = new Map();
  for (const row of input.dialogue_map) {
    assertObject(row, 'dialogue_map[]');
    assertOnlyKeys(row, EPISODE_DIALOGUE_FIELDS, 'LOCALIZATION_UNKNOWN_FIELD', 'dialogue_map[]');
    const shotId = String(row.shot_id || '').trim();
    const turns = dialogueByShot.get(shotId) || [];
    turns.push({
      id: row.source_dialogue_id,
      speaker_id: row.speaker_id,
      target_text: row.target_text,
      pronunciation_hint: row.pronunciation_hint,
    });
    dialogueByShot.set(shotId, turns);
  }
  const textMap = Object.fromEntries(input.text_region_map.map((row) => {
    assertObject(row, 'text_region_map[]');
    assertOnlyKeys(row, EPISODE_TEXT_REGION_FIELDS, 'LOCALIZATION_UNKNOWN_FIELD', 'text_region_map[]');
    return [`${String(row.shot_id)}:${String(row.text_region_id)}`, row.target_text];
  }));
  const normalized = normalizeEpisodeLocalizationResult({
    blueprint_hash: input.blueprint_hash,
    locale: input.locale,
    market: input.market,
    name_map: input.character_name_map,
    dialogue: [...dialogueByShot.entries()].map(([shotId, turns]) => ({ shot_id: shotId, turns })),
    text_map: textMap,
    culture_map: input.cultural_adaptations,
    glossary: input.glossary,
    locked_terms: input.locked_terms,
  }, context.blueprint, {
    locale: input.locale,
    market: input.market,
    blueprintHash: context.blueprintHash,
    validateTargetText: options.validateTargetText,
  });
  const suppliedDialogue = new Map(input.dialogue_map.map((item) => [item.source_dialogue_id, item]));
  for (const row of normalized.dialogue_map) {
    const supplied = suppliedDialogue.get(row.source_dialogue_id);
    for (const field of ['shot_id', 'speaker_id', 'speaker_kind', 'source_text', 'start_ms', 'end_ms', 'emotion']) {
      if (stableStringify(supplied?.[field]) !== stableStringify(row[field])) {
        throw codedError('LOCALIZATION_SOURCE_IMMUTABLE', `dialogue_map.${row.source_dialogue_id}.${field} changed`);
      }
    }
  }
  const suppliedRegions = new Map(input.text_region_map.map((item) => [item.text_region_id, item]));
  for (const row of normalized.text_region_map) {
    const supplied = suppliedRegions.get(row.text_region_id);
    for (const field of ['shot_id', 'source_text']) {
      if (stableStringify(supplied?.[field]) !== stableStringify(row[field])) {
        throw codedError('LOCALIZATION_SOURCE_IMMUTABLE', `text_region_map.${row.text_region_id}.${field} changed`);
      }
    }
  }
  normalized.review = normalizeReviewChecklist(input.review, normalized);
  normalized.localization_hash = episodeLocalizationHash(normalized);
  return normalized;
}

function saveGeneratedLocalizationReview(db, owner, versionId, input, options = {}) {
  const context = episodeReviewContext(db, owner, versionId);
  if (input?.schema_version !== 'episode-localization-v1'
    || input.blueprint_hash !== context.blueprintHash
    || input.localization_hash !== episodeLocalizationHash(input)) {
    throw codedError('LOCALIZATION_HASH_MISMATCH', 'generated localization hash invalid');
  }
  const current = context.version.localization_review_json;
  if (current != null && String(current).trim()) {
    throw codedError('LOCALIZATION_CAS_CONFLICT', 'localization review already exists');
  }
  const localization = clone(input);
  localization.review = {
    ...uncheckedReview(localization),
    updated_at: nextLocalizationTimestamp(context.version.updated_at, options.now),
  };
  const transaction = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE redraw_versions
      SET localization_review_json = ?, localization_hash = ?, status = 'needs_review', updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND blueprint_hash = ?
        AND localization_review_json IS NULL
    `).run(
      JSON.stringify(localization),
      localization.localization_hash,
      localization.review.updated_at,
      Number(context.version.id),
      String(context.owner.tenantId),
      String(context.owner.userId),
      context.blueprintHash,
    );
    if (changed.changes !== 1) throw codedError('LOCALIZATION_CAS_CONFLICT', 'localization review changed');
    db.prepare(`
      UPDATE redraw_works
      SET current_version = ?, current_step = 1, status = 'needs_review', updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ?
    `).run(Number(context.version.version), localization.review.updated_at, Number(context.version.work_id),
      String(context.owner.tenantId), String(context.owner.userId));
  });
  transaction.immediate();
  return getLocalizationReview(db, owner, versionId);
}

function expectedReviewTimestamp(input) {
  const value = String(input?.expectedUpdatedAt ?? input?.expected_updated_at ?? '').trim();
  if (!value) throw codedError('LOCALIZATION_INPUT_INVALID', 'expected_updated_at required');
  return value;
}

function saveLocalizationReview(db, owner, versionId, input = {}) {
  const context = episodeReviewContext(db, owner, versionId);
  const current = parseStoredLocalization(context.version);
  if (current.review?.status === 'locked' || context.version.status === 'asset_review') {
    throw codedError('LOCALIZATION_LOCKED', 'locked localization cannot be changed');
  }
  const expected = expectedReviewTimestamp(input);
  if (expected !== String(current.review?.updated_at || '')) {
    throw codedError('LOCALIZATION_CAS_CONFLICT', 'localization changed, refresh required');
  }
  const localizationInput = clone(input.localization);
  const localization = normalizeLocalizationReviewInput(localizationInput, context, {
    validateTargetText: input.validateTargetText,
    expectedLocale: current.locale,
    expectedMarket: current.market,
  });
  const now = nextLocalizationTimestamp(expected, input.now);
  localization.review.updated_at = now;
  const previousJson = context.version.localization_review_json;
  const previousHash = String(context.version.localization_hash || '');
  const changed = db.prepare(`
    UPDATE redraw_versions
    SET localization_review_json = ?, localization_hash = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'needs_review'
      AND localization_review_json = ? AND localization_hash = ? AND blueprint_hash = ?
  `).run(
    JSON.stringify(localization), localization.localization_hash, now,
    Number(context.version.id), String(context.owner.tenantId), String(context.owner.userId),
    previousJson, previousHash, context.blueprintHash,
  );
  if (changed.changes !== 1) throw codedError('LOCALIZATION_CAS_CONFLICT', 'localization changed, refresh required');
  return getLocalizationReview(db, owner, versionId);
}

function reviewComplete(review) {
  return ['character_name_map', 'dialogue_map', 'text_region_map', 'cultural_adaptations', 'glossary', 'locked_terms']
    .every((key) => Object.values(review[key] || {}).every((value) => value === true));
}

function expectedLocalizationHash(input) {
  const value = String(input?.expectedLocalizationHash ?? input?.expected_localization_hash ?? '').trim();
  if (!SHA256.test(value)) throw codedError('LOCALIZATION_INPUT_INVALID', 'expected_localization_hash invalid');
  return value;
}

function expectedBlueprintHash(input) {
  const value = String(input?.blueprintHash ?? input?.blueprint_hash ?? '').trim();
  if (!SHA256.test(value)) throw codedError('LOCALIZATION_INPUT_INVALID', 'blueprint_hash invalid');
  return value;
}

function lockLocalizationReview(db, owner, versionId, input = {}) {
  const expectedUpdatedAt = expectedReviewTimestamp(input);
  const expectedHash = expectedLocalizationHash(input);
  const blueprintHash = expectedBlueprintHash(input);
  const transaction = db.transaction(() => {
    const context = episodeReviewContext(db, owner, versionId);
    const current = parseStoredLocalization(context.version);
    if (current.review?.status === 'locked' || context.version.status === 'asset_review') {
      throw codedError('LOCALIZATION_LOCKED', 'localization already locked');
    }
    if (blueprintHash !== context.blueprintHash) throw codedError('BLUEPRINT_HASH_MISMATCH', 'blueprint hash changed');
    if (expectedUpdatedAt !== String(current.review?.updated_at || '')) {
      throw codedError('LOCALIZATION_CAS_CONFLICT', 'localization changed, refresh required');
    }
    const reviewInput = clone(current);
    const normalized = normalizeLocalizationReviewInput(reviewInput, context, {
      validateTargetText: input.validateTargetText,
      expectedLocale: current.locale,
      expectedMarket: current.market,
    });
    if (!reviewComplete(normalized.review)) throw codedError('LOCALIZATION_REVIEW_REQUIRED', 'all localization items must be reviewed');
    const recalculated = episodeLocalizationHash(normalized);
    if (expectedHash !== String(context.version.localization_hash || '')
      || expectedHash !== recalculated
      || expectedHash !== String(current.localization_hash || '')) {
      throw codedError('LOCALIZATION_HASH_MISMATCH', 'localization hash changed');
    }
    const now = nextLocalizationTimestamp(expectedUpdatedAt, input.now);
    normalized.review = { ...normalized.review, status: 'locked', updated_at: now };
    const lockedHash = episodeLocalizationHash(normalized);
    normalized.localization_hash = lockedHash;
    const changed = db.prepare(`
      UPDATE redraw_versions
      SET localization_review_json = ?, localization_hash = ?, status = 'asset_review', updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'needs_review'
        AND localization_review_json = ? AND localization_hash = ? AND blueprint_hash = ?
    `).run(
      JSON.stringify(normalized), lockedHash, now,
      Number(context.version.id), String(context.owner.tenantId), String(context.owner.userId),
      context.version.localization_review_json, expectedHash, context.blueprintHash,
    );
    if (changed.changes !== 1) throw codedError('LOCALIZATION_CAS_CONFLICT', 'localization changed, refresh required');
    const workChanged = db.prepare(`
      UPDATE redraw_works
      SET current_version = ?, current_step = 2, status = 'asset_review', updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND current_step = 1
    `).run(Number(context.version.version), now, Number(context.version.work_id),
      String(context.owner.tenantId), String(context.owner.userId));
    if (workChanged.changes !== 1) throw codedError('LOCALIZATION_CAS_CONFLICT', 'work localization gate changed');
  });
  transaction.immediate();
  return getLocalizationReview(db, owner, versionId);
}

function normalizeLocalizationResultV2(raw, sourceFacts, options = {}) {
  if (sourceFacts?.schema_version === 'episode-blueprint-v1') {
    return normalizeEpisodeLocalizationResult(raw, sourceFacts, options);
  }
  assertSafeJson(raw);
  assertV2RootFields(raw);
  const expectedHash = v2SourceHash(sourceFacts);
  if (String(raw.facts_hash || '') !== expectedHash) {
    throw codedError('LOCALIZATION_FACT_HASH_MISMATCH', 'v2 facts_hash mismatch', {
      expected: expectedHash,
      received: String(raw.facts_hash || ''),
    });
  }
  const expectedLocale = String(options.locale || sourceFacts.locale || '').trim();
  const expectedMarket = String(options.market || sourceFacts.market || '').trim();
  const locale = String(raw.locale ?? expectedLocale).trim();
  const market = String(raw.market ?? expectedMarket).trim();
  if (!locale || locale !== expectedLocale) throw codedError('LOCALIZATION_LOCALE_MISMATCH', 'v2 locale mismatch');
  if (!market || market !== expectedMarket) throw codedError('LOCALIZATION_MARKET_MISMATCH', 'v2 market mismatch');
  const nameMap = normalizeV2NameMap(raw.name_map, sourceFacts);
  return {
    facts_hash: expectedHash,
    locale,
    market,
    name_map: nameMap,
    culture_map: safeStringMap(raw.culture_map || {}, 'culture_map', 'LOCALIZATION_CULTURE_MAP_INVALID'),
    glossary: safeStringMap(raw.glossary || {}, 'glossary', 'LOCALIZATION_GLOSSARY_INVALID'),
    dialogue: normalizeV2Dialogue(raw.dialogue || [], sourceFacts, locale),
    text_map: normalizeV2TextMap(raw.text_map || {}, sourceFacts),
    confidence: normalizeV2Confidence(raw.confidence),
  };
}

function buildLocalizationInput(sourceFacts, options = {}) {
  assertObject(sourceFacts, 'source_facts');
  const locale = assertLocale(options.locale);
  return {
    locale,
    market: String(options.market || '').trim(),
    localization_level: String(options.localizationLevel || options.localization_level || 'faithful'),
    source_facts: clone(sourceFacts),
    source_facts_hash: factsHash(sourceFacts),
    style_snapshot: clone(options.styleSnapshot || options.style_snapshot || {}),
    allowed_changes: ['name_map', 'culture_map', 'glossary', 'localized_dialogue'],
  };
}

function normalizeLocalizationResult(raw, sourceFacts, options = {}) {
  assertObject(raw, 'localized_result');
  if (['2.0', 'episode-blueprint-v1'].includes(sourceFacts?.schema_version)) {
    return normalizeLocalizationResultV2(raw, sourceFacts, options);
  }
  const validation = validateLocalizedFacts(sourceFacts, raw);
  if (!validation.ok) {
    throw Object.assign(new Error('本地化结果改变了锁定事实'), {
      code: 'LOCALIZATION_FACT_CONFLICT',
      conflicts: validation.conflicts,
    });
  }
  const expectedFactsHash = factsHash(sourceFacts);
  if (raw.facts_hash != null && String(raw.facts_hash) !== expectedFactsHash) {
    throw Object.assign(new Error('本地化结果事实哈希不匹配'), {
      code: 'LOCALIZATION_FACT_HASH_MISMATCH',
      expected: expectedFactsHash,
      received: String(raw.facts_hash),
    });
  }
  return {
    source_facts: clone(sourceFacts),
    facts_hash: expectedFactsHash,
    glossary: clone(raw.glossary || {}),
    name_map: clone(raw.name_map || {}),
    culture_map: clone(raw.culture_map || {}),
    dialogue: clone(raw.dialogue || raw.localized_dialogue || []),
  };
}

function parseJson(value, fallback) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function trimValue(value) {
  return String(value ?? '').trim();
}

function findExistingLocalizationDraft(db, tenantId, userId, workId, idempotencyKey) {
  return db.prepare(`
    SELECT *
    FROM redraw_versions
    WHERE work_id = ? AND tenant_id = ? AND user_id = ?
      AND localization_idempotency_key = ? AND deleted_at IS NULL
    ORDER BY id ASC
    LIMIT 1
  `).get(Number(workId), String(tenantId), String(userId), idempotencyKey);
}

function createLocalizationDraftRecord(db, owner, workId, input) {
  const { tenantId, userId } = normalizeOwner(owner);
  assertObject(input, 'localization_draft_input');
  const idempotencyKey = trimValue(input.idempotencyKey ?? input.idempotency_key);
  if (!tenantId || !userId || !idempotencyKey) {
    throw Object.assign(new Error('缺少本地化草稿幂等参数'), { code: 'LOCALIZATION_DRAFT_INVALID' });
  }
  const locale = assertLocale(input.locale);
  const market = trimValue(input.market);
  const existing = findExistingLocalizationDraft(db, tenantId, userId, workId, idempotencyKey);
  if (existing) return existing;

  const work = db.prepare(`
    SELECT id
    FROM redraw_works
    WHERE id = ? AND tenant_id = ? AND user_id = ?
  `).get(Number(workId), String(tenantId), String(userId));
  if (!work) throw Object.assign(new Error('转绘作品不存在'), { code: 'LOCALIZATION_WORK_NOT_FOUND' });
  const existingMarket = db.prepare(`
    SELECT locale, market
    FROM redraw_versions
    WHERE work_id = ? AND tenant_id = ? AND user_id = ?
      AND locale != 'source' AND deleted_at IS NULL
    ORDER BY id ASC
    LIMIT 1
  `).get(Number(workId), String(tenantId), String(userId));
  if (existingMarket && (String(existingMarket.locale) !== locale || String(existingMarket.market || '') !== market)) {
    throw codedError('LOCALIZATION_TARGET_MARKET_CONFLICT', '一个转绘版本只允许一个目标 locale/market', {
      existing_locale: existingMarket.locale,
      existing_market: existingMarket.market,
    });
  }

  const nextVersion = Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS value FROM redraw_versions WHERE work_id = ?').get(Number(workId)).value) + 1;
  const now = new Date().toISOString();
  try {
    const result = db.prepare(`
      INSERT INTO redraw_versions
        (work_id, tenant_id, user_id, version, locale, market, localization_level,
         localization_input_hash, localization_idempotency_key, localization_model_snapshot_json,
         status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(
      Number(workId),
      String(tenantId),
      String(userId),
      nextVersion,
      locale,
      market,
      trimValue(input.localizationLevel ?? input.localization_level) || 'faithful',
      trimValue(input.inputHash ?? input.input_hash),
      idempotencyKey,
      JSON.stringify(input.modelSnapshot ?? input.model_snapshot ?? {}),
      now,
      now,
    );
    return db.prepare('SELECT * FROM redraw_versions WHERE id = ?').get(Number(result.lastInsertRowid));
  } catch (error) {
    const concurrent = findExistingLocalizationDraft(db, tenantId, userId, workId, idempotencyKey);
    if (concurrent) return concurrent;
    throw error;
  }
}

function createLocalizationDraft(db, owner, workId, input = {}) {
  return db.transaction(() => createLocalizationDraftRecord(db, owner, workId, input)).immediate();
}

function findOwnedDraftVersion(db, owner, draftVersionId, workId) {
  const { tenantId, userId } = normalizeOwner(owner);
  const draft = db.prepare(`
    SELECT *
    FROM redraw_versions
    WHERE id = ? AND work_id = ? AND tenant_id = ? AND user_id = ?
      AND status = 'draft' AND deleted_at IS NULL
  `).get(Number(draftVersionId), Number(workId), String(tenantId), String(userId));
  if (!draft) throw Object.assign(new Error('本地化草稿不存在'), { code: 'LOCALIZATION_DRAFT_NOT_FOUND' });
  return draft;
}

function localizedDialogueError(shotId, reason) {
  return Object.assign(new Error(`localized dialogue ${shotId}: ${reason}`), {
    code: 'LOCALIZATION_DIALOGUE_INVALID',
    reason,
    shot_id: shotId,
  });
}

function localizedDialogueByShot(input, sourceFacts, locale) {
  const rows = input.dialogue || input.localizedDialogue || input.localized_dialogue || [];
  if (!Array.isArray(rows)) {
    throw Object.assign(new Error('localized dialogue 必须是数组'), { code: 'LOCALIZATION_INVALID_INPUT' });
  }
  const sourceShots = new Map((sourceFacts.shots || []).map((shot) => [String(shot.id), shot]));
  const byShot = new Map();
  for (const row of rows) {
    assertObject(row, 'localized_dialogue[]');
    const shotId = String(row.shot_id ?? row.shotId ?? '').trim();
    if (!shotId) {
      throw Object.assign(new Error('localized dialogue 必须提供 shot_id'), {
        code: 'LOCALIZATION_DIALOGUE_SHOT_REQUIRED',
      });
    }
    if (byShot.has(shotId)) {
      throw Object.assign(new Error(`localized dialogue 的 shot_id 重复: ${shotId}`), {
        code: 'LOCALIZATION_DIALOGUE_SHOT_DUPLICATE',
      });
    }
    if (!sourceShots.has(shotId)) throw localizedDialogueError(shotId, 'dialogue_shot_unknown');
    const turns = row.turns ?? row.dialogue ?? row.localized_dialogue ?? [];
    if (!Array.isArray(turns)) {
      throw Object.assign(new Error(`localized dialogue ${shotId} 的 turns 必须是数组`), {
        code: 'LOCALIZATION_INVALID_INPUT',
      });
    }
    byShot.set(shotId, clone(turns));
  }

  for (const [shotId, sourceShot] of sourceShots) {
    const sourceTurns = Array.isArray(sourceShot.dialogue) ? sourceShot.dialogue : [];
    const localizedTurns = byShot.get(shotId);
    if (!sourceTurns.length) {
      if (localizedTurns?.length) throw localizedDialogueError(shotId, 'dialogue_turn_count_mismatch');
      continue;
    }
    if (!localizedTurns) throw localizedDialogueError(shotId, 'dialogue_missing');

    const timedTurns = sourceTurns.filter((turn) => turn?.start_ms != null || turn?.end_ms != null);
    if (timedTurns.length === 0) {
      if (localizedTurns.length !== sourceTurns.length) {
        throw localizedDialogueError(shotId, 'dialogue_turn_count_mismatch');
      }
      for (let index = 0; index < sourceTurns.length; index += 1) {
        if (String(sourceTurns[index]?.speaker_id) !== String(localizedTurns[index]?.speaker_id)) {
          throw localizedDialogueError(shotId, 'dialogue_speaker_order_mismatch');
        }
      }
      continue;
    }
    if (timedTurns.length !== sourceTurns.length || sourceTurns.some((turn) => turn.start_ms == null || turn.end_ms == null)) {
      throw localizedDialogueError(shotId, 'dialogue_source_timing_incomplete');
    }

    const enrichedTurns = localizedTurns.map((turn, index) => {
      const source = sourceTurns[index] || {};
      return {
        ...turn,
        start_ms: turn?.start_ms ?? source.start_ms,
        end_ms: turn?.end_ms ?? source.end_ms,
        emotion: turn?.emotion ?? source.emotion ?? null,
        overlap_group: turn?.overlap_group ?? source.overlap_group ?? null,
      };
    });
    const validation = validateLocalizedDialogue(
      { turns: sourceTurns },
      { turns: enrichedTurns },
      { locale, maxSpeechRate: input.maxSpeechRate || input.max_speech_rate },
    );
    if (!validation.ok) throw localizedDialogueError(shotId, validation.reason);
    byShot.set(shotId, validation.turns);
  }
  return byShot;
}

function overlapsShot(ranges, shot) {
  return Array.isArray(ranges) && ranges.some((range) => (
    Number.isFinite(Number(range?.start_ms))
      && Number.isFinite(Number(range?.end_ms))
      && Number(range.start_ms) < Number(shot.end_ms)
      && Number(range.end_ms) > Number(shot.start_ms)
  ));
}

function localizedAssetName(kind, item, input) {
  const nameMap = input.nameMap || input.name_map || {};
  const cultureMap = input.cultureMap || input.culture_map || {};
  const glossary = input.glossary || input.glossaryMap || {};
  if (kind === 'character') return String(nameMap[item.id] ?? nameMap[item.source_name] ?? item.source_name ?? '');
  if (kind === 'scene') return String(cultureMap[item.id] ?? cultureMap[item.location] ?? item.location ?? '');
  return String(glossary[item.id] ?? glossary[item.name] ?? item.name ?? '');
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function v2ShotFactDraft(shot = {}, textMap = {}) {
  return {
    composition: clone(shot.composition || ''),
    camera_movement: clone(shot.camera_movement || ''),
    opening_state: clone(shot.opening_state || ''),
    continuous_action: clone(shot.continuous_action || ''),
    ending_state: clone(shot.ending_state || ''),
    visible_character_ids: clone(Array.isArray(shot.visible_character_ids) ? shot.visible_character_ids : []),
    text_regions: (Array.isArray(shot.text_regions) ? shot.text_regions : []).map((region) => {
      const key = `${String(shot.id)}:${String(region?.id)}`;
      if (!Object.prototype.hasOwnProperty.call(textMap, key)) {
        throw codedError('LOCALIZATION_TEXT_REGION_MISMATCH', 'v2 text_map target missing');
      }
      return {
        ...clone(region),
        target_text: textMap[key],
      };
    }),
    audio_contract: clone(shot.audio_contract || {}),
  };
}

function existingMaterializedDraft(db, owner, draftVersionId, workId) {
  const { tenantId, userId } = normalizeOwner(owner);
  const row = db.prepare(`
    SELECT *
    FROM redraw_versions
    WHERE id = ? AND work_id = ? AND tenant_id = ? AND user_id = ?
      AND status != 'draft' AND deleted_at IS NULL
  `).get(Number(draftVersionId), Number(workId), String(tenantId), String(userId));
  if (!row) return null;
  return {
    id: Number(row.id),
    version: Number(row.version),
    work_id: Number(workId),
    locale: row.locale,
    shot_count: db.prepare('SELECT COUNT(*) AS count FROM redraw_shots WHERE version_id = ? AND deleted_at IS NULL').get(Number(row.id)).count,
    asset_count: db.prepare('SELECT COUNT(*) AS count FROM redraw_assets WHERE version_id = ? AND deleted_at IS NULL').get(Number(row.id)).count,
  };
}

function sourceAssetDescription(kind, item) {
  if (kind === 'scene') return [item.location, item.time].filter(Boolean).join(' · ');
  return String(item.source_name || item.name || '');
}

function createLocalizationVersion(db, owner, workId, input) {
  const { tenantId, userId } = normalizeOwner(owner);
  if (!tenantId) throw Object.assign(new Error('缺少租户'), { code: 'LOCALIZATION_TENANT_REQUIRED' });
  if (!userId) throw Object.assign(new Error('缺少用户'), { code: 'LOCALIZATION_USER_REQUIRED' });
  assertObject(input, 'localization_input');
  const locale = assertLocale(input.locale);
  const sourceFacts = input.sourceFacts || input.source_facts;
  assertObject(sourceFacts, 'source_facts');
  const expectedFactsHash = factsHash(sourceFacts);
  const suppliedFactsHash = input.sourceFactsHash || input.source_facts_hash || expectedFactsHash;
  if (String(suppliedFactsHash) !== expectedFactsHash) {
    throw Object.assign(new Error('本地化输入事实哈希不匹配'), {
      code: 'LOCALIZATION_FACT_HASH_MISMATCH',
      expected: expectedFactsHash,
      received: String(suppliedFactsHash),
    });
  }
  const run = () => {
    const now = new Date().toISOString();
    const work = db.prepare(`
      SELECT id, current_version
      FROM redraw_works
      WHERE id = ? AND tenant_id = ? AND user_id = ?
    `).get(Number(workId), String(tenantId), String(userId));
    if (!work) throw Object.assign(new Error('转绘作品不存在'), { code: 'LOCALIZATION_WORK_NOT_FOUND' });
    const sourceVersionId = input.sourceVersionId ?? input.source_version_id;
    const sourceVersion = sourceVersionId != null
      ? db.prepare(`
        SELECT *
        FROM redraw_versions
        WHERE id = ? AND work_id = ? AND tenant_id = ? AND user_id = ?
          AND locale = 'source'
          AND source_facts_json IS NOT NULL AND TRIM(source_facts_json) != ''
          AND deleted_at IS NULL
        LIMIT 1
      `).get(Number(sourceVersionId), Number(workId), String(tenantId), String(userId))
      : db.prepare(`
        SELECT *
        FROM redraw_versions
        WHERE work_id = ? AND tenant_id = ? AND user_id = ?
          AND locale = 'source'
          AND source_facts_json IS NOT NULL AND TRIM(source_facts_json) != ''
          AND deleted_at IS NULL
        ORDER BY CASE WHEN version = ? THEN 0 ELSE 1 END, version DESC, id DESC
        LIMIT 1
      `).get(Number(workId), String(tenantId), String(userId), Number(work.current_version || 0));
    if (!sourceVersion) {
      throw Object.assign(new Error('源片事实版本不存在'), { code: 'LOCALIZATION_SOURCE_VERSION_REQUIRED' });
    }
    const persistedSourceFacts = parseJson(sourceVersion.source_facts_json, null);
    assertObject(persistedSourceFacts, 'source_facts');
    const isV2 = persistedSourceFacts.schema_version === '2.0';
    const persistedFactsHash = String(sourceVersion.facts_hash || factsHash(persistedSourceFacts));
    if (persistedFactsHash !== expectedFactsHash) {
      throw Object.assign(new Error('本地化输入事实哈希不匹配'), {
        code: 'LOCALIZATION_FACT_HASH_MISMATCH',
        expected: persistedFactsHash,
        received: expectedFactsHash,
      });
    }
    const dialogueByShot = localizedDialogueByShot(input, persistedSourceFacts, locale);
    const textMap = isV2
      ? normalizeV2TextMap(input.textMap ?? input.text_map ?? {}, persistedSourceFacts)
      : {};
    const draft = input.draftVersionId != null
      ? findOwnedDraftVersion(db, owner, input.draftVersionId, workId)
      : createLocalizationDraftRecord(db, owner, workId, {
        locale,
        market: input.market,
        localizationLevel: input.localizationLevel || input.localization_level || 'faithful',
        inputHash: expectedFactsHash,
        idempotencyKey: `compat-${workId}-${expectedFactsHash}-${randomUUID()}`,
        modelSnapshot: input.modelSnapshot || input.model_snapshot || {},
      });
    const versionId = Number(draft.id);
    const nextVersion = Number(draft.version);
    const sourceShots = db.prepare(`
      SELECT *
      FROM redraw_shots
      WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY batch_index ASC, shot_index ASC, id ASC
    `).all(Number(sourceVersion.id), String(tenantId), String(userId));
    if (sourceShots.length === 0) {
      throw Object.assign(new Error('源片事实版本没有可物化分镜'), { code: 'LOCALIZATION_SOURCE_SHOTS_REQUIRED' });
    }
    const assetByStableId = new Map();
    const insertAsset = db.prepare(`
      INSERT INTO redraw_assets
        (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
         localized_description, prompt, version_number, approval_status, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, 'pending', 'draft', ?, ?)
    `);
    for (const character of Array.isArray(persistedSourceFacts.characters) ? persistedSourceFacts.characters : []) {
      const stableId = String(character?.id || '').trim();
      if (!stableId) continue;
      for (const kind of ['character', 'voice']) {
        const asset = insertAsset.run(
          versionId,
          String(tenantId),
          String(userId),
          kind,
          JSON.stringify(isV2
            ? { source_ref: { kind, source_character_key: stableId }, snapshot: character }
            : { source_ref: { kind, id: stableId, stable_id: stableId }, snapshot: character }),
          localizedAssetName('character', character, input),
          sourceAssetDescription('character', character),
          now,
          now,
        );
        assetByStableId.set(`${kind}:${stableId}`, Number(asset.lastInsertRowid));
      }
    }
    if (!isV2) {
      for (const [kind, items] of [
        ['scene', persistedSourceFacts.scenes],
        ['prop', persistedSourceFacts.props],
      ]) {
        for (const item of Array.isArray(items) ? items : []) {
          const stableId = String(item?.id || '').trim();
          if (!stableId) continue;
          const asset = insertAsset.run(
            versionId,
            String(tenantId),
            String(userId),
            kind,
            JSON.stringify({ source_ref: { kind, id: stableId, stable_id: stableId }, snapshot: item }),
            localizedAssetName(kind, item, input),
            sourceAssetDescription(kind, item),
            now,
            now,
          );
          assetByStableId.set(`${kind}:${stableId}`, Number(asset.lastInsertRowid));
        }
      }
    }

    const factShots = new Map((persistedSourceFacts.shots || []).map((shot) => [String(shot.id), shot]));
    const canStoreDraftJson = hasColumn(db, 'redraw_shots', 'draft_json');
    const insertShotSql = `
      INSERT INTO redraw_shots
        (work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
         start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
         references_json, opening_state, continuous_action, ending_state, prompt,
         negative_prompt, compiled_prompt_json${canStoreDraftJson ? ', draft_json' : ''}, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?${canStoreDraftJson ? ', ?' : ''}, 'draft', ?, ?)
    `;
    const insertShot = db.prepare(insertShotSql);
    for (const sourceShot of sourceShots) {
      const stableShotId = String(sourceShot.shot_id || '').trim();
      const factShot = factShots.get(stableShotId) || {};
      if (!stableShotId) {
        throw Object.assign(new Error('源片分镜缺少稳定 shot_id'), { code: 'LOCALIZATION_SOURCE_SHOT_ID_REQUIRED' });
      }
      const sourceDialogue = parseJson(sourceShot.source_dialogue_json, factShot.dialogue || []);
      const references = [];
      const seen = new Set();
      for (const turn of Array.isArray(sourceDialogue) ? sourceDialogue : []) {
        const stableId = String(turn?.speaker_id || '').trim();
        for (const kind of ['character', 'voice']) {
          const assetId = assetByStableId.get(`${kind}:${stableId}`);
          if (!assetId || seen.has(`${kind}:${assetId}`)) continue;
          seen.add(`${kind}:${assetId}`);
          references.push({ kind, asset_id: assetId, anchor: `${kind}:${stableId}` });
        }
      }
      for (const scene of Array.isArray(persistedSourceFacts.scenes) ? persistedSourceFacts.scenes : []) {
        const assetId = assetByStableId.get(`scene:${scene.id}`);
        if (!assetId || !overlapsShot(scene.source_ranges, sourceShot)) continue;
        references.push({ kind: 'scene', asset_id: assetId, anchor: `scene:${scene.id}` });
      }
      for (const prop of Array.isArray(persistedSourceFacts.props) ? persistedSourceFacts.props : []) {
        const assetId = assetByStableId.get(`prop:${prop.id}`);
        if (!assetId || !overlapsShot(prop.evidence_ranges, sourceShot)) continue;
        references.push({ kind: 'prop', asset_id: assetId, anchor: `prop:${prop.id}` });
      }
      const draftJson = isV2 ? JSON.stringify(v2ShotFactDraft(factShot, textMap)) : '{}';
      const compiledPromptJson = isV2 ? draftJson : '{}';
      const shotParams = [
        Number(workId),
        stableShotId,
        versionId,
        String(tenantId),
        String(userId),
        Number(sourceShot.batch_index || 1),
        Number(sourceShot.shot_index),
        Number(sourceShot.start_ms),
        Number(sourceShot.end_ms),
        Number(sourceShot.duration_ms || Number(sourceShot.end_ms) - Number(sourceShot.start_ms)),
        JSON.stringify(sourceDialogue),
        JSON.stringify(dialogueByShot.get(stableShotId) || []),
        JSON.stringify(references),
        String(sourceShot.opening_state || factShot.opening_state || ''),
        String(sourceShot.continuous_action || factShot.continuous_action || ''),
        String(sourceShot.ending_state || factShot.ending_state || ''),
        compiledPromptJson,
      ];
      if (canStoreDraftJson) shotParams.push(draftJson);
      shotParams.push(
        now,
        now,
      );
      insertShot.run(...shotParams);
    }
    const canStoreReferenceBundleRequired = hasColumn(db, 'redraw_versions', 'reference_bundle_required');
    const finalized = db.prepare(`
      UPDATE redraw_versions
      SET source_facts_json = ?, glossary_json = ?, name_map_json = ?, culture_map_json = ?,
        text_map_json = ?, style_snapshot_json = ?, facts_hash = ?, status = 'asset_review',
        updated_at = ?${canStoreReferenceBundleRequired ? ', reference_bundle_required = ?' : ''}
      WHERE id = ? AND status = 'draft'
    `).run(
      sourceVersion.source_facts_json,
      JSON.stringify(input.glossary || input.glossaryMap || {}),
      JSON.stringify(input.nameMap || input.name_map || {}),
      JSON.stringify(input.cultureMap || input.culture_map || {}),
      JSON.stringify(textMap),
      JSON.stringify(input.styleSnapshot || input.style_snapshot || {}),
      persistedFactsHash,
      now,
      ...(canStoreReferenceBundleRequired ? [isV2 ? 1 : 0] : []),
      versionId,
    );
    if (finalized.changes !== 1) {
      throw Object.assign(new Error('本地化草稿状态冲突'), { code: 'LOCALIZATION_DRAFT_CONFLICT' });
    }
    db.prepare(`
      UPDATE redraw_works
      SET current_version = ?, current_step = 2, status = 'asset_review', updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ?
    `).run(nextVersion, now, Number(workId), String(tenantId), String(userId));
    return {
      id: versionId,
      version: nextVersion,
      work_id: Number(workId),
      locale,
      shot_count: sourceShots.length,
      asset_count: assetByStableId.size,
    };
  };
  return db.inTransaction ? run() : db.transaction(run).immediate();
}

function materializeLocalizationDraft(db, owner, draftVersionId, input) {
  const workId = Number(input.workId || input.work_id);
  const existing = existingMaterializedDraft(db, owner, draftVersionId, workId);
  if (existing) return existing;
  return createLocalizationVersion(db, owner, input.workId || input.work_id, {
    ...input,
    draftVersionId: Number(draftVersionId),
  });
}

const RTL_LOCALES = new Set(['ar', 'ar-SA', 'ar-EG', 'fa', 'he', 'ur']);

function dialogueDirection(locale) {
  return RTL_LOCALES.has(String(locale || '')) ? 'rtl' : 'ltr';
}

function estimateSpeechMs(text, locale) {
  const value = String(text || '').trim();
  if (!value) return 0;
  if (/^(zh|ja|ko)(-|$)/i.test(String(locale || ''))) {
    return Array.from(value).length * 250;
  }
  const words = value.split(/\s+/u).filter(Boolean);
  return words.length * 300;
}

function validateLocalizedDialogue(sourceTurn, localizedTurn, options = {}) {
  const sourceTurns = Array.isArray(sourceTurn?.turns) ? sourceTurn.turns : [];
  const turns = Array.isArray(localizedTurn?.turns) ? localizedTurn.turns : [];
  const locale = String(options.locale || '').trim();
  const maxSpeechRate = Number(options.maxSpeechRate || 1.12);
  if (!sourceTurns.length || sourceTurns.length !== turns.length) {
    return { ok: false, reason: 'dialogue_turn_count_mismatch', status: 'needs_rewrite' };
  }
  if (!Number.isFinite(maxSpeechRate) || maxSpeechRate <= 0) {
    return { ok: false, reason: 'invalid_max_speech_rate', status: 'needs_rewrite' };
  }

  const normalizedTurns = [];
  for (let index = 0; index < sourceTurns.length; index += 1) {
    const source = sourceTurns[index] || {};
    const localized = turns[index] || {};
    if (String(source.speaker_id) !== String(localized.speaker_id)) {
      return { ok: false, reason: 'dialogue_speaker_order_mismatch', status: 'needs_rewrite', turn_index: index };
    }
    if (Number(source.start_ms) !== Number(localized.start_ms) || Number(source.end_ms) !== Number(localized.end_ms)) {
      return { ok: false, reason: 'dialogue_timing_mismatch', status: 'needs_rewrite', turn_index: index };
    }
    if (localized.emotion != null && String(localized.emotion) !== String(source.emotion || '')) {
      return { ok: false, reason: 'dialogue_emotion_mismatch', status: 'needs_rewrite', turn_index: index };
    }
    if ((source.overlap_group || null) !== (localized.overlap_group || null)) {
      return { ok: false, reason: 'dialogue_overlap_mismatch', status: 'needs_rewrite', turn_index: index };
    }
    const availableMs = Number(source.end_ms) - Number(source.start_ms);
    if (!Number.isFinite(availableMs) || availableMs <= 0) {
      return { ok: false, reason: 'dialogue_timing_invalid', status: 'needs_rewrite', turn_index: index };
    }
    const localizedText = String(localized.localized_text ?? localized.target_text ?? localized.text ?? '').trim();
    if (!localizedText) {
      return { ok: false, reason: 'dialogue_text_missing', status: 'needs_rewrite', turn_index: index };
    }
    const estimatedDurationMs = estimateSpeechMs(localizedText, locale);
    if (estimatedDurationMs > availableMs * maxSpeechRate) {
      return {
        ok: false,
        reason: 'dialogue_duration_exceeded',
        status: 'needs_rewrite',
        turn_index: index,
        estimated_duration_ms: estimatedDurationMs,
        available_ms: availableMs,
      };
    }
    normalizedTurns.push({
      speaker_id: String(source.speaker_id),
      source_text: String(source.source_text || source.text || ''),
      localized_text: localizedText,
      start_ms: Number(source.start_ms),
      end_ms: Number(source.end_ms),
      emotion: localized.emotion ?? source.emotion ?? null,
      overlap_group: localized.overlap_group || null,
      estimated_duration_ms: estimatedDurationMs,
    });
  }
  return { ok: true, direction: dialogueDirection(locale), turns: normalizedTurns };
}

module.exports = {
  buildLocalizationInput,
  episodeLocalizationHash,
  normalizeLocalizationResult,
  normalizeLocalizationResultV2,
  assertSafeLocalizationReviewValue,
  getLocalizationReview,
  lockLocalizationReview,
  saveGeneratedLocalizationReview,
  saveLocalizationReview,
  validateLocalizedFacts,
  createLocalizationDraft,
  findOwnedDraftVersion,
  materializeLocalizationDraft,
  createLocalizationVersion,
  validateLocalizedDialogue,
};
