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
const CONFIDENCE_KEYS = ['names', 'dialogue_semantics', 'dialogue_timing', 'culture', 'screen_text'];
const UNSAFE_KEY = /(?:^|_|\b)(?:auth|authorization|token|secret|password|credential|provider|raw|prompt|url|path)(?:$|_|\b)/i;
const TARGET_INJECTION_KEYS = new Set(['locale', 'market', 'region', 'currency', 'country', 'language', 'target_locale', 'target_market']);

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
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || UNSAFE_KEY.test(key)) {
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

function safeMap(value, name) {
  assertObject(value, name);
  assertSafeJson(value, name);
  return clone(value);
}

function safeStringMap(value, name, code) {
  const map = safeMap(value, name);
  for (const key of Object.keys(map)) {
    if (TARGET_INJECTION_KEYS.has(normalizeText(key))) throw codedError(code, `${name} target field invalid`);
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
    const value = String(nameMap[id] ?? '').trim();
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
    const sourceName = compactComparableText(character?.source_name);
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

function normalizeLocalizationResultV2(raw, sourceFacts, options = {}) {
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
  if (sourceFacts?.schema_version === '2.0') {
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

function v2ShotFactDraft(shot = {}) {
  return {
    composition: clone(shot.composition || ''),
    camera_movement: clone(shot.camera_movement || ''),
    opening_state: clone(shot.opening_state || ''),
    continuous_action: clone(shot.continuous_action || ''),
    ending_state: clone(shot.ending_state || ''),
    visible_character_ids: clone(Array.isArray(shot.visible_character_ids) ? shot.visible_character_ids : []),
    text_regions: clone(Array.isArray(shot.text_regions) ? shot.text_regions : []),
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
    const sourceVersion = db.prepare(`
      SELECT *
      FROM redraw_versions
      WHERE work_id = ? AND tenant_id = ? AND user_id = ?
        AND source_facts_json IS NOT NULL AND deleted_at IS NULL
      ORDER BY version ASC, id ASC
      LIMIT 1
    `).get(Number(workId), String(tenantId), String(userId));
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
      const draftJson = isV2 ? JSON.stringify(v2ShotFactDraft(factShot)) : '{}';
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
    const finalized = db.prepare(`
      UPDATE redraw_versions
      SET source_facts_json = ?, glossary_json = ?, name_map_json = ?, culture_map_json = ?,
        style_snapshot_json = ?, facts_hash = ?, status = 'asset_review', updated_at = ?
      WHERE id = ? AND status = 'draft'
    `).run(
      sourceVersion.source_facts_json,
      JSON.stringify(input.glossary || input.glossaryMap || {}),
      JSON.stringify(input.nameMap || input.name_map || {}),
      JSON.stringify(input.cultureMap || input.culture_map || {}),
      JSON.stringify(input.styleSnapshot || input.style_snapshot || {}),
      persistedFactsHash,
      now,
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
  normalizeLocalizationResult,
  validateLocalizedFacts,
  createLocalizationDraft,
  findOwnedDraftVersion,
  materializeLocalizationDraft,
  createLocalizationVersion,
  validateLocalizedDialogue,
};
