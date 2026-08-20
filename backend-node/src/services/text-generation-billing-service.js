const { randomUUID } = require('crypto');
const aiClient = require('./aiClient');
const auditEvent = require('./auditEventService');
const creditLedger = require('./creditLedgerService');
const generationCost = require('./generationCostLedgerService');
const usageContext = require('./generationUsageContext');
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
  if (requestedModel
    && String(config.logical_model_id || '').trim().toLowerCase() === String(requestedModel).trim().toLowerCase()) {
    return modelPrice.canonicalModel(requestedModel);
  }
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
    operationKey: input.idempotencyKey
      ? `${input.operation}:${String(input.idempotencyKey)}`
      : `${input.operation}:${input.resourceId}:${randomUUID()}`,
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
  const billing = {
    model,
    reservationId: reservation.id,
    tenantId: input.tenantId || null,
    userId: input.userId || null,
    idempotencyKey: input.idempotencyKey || null,
    operation: input.operation,
    resourceType: input.resourceType,
    resourceId: String(input.resourceId),
  };
  generationCost.record(db, {
    reservationId: reservation.id,
    model,
    quantity: 1,
    usageSource: 'unavailable',
  });
  usageContext.activate(billing);
  return billing;
}

function settle(db, log, billing, outcome, message = '') {
  if (!billing?.reservationId) return null;
  try {
    const heldForReview = outcome === 'needs_attention' || outcome === 'held_for_review';
    const settlementOutcome = heldForReview ? 'failed' : outcome;
    const settlementMessage = heldForReview
      ? `文本生成结果未知，等待管理员核对${message ? `：${message}` : ''}`
      : message;
    const settled = creditLedger.settleGeneration(
      db,
      billing.reservationId,
      settlementOutcome,
      settlementMessage,
    );
    try {
      if (outcome === 'completed') {
        generationCost.record(db, {
          reservationId: billing.reservationId,
          model: billing.model,
          configId: billing.route?.configId,
          count: 1,
          inputTokens: billing.usage?.inputTokens,
          outputTokens: billing.usage?.outputTokens,
          reasoningTokens: billing.usage?.reasoningTokens,
          usageSource: billing.usage?.source || 'unavailable',
        });
      } else if (heldForReview) {
        generationCost.record(db, {
          reservationId: billing.reservationId,
          model: billing.model,
          usageSource: 'unknown',
        });
      }
    } catch (costError) {
      log?.error?.('文本生成成本记录失败，保留未计成本标记', {
        reservation_id: billing.reservationId,
        error: costError.message,
      });
    }
    auditEvent.record(db, {
      userId: settled?.actor_user_id || settled?.user_id,
      tenantId: settled?.tenant_id,
      eventType: `generation.${billing.operation}.${outcome}`,
      resourceType: billing.resourceType,
      resourceId: billing.resourceId,
      outcome: outcome === 'completed' ? 'success' : heldForReview ? 'pending' : 'failed',
      code: heldForReview ? 'GENERATION_RESULT_UNKNOWN'
        : outcome === 'failed' ? 'GENERATION_FAILED' : null,
    });
    return settled;
  } catch (error) {
    log?.error?.('文本生成积分结算失败，保留原预扣状态', {
      reservation_id: billing.reservationId,
      error: error.message,
    });
    return null;
  } finally {
    usageContext.clear(billing);
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
