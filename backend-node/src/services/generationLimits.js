'use strict';

const DEFAULT_GENERATION_SUBMIT_LIMIT_PER_MINUTE = 300;
const DEFAULT_PIPELINE_CONCURRENCY_MAX = 300;
const HARD_CAP = 1000;

function readPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(HARD_CAP, n);
}

/** 公开平台：每用户每分钟可发起的生成提交次数（对齐上游常见 RPM） */
function resolveGenerationSubmitLimitPerMinute(env = process.env) {
  return readPositiveInt(
    env.GENERATION_SUBMIT_LIMIT_PER_MINUTE,
    DEFAULT_GENERATION_SUBMIT_LIMIT_PER_MINUTE,
  );
}

/** 流水线/生成设置里图片与视频并发可配置上限 */
function resolvePipelineConcurrencyMax(env = process.env) {
  return readPositiveInt(
    env.PIPELINE_CONCURRENCY_MAX,
    DEFAULT_PIPELINE_CONCURRENCY_MAX,
  );
}

module.exports = {
  DEFAULT_GENERATION_SUBMIT_LIMIT_PER_MINUTE,
  DEFAULT_PIPELINE_CONCURRENCY_MAX,
  resolveGenerationSubmitLimitPerMinute,
  resolvePipelineConcurrencyMax,
};
