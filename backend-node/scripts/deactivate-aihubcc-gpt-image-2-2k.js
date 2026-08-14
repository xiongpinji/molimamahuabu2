'use strict';

const Database = require('better-sqlite3');

const TARGET_CONFIG_ID = 2;
const TARGET_MODEL = 'gpt-image-2-2k';
const TARGET_HOSTNAME = 'aihubcc.cc';

function deactivationError(message, details = {}) {
  const error = new Error(message);
  error.code = 'DEACTIVATION_PRECONDITION_FAILED';
  error.details = details;
  return error;
}

function argumentError() {
  const error = new Error('参数不完整或重复');
  error.code = 'INVALID_ARGUMENTS';
  return error;
}

function parseModels(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  } catch {
    return [String(value || '').trim()].filter(Boolean);
  }
}

function safeHostname(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function inspectAihubccGptImage2k(db) {
  const config = db.prepare(`SELECT id, service_type, base_url, model,
      is_active, is_default, verification_status
    FROM ai_service_configs
    WHERE id = ? AND deleted_at IS NULL`).get(TARGET_CONFIG_ID);
  const price = db.prepare(`SELECT model, status
    FROM model_credit_prices
    WHERE model = ? COLLATE NOCASE`).get(TARGET_MODEL);
  const hostname = safeHostname(config?.base_url);
  const ready = Boolean(config)
    && config.service_type === 'image'
    && hostname === TARGET_HOSTNAME
    && parseModels(config.model).includes(TARGET_MODEL)
    && config.is_active === 1
    && config.is_default === 1
    && config.verification_status === 'verified'
    && price?.status === 'enabled';
  if (!ready) {
    throw deactivationError('目标配置或价格旧值不符合下架前置条件', {
      config_id: config?.id || null,
      model: price?.model || TARGET_MODEL,
      hostname,
    });
  }
  return {
    config_id: config.id,
    model: price.model,
    hostname,
  };
}

function deactivateAihubccGptImage2k(db, now = new Date().toISOString()) {
  return db.transaction(() => {
    const target = inspectAihubccGptImage2k(db);
    const configUpdate = db.prepare(`UPDATE ai_service_configs
      SET is_active = 0,
          is_default = 0,
          verification_status = 'failed',
          updated_at = ?
      WHERE id = ?
        AND deleted_at IS NULL
        AND service_type = 'image'
        AND is_active = 1
        AND is_default = 1
        AND verification_status = 'verified'`).run(now, TARGET_CONFIG_ID);
    const priceUpdate = db.prepare(`UPDATE model_credit_prices
      SET status = 'disabled', updated_at = ?
      WHERE model = ? COLLATE NOCASE AND status = 'enabled'`).run(now, TARGET_MODEL);
    if (configUpdate.changes !== 1 || priceUpdate.changes !== 1) {
      throw deactivationError('目标行数发生漂移，已回滚', {
        config_changes: configUpdate.changes,
        price_changes: priceUpdate.changes,
      });
    }
    return {
      ...target,
      config_changes: 1,
      price_changes: 1,
    };
  })();
}

function parseArguments(argv) {
  let databasePath = null;
  let apply = false;
  let sawDatabase = false;
  let sawApply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--database') {
      const value = argv[index + 1];
      if (sawDatabase || !value || value.startsWith('--')) throw argumentError();
      sawDatabase = true;
      databasePath = value;
      index += 1;
    } else if (argument === '--apply') {
      if (sawApply) throw argumentError();
      sawApply = true;
      apply = true;
    } else {
      throw argumentError();
    }
  }
  if (!databasePath) throw argumentError();
  return { databasePath, apply };
}

function executeCli(argv) {
  const { databasePath, apply } = parseArguments(argv);
  let db;
  try {
    db = new Database(databasePath, {
      readonly: !apply,
      fileMustExist: true,
    });
  } catch {
    const error = new Error('数据库不可读取');
    error.code = 'DATABASE_UNAVAILABLE';
    throw error;
  }
  try {
    const result = apply
      ? deactivateAihubccGptImage2k(db)
      : inspectAihubccGptImage2k(db);
    return {
      ok: true,
      dry_run: !apply,
      ...result,
    };
  } finally {
    db.close();
  }
}

function safeCliFailure(error) {
  const knownCode = [
    'INVALID_ARGUMENTS',
    'DATABASE_UNAVAILABLE',
    'DEACTIVATION_PRECONDITION_FAILED',
  ].includes(error?.code) ? error.code : 'DEACTIVATION_FAILED';
  const message = knownCode === 'INVALID_ARGUMENTS'
    ? '参数不完整或重复'
    : knownCode === 'DATABASE_UNAVAILABLE'
      ? '数据库不可读取'
      : knownCode === 'DEACTIVATION_PRECONDITION_FAILED'
        ? error.message
        : '下架检查失败';
  return {
    ok: false,
    error: {
      code: knownCode,
      message,
      ...(knownCode === 'DEACTIVATION_PRECONDITION_FAILED'
        ? { details: error.details || {} }
        : {}),
    },
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(executeCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(safeCliFailure(error))}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  inspectAihubccGptImage2k,
  deactivateAihubccGptImage2k,
};
