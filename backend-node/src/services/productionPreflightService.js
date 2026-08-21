const modelPriceService = require('./modelPriceService');
const mediaModelSelection = require('./mediaModelSelectionService');
const { createRedrawLocalePackRegistry } = require('./redrawLocalePackRegistry');
const { hasTrustedEvidenceBinding } = require('./externalModelEvidenceService');

const REDRAW_LOCALE_PRECHECK_ID = 'redraw_locale_verifier';
const REDRAW_LOCALE_DEFAULTS = {
  socketPath: '/run/moli-drama/redraw-locale-verifier.sock',
  readyPath: '/run/moli-drama/redraw-locale-verifier.ready.json',
  registryPath: '/opt/moli-drama/shared/redraw-locale-verifier/manifests/enabled-packs.json',
  signaturePath: '/opt/moli-drama/shared/redraw-locale-verifier/manifests/enabled-packs.sig',
  publicKeyPath: '/opt/moli-drama/shared/redraw-locale-verifier/manifests/ed25519-public.pem',
  timeoutMs: 180000,
};

const REQUIRED_MODEL_CATEGORIES = [
  ['text', '文本'],
  ['image', '图片'],
  ['video', '视频'],
];

const CATEGORY_BY_SERVICE = {
  text: 'text',
  image: 'image',
  storyboard_image: 'image',
  video: 'video',
};

function configuredModelKeys(db) {
  const configs = db.prepare(`SELECT * FROM ai_service_configs
    WHERE deleted_at IS NULL`).all()
    .filter((config) => config.is_active && config.verification_status === 'verified');
  const keys = new Set(mediaModelSelection.listEntries(configs)
    .map((entry) => `${entry.kind}:${entry.model.toLowerCase()}`));
  for (const config of configs) {
    const serviceType = String(config.service_type || '').toLowerCase();
    const category = CATEGORY_BY_SERVICE[serviceType];
    if (!category || mediaModelSelection.KIND_BY_SERVICE[serviceType]) continue;
    for (const model of mediaModelSelection.orderedModels(config)) {
      keys.add(`${category}:${model.toLowerCase()}`);
    }
  }
  return keys;
}

function isTrue(value) {
  return value === true || value === 1 || String(value || '').trim().toLowerCase() === 'true';
}

function isHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname !== 'localhost'
      && !url.hostname.endsWith('.localhost')
      && url.hostname !== '127.0.0.1'
      && url.hostname !== '::1';
  } catch {
    return false;
  }
}

function addCheck(checks, id, passed, message, code) {
  const check = {
    id,
    status: passed ? 'pass' : 'fail',
    message,
  };
  if (code) check.code = code;
  checks.push(check);
}

function parseCapabilities(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function externalModelEvidenceBindingsReady(db, roots) {
  const configs = db.prepare(`SELECT * FROM ai_service_configs
    WHERE deleted_at IS NULL AND is_active = 1 AND verification_status = 'verified'`).all();
  const failures = [];
  for (const config of configs) {
    const capabilitiesByModel = parseCapabilities(config.verified_capabilities);
    for (const model of mediaModelSelection.orderedModels(config)) {
      if (!hasTrustedEvidenceBinding(model, capabilitiesByModel[model], roots)) failures.push(model);
    }
  }
  return [...new Set(failures)];
}

function redrawLocaleVerifierOptions(env = process.env) {
  return {
    enabled: isTrue(env.REDRAW_LOCALE_VERIFIER_ENABLED),
    socketPath: String(env.REDRAW_LOCALE_VERIFIER_SOCKET || REDRAW_LOCALE_DEFAULTS.socketPath),
    readyPath: String(env.REDRAW_LOCALE_VERIFIER_READY_PATH || REDRAW_LOCALE_DEFAULTS.readyPath),
    registryPath: String(env.REDRAW_LOCALE_PACK_REGISTRY_PATH || REDRAW_LOCALE_DEFAULTS.registryPath),
    signaturePath: String(env.REDRAW_LOCALE_PACK_SIGNATURE_PATH || REDRAW_LOCALE_DEFAULTS.signaturePath),
    publicKeyPath: String(env.REDRAW_LOCALE_PACK_PUBLIC_KEY_PATH || REDRAW_LOCALE_DEFAULTS.publicKeyPath),
    timeoutMs: Number(env.REDRAW_LOCALE_VERIFIER_TIMEOUT_MS || REDRAW_LOCALE_DEFAULTS.timeoutMs),
  };
}

function createRedrawLocaleRegistryFromEnv(env = process.env) {
  const options = redrawLocaleVerifierOptions(env);
  return createRedrawLocalePackRegistry({
    enabled: true,
    registryPath: options.registryPath,
    signaturePath: options.signaturePath,
    publicKeyPath: options.publicKeyPath,
    readyPath: options.readyPath,
    socketPath: options.socketPath,
  });
}

function runRedrawLocaleVerifierPreflight({ env = process.env, localeRegistry } = {}) {
  const options = redrawLocaleVerifierOptions(env);
  if (!options.enabled) {
    return {
      id: REDRAW_LOCALE_PRECHECK_ID,
      status: 'pass',
      message: 'Redraw locale verifier disabled; production voice locale capability is not available.',
      code: 'REDRAW_LOCALE_VERIFIER_DISABLED',
    };
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return {
      id: REDRAW_LOCALE_PRECHECK_ID,
      status: 'fail',
      message: 'REDRAW_LOCALE_TIMEOUT_INVALID: redraw locale verifier timeout must be a positive integer.',
      code: 'REDRAW_LOCALE_TIMEOUT_INVALID',
    };
  }
  try {
    const registry = localeRegistry || createRedrawLocaleRegistryFromEnv(env);
    registry.assertReady('en-US');
    return {
      id: REDRAW_LOCALE_PRECHECK_ID,
      status: 'pass',
      message: 'Redraw locale verifier enabled and en-US pack ready.',
      code: 'REDRAW_LOCALE_VERIFIER_READY',
    };
  } catch (error) {
    const code = error && error.code ? String(error.code) : 'REDRAW_LOCALE_VERIFIER_NOT_READY';
    return {
      id: REDRAW_LOCALE_PRECHECK_ID,
      status: 'fail',
      message: `${code}: redraw locale verifier is not ready.`,
      code,
    };
  }
}

function runProductionPreflight({ config, env = process.env, db, localeRegistry, evidenceRoots }) {
  const checks = [];
  const jwtSecret = String(env.PLATFORM_JWT_SECRET || '');
  const adminToken = String(env.PLATFORM_ADMIN_TOKEN || '');
  const redrawProviderAssetSecret = String(env.REDRAW_PROVIDER_ASSET_HMAC_SECRET || '');
  const bootstrapEmail = String(env.PLATFORM_BOOTSTRAP_ADMIN_EMAIL || '').trim();
  const corsOrigins = Array.isArray(config.server?.cors_origins)
    ? config.server.cors_origins
    : [];

  addCheck(
    checks,
    'public_platform_mode',
    isTrue(env.PUBLIC_PLATFORM_MODE),
    '公开平台模式必须启用',
  );
  const smtpPort = Number(env.SMTP_PORT || 0);
  const emailVerificationReady = isTrue(env.PLATFORM_EMAIL_VERIFICATION_ENABLED)
    && Boolean(String(env.SMTP_HOST || '').trim())
    && smtpPort > 0
    && smtpPort <= 65535
    && Boolean(String(env.SMTP_USER || '').trim())
    && Boolean(String(env.SMTP_PASSWORD || ''))
    && Boolean(String(env.SMTP_FROM || '').trim());
  addCheck(
    checks,
    'registration_email_verification',
    emailVerificationReady,
    '公开平台必须启用邮箱验证码并完整配置 SMTP，以支持注册和找回密码',
  );
  addCheck(
    checks,
    'secrets',
    jwtSecret.length >= 32 && adminToken.length >= 32 && jwtSecret !== adminToken,
    'JWT 密钥和管理员令牌必须分别设置且不少于 32 字符',
  );
  addCheck(
    checks,
    'redraw_provider_asset_secret',
    redrawProviderAssetSecret.length >= 32
      && redrawProviderAssetSecret !== jwtSecret
      && redrawProviderAssetSecret !== adminToken,
    '转绘供应商素材 HMAC 密钥必须独立设置且不少于 32 字符',
  );
  addCheck(
    checks,
    'bootstrap_admin_email',
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapEmail),
    '必须设置有效的首管理员邮箱',
  );
  addCheck(checks, 'debug_mode', !isTrue(config.app?.debug), '生产环境必须关闭调试模式');
  addCheck(
    checks,
    'tls_verification',
    !isTrue(config.server?.insecure_tls ?? config.server?.INSECURE_TLS),
    '生产环境不得跳过 TLS 证书校验',
  );
  addCheck(
    checks,
    'cors_origins',
    corsOrigins.length > 0
      && corsOrigins.every((origin) => origin !== '*' && isHttpsUrl(origin)),
    'CORS 来源必须显式配置为 HTTPS 地址',
  );
  addCheck(
    checks,
    'storage_public_url',
    isHttpsUrl(config.storage?.base_url),
    '素材公网地址必须使用 HTTPS',
  );
  addCheck(
    checks,
    'database_path',
    config.database?.type === 'sqlite'
      && Boolean(String(config.database?.path || '').trim())
      && config.database?.path !== ':memory:',
    '必须配置持久化 SQLite 数据库路径',
  );

  checks.push(runRedrawLocaleVerifierPreflight({ env, localeRegistry }));

  try {
    const integrity = db.pragma('quick_check', { simple: true });
    addCheck(checks, 'database_integrity', integrity === 'ok', 'SQLite quick_check 必须通过');
  } catch {
    addCheck(checks, 'database_integrity', false, 'SQLite quick_check 执行失败');
  }

  try {
    const mismatched = externalModelEvidenceBindingsReady(db, evidenceRoots);
    addCheck(
      checks,
      'external_model_evidence_binding',
      mismatched.length === 0,
      mismatched.length === 0
        ? '外部模型数据库能力与共享真实验证证据一致'
        : `外部模型证据绑定漂移：${mismatched.join('、')}`,
      mismatched.length === 0 ? undefined : 'EXTERNAL_MODEL_EVIDENCE_BINDING_MISMATCH',
    );
  } catch {
    addCheck(
      checks,
      'external_model_evidence_binding',
      false,
      '外部模型证据绑定无法读取',
      'EXTERNAL_MODEL_EVIDENCE_BINDING_UNAVAILABLE',
    );
  }

  try {
    const sceneColumns = new Set(
      db.prepare('PRAGMA table_info(scenes)').all().map((row) => String(row.name)),
    );
    addCheck(
      checks,
      'short_drama_schema',
      sceneColumns.has('polished_prompt_single'),
      '短剧工厂场景表必须包含单图润色提示词字段',
    );
  } catch {
    addCheck(checks, 'short_drama_schema', false, '短剧工厂场景表结构无法读取');
  }

  try {
    const row = db.prepare(`SELECT COUNT(*) AS count
      FROM platform_users
      WHERE role = 'admin' AND status = 'active'`).get();
    addCheck(checks, 'active_admin', row.count > 0, '至少需要一个活跃平台管理员');
  } catch {
    addCheck(checks, 'active_admin', false, '平台管理员表不存在或无法读取');
  }

  try {
    const configured = configuredModelKeys(db);
    const configuredCategories = new Set(modelPriceService.listPublic(db)
      .filter((row) => configured.has(
        `${String(row.category).toLowerCase()}:${String(row.model).toLowerCase()}`,
      ))
      .map((row) => String(row.category).toLowerCase()));
    const missing = REQUIRED_MODEL_CATEGORIES
      .filter(([category]) => !configuredCategories.has(category))
      .map(([, label]) => label);
    addCheck(
      checks,
      'model_prices',
      missing.length === 0,
      missing.length === 0
        ? '文本、图片、视频核心类别均有已验证且已定价的可用模型'
        : `缺少可用核心模型类别：${missing.join('、')}`,
    );
  } catch {
    addCheck(checks, 'model_prices', false, '模型价格表不存在或无法读取');
  }

  return {
    ready: checks.every((check) => check.status === 'pass'),
    checked_at: new Date().toISOString(),
    checks,
  };
}

module.exports = {
  REDRAW_LOCALE_DEFAULTS,
  createRedrawLocaleRegistryFromEnv,
  externalModelEvidenceBindingsReady,
  runRedrawLocaleVerifierPreflight,
  runProductionPreflight,
};
