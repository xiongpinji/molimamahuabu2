const { createHash } = require('node:crypto');

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
  return createHash('sha256').update(stableStringify(sourceFacts)).digest('hex');
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

function normalizeLocalizationResult(raw, sourceFacts) {
  assertObject(raw, 'localized_result');
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

function createLocalizationVersion(db, owner, workId, input) {
  const { tenantId, userId } = normalizeOwner(owner);
  if (!tenantId) throw Object.assign(new Error('缺少租户'), { code: 'LOCALIZATION_TENANT_REQUIRED' });
  if (!userId) throw Object.assign(new Error('缺少用户'), { code: 'LOCALIZATION_USER_REQUIRED' });
  assertObject(input, 'localization_input');
  const locale = assertLocale(input.locale);
  const work = db.prepare(`
    SELECT id, current_version
    FROM redraw_works
    WHERE id = ? AND tenant_id = ? AND user_id = ?
  `).get(Number(workId), String(tenantId), String(userId));
  if (!work) throw Object.assign(new Error('转绘作品不存在'), { code: 'LOCALIZATION_WORK_NOT_FOUND' });

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
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       source_facts_json, glossary_json, name_map_json, culture_map_json,
       style_snapshot_json, facts_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `);
  const updateWork = db.prepare('UPDATE redraw_works SET current_version = ?, updated_at = ? WHERE id = ?');
  const nextVersion = Number(work.current_version || 0) + 1;
  const transaction = db.transaction(() => {
    const result = insert.run(
      Number(workId), String(tenantId), String(userId), nextVersion, locale,
      String(input.market || ''), String(input.localizationLevel || input.localization_level || 'faithful'),
      JSON.stringify(sourceFacts), JSON.stringify(input.glossary || input.glossaryMap || {}),
      JSON.stringify(input.nameMap || input.name_map || {}), JSON.stringify(input.cultureMap || input.culture_map || {}),
      JSON.stringify(input.styleSnapshot || input.style_snapshot || {}),
      expectedFactsHash, now, now,
    );
    updateWork.run(nextVersion, now, Number(workId));
    return { id: Number(result.lastInsertRowid), version: nextVersion, work_id: Number(workId), locale };
  });
  return transaction();
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
    const localizedText = String(localized.localized_text ?? localized.text ?? '').trim();
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
  createLocalizationVersion,
  validateLocalizedDialogue,
};
