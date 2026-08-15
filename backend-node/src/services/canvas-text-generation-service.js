const { randomUUID } = require('crypto');
const aiClient = require('./aiClient');
const textGenerationBilling = require('./text-generation-billing-service');

async function generate(db, log, input = {}) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('请输入文本生成要求');
  const hasDramaId = input.dramaId != null && String(input.dramaId).trim() !== '';
  const dramaId = hasDramaId ? Number(input.dramaId) : null;
  if (hasDramaId && (!Number.isInteger(dramaId) || dramaId <= 0)) {
    throw new Error('drama_id 必须是正整数');
  }
  const standaloneRequestId = String(input.requestId || '').trim();
  const resourceId = hasDramaId ? String(dramaId) : (standaloneRequestId || randomUUID());
  if (resourceId.length > 120) throw new Error('request_id 不能超过 120 个字符');
  const operation = hasDramaId ? 'canvas_text' : 'standalone_text';

  let billing = null;
  try {
    billing = textGenerationBilling.begin(db, {
      enabled: input.billingEnabled === true,
      tenantId: input.tenantId,
      userId: input.userId,
      requestedModel: input.model,
      sceneKey: 'canvas_text',
      resourceType: operation,
      resourceId,
      operation,
    });
    const content = await aiClient.generateText(
      db,
      log,
      'text',
      prompt,
      '你是独立画布文本节点的创作助手。直接输出可继续编辑和连接到下游节点的正文，不要解释过程。',
      {
        model: billing.model || input.model,
        max_tokens: 4096,
        ...(billing.reservationId ? {
          tenantId: billing.tenantId,
          userId: billing.userId,
          creditReservationId: billing.reservationId,
          idempotency_key: billing.reservationId,
        } : {}),
      },
    );
    textGenerationBilling.settle(db, log, billing, 'completed');
    return {
      content: String(content || '').trim(),
      model: billing.model || input.model || '',
    };
  } catch (error) {
    textGenerationBilling.settle(
      db,
      log,
      billing,
      error.code === 'TEXT_RESULT_UNKNOWN' ? 'needs_attention' : 'failed',
      error.message,
    );
    throw error;
  }
}

module.exports = { generate };
