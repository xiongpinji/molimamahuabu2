const crypto = require('crypto');

const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');
const redrawVoiceService = require('./redrawVoiceService');

const RESOURCE_TYPE = 'redraw_dialogue';

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function postProviderError(error, providerTaskId) {
  const value = error instanceof Error ? error : new Error(String(error || '配音供应商完成后的本地状态未知'));
  if (!value.code) value.code = 'REDRAW_DIALOGUE_POST_PROVIDER_UNKNOWN';
  value.unknown = true;
  value.provider_completed = true;
  if (!value.provider_task_id && providerTaskId) value.provider_task_id = String(providerTaskId);
  return value;
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalVoiceSnapshot(snapshot = {}) {
  return {
    locale: String(snapshot.locale || ''),
    market: String(snapshot.market || ''),
    provider: String(snapshot.provider || ''),
    model: String(snapshot.model || ''),
    ai_service_config_id: Number(snapshot.ai_service_config_id),
    config_updated_at: String(snapshot.config_updated_at || ''),
    voice_id: String(snapshot.voice_id || ''),
    task_id: String(snapshot.task_id || ''),
    terminal_status: String(snapshot.terminal_status || ''),
    audio_asset_id: Number(snapshot.audio_asset_id),
    duration_ms: Number(snapshot.duration_ms),
    real_generation_verified: snapshot.real_generation_verified === true,
    language_verified: snapshot.language_verified === true,
    detected_locale: snapshot.detected_locale == null ? null : String(snapshot.detected_locale),
    is_cloned: snapshot.is_cloned === true,
    authorization_asset_id: snapshot.authorization_asset_id == null ? null : Number(snapshot.authorization_asset_id),
  };
}

function assertLocaleVerifierReady(ctx, locale) {
  const verifier = ctx?.localeVerifier || ctx?.locale_verifier;
  if (!verifier || typeof verifier.assertReady !== 'function') return null;
  try {
    const pack = verifier.assertReady(locale);
    return pack && typeof pack === 'object' ? {
      locale_pack: String(pack.id || pack.locale_pack || ''),
      model_manifest_sha256: String(pack.model_manifest_sha256 || ''),
      calibration_manifest_sha256: String(pack.calibration_manifest_sha256 || ''),
    } : null;
  } catch (error) {
    throw codedError(error.code || 'REDRAW_LOCALE_VERIFIER_NOT_READY', error.message || '语言验证 Worker 未就绪');
  }
}

function getVersion(db, input) {
  const versionId = Number(input.versionId ?? input.version_id);
  const tenantId = String(input.tenantId ?? input.tenant_id ?? '');
  const userId = String(input.userId ?? input.user_id ?? '');
  if (!db || !Number.isSafeInteger(versionId) || !tenantId || !userId) {
    throw codedError('REDRAW_DIALOGUE_CONTEXT_INVALID', '缺少转绘配音上下文');
  }
  const version = db.prepare(`
    SELECT * FROM redraw_versions
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(versionId, tenantId, userId);
  if (!version) throw codedError('REDRAW_DIALOGUE_VERSION_NOT_FOUND', '转绘版本不存在');
  return version;
}

function listShots(db, version, input) {
  return db.prepare(`
    SELECT *
    FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(Number(version.id), String(input.tenantId), String(input.userId));
}

function normalizeTurn(shot, turn, index) {
  return {
    ...turn,
    turn_index: index,
    speaker_id: String(turn?.speaker_id || ''),
    localized_text: String(turn?.localized_text ?? turn?.text ?? ''),
    start_ms: Number(turn?.start_ms),
    end_ms: Number(turn?.end_ms),
    estimated_duration_ms: Number(turn?.estimated_duration_ms ?? turn?.audio_duration_ms),
  };
}

function buildDialoguePlan(db, input = {}) {
  const version = getVersion(db, input);
  const shots = listShots(db, version, input);
  const turns = [];
  const turnRefs = [];
  const issues = [];

  for (const shot of shots) {
    const shotTurns = parseJson(shot.localized_dialogue_json, []);
    const dialogue = Array.isArray(shotTurns) ? shotTurns : [];
    dialogue.forEach((rawTurn, index) => {
      const turn = normalizeTurn(shot, rawTurn, index);
      const globalIndex = turns.length;
      turns.push(turn);
      turnRefs.push({ shot, turn, turn_index: index, global_index: globalIndex });
      if (!turn.localized_text.trim()) {
        issues.push({
          shot_id: shot.id,
          segment_id: `${shot.id}:${index}`,
          turn_index: globalIndex,
          speaker_id: turn.speaker_id,
          reason: 'dialogue_text_invalid',
        });
      }
      if (!Number.isFinite(turn.start_ms) || !Number.isFinite(turn.end_ms)
        || turn.start_ms < Number(shot.start_ms) || turn.end_ms > Number(shot.end_ms)
        || turn.end_ms <= turn.start_ms) {
        issues.push({
          shot_id: shot.id,
          segment_id: `${shot.id}:${index}`,
          turn_index: globalIndex,
          speaker_id: turn.speaker_id,
          reason: 'dialogue_window_invalid',
        });
      }
    });
  }

  const tts = redrawVoiceService.validateTtsBatch(db, version.id, turns, {
    tenantId: version.tenant_id,
    userId: version.user_id,
    canReadAsset: input.canReadAudioAsset || input.canReadAsset,
    canReadArtifact: input.canReadArtifact,
    assetReader: input.assetReader,
    localeVerifier: input.localeVerifier,
  });
  issues.push(...tts.issues.map((issue) => {
    const ref = turnRefs[issue.turn_index] || {};
    return {
      ...issue,
      shot_id: ref.shot?.id ?? null,
      segment_id: ref.shot ? `${ref.shot.id}:${ref.turn_index}` : null,
    };
  }));

  if (issues.length > 0) {
    return {
      status: 'needs_rewrite',
      version: {
        id: Number(version.id),
        locale: version.locale,
        market: version.market,
      },
      tracks: [],
      segments: [],
      issues,
    };
  }

  const tracks = [];
  const seenSpeakers = new Set();
  const segments = tts.requests.map((request) => {
    const ref = turnRefs[request.turn_index];
    if (!seenSpeakers.has(request.speaker_id)) {
      seenSpeakers.add(request.speaker_id);
      tracks.push({
        speaker_id: request.speaker_id,
        character_asset_id: request.character_asset_id,
        voice_snapshot: request.voice_snapshot,
      });
    }
    return {
      segment_id: `${ref.shot.id}:${ref.turn_index}`,
      version_id: Number(version.id),
      tenant_id: String(input.tenantId),
      user_id: String(input.userId),
      shot_row_id: Number(ref.shot.id),
      shot_id: String(ref.shot.shot_id || ref.shot.id),
      batch_index: Number(ref.shot.batch_index),
      shot_index: Number(ref.shot.shot_index),
      turn_index: ref.turn_index,
      speaker_id: request.speaker_id,
      character_asset_id: request.character_asset_id,
      text: request.text,
      start_ms: request.start_ms,
      end_ms: request.end_ms,
      expected_duration_ms: request.expected_duration_ms,
      provider: request.provider,
      model: request.model,
      voice_id: request.voice_id,
      locale_pack: request.locale_pack || null,
      model_manifest_sha256: request.model_manifest_sha256 || null,
      calibration_manifest_sha256: request.calibration_manifest_sha256 || null,
      voice_snapshot: canonicalVoiceSnapshot(request.voice_snapshot),
    };
  });

  return {
    status: 'ready',
    version: {
      id: Number(version.id),
      locale: version.locale,
      market: version.market,
    },
    tracks,
    segments,
    issues: [],
  };
}

function quoteDialoguePlan(db, input = {}) {
  const plan = buildDialoguePlan(db, input);
  if (plan.status !== 'ready') {
    const empty = {
      version_id: plan.version.id,
      status: plan.status,
      segment_count: 0,
      total_credits: 0,
      models: [],
    };
    return { ...empty, quote_hash: sha256(stableJson(empty)) };
  }

  const modelsByName = new Map();
  for (const segment of plan.segments) {
    const credits = modelPrice.requirePrice(db, segment.voice_snapshot.model);
    const key = [
      segment.voice_snapshot.ai_service_config_id,
      segment.voice_snapshot.config_updated_at,
      segment.voice_snapshot.provider,
      segment.voice_snapshot.model,
    ].join(':');
    const current = modelsByName.get(key) || {
      model: segment.voice_snapshot.model,
      provider: segment.voice_snapshot.provider,
      ai_service_config_id: segment.voice_snapshot.ai_service_config_id,
      config_updated_at: segment.voice_snapshot.config_updated_at,
      credits,
      segments: 0,
    };
    current.segments += 1;
    modelsByName.set(key, current);
  }
  const models = [...modelsByName.values()];
  const totalCredits = models.reduce((sum, item) => sum + item.credits * item.segments, 0);
  const snapshot = {
    version_id: plan.version.id,
    version_locale: plan.version.locale,
    version_market: plan.version.market,
    status: plan.status,
    segment_count: plan.segments.length,
    total_credits: totalCredits,
    models,
    segments: plan.segments.map((segment) => ({
      segment_id: segment.segment_id,
      model: segment.voice_snapshot.model,
      credits: modelPrice.requirePrice(db, segment.voice_snapshot.model),
      voice_id: segment.voice_snapshot.voice_id,
      locale_pack: segment.locale_pack || null,
      model_manifest_sha256: segment.model_manifest_sha256 || null,
      calibration_manifest_sha256: segment.calibration_manifest_sha256 || null,
      voice_snapshot: segment.voice_snapshot,
      text_hash: sha256(segment.text),
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
    })),
  };
  return {
    status: plan.status,
    version_id: plan.version.id,
    segment_count: plan.segments.length,
    total_credits: totalCredits,
    models,
    quote_hash: sha256(stableJson(snapshot)),
  };
}

function getAsset(db, assetId) {
  return db.prepare("SELECT * FROM assets WHERE id = ? AND type = ? AND mime_type LIKE 'audio/%' AND deleted_at IS NULL")
    .get(Number(assetId), 'audio') || null;
}

function canReadAsset(ctx, asset) {
  return Boolean(asset && String(asset.type || '') === 'audio'
    && String(asset.mime_type || '').toLowerCase().startsWith('audio/')
    && Number(asset.duration) > 0
    && typeof ctx.canReadAudioAsset === 'function'
    && ctx.canReadAudioAsset(asset) === true);
}

function reservationStatus(db, reservationId) {
  return creditLedger.getReservation(db, reservationId)?.status || null;
}

function validateDialogueAudioAsset(ctx, segment, asset, output, idempotencyKey, reservationId) {
  if (!canReadAsset(ctx, asset) || asset.category !== RESOURCE_TYPE) return false;
  const metadata = parseJson(asset.metadata, {})?.redraw_dialogue;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const expected = {
    tenant_id: String(ctx.tenantId),
    user_id: String(ctx.userId),
    version_id: Number(segment.version_id),
    segment_id: String(segment.segment_id),
    idempotency_key: String(idempotencyKey),
    reservation_id: String(reservationId),
  };
  if (String(metadata.tenant_id) !== expected.tenant_id) return false;
  if (String(metadata.user_id) !== expected.user_id) return false;
  if (Number(metadata.version_id) !== expected.version_id) return false;
  if (String(metadata.segment_id) !== expected.segment_id) return false;
  if (String(metadata.idempotency_key) !== expected.idempotency_key) return false;
  if (String(metadata.reservation_id) !== expected.reservation_id) return false;
  const providerTaskId = String(output?.provider_task_id || '').trim();
  if (!providerTaskId || String(metadata.provider_task_id || '').trim() !== providerTaskId) return false;
  const snapshot = canonicalVoiceSnapshot(segment.voice_snapshot);
  if (String(metadata.provider || '') !== snapshot.provider) return false;
  if (String(metadata.model || '') !== snapshot.model) return false;
  if (Number(metadata.ai_service_config_id) !== snapshot.ai_service_config_id) return false;
  if (String(metadata.config_updated_at || '') !== snapshot.config_updated_at) return false;
  if (stableJson(canonicalVoiceSnapshot(metadata.voice_snapshot)) !== stableJson(snapshot)) return false;
  return true;
}

function validateCurrentDialogueSegment(ctx, segment) {
  assertLocaleVerifierReady(ctx, segment.voice_snapshot.locale);
  const validation = redrawVoiceService.validateTtsBatch(ctx.db, segment.version_id, [{
    speaker_id: segment.speaker_id,
    localized_text: segment.text,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
    estimated_duration_ms: segment.expected_duration_ms,
  }], {
    tenantId: segment.tenant_id,
    userId: segment.user_id,
    canReadAsset: ctx.canReadAudioAsset || ctx.canReadAsset,
    canReadArtifact: ctx.canReadArtifact,
    assetReader: ctx.assetReader,
    localeVerifier: ctx.localeVerifier,
  });
  const current = validation.requests[0];
  const sameSnapshot = current
    && stableJson(canonicalVoiceSnapshot(current.voice_snapshot))
      === stableJson(canonicalVoiceSnapshot(segment.voice_snapshot));
  if (!validation.ok || !current
    || Number(current.character_asset_id) !== Number(segment.character_asset_id)
    || String(current.locale_pack || '') !== String(segment.locale_pack || '')
    || String(current.model_manifest_sha256 || '') !== String(segment.model_manifest_sha256 || '')
    || String(current.calibration_manifest_sha256 || '') !== String(segment.calibration_manifest_sha256 || '')
    || !sameSnapshot) {
    throw codedError('REDRAW_DIALOGUE_VOICE_INVALID', '配音音色、授权、样音或 TTS 配置已变化', {
      reason: validation.issues[0]?.reason || 'voice_snapshot_changed',
    });
  }
}

function readShotDraft(shot) {
  const draft = parseJson(shot.draft_json, {});
  return draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
}

function readAudits(db, segments) {
  const byShot = new Map();
  for (const segment of segments) {
    if (!byShot.has(segment.shot_row_id)) {
      const shot = db.prepare('SELECT id, audio_asset_id, draft_json FROM redraw_shots WHERE id = ?')
        .get(segment.shot_row_id);
      byShot.set(segment.shot_row_id, {
        shot,
        draft: readShotDraft(shot || {}),
        segments: new Map(),
      });
      const auditSegments = parseJson(shot?.draft_json, {})?.dialogue_generation?.segments;
      if (Array.isArray(auditSegments)) {
        for (const item of auditSegments) byShot.get(segment.shot_row_id).segments.set(item.segment_id, item);
      }
    }
  }
  return byShot;
}

function writeShotAudit(db, shotId, draft, segments) {
  const segmentList = [...segments.values()].sort((a, b) => Number(a.turn_index) - Number(b.turn_index));
  const completed = segmentList.filter((item) => item.status === 'completed');
  const audioAssetId = segmentList.length === 1 && completed.length === 1 ? completed[0].audio_asset_id : null;
  const nextDraft = {
    ...draft,
    dialogue_generation: {
      status: segmentList.some((item) => item.status === 'needs_attention') ? 'needs_attention'
        : segmentList.some((item) => item.status === 'failed') ? 'failed'
          : completed.length === segmentList.length ? 'completed' : 'processing',
      segments: segmentList,
    },
  };
  db.prepare(`
    UPDATE redraw_shots
    SET audio_asset_id = ?, draft_json = ?, updated_at = ?
    WHERE id = ?
  `).run(audioAssetId, JSON.stringify(nextDraft), new Date().toISOString(), shotId);
}

function safeAudit(segment, patch) {
  const voiceSnapshot = canonicalVoiceSnapshot(segment.voice_snapshot);
  return {
    segment_id: segment.segment_id,
    shot_id: segment.shot_id,
    turn_index: segment.turn_index,
    speaker_id: segment.speaker_id,
    provider: voiceSnapshot.provider,
    model: voiceSnapshot.model,
    ai_service_config_id: voiceSnapshot.ai_service_config_id,
    config_updated_at: voiceSnapshot.config_updated_at,
    voice_snapshot: voiceSnapshot,
    voice_id: segment.voice_id,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
    text_hash: sha256(segment.text),
    ...patch,
  };
}

function operationKey(idempotencyKey, quoteHash, segment) {
  return [
    RESOURCE_TYPE,
    idempotencyKey,
    segment.version_id,
    segment.segment_id,
    quoteHash,
  ].join(':');
}

function claimSegment(db, ctx, quoteHash, idempotencyKey, segment, onCreated) {
  return creditLedger.claim(db, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    actorUserId: ctx.userId,
    operationKey: operationKey(idempotencyKey, quoteHash, segment),
    model: segment.voice_snapshot.model,
    resourceType: RESOURCE_TYPE,
    resourceId: `${segment.version_id}:${segment.segment_id}`,
    amount: modelPrice.requirePrice(db, segment.voice_snapshot.model),
    onCreated,
  });
}

async function synthesizeDialogueForVersion(ctx = {}, input = {}) {
  const { db } = ctx;
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const quoteHash = String(input.quoteHash || '').trim();
  if (!idempotencyKey || !quoteHash) throw codedError('REDRAW_DIALOGUE_CONTEXT_INVALID', '缺少配音幂等参数');
  const plan = buildDialoguePlan(db, ctx);
  if (plan.status !== 'ready') throw codedError('REDRAW_DIALOGUE_PLAN_NOT_READY', '配音计划需要重写');
  const quote = quoteDialoguePlan(db, ctx);
  if (quote.quote_hash !== quoteHash) throw codedError('REDRAW_DIALOGUE_QUOTE_MISMATCH', '配音报价已变化');

  const shotAudits = readAudits(db, plan.segments);

  for (const segment of plan.segments) {
    const holder = shotAudits.get(segment.shot_row_id);
    const existing = holder.segments.get(segment.segment_id);
    const sameSubmission = existing?.idempotency_key === idempotencyKey
      && existing?.quote_hash === quoteHash;
    if (existing && !sameSubmission) {
      const existingReservationStatus = reservationStatus(db, existing.reservation_id);
      if (existing.status === 'completed' && existingReservationStatus === 'confirmed') {
        const asset = getAsset(db, existing.audio_asset_id);
        if (validateDialogueAudioAsset(
          ctx,
          segment,
          asset,
          existing,
          existing.idempotency_key,
          existing.reservation_id,
        )) {
          continue;
        }
      }
      if (existing.status !== 'failed' && existingReservationStatus !== 'refunded') {
        throw codedError('REDRAW_DIALOGUE_NEEDS_ATTENTION', '该配音片段已有未决生成结果，需要人工处理');
      }
    }
    if (sameSubmission) {
      if (existing.status === 'needs_attention' || existing.status === 'processing') {
        if (existing.status === 'processing') {
          holder.segments.set(segment.segment_id, safeAudit(segment, {
            ...existing,
            status: 'needs_attention',
            error_code: 'REDRAW_DIALOGUE_NEEDS_ATTENTION',
          }));
          writeShotAudit(db, segment.shot_row_id, holder.draft, holder.segments);
        }
        throw codedError('REDRAW_DIALOGUE_NEEDS_ATTENTION', '配音结果未知，需要人工处理');
      }
      if (existing.status === 'failed' || existing.reservation_status === 'refunded') {
        throw codedError('REDRAW_DIALOGUE_RETRY_REQUIRED', '配音已明确失败，请使用新的幂等键重试');
      }
      if (existing.status === 'completed') {
        const asset = getAsset(db, existing.audio_asset_id);
        if (validateDialogueAudioAsset(ctx, segment, asset, existing, idempotencyKey, existing.reservation_id)
          && reservationStatus(db, existing.reservation_id) === 'confirmed') {
          continue;
        }
        throw codedError('REDRAW_DIALOGUE_AUDIO_INVALID', '配音音频不可读');
      }
      if (existing.status === 'provider_completed') {
        const asset = getAsset(db, existing.audio_asset_id);
        if (!validateDialogueAudioAsset(ctx, segment, asset, existing, idempotencyKey, existing.reservation_id)) {
          const currentStatus = reservationStatus(db, existing.reservation_id);
          holder.segments.set(segment.segment_id, safeAudit(segment, {
            ...existing,
            status: 'needs_attention',
            reservation_status: currentStatus,
            error_code: 'REDRAW_DIALOGUE_AUDIO_INVALID',
          }));
          writeShotAudit(db, segment.shot_row_id, holder.draft, holder.segments);
          throw codedError('REDRAW_DIALOGUE_AUDIO_INVALID', '配音音频不可读', {
            unknown: true,
            provider_completed: true,
            provider_task_id: existing.provider_task_id || null,
          });
        }
        try {
          const currentStatus = reservationStatus(db, existing.reservation_id);
          const confirmed = currentStatus === 'confirmed'
            ? creditLedger.getReservation(db, existing.reservation_id)
            : creditLedger.confirm(db, existing.reservation_id);
          if (confirmed.status !== 'confirmed') {
            throw codedError('REDRAW_DIALOGUE_CONFIRM_FAILED', '配音扣费确认失败');
          }
          holder.segments.set(segment.segment_id, safeAudit(segment, {
            ...existing,
            status: 'completed',
            reservation_status: confirmed.status,
            audio_duration: Number(asset.duration),
          }));
          writeShotAudit(db, segment.shot_row_id, holder.draft, holder.segments);
        } catch (error) {
          throw postProviderError(error, existing.provider_task_id);
        }
        continue;
      }
    }

    const opKey = operationKey(idempotencyKey, quoteHash, segment);
    if (typeof ctx.synthesizeSegment !== 'function') {
      throw codedError('REDRAW_DIALOGUE_SYNTHESIZER_REQUIRED', '缺少配音生成器');
    }
    const claim = claimSegment(db, ctx, quoteHash, idempotencyKey, segment, (reservation) => {
      if (typeof ctx.beforeProcessingAuditWrite === 'function') {
        ctx.beforeProcessingAuditWrite({ segment, reservation, operation_key: opKey });
      }
      holder.segments.set(segment.segment_id, safeAudit(segment, {
        status: 'processing',
        idempotency_key: idempotencyKey,
        quote_hash: quoteHash,
        reservation_id: reservation.id,
        reservation_status: reservation.status,
        operation_key: opKey,
      }));
      writeShotAudit(db, segment.shot_row_id, holder.draft, holder.segments);
    });
    const reservation = claim.reservation;
    if (claim.error) throw claim.error;
    if (!claim.created) {
      if (reservation.status === 'refunded') {
        throw codedError('REDRAW_DIALOGUE_RETRY_REQUIRED', '配音已明确失败，请使用新的幂等键重试');
      }
      if (reservation.status === 'held') {
        throw codedError('REDRAW_DIALOGUE_NEEDS_ATTENTION', '配音结果未知，需要人工处理');
      }
      throw codedError('REDRAW_DIALOGUE_IDEMPOTENCY_CONFLICT', '配音幂等状态不可重投');
    }
    if (reservation.status !== 'held') {
      const code = reservation.status === 'refunded'
        ? 'REDRAW_DIALOGUE_RETRY_REQUIRED'
        : 'REDRAW_DIALOGUE_IDEMPOTENCY_CONFLICT';
      throw codedError(code, '配音幂等状态不可重投');
    }
    if (typeof ctx.afterProcessingAuditWrite === 'function') {
      await ctx.afterProcessingAuditWrite({ segment, reservation, operation_key: opKey });
    }

    let output;
    let asset;
    let assetId;
    try {
      validateCurrentDialogueSegment(ctx, segment);
      assertLocaleVerifierReady(ctx, segment.voice_snapshot.locale);
      output = await ctx.synthesizeSegment({
        ...segment,
        quote_hash: quoteHash,
        idempotency_key: idempotencyKey,
        reservation_id: reservation.id,
      });
      const providerTaskId = String(output?.provider_task_id || '').trim();
      if (!providerTaskId) {
        throw codedError('PROVIDER_STATUS_UNKNOWN', '配音供应商完成响应缺少任务 ID', {
          unknown: true,
          provider_completed: true,
          provider_task_id: null,
        });
      }
      assetId = Number(output?.asset_id ?? output?.audio_asset_id);
      asset = getAsset(db, assetId);
      if (!validateDialogueAudioAsset(ctx, segment, asset, output, idempotencyKey, reservation.id)) {
        throw codedError('REDRAW_DIALOGUE_AUDIO_INVALID', '配音音频不可读', {
          provider_completed: true,
          provider_task_id: providerTaskId,
        });
      }
    } catch (error) {
      const providerTaskId = String(error?.provider_task_id || output?.provider_task_id || '').trim() || null;
      const postProvider = error?.provider_completed === true || Boolean(output && providerTaskId);
      if (error?.unknown === true || error?.code === 'PROVIDER_STATUS_UNKNOWN' || postProvider) {
        error.unknown = true;
        if (postProvider) error.provider_completed = true;
        if (!error.provider_task_id && providerTaskId) error.provider_task_id = providerTaskId;
        holder.segments.set(segment.segment_id, safeAudit(segment, {
          status: 'needs_attention',
          idempotency_key: idempotencyKey,
          quote_hash: quoteHash,
          reservation_id: reservation.id,
          reservation_status: reservation.status,
          operation_key: opKey,
          provider_task_id: error.provider_task_id || null,
          error_code: error.code || 'PROVIDER_STATUS_UNKNOWN',
        }));
        writeShotAudit(db, segment.shot_row_id, holder.draft, holder.segments);
        throw error;
      }
      const refunded = creditLedger.refund(db, reservation.id, error?.code || 'generation_failed');
      holder.segments.set(segment.segment_id, safeAudit(segment, {
        status: 'failed',
        idempotency_key: idempotencyKey,
        quote_hash: quoteHash,
        reservation_id: reservation.id,
        reservation_status: refunded.status,
        operation_key: opKey,
        error_code: error?.code || 'REDRAW_DIALOGUE_SYNTHESIS_FAILED',
      }));
      writeShotAudit(db, segment.shot_row_id, holder.draft, holder.segments);
      throw error;
    }
    try {
      holder.segments.set(segment.segment_id, safeAudit(segment, {
        status: 'provider_completed',
        idempotency_key: idempotencyKey,
        quote_hash: quoteHash,
        reservation_id: reservation.id,
        reservation_status: reservation.status,
        operation_key: opKey,
        provider_task_id: output?.provider_task_id || null,
        audio_asset_id: assetId,
        audio_duration: Number(asset.duration),
      }));
      writeShotAudit(db, segment.shot_row_id, holder.draft, holder.segments);
      if (typeof ctx.afterProviderCompletedAuditWrite === 'function') {
        await ctx.afterProviderCompletedAuditWrite({ segment, reservation, output, asset });
      }
      const confirmed = creditLedger.confirm(db, reservation.id);
      if (confirmed.status !== 'confirmed') {
        throw codedError('REDRAW_DIALOGUE_CONFIRM_FAILED', '配音扣费确认失败');
      }
      if (typeof ctx.afterConfirmBeforeCompletedAuditWrite === 'function') {
        await ctx.afterConfirmBeforeCompletedAuditWrite({ segment, reservation: confirmed, output, asset });
      }
      holder.segments.set(segment.segment_id, safeAudit(segment, {
        status: 'completed',
        idempotency_key: idempotencyKey,
        quote_hash: quoteHash,
        reservation_id: reservation.id,
        reservation_status: confirmed.status,
        operation_key: opKey,
        provider_task_id: output?.provider_task_id || null,
        audio_asset_id: assetId,
        audio_duration: Number(asset.duration),
      }));
      writeShotAudit(db, segment.shot_row_id, holder.draft, holder.segments);
    } catch (error) {
      throw postProviderError(error, output?.provider_task_id);
    }
  }

  return { status: 'completed', segment_count: plan.segments.length, quote_hash: quoteHash };
}

module.exports = {
  buildDialoguePlan,
  quoteDialoguePlan,
  synthesizeDialogueForVersion,
};
