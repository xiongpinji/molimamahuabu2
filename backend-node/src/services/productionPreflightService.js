const { SUPPORTED_MODELS } = require('./modelPriceService');
const { createRedrawLocalePackRegistry } = require('./redrawLocalePackRegistry');

const REDRAW_LOCALE_PRECHECK_ID = 'redraw_locale_verifier';
const REDRAW_LOCALE_DEFAULTS = {
  socketPath: '/run/moli-drama/redraw-locale-verifier.sock',
  readyPath: '/run/moli-drama/redraw-locale-verifier.ready.json',
  registryPath: '/opt/moli-drama/shared/redraw-locale-verifier/manifests/enabled-packs.json',
  signaturePath: '/opt/moli-drama/shared/redraw-locale-verifier/manifests/enabled-packs.sig',
  publicKeyPath: '/opt/moli-drama/shared/redraw-locale-verifier/manifests/ed25519-public.pem',
  timeoutMs: 180000,
};

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
  if (code) {
    check.code = code;
  }
  checks.push(check);
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

function runProductionPreflight({ config, env = process.env, db, localeRegistry }) {
  const checks = [];
  const jwtSecret = String(env.PLATFORM_JWT_SECRET || '');
  const adminToken = String(env.PLATFORM_ADMIN_TOKEN || '');
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

  const redrawLocaleCheck = runRedrawLocaleVerifierPreflight({ env, localeRegistry });
  checks.push(redrawLocaleCheck);

  try {
    const integrity = db.pragma('quick_check', { simple: true });
    addCheck(checks, 'database_integrity', integrity === 'ok', 'SQLite quick_check 必须通过');
  } catch {
    addCheck(checks, 'database_integrity', false, 'SQLite quick_check 执行失败');
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
    const rows = db.prepare(`SELECT model, credits, status
      FROM model_credit_prices
      WHERE status = 'enabled' AND credits > 0`).all();
    const configured = new Set(rows.map((row) => String(row.model).toLowerCase()));
    const missing = SUPPORTED_MODELS.filter(
      (model) => !configured.has(model.toLowerCase()),
    );
    addCheck(
      checks,
      'model_prices',
      missing.length === 0,
      missing.length === 0
        ? '必需模型均已启用并配置正整数积分价格'
        : `缺少模型价格：${missing.join('、')}`,
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
  runRedrawLocaleVerifierPreflight,
  runProductionPreflight,
};
