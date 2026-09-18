'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONFIRM_CANARY = 'RUN_NATIVE_DIALOGUE_CANARY';
const CONFIRM_PROMOTE = 'PROMOTE_NATIVE_DIALOGUE_EVIDENCE';
const SHA256 = /^[a-f0-9]{64}$/;

function parseArgs(argv = process.argv.slice(2)) {
  const out = { flags: new Set(), values: {} };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) out.flags.add(arg.slice(2));
    else out.values[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function redactEvidence(value) {
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api[_-]?key|token|secret|authorization/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof item === 'string' && (/sk-|Bearer\s/i.test(item) || item.length > 200)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = redactEvidence(item);
  }
  return out;
}

function assertNativeEvidenceShape(evidence = {}) {
  const errors = [];
  const contract = String(evidence.contract || evidence.schema || '');
  if (!contract.includes('native')) errors.push('contract');
  if (!SHA256.test(String(evidence.artifact_sha256 || '').toLowerCase())) errors.push('artifact_sha256');
  if (!SHA256.test(String(evidence.validation_hash || evidence.evidence_hash || '').toLowerCase())) {
    errors.push('validation_hash');
  }
  const human = evidence.human_review || {};
  const humanStatus = String(human.status || '');
  // Promote/preflight historically used "approved"; capability gate used "passed".
  // Accept both so a single human-review document can pass both validators.
  if (!['approved', 'passed'].includes(humanStatus)) errors.push('human_review.status');
  if (humanStatus === 'passed') {
    for (const key of ['speaker_order', 'lip_sync', 'extra_dialogue']) {
      if (String(human[key] || '') !== 'passed') errors.push(`human_review.${key}`);
    }
  }
  const verification = evidence.verification || {};
  if (verification.language_verified !== true) errors.push('language_verified');
  const config = evidence.config || evidence.invocation || {};
  if (!Number.isSafeInteger(Number(config.ai_service_config_id || config.aiServiceConfigId))) {
    errors.push('ai_service_config_id');
  }
  if (!String(config.model || evidence.model || '').trim()) errors.push('model');
  if (!String(config.provider || evidence.provider || '').trim()) errors.push('provider');
  return errors;
}

function dryRunCanary(options = {}) {
  const sideEffects = {
    fetchCalls: 0,
    providerSubmissions: 0,
    dbWriteCalls: 0,
    outputFiles: [],
  };
  const confirm = String(options.confirm || '');
  if (confirm !== CONFIRM_CANARY) {
    return {
      mode: 'dry-run',
      ready: false,
      reason: 'missing_confirm',
      required_confirm: CONFIRM_CANARY,
      sideEffects,
      plan: {
        provider: 'toapis',
        model: options.model || 'seedance-2-fast',
        generate_audio: true,
        locale_pack: options.packId || 'es@1',
        max_submits: 1,
      },
    };
  }
  return {
    mode: 'armed',
    ready: true,
    sideEffects,
    plan: {
      provider: 'toapis',
      model: options.model || 'seedance-2-fast',
      generate_audio: true,
      locale_pack: options.packId || 'es@1',
      max_submits: 1,
      note: 'armed but caller must supply isolated storage/db and execute submit separately',
    },
  };
}

function dryRunPromote(options = {}) {
  const evidencePath = options.evidencePath;
  const sideEffects = { dbWriteCalls: 0, filesWritten: [] };
  if (!evidencePath) {
    return {
      mode: 'dry-run',
      ready: false,
      reason: 'missing_evidence_path',
      sideEffects,
    };
  }
  const absolute = path.resolve(evidencePath);
  const evidence = readJson(absolute);
  const fileHash = sha256File(absolute);
  const shapeErrors = assertNativeEvidenceShape(evidence);
  const confirm = String(options.confirm || '');
  const commit = options.commit === true || options.commit === '1';
  if (!commit || confirm !== CONFIRM_PROMOTE || shapeErrors.length) {
    return {
      mode: 'dry-run',
      ready: shapeErrors.length === 0,
      reason: shapeErrors.length
        ? 'evidence_invalid'
        : (!commit ? 'missing_commit' : 'missing_confirm'),
      required_confirm: CONFIRM_PROMOTE,
      evidence_sha256: fileHash,
      shape_errors: shapeErrors,
      redacted: redactEvidence(evidence),
      sideEffects,
    };
  }
  return {
    mode: 'armed',
    ready: true,
    evidence_sha256: fileHash,
    redacted: redactEvidence(evidence),
    sideEffects,
    note: 'armed; call commitPromoteLocaleCapabilities(db, ...) to write settings.redraw_locale_capabilities',
  };
}

/**
 * Write only settings.redraw_locale_capabilities for one AI config row.
 * Requires prior dryRunPromote ready/armed gatekeeping by the caller.
 */
function commitPromoteLocaleCapabilities(db, options = {}) {
  const configId = Number(options.configId || options.aiServiceConfigId);
  const evidence = options.evidence;
  const backupDir = options.backupDir || path.resolve(process.cwd(), 'data/promote-backups');
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('db required');
  }
  if (!Number.isSafeInteger(configId) || configId <= 0) {
    throw new Error('configId required');
  }
  if (!evidence || typeof evidence !== 'object') {
    throw new Error('evidence object required');
  }
  const shapeErrors = assertNativeEvidenceShape(evidence);
  if (shapeErrors.length) {
    throw new Error(`evidence_invalid: ${shapeErrors.join(',')}`);
  }

  const row = db.prepare(`
    SELECT id, settings FROM ai_service_configs
    WHERE id = ? AND deleted_at IS NULL
  `).get(configId);
  if (!row) throw new Error(`config ${configId} not found`);

  let settings = {};
  try {
    settings = row.settings ? JSON.parse(row.settings) : {};
  } catch (_) {
    settings = {};
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};

  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `ai-config-${configId}-settings-${Date.now()}.json`,
  );
  fs.writeFileSync(backupPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

  const packId = String(options.packId || evidence.locale_pack || evidence.pack_id || 'es@1');
  const language = String(options.language || evidence.verification?.language || 'es');
  const nextEntries = Array.isArray(settings.redraw_locale_capabilities)
    ? [...settings.redraw_locale_capabilities]
    : [];
  const entry = {
    pack_id: packId,
    language,
    locale: language,
    market: '',
    target_locale: null,
    native_dialogue_audio: true,
    video_evidence: evidence,
  };
  const idx = nextEntries.findIndex((item) => String(item?.pack_id || '') === packId);
  if (idx >= 0) nextEntries[idx] = { ...nextEntries[idx], ...entry };
  else nextEntries.push(entry);
  settings.redraw_locale_capabilities = nextEntries;

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE ai_service_configs
      SET settings = ?, updated_at = datetime('now')
      WHERE id = ? AND deleted_at IS NULL
    `).run(JSON.stringify(settings), configId);
  });
  tx();

  return {
    ok: true,
    config_id: configId,
    pack_id: packId,
    backup_path: backupPath,
    entry_count: nextEntries.length,
  };
}

module.exports = {
  CONFIRM_CANARY,
  CONFIRM_PROMOTE,
  parseArgs,
  sha256File,
  redactEvidence,
  assertNativeEvidenceShape,
  dryRunCanary,
  dryRunPromote,
  commitPromoteLocaleCapabilities,
};
