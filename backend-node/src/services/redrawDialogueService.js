const crypto = require('crypto');

const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');
const redrawVoiceService = require('./redrawVoiceService');

const RESOURCE_TYPE = 'redraw_dialogue';

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
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

  const tts = redrawVoiceService.validateTtsBatch(db, version.id, turns);
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
    const key = String(segment.voice_snapshot.model);
    const current = modelsByName.get(key) || { model: key, credits, segments: 0 };
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
  return db.prepare('SELECT * FROM assets WHERE id = ? AND type = ? AND deleted_at IS NULL')
    .get(Number(assetId), 'audio') || null;
}

function canReadAsset(ctx, asset) {
  return Boolean(asset && Number(asset.duration) > 0
    && typeof ctx.canReadAudioAsset === 'function'
    && ctx.canReadAudioAsset(asset) === true);
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
  return {
    segment_id: segment.segment_id,
    shot_id: segment.shot_id,
    turn_index: segment.turn_index,
    speaker_id: segment.speaker_id,
    provider: segment.provider,
    model: segment.model,
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

function reserveSegment(db, ctx, quoteHash, idempotencyKey, segment) {
  return creditLedger.reserve(db, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    actorUserId: ctx.userId,
    operationKey: operationKey(idempotencyKey, quoteHash, segment),
    model: segment.voice_snapshot.model,
    resourceType: RESOURCE_TYPE,
    resourceId: `${segment.version_id}:${segment.segment_id}`,
    amount: modelPrice.requirePrice(db, segment.voice_snapshot.model),
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
    const audit = shotAudits.get(segment.shot_row_id)?.segments.get(segment.segment_id);
    if (audit?.idempotency_key !== idempotencyKey || audit?.quote_hash !== quoteHash) continue;
    if (audit.status === 'needs_attention') {
      throw codedError('REDRAW_DIALOGUE_NEEDS_ATTENTION', '配音结果未知，需要人工处理');
    }
    if (audit.status === 'failed' || audit.reservation_status === 'refunded') {
      throw codedError('REDRAW_DIALOGUE_RETRY_REQUIRED', '配音已明确失败，请使用新的幂等键重试');
    }
    if (audit.status === 'completed' && canReadAsset(ctx, getAsset(db, audit.audio_asset_id))) continue;
  }

  if (plan.segments.every((segment) => {
    const audit = shotAudits.get(segment.shot_row_id)?.segments.get(segment.segment_id);
    return audit?.idempotency_key === idempotencyKey
      && audit?.quote_hash === quoteHash
      && audit.status === 'completed'
      && canReadAsset(ctx, getAsset(db, audit.audio_asset_id));
  })) {
    return { status: 'completed', segment_count: plan.segments.length, quote_hash: quoteHash };
  }

  if (typeof ctx.synthesizeSegment !== 'function') {
    throw codedError('REDRAW_DIALOGUE_SYNTHESIZER_REQUIRED', '缺少配音生成器');
  }

  for (const segment of plan.segments) {
    const holder = shotAudits.get(segment.shot_row_id);
    const existing = holder.segments.get(segment.segment_id);
    if (existing?.idempotency_key === idempotencyKey
      && existing?.quote_hash === quoteHash
      && existing.status === 'completed'
      && canReadAsset(ctx, getAsset(db, existing.audio_asset_id))) {
      continue;
    }
    const reservation = reserveSegment(db, ctx, quoteHash, idempotencyKey, segment);
    if (reservation.status !== 'held') {
      const code = reservation.status === 'refunded'
        ? 'REDRAW_DIALOGUE_RETRY_REQUIRED'
        : 'REDRAW_DIALOGUE_IDEMPOTENCY_CONFLICT';
      throw codedError(code, '配音幂等状态不可重投');
    }
    try {
      const output = await ctx.synthesizeSegment({
        ...segment,
        quote_hash: quoteHash,
        idempotency_key: idempotencyKey,
        reservation_id: reservation.id,
      });
      const assetId = Number(output?.asset_id ?? output?.audio_asset_id);
      const asset = getAsset(db, assetId);
      if (!canReadAsset(ctx, asset)) {
        throw codedError('REDRAW_DIALOGUE_AUDIO_INVALID', '配音音频不可读');
      }
      const confirmed = creditLedger.confirm(db, reservation.id);
      if (confirmed.status !== 'confirmed') {
        throw codedError('REDRAW_DIALOGUE_CONFIRM_FAILED', '配音扣费确认失败');
      }
      holder.segments.set(segment.segment_id, safeAudit(segment, {
        status: 'completed',
        idempotency_key: idempotencyKey,
        quote_hash: quoteHash,
        reservation_id: reservation.id,
        reservation_status: confirmed.status,
        provider_task_id: output?.provider_task_id || null,
        audio_asset_id: assetId,
        audio_duration: Number(asset.duration),
      }));
      writeShotAudit(db, segment.shot_row_id, holder.draft, holder.segments);
    } catch (error) {
      if (error?.unknown === true || error?.code === 'PROVIDER_STATUS_UNKNOWN') {
        holder.segments.set(segment.segment_id, safeAudit(segment, {
          status: 'needs_attention',
          idempotency_key: idempotencyKey,
          quote_hash: quoteHash,
          reservation_id: reservation.id,
          reservation_status: reservation.status,
          provider_task_id: error.provider_task_id || null,
          error_code: 'PROVIDER_STATUS_UNKNOWN',
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
        error_code: error?.code || 'REDRAW_DIALOGUE_SYNTHESIS_FAILED',
      }));
      writeShotAudit(db, segment.shot_row_id, holder.draft, holder.segments);
      throw error;
    }
  }

  return { status: 'completed', segment_count: plan.segments.length, quote_hash: quoteHash };
}

module.exports = {
  buildDialoguePlan,
  quoteDialoguePlan,
  synthesizeDialogueForVersion,
};
