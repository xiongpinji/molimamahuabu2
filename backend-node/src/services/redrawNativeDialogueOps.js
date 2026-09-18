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
  if (String(human.status || '') !== 'approved') errors.push('human_review.status');
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
    note: 'armed; caller must open a DB transaction and write only settings.redraw_locale_capabilities',
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
};
