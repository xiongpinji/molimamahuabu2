'use strict';

const Database = require('better-sqlite3');

const TARGETS = Object.freeze({
  4: { serviceType: 'storyboard_image', provider: 'aihubcc', models: ['gpt-image-2'] },
  11: { serviceType: 'image', provider: 'token6688', models: ['token6688-gpt-image-2', 'gemini-3-pro-image'] },
  21: { serviceType: 'image', provider: 'fumin_image', models: ['fumin-gpt-image-2', 'fumin-gpt-image-2-4K'] },
  24: { serviceType: 'image', provider: 'aihubcc', models: ['gpt-image-2'] },
  25: { serviceType: 'image', provider: 'fumin_image', models: ['fumin-gpt-image-2'] },
  26: { serviceType: 'image', provider: 'token6688', models: ['token6688-gpt-image-2'] },
});

const AIHUB_CAPABILITY = Object.freeze({
  supportsTextToImage: true,
  supportsImageReference: true,
  maxReferences: 20,
  maxImageReferences: 20,
  resolutions: ['1K', '2K'],
  aspectRatios: ['16:9', '9:16', '1:1'],
  quantities: [1],
});
const FUMIN_BASE_CAPABILITY = Object.freeze({
  supportsTextToImage: true,
  supportsImageReference: false,
  supportsReferenceImages: false,
  maxReferences: 0,
  maxImageReferences: 0,
  aspectRatios: ['16:9', '9:16', '1:1'],
  quantities: [1],
});
const TOKEN_CAPABILITIES = Object.freeze({
  'token6688-gpt-image-2': {
    supportsTextToImage: true,
    supportsImageReference: true,
    maxReferences: 9,
    maxImageReferences: 9,
    resolutions: ['1K', '2K', '4K'],
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    quantities: [1],
  },
  'gemini-3-pro-image': {
    supportsTextToImage: true,
    supportsImageReference: true,
    maxReferences: 3,
    maxImageReferences: 3,
    resolutions: ['1K', '2K', '4K'],
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    quantities: [1],
  },
});

function failure(message, details = {}) {
  const error = new Error(message);
  error.code = 'IMAGE_CAPABILITY_PRECONDITION_FAILED';
  error.details = details;
  return error;
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw failure('图片模型能力配置不是有效 JSON');
  }
}

function parseModels(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String).filter(Boolean);
  } catch {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function sameModels(actual, expected) {
  const normalize = (models) => models.map((item) => item.toLowerCase()).sort();
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

function desiredValues(row) {
  const settings = parseObject(row.settings);
  const verified = parseObject(row.verified_capabilities);
  if (row.provider === 'aihubcc') {
    settings.canvas_capabilities = { ...AIHUB_CAPABILITY };
    verified['gpt-image-2'] = {
      supportsTextToImage: true,
      supportsImageReference: true,
      maxReferences: 20,
      maxImageReferences: 20,
      reference_count_verified: 20,
      artifact_sha256: 'ae67a00663700a2db076067526afca2db6a5af0347b985cb9bd0b9241abb6cf0',
    };
  } else if (row.provider === 'fumin_image') {
    settings.canvas_capabilities = { ...FUMIN_BASE_CAPABILITY };
    settings.canvas_capabilities_by_model = {
      ...(settings.canvas_capabilities_by_model || {}),
      'fumin-gpt-image-2': { resolutions: ['2K'] },
      'fumin-gpt-image-2-4K': { resolutions: ['4K'] },
    };
    delete verified.maxReferences;
    delete verified.supportsReferenceImages;
    delete verified.supportsImageReference;
    for (const model of parseModels(row.model)) {
      verified[model] = {
        supportsTextToImage: true,
        supportsImageReference: false,
        maxReferences: 0,
        maxImageReferences: 0,
      };
    }
  } else {
    settings.canvas_capabilities_by_model = {
      ...(settings.canvas_capabilities_by_model || {}),
      ...Object.fromEntries(parseModels(row.model).map((model) => [model, TOKEN_CAPABILITIES[model]])),
    };
  }
  return {
    settings: JSON.stringify(settings),
    verifiedCapabilities: JSON.stringify(verified),
  };
}

function inspectImageModelCapabilities(db) {
  const rows = db.prepare(`SELECT id, service_type, provider, model, is_active,
      verification_status, settings, verified_capabilities
    FROM ai_service_configs
    WHERE id IN (4, 11, 21, 24, 25, 26) AND deleted_at IS NULL
    ORDER BY id`).all();
  if (rows.length !== Object.keys(TARGETS).length) {
    throw failure('图片模型能力目标数量发生漂移', { target_count: rows.length });
  }
  return rows.map((row) => {
    const expected = TARGETS[row.id];
    const models = parseModels(row.model);
    if (!expected
        || row.service_type !== expected.serviceType
        || row.provider !== expected.provider
        || row.is_active !== 1
        || row.verification_status !== 'verified'
        || !sameModels(models, expected.models)) {
      throw failure('图片模型能力目标旧值发生漂移', { config_id: row.id });
    }
    const desired = desiredValues(row);
    return {
      id: row.id,
      provider: row.provider,
      models,
      needs_update: row.settings !== desired.settings
        || row.verified_capabilities !== desired.verifiedCapabilities,
      desired,
    };
  });
}

function syncImageModelCapabilities(db, now = new Date().toISOString()) {
  return db.transaction(() => {
    const targets = inspectImageModelCapabilities(db);
    let changes = 0;
    const update = db.prepare(`UPDATE ai_service_configs
      SET settings = ?, verified_capabilities = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL AND is_active = 1 AND verification_status = 'verified'`);
    for (const target of targets) {
      if (!target.needs_update) continue;
      const result = update.run(target.desired.settings, target.desired.verifiedCapabilities, now, target.id);
      if (result.changes !== 1) throw failure('图片模型能力更新行数发生漂移', { config_id: target.id });
      changes += 1;
    }
    return { changes, config_ids: targets.map(({ id }) => id) };
  })();
}

function parseArguments(argv) {
  let databasePath = '';
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--database') {
      const value = argv[index + 1];
      if (databasePath || !value || value.startsWith('--')) throw failure('参数不完整或重复');
      databasePath = value;
      index += 1;
    } else if (argument === '--apply') {
      if (apply) throw failure('参数不完整或重复');
      apply = true;
    } else {
      throw failure('参数不完整或重复');
    }
  }
  if (!databasePath) throw failure('参数不完整或重复');
  return { databasePath, apply };
}

function executeCli(argv) {
  const { databasePath, apply } = parseArguments(argv);
  const db = new Database(databasePath, { readonly: !apply, fileMustExist: true });
  try {
    if (!apply) {
      const targets = inspectImageModelCapabilities(db);
      return {
        ok: true,
        dry_run: true,
        targets: targets.map(({ id, models, needs_update }) => ({ id, models, needs_update })),
      };
    }
    return { ok: true, dry_run: false, ...syncImageModelCapabilities(db) };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(executeCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: error.code || 'IMAGE_CAPABILITY_SYNC_FAILED',
        message: error.message,
        details: error.details || {},
      },
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { inspectImageModelCapabilities, syncImageModelCapabilities };
