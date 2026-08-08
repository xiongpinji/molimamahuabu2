const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const modelPrices = require('../src/services/modelPriceService');
const { runProductionPreflight } = require('../src/services/productionPreflightService');
const packageJson = require('../package.json');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE platform_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active'
  )`);
  db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt, role, status)
    VALUES (?, ?, ?, ?, 'admin', 'active')`)
    .run('admin-1', 'admin@example.com', 'hash', 'salt');
  modelPrices.set(db, 'GPT-5.5', 2, { category: 'text' });
  modelPrices.set(db, 'gpt-image-2', 8, { category: 'image' });
  modelPrices.set(db, 'seedance 2.0', 25, { category: 'video' });
  return db;
}

function productionConfig() {
  return {
    app: { name: '茉莉妈妈短剧制作平台 API', debug: false },
    server: {
      insecure_tls: false,
      cors_origins: ['https://studio.example.com'],
    },
    database: { type: 'sqlite', path: './data/production.sqlite' },
    storage: {
      type: 'local',
      local_path: './data/storage',
      base_url: 'https://api.example.com/static',
    },
  };
}

function productionEnv() {
  return {
    PUBLIC_PLATFORM_MODE: 'true',
    PLATFORM_REGISTRATION_ENABLED: 'false',
    PLATFORM_EMAIL_VERIFICATION_ENABLED: 'true',
    PLATFORM_JWT_SECRET: 'j'.repeat(40),
    PLATFORM_ADMIN_TOKEN: 'a'.repeat(40),
    PLATFORM_BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USER: 'mailer@example.com',
    SMTP_PASSWORD: 'smtp-app-password',
    SMTP_FROM: '茉莉妈妈 <mailer@example.com>',
  };
}

test('安全生产配置、管理员和模型价格齐全时预检通过且不泄露密钥', () => {
  const db = createDb();
  try {
    const env = productionEnv();
    const report = runProductionPreflight({
      config: productionConfig(),
      env,
      db,
    });

    assert.equal(report.ready, true);
    assert.equal(report.checks.every((check) => check.status === 'pass'), true);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(env.PLATFORM_JWT_SECRET), false);
    assert.equal(serialized.includes(env.PLATFORM_ADMIN_TOKEN), false);
  } finally {
    db.close();
  }
});

test('开发配置和缺失生产环境变量时预检失败并列出阻塞项', () => {
  const db = createDb();
  try {
    const report = runProductionPreflight({
      config: {
        ...productionConfig(),
        app: { name: 'LocalMiniDrama API', debug: true },
        server: {
          insecure_tls: true,
          cors_origins: ['http://localhost:3012'],
        },
        storage: {
          type: 'local',
          local_path: './data/storage',
          base_url: 'http://localhost:5679/static',
        },
      },
      env: {},
      db,
    });

    assert.equal(report.ready, false);
    const failed = new Set(
      report.checks.filter((check) => check.status === 'fail').map((check) => check.id),
    );
    assert.equal(failed.has('public_platform_mode'), true);
    assert.equal(failed.has('secrets'), true);
    assert.equal(failed.has('debug_mode'), true);
    assert.equal(failed.has('tls_verification'), true);
    assert.equal(failed.has('cors_origins'), true);
    assert.equal(failed.has('storage_public_url'), true);
  } finally {
    db.close();
  }
});

test('缺少活跃管理员或模型价格时预检阻止发布', () => {
  const db = createDb();
  try {
    db.prepare("UPDATE platform_users SET status = 'disabled' WHERE role = 'admin'").run();
    db.prepare("DELETE FROM model_credit_prices WHERE model = 'seedance 2.0'").run();

    const report = runProductionPreflight({
      config: productionConfig(),
      env: productionEnv(),
      db,
    });

    assert.equal(report.ready, false);
    assert.equal(
      report.checks.find((check) => check.id === 'active_admin')?.status,
      'fail',
    );
    assert.equal(
      report.checks.find((check) => check.id === 'model_prices')?.status,
      'fail',
    );
  } finally {
    db.close();
  }
});

test('即使使用 HTTPS 也拒绝 localhost 作为生产 CORS 和素材地址', () => {
  const db = createDb();
  try {
    const config = productionConfig();
    config.server.cors_origins = ['https://localhost:3012'];
    config.storage.base_url = 'https://localhost:5679/static';

    const report = runProductionPreflight({
      config,
      env: productionEnv(),
      db,
    });

    assert.equal(report.ready, false);
    assert.equal(
      report.checks.find((check) => check.id === 'cors_origins')?.status,
      'fail',
    );
    assert.equal(
      report.checks.find((check) => check.id === 'storage_public_url')?.status,
      'fail',
    );
  } finally {
    db.close();
  }
});

test('开放注册时必须同时启用邮箱验证并完整配置 SMTP', () => {
  const db = createDb();
  try {
    const missingMail = productionEnv();
    missingMail.PLATFORM_REGISTRATION_ENABLED = 'true';
    missingMail.PLATFORM_EMAIL_VERIFICATION_ENABLED = 'false';
    const blocked = runProductionPreflight({
      config: productionConfig(),
      env: missingMail,
      db,
    });
    assert.equal(
      blocked.checks.find((check) => check.id === 'registration_email_verification')?.status,
      'fail',
    );

    const readyMail = {
      ...missingMail,
      PLATFORM_EMAIL_VERIFICATION_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'mailer@example.com',
      SMTP_PASSWORD: 'smtp-app-password',
      SMTP_FROM: '茉莉妈妈 <mailer@example.com>',
    };
    const ready = runProductionPreflight({
      config: productionConfig(),
      env: readyMail,
      db,
    });
    assert.equal(
      ready.checks.find((check) => check.id === 'registration_email_verification')?.status,
      'pass',
    );
  } finally {
    db.close();
  }
});

test('关闭新用户注册时仍要求邮箱服务可用于已有用户找回密码', () => {
  const db = createDb();
  try {
    const env = productionEnv();
    delete env.SMTP_PASSWORD;

    const report = runProductionPreflight({
      config: productionConfig(),
      env,
      db,
    });

    assert.equal(
      report.checks.find((check) => check.id === 'registration_email_verification')?.status,
      'fail',
    );
  } finally {
    db.close();
  }
});

test('语言验证预检默认关闭时通过，启用后必须阻止过期 ready 且不泄露路径', () => {
  const db = createDb();
  try {
    const disabledEnv = productionEnv();
    disabledEnv.REDRAW_LOCALE_VERIFIER_ENABLED = 'false';
    const disabled = runProductionPreflight({
      config: productionConfig(),
      env: disabledEnv,
      db,
    });
    const disabledCheck = disabled.checks.find((check) => check.id === 'redraw_locale_verifier');
    assert.equal(disabledCheck?.status, 'pass');
    assert.match(disabledCheck?.message || '', /disabled|关闭/);

    const sensitiveManifestPath = 'C:\\secure\\enabled-packs.json';
    const enabledEnv = {
      ...productionEnv(),
      REDRAW_LOCALE_VERIFIER_ENABLED: 'true',
      REDRAW_LOCALE_PACK_REGISTRY_PATH: sensitiveManifestPath,
      REDRAW_LOCALE_PACK_SIGNATURE_PATH: 'C:\\secure\\enabled-packs.sig',
      REDRAW_LOCALE_PACK_PUBLIC_KEY_PATH: 'C:\\secure\\ed25519-public.pem',
      REDRAW_LOCALE_VERIFIER_READY_PATH: 'C:\\secure\\ready.json',
      REDRAW_LOCALE_VERIFIER_SOCKET: 'C:\\secure\\redraw-locale.sock',
      REDRAW_LOCALE_VERIFIER_TIMEOUT_MS: '180000',
    };
    const stale = runProductionPreflight({
      config: productionConfig(),
      env: enabledEnv,
      db,
      localeRegistry: {
        assertReady(locale) {
          assert.equal(locale, 'en-US');
          const error = new Error(`${sensitiveManifestPath} expired`);
          error.code = 'REDRAW_LOCALE_VERIFIER_NOT_READY';
          throw error;
        },
      },
    });
    const staleCheck = stale.checks.find((check) => check.id === 'redraw_locale_verifier');
    assert.equal(staleCheck?.status, 'fail');
    assert.match(staleCheck?.message || '', /REDRAW_LOCALE_VERIFIER_NOT_READY/);
    assert.equal(JSON.stringify(stale).includes(sensitiveManifestPath), false);
  } finally {
    db.close();
  }
});

test('package exposes a read-only redraw locale preflight command', () => {
  assert.equal(
    packageJson.scripts['preflight:redraw-locale'],
    'node scripts/preproduction-check.js --redraw-locale',
  );
});
