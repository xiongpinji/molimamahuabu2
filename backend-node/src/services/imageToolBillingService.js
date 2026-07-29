const { randomUUID } = require('crypto');
const auditEvent = require('./auditEventService');
const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');

function begin(db, input) {
  if (!input.enabled) return null;
  if (!input.userId) {
    const error = new Error('公开计费模式缺少用户身份');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
  const model = modelPrice.canonicalModel(input.model);
  const amount = modelPrice.requirePrice(db, model);
  const resourceId = String(input.resourceId);
  const reservation = db.transaction(() => {
    const held = creditLedger.reserve(db, {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      userId: input.userId,
      operationKey: `image_tool:${input.operation}:${resourceId}:${randomUUID()}`,
      model,
      resourceType: 'image_tool',
      resourceId,
      amount,
    });
    auditEvent.record(db, {
      userId: input.userId,
      tenantId: input.tenantId,
      eventType: `generation.image_tool.${input.operation}.created`,
      resourceType: 'image_tool',
      resourceId,
      outcome: 'success',
      code: 'CREATED',
    });
    return held;
  })();
  return {
    reservationId: reservation.id,
    operation: input.operation,
    resourceId,
  };
}

function settle(db, log, billing, outcome, message = '') {
  if (!billing?.reservationId) return null;
  try {
    const reservation = creditLedger.settleGeneration(
      db,
      billing.reservationId,
      outcome,
      message,
    );
    auditEvent.record(db, {
      userId: reservation?.actor_user_id || reservation?.user_id,
      tenantId: reservation?.tenant_id,
      eventType: `generation.image_tool.${billing.operation}.${outcome}`,
      resourceType: 'image_tool',
      resourceId: billing.resourceId,
      outcome: outcome === 'completed' ? 'success' : 'failed',
      code: outcome === 'failed' ? 'GENERATION_FAILED' : null,
    });
    return reservation;
  } catch (error) {
    log?.error?.('图片工具积分结算失败，保留原预扣状态', {
      reservation_id: billing.reservationId,
      error: error.message,
    });
    return null;
  }
}

function availability(db, tool) {
  if (!tool) return { tool: null, reason: undefined };
  try {
    modelPrice.requirePrice(db, tool.model);
    return { tool, reason: undefined };
  } catch (error) {
    if (error.code === 'MODEL_DISABLED') {
      return { tool: null, reason: '图片模型已被管理员停用' };
    }
    return { tool: null, reason: '图片模型尚未配置积分价格' };
  }
}

function respondError(response, res, error) {
  if (['MODEL_PRICE_NOT_CONFIGURED', 'MODEL_DISABLED'].includes(error.code)) {
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
  availability,
  begin,
  settle,
  respondError,
};
