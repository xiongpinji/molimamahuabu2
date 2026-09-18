'use strict';

function isPublicPlatformMode(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.PUBLIC_PLATFORM_MODE || ''));
}

/**
 * 公开平台能力矩阵（渐进收敛入口）。
 * 先统一读取开关，后续再把散落的 billing/staticOwnership 等字段迁入。
 */
function createPlatformCapabilities(env = process.env) {
  const publicPlatformEnabled = isPublicPlatformMode(env);
  return {
    publicPlatformEnabled,
    billingEnabled: publicPlatformEnabled,
    staticOwnershipEnabled: publicPlatformEnabled,
    requireUserAuth: publicPlatformEnabled,
    tenantContextEnabled: publicPlatformEnabled,
  };
}

module.exports = {
  isPublicPlatformMode,
  createPlatformCapabilities,
};
