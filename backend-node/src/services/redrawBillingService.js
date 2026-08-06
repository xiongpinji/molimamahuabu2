const { createHash } = require('crypto');

const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');

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

function assertVideoDuration(value) {
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < 5 || duration > 15) {
    throw codedError('INVALID_VIDEO_DURATION', '视频时长必须是 5 到 15 秒之间的整数');
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
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
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

function buildSnapshot(input, shotIds, count, attempt) {
  const snapshotInput = {
    model: requiredString(input.model, 'model'),
    duration: assertVideoDuration(input.duration),
    resolution: input.resolution == null ? null : String(input.resolution),
    count,
    locale: input.locale == null ? null : String(input.locale),
    style_snapshot: input.styleSnapshot ?? null,
    version_id: requiredString(input.versionId, 'versionId'),
    shot_ids: shotIds,
    attempt,
  };
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
  return {
    success: true,
    reservation_id: reservation.id,
    operation_key: operationKey,
    amount: reservation.amount,
    quote,
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
