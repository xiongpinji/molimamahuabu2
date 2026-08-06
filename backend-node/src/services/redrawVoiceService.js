function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function normalizeEvidence(input = {}) {
  const source = input.evidence && typeof input.evidence === 'object' ? input.evidence : input;
  return {
    locale: String(source.locale || ''),
    market: String(source.market || ''),
    provider: String(source.provider || ''),
    model: String(source.model || ''),
    voice_id: String(source.voice_id || source.voiceId || ''),
    task_id: String(source.task_id || source.taskId || ''),
    terminal_status: String(source.terminal_status || source.terminalStatus || '').toLowerCase(),
    audio_asset_id: Number(source.audio_asset_id ?? source.audioAssetId),
    duration_ms: Number(source.duration_ms ?? source.durationMs),
    real_generation_verified: source.real_generation_verified === true,
    language_verified: source.language_verified === true,
    detected_locale: source.detected_locale ? String(source.detected_locale) : null,
    is_cloned: source.is_cloned === true || source.cloned === true || source.voice_type === 'clone',
    authorization_asset_id: source.authorization_asset_id ?? source.authorizationAssetId ?? null,
  };
}

function isCompleted(status) {
  return ['completed', 'complete', 'succeeded', 'success', 'done'].includes(status);
}

function isVerifiedEvidence(evidence) {
  return Boolean(
    evidence.locale
    && evidence.market
    && evidence.provider
    && evidence.model
    && evidence.voice_id
    && evidence.task_id
    && isCompleted(evidence.terminal_status)
    && Number.isInteger(evidence.audio_asset_id)
    && evidence.audio_asset_id > 0
    && Number.isFinite(evidence.duration_ms)
    && evidence.duration_ms > 0
    && evidence.real_generation_verified
    && evidence.language_verified
    && (!evidence.detected_locale || evidence.detected_locale === evidence.locale)
  );
}

function hasCloneAuthorization(evidence) {
  return !evidence.is_cloned || Boolean(evidence.authorization_asset_id);
}

function listProductionVoices(db, filters = {}, canReadAudio) {
  if (!db) throw codedError('REDRAW_VOICE_DB_REQUIRED', '缺少数据库');
  if (typeof canReadAudio !== 'function') return [];
  const tenantId = filters.tenantId ?? filters.tenant_id;
  const userId = filters.userId ?? filters.user_id;
  if (!tenantId || !userId) return [];
  const rows = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE kind = 'voice' AND status IN ('generated', 'needs_attention')
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY id ASC
  `).all(String(tenantId), String(userId));
  const result = [];
  for (const row of rows) {
    const payload = parseJson(row.source_ref_json);
    const evidence = normalizeEvidence(payload.evidence || payload.voice_evidence || {});
    if (!isVerifiedEvidence(evidence) || !hasCloneAuthorization(evidence)) continue;
    if (filters.locale && evidence.locale !== String(filters.locale)) continue;
    if (filters.market && evidence.market !== String(filters.market)) continue;
    const asset = db.prepare(`
      SELECT * FROM assets
      WHERE id = ? AND type = 'audio' AND deleted_at IS NULL
    `).get(evidence.audio_asset_id);
    if (!asset || canReadAudio(asset) !== true) continue;
    result.push({
      id: row.id,
      ...evidence,
      audio_asset: asset,
      audio_readable: true,
    });
  }
  return result;
}

function sameVoice(left, right) {
  return left.voice_id === right.voice_id
    && left.provider === right.provider
    && left.model === right.model
    && left.locale === right.locale
    && left.market === right.market
    && Number(left.audio_asset_id) === Number(right.audio_asset_id);
}

function assignVoice(db, assetId, verifiedVoice) {
  if (!db) throw codedError('REDRAW_VOICE_DB_REQUIRED', '缺少数据库');
  const evidence = normalizeEvidence(verifiedVoice);
  if (!isVerifiedEvidence(evidence)) throw codedError('REDRAW_VOICE_NOT_VERIFIED', '音色缺少真实 TTS 或语言验证证据');
  if (!hasCloneAuthorization(evidence)) throw codedError('REDRAW_VOICE_AUTHORIZATION_REQUIRED', '克隆音色缺少授权资产');
  const row = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND kind = 'character' AND deleted_at IS NULL
  `).get(Number(assetId));
  if (!row) throw codedError('REDRAW_CHARACTER_ASSET_NOT_FOUND', '角色资产不存在');
  const version = db.prepare('SELECT locale, market FROM redraw_versions WHERE id = ? AND deleted_at IS NULL')
    .get(Number(row.version_id));
  if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '本地化版本不存在');
  if (String(version.locale) !== evidence.locale || (version.market && String(version.market) !== evidence.market)) {
    throw codedError('REDRAW_VOICE_LOCALE_MISMATCH', '音色语言或地区与本地化版本不匹配');
  }
  const audioAsset = db.prepare(`
    SELECT id FROM assets WHERE id = ? AND type = 'audio' AND deleted_at IS NULL
  `).get(evidence.audio_asset_id);
  if (!audioAsset) throw codedError('REDRAW_VOICE_AUDIO_NOT_FOUND', '音色样音资产不存在');

  const payload = parseJson(row.source_ref_json);
  const snapshotRoot = payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : {};
  const current = snapshotRoot.voice_snapshot ? normalizeEvidence(snapshotRoot.voice_snapshot) : null;
  if (current) {
    return {
      conflict: !sameVoice(current, evidence),
      snapshot: snapshotRoot.voice_snapshot,
      asset_id: Number(row.id),
    };
  }
  const snapshot = {
    locale: evidence.locale,
    market: evidence.market,
    provider: evidence.provider,
    model: evidence.model,
    voice_id: evidence.voice_id,
    task_id: evidence.task_id,
    terminal_status: evidence.terminal_status,
    audio_asset_id: evidence.audio_asset_id,
    duration_ms: evidence.duration_ms,
    real_generation_verified: true,
    language_verified: true,
    is_cloned: evidence.is_cloned,
    authorization_asset_id: evidence.authorization_asset_id,
  };
  const nextPayload = {
    ...payload,
    snapshot: {
      ...snapshotRoot,
      voice_snapshot: snapshot,
    },
  };
  db.prepare(`
    UPDATE redraw_assets
    SET voice_asset_id = ?, source_ref_json = ?, approval_status = 'pending', updated_at = ?
    WHERE id = ?
  `).run(evidence.audio_asset_id, JSON.stringify(nextPayload), new Date().toISOString(), Number(row.id));
  return { conflict: false, snapshot, asset_id: Number(row.id) };
}

function validateTtsBatch(db, versionId, turns = []) {
  if (!db) throw codedError('REDRAW_VOICE_DB_REQUIRED', '缺少数据库');
  const version = db.prepare(`
    SELECT id, locale, market FROM redraw_versions WHERE id = ? AND deleted_at IS NULL
  `).get(Number(versionId));
  if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '本地化版本不存在');
  const characters = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND kind = 'character' AND deleted_at IS NULL
    ORDER BY id ASC
  `).all(Number(version.id));
  const bySpeaker = new Map();
  for (const character of characters) {
    const payload = parseJson(character.source_ref_json);
    const speakerId = payload.source_ref?.character_id ?? payload.source_ref?.id;
    const voiceSnapshot = payload.snapshot?.voice_snapshot;
    if (speakerId != null && voiceSnapshot) {
      bySpeaker.set(String(speakerId), { character, snapshot: voiceSnapshot });
    }
  }

  const issues = [];
  const requests = [];
  for (const [index, turn] of turns.entries()) {
    const speakerId = String(turn?.speaker_id || '');
    const assigned = bySpeaker.get(speakerId);
    if (!assigned) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'speaker_voice_missing' });
      continue;
    }
    const evidence = normalizeEvidence(assigned.snapshot);
    if (!isVerifiedEvidence(evidence)) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'voice_not_verified' });
      continue;
    }
    if (evidence.locale !== String(version.locale)
      || (version.market && evidence.market !== String(version.market))) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'voice_locale_mismatch' });
      continue;
    }
    if (!hasCloneAuthorization(evidence)) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'voice_authorization_missing' });
      continue;
    }
    const audioAsset = db.prepare(`
      SELECT id FROM assets WHERE id = ? AND type = 'audio' AND deleted_at IS NULL
    `).get(evidence.audio_asset_id);
    if (!audioAsset) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'voice_audio_missing' });
      continue;
    }
    const availableMs = Number(turn?.end_ms) - Number(turn?.start_ms);
    const durationMs = Number(turn?.audio_duration_ms ?? turn?.estimated_duration_ms);
    if (!Number.isFinite(availableMs) || availableMs <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
      issues.push({ turn_index: index, speaker_id: speakerId, reason: 'dialogue_duration_invalid' });
      continue;
    }
    if (durationMs > availableMs) {
      issues.push({
        turn_index: index,
        speaker_id: speakerId,
        reason: 'dialogue_duration_exceeded',
        duration_ms: durationMs,
        available_ms: availableMs,
      });
      continue;
    }
    requests.push({
      turn_index: index,
      speaker_id: speakerId,
      character_asset_id: Number(assigned.character.id),
      voice_id: evidence.voice_id,
      model: evidence.model,
      provider: evidence.provider,
      text: String(turn?.localized_text || turn?.text || ''),
      start_ms: Number(turn.start_ms),
      end_ms: Number(turn.end_ms),
      expected_duration_ms: durationMs,
      voice_snapshot: assigned.snapshot,
    });
  }
  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? 'ready' : 'needs_rewrite',
    issues,
    requests: issues.length === 0 ? requests : [],
  };
}

module.exports = {
  assignVoice,
  listProductionVoices,
  validateTtsBatch,
};
