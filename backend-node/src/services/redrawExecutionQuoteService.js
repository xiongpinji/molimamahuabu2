'use strict';

const modelPrice = require('./modelPriceService');
const { hashPlanValue } = require('./redrawExecutionPlanService');

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const seconds = (value) => Number.isSafeInteger(value) && value > 0 && value % 1000 === 0;
const strings = (value) => Array.isArray(value) && value.length > 0 && value.every(text);
const fail = (suffix) => { throw Object.assign(new Error(suffix), { code: `EXECUTION_QUOTE_${suffix}` }); };
const safeCodes = new Set(['EXECUTION_QUOTE_INPUT_INVALID', 'EXECUTION_QUOTE_PLAN_INVALID',
  'EXECUTION_QUOTE_CAPABILITY_INVALID', 'EXECUTION_QUOTE_UNIT_INVALID',
  'EXECUTION_QUOTE_OUTPUT_PARAMETERS_REQUIRED', 'EXECUTION_QUOTE_OUTPUT_PARAMETERS_UNSUPPORTED',
  'EXECUTION_QUOTE_DURATION_INVALID', 'EXECUTION_QUOTE_AMOUNT_INVALID', 'EXECUTION_QUOTE_PRICE_CHECK_FAILED',
  'MODEL_PRICE_NOT_CONFIGURED', 'MODEL_DISABLED', 'MODEL_RESOLUTION_PRICE_REQUIRED']);

function contentHash(value, field) {
  const { [field]: ignored, ...body } = value;
  return hashPlanValue(body);
}

// Input is the caller's freshly checked server-side saved plan, not a client plan.
// These hashes bind this calculation; they do not authenticate owner, review or materials.
function quoteExecutionUnits(ctx, input) {
  const blocked = { schema_version: 'redraw-execution-unit-quote-v1', status: 'blocked',
    executable: false, reason_codes: [] };
  let pricing = false;
  try {
    if (!ctx?.db || typeof ctx.db.prepare !== 'function' || typeof ctx.db.transaction !== 'function'
      || !object(input) || Object.keys(input).some((key) => !['plan', 'output_parameters'].includes(key))) {
      fail('INPUT_INVALID');
    }
    const { plan, output_parameters: parameters } = input;
    if (!object(plan) || plan.schema_version !== 'redraw-execution-plan-preview-v1'
      || plan.status !== 'ready' || plan.executable !== false || !sha(plan.plan_hash)
      || contentHash(plan, 'plan_hash') !== plan.plan_hash) fail('PLAN_INVALID');
    const capability = plan.capability;
    if (!object(capability) || !sha(capability.capability_hash)
      || contentHash(capability, 'capability_hash') !== capability.capability_hash
      || plan.bindings?.capability_hash !== capability.capability_hash || !text(capability.model)
      || !strings(capability.resolutions) || !strings(capability.aspect_ratios)) fail('CAPABILITY_INVALID');
    if (!Array.isArray(plan.units) || !plan.units.length) fail('UNIT_INVALID');
    const ids = new Set();
    for (const unit of plan.units) {
      if (!object(unit) || !text(unit.id) || ids.has(unit.id)) fail('UNIT_INVALID');
      ids.add(unit.id);
    }
    // Validate before calculateCharge: free and per-request prices return before its duration check.
    if (!Array.isArray(capability.durations_ms) || !capability.durations_ms.length
      || !capability.durations_ms.every(seconds)
      || !plan.units.every((unit) => seconds(unit.generated_duration_ms)
        && capability.durations_ms.includes(unit.generated_duration_ms))) fail('DURATION_INVALID');
    if (object(parameters) && Object.keys(parameters).some((key) => !['resolution', 'aspect_ratio'].includes(key))) {
      fail('INPUT_INVALID');
    }
    if (!object(parameters) || parameters.resolution == null || parameters.aspect_ratio == null
      || parameters.resolution === '' || parameters.aspect_ratio === '') fail('OUTPUT_PARAMETERS_REQUIRED');
    if (!capability.resolutions.includes(parameters.resolution)
      || !capability.aspect_ratios.includes(parameters.aspect_ratio)) fail('OUTPUT_PARAMETERS_UNSUPPORTED');
    const outputParameters = { resolution: parameters.resolution, aspect_ratio: parameters.aspect_ratio };
    const allowedDurations = capability.durations_ms.map((duration) => duration / 1000);
    pricing = true;
    const model = modelPrice.canonicalModel(capability.model);
    return ctx.db.transaction(() => {
      const metadata = ctx.db.prepare(`SELECT category, pricing_mode
        FROM model_credit_prices WHERE model = ? COLLATE NOCASE`).get(model);
      let amount = 0;
      const units = plan.units.map((unit, ordinal) => {
        const unitAmount = modelPrice.calculateCharge(ctx.db, model, {
          duration: unit.generated_duration_ms / 1000, allowedDurations, resolution: outputParameters.resolution,
        });
        // Preserve the calculator's missing/disabled/tier errors before rejecting pricing metadata.
        if (metadata?.category !== 'video' || !['free', 'paid'].includes(metadata.pricing_mode)) fail('PRICE_CHECK_FAILED');
        if (!Number.isSafeInteger(unitAmount) || (metadata.pricing_mode === 'free' ? unitAmount !== 0 : unitAmount <= 0)
          || !Number.isSafeInteger(amount + unitAmount)) fail('AMOUNT_INVALID');
        amount += unitAmount;
        return { unit_id: unit.id, ordinal, unit_hash: hashPlanValue(unit),
          generated_duration_ms: unit.generated_duration_ms, amount: unitAmount };
      });
      const quote = { schema_version: blocked.schema_version, status: 'quoted', executable: false, reason_codes: [],
        plan_hash: plan.plan_hash, capability_hash: capability.capability_hash, output_parameters: outputParameters,
        pricing_mode: metadata.pricing_mode, count: units.length, units, amount };
      // No reservation is created, including free0. Run/claim must synchronously recheck this
      // quote with current owner/review/materials/capability and the eventual billing operation.
      return { ...quote, quote_hash: hashPlanValue(quote) };
    }).deferred();
  } catch (error) {
    blocked.reason_codes = [safeCodes.has(error?.code) ? error.code
      : `EXECUTION_QUOTE_${pricing ? 'PRICE_CHECK_FAILED' : 'INPUT_INVALID'}`];
    return blocked;
  }
}

module.exports = { quoteExecutionUnits };
