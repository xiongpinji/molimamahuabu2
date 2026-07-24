const { randomUUID } = require('crypto');
const aiClient = require('./aiClient');
const auditEvent = require('./auditEventService');
const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveModel(db, requestedModel, sceneKey) {
  const mapped = sceneKey ? aiClient.getConfigFromModelMap(db, sceneKey) : null;
  const config = mapped?.config
    || (requestedModel
      ? aiClient.getConfigForModel(db, 'text', requestedModel)
      : aiClient.getDefaultConfig(db, 'text'));
  if (!config) throw codedError('TEXT_MODEL_NOT_CONFIGURED', '未配置可用的文本或视觉模型');
  return modelPrice.canonicalModel(
    aiClient.getModelFromConfig(config, mapped?.modelOverride || requestedModel),
  );
}

function begin(db, input) {
  const requestedModel = input.requestedModel || undefined;
  if (!input.enabled) {
    return {
      model: requestedModel,
      reservationId: null,
      operation: input.operation,
      resourceType: input.resourceType,
      resourceId: String(input.resourceId),
    };
  }
  if (!input.userId) throw codedError('UNAUTHORIZED', '公开计费模式缺少用户身份');
  const model = resolveModel(db, requestedModel, input.sceneKey);
  const amount = modelPrice.requirePrice(db, model);
  const reservation = creditLedger.reserve(db, {
    tenantId: input.tenantId,
    actorUserId: input.userId,
    userId: input.userId,
    operationKey: `${input.operation}:${input.resourceId}:${randomUUID()}`,
    model,
    resourceType: input.resourceType,
    resourceId: String(input.resourceId),
    amount,
  });
  auditEvent.record(db, {
    userId: input.userId,
    tenantId: input.tenantId,
    eventType: `generation.${input.operation}.created`,
    resourceType: input.resourceType,
    resourceId: String(input.resourceId),
    outcome: 'success',
    code: 'CREATED',
  });
  return {
    model,
    reservationId: reservation.id,
    operation: input.operation,
    resourceType: input.resourceType,
    resourceId: String(input.resourceId),
  };
}

function settle(db, log, billing, outcome, message = '') {
  if (!billing?.reservationId) return null;
  try {
    const settled = creditLedger.settleGeneration(
      db,
      billing.reservationId,
      outcome,
      message,
    );
    auditEvent.record(db, {
      userId: settled?.actor_user_id || settled?.user_id,
      tenantId: settled?.tenant_id,
      eventType: `generation.${billing.operation}.${outcome}`,
      resourceType: billing.resourceType,
      resourceId: billing.resourceId,
      outcome: outcome === 'completed' ? 'success' : 'failed',
      code: outcome === 'failed' ? 'GENERATION_FAILED' : null,
    });
    return settled;
  } catch (error) {
    log?.error?.('文本生成积分结算失败，保留原预扣状态', {
      reservation_id: billing.reservationId,
      error: error.message,
    });
    return null;
  }
}

function respondError(response, res, error) {
  if (['MODEL_PRICE_NOT_CONFIGURED', 'MODEL_DISABLED', 'TEXT_MODEL_NOT_CONFIGURED'].includes(error.code)) {
    response.error(res, 503, error.code, error.message);
    return true;
  }
  if (error.code === 'INSUFFICIENT_CREDITS') {
    response.error(res, 402, error.code, '积分不足，请兑换积分后重试');
    return true;
  }
  if (error.code === 'UNAUTHORIZED') {
    response.error(res, 401, error.code, error.message);
    return true;
  }
  return false;
}

module.exports = {
  begin,
  settle,
  respondError,
  resolveModel,
};
