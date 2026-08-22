const { createHash } = require('crypto');

const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');
const ICREAT_MINI_MODEL = 'bytedance/seedance-2-0-mini';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', `${name} 必须是正整数`);
  }
  return number;
}

function assertVideoDuration(value, model) {
  const duration = Number(value);
  const minimum = model === ICREAT_MINI_MODEL ? 4 : 5;
  if (!Number.isSafeInteger(duration) || duration < minimum || duration > 15) {
    throw codedError('INVALID_VIDEO_DURATION', `视频时长必须是 ${minimum} 到 15 秒之间的整数`);
  }
  return duration;
}

function requiredString(value, name) {
  const string = String(value ?? '').trim();
  if (!string) throw codedError('INVALID_REDRAW_BILLING_INPUT', `${name} 不能为空`);
  return string;
}

function accountId(input) {
  return requiredString(input.tenantId || input.userId, 'account');
}

function stableValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw codedError('INVALID_REDRAW_BILLING_INPUT', '计费快照只接受可 JSON 序列化的值');
    }
    return value;
  }
  if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', '计费快照只接受可 JSON 序列化的值');
  }
  if (Array.isArray(value)) {
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw codedError('INVALID_REDRAW_BILLING_INPUT', '计费快照数组不能包含空洞');
      }
      result.push(stableValue(value[index]));
    }
    return result;
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw codedError('INVALID_REDRAW_BILLING_INPUT', '计费快照只接受普通对象');
    }
    return Object.keys(value).sort().reduce((result, key) => {
      Object.defineProperty(result, key, {
        value: stableValue(value[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return result;
    }, Object.create(null));
  }
  throw codedError('INVALID_REDRAW_BILLING_INPUT', '计费快照只接受可 JSON 序列化的值');
}

function stableHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function uniqueShotIds(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', 'shotIds 必须是非空数组');
  }
  const seen = new Set();
  const ids = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      throw codedError('INVALID_REDRAW_BILLING_INPUT', 'shotIds 必须是字符串数组');
    }
    const id = requiredString(value, 'shotId');
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function normalizeSnapshotResolution(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return modelPrice.normalizeResolution(trimmed) || trimmed.toLowerCase();
}

function normalizeSourceConditioning(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', 'sourceConditioning 必须是对象');
  }
  const sourceAssetId = assertPositiveInteger(value.source_asset_id ?? value.sourceAssetId, 'source_asset_id');
  const sourceFingerprint = requiredString(value.source_fingerprint ?? value.sourceFingerprint, 'source_fingerprint').toLowerCase();
  const segmentSha256 = requiredString(value.segment_sha256 ?? value.segmentSha256, 'segment_sha256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprint) || !/^[a-f0-9]{64}$/.test(segmentSha256)) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', 'source conditioning hash 必须是 SHA-256');
  }
  const startMs = Number(value.start_ms ?? value.startMs);
  const endMs = Number(value.end_ms ?? value.endMs);
  if (!Number.isSafeInteger(startMs) || startMs < 0 || !Number.isSafeInteger(endMs) || endMs <= startMs) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', 'source conditioning shot 边界无效');
  }
  const audioMode = String(value.audio_mode ?? value.audioMode ?? 'preserve').trim().toLowerCase();
  if (!['preserve', 'strip'].includes(audioMode)) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', 'source conditioning audio_mode 无效');
  }
  return {
    source_asset_id: sourceAssetId,
    source_fingerprint: sourceFingerprint,
    start_ms: startMs,
    end_ms: endMs,
    segment_sha256: segmentSha256,
    audio_mode: audioMode,
  };
}

function buildSnapshot(input, shotIds, count, attempt) {
  const model = modelPrice.canonicalModel(input.model);
  const snapshotInput = {
    model,
    duration: assertVideoDuration(input.duration, model),
    resolution: normalizeSnapshotResolution(input.resolution),
    count,
    locale: input.locale == null ? null : String(input.locale),
    style_snapshot: input.styleSnapshot ?? null,
    version_id: requiredString(input.versionId, 'versionId'),
    shot_ids: shotIds,
    attempt,
  };
  const sourceConditioning = normalizeSourceConditioning(input.sourceConditioning);
  if (sourceConditioning) snapshotInput.source_conditioning = sourceConditioning;
  return {
    ...snapshotInput,
    input_hash: stableHash(snapshotInput),
  };
}

function quoteForShots(db, input, shotIds) {
  accountId(input);
  const count = assertPositiveInteger(input.count ?? 1, 'count');
  const attempt = assertPositiveInteger(input.attempt ?? 1, 'attempt');
  const snapshot = buildSnapshot(input, shotIds, count, attempt);
  let unitAmount;
  try {
    unitAmount = modelPrice.calculateCharge(db, snapshot.model, {
      duration: snapshot.duration,
      resolution: snapshot.resolution,
    });
  } catch (error) {
    if (error.code === 'MODEL_PRICE_NOT_CONFIGURED') {
      return {
        success: false,
        code: 'pricing_unconfigured',
        message: error.message,
        amount: null,
        snapshot: null,
      };
    }
    throw error;
  }
  const amount = unitAmount * count * shotIds.length;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', '计费金额无效');
  }
  return {
    success: true,
    amount,
    unit_amount: unitAmount,
    count,
    snapshot,
  };
}

function quoteShotGeneration(db, input) {
  const shotId = requiredString(input.shotId, 'shotId');
  return quoteForShots(db, input, [shotId]);
}

function quoteBatchGeneration(db, input) {
  const shotIds = uniqueShotIds(input.shotIds);
  return {
    ...quoteForShots(db, input, shotIds),
    shot_count: shotIds.length,
  };
}

function quoteForReservation(quote, reservation) {
  if (reservation.amount === quote.amount) return quote;
  if (reservation.amount % quote.count !== 0) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', '冻结计费金额无法还原单价');
  }
  const unitAmount = reservation.amount / quote.count;
  if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', '冻结计费单价无效');
  }
  return {
    ...quote,
    amount: reservation.amount,
    unit_amount: unitAmount,
    price_source: 'reservation',
  };
}

function reserveShotGeneration(db, input) {
  if (input.shotIds != null) {
    throw codedError('INVALID_REDRAW_BILLING_INPUT', 'reserveShotGeneration 只接受单镜 shotId');
  }
  const quote = quoteShotGeneration(db, input);
  if (!quote.success) return quote;
  const account = accountId(input);
  const shotId = quote.snapshot.shot_ids[0];
  const operationKey = `redraw-shot:${account}:${quote.snapshot.version_id}:${shotId}:${quote.snapshot.input_hash}:${quote.snapshot.attempt}`;
  const reservation = creditLedger.reserve(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    userId: input.userId,
    operationKey,
    model: quote.snapshot.model,
    resourceType: 'redraw_shot',
    resourceId: shotId,
    amount: quote.amount,
  });
  const reservationQuote = quoteForReservation(quote, reservation);
  return {
    success: true,
    reservation_id: reservation.id,
    operation_key: operationKey,
    amount: reservation.amount,
    quote: reservationQuote,
    billing: billingForReservation(reservation),
    status: reservation.status,
  };
}

function billingForReservation(row) {
  if (row.status === 'confirmed') return { held: 0, charged: row.amount, released: 0 };
  if (row.status === 'refunded') return { held: 0, charged: 0, released: row.amount };
  return { held: row.amount, charged: 0, released: 0 };
}

function settleShotGeneration(db, reservationId, outcome, reason) {
  const reservation = creditLedger.settleGeneration(db, reservationId, outcome, reason);
  if (!reservation) return null;
  return {
    success: true,
    reservation_id: reservation.id,
    status: reservation.status,
    amount: reservation.amount,
    billing: billingForReservation(reservation),
  };
}

module.exports = {
  quoteShotGeneration,
  quoteBatchGeneration,
  reserveShotGeneration,
  settleShotGeneration,
};
