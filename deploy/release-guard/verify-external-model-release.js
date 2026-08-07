#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_CONTRACT = 'external-model-release-evidence-manifest-v1';
const PROVIDERS = Object.freeze({
  toapis: Object.freeze({
    label: 'ToAPIs',
    contract: 'toapis-video-real-verification-v1',
    evidenceFile: 'toapis-video-verification.json',
    clientFile: 'backend-node/src/services/toapisVideoClient.js',
    markers: /\btoapis_video\b|\bseedance-2-(?:fast|mini)\b/,
    surfaceFiles: Object.freeze([
      'backend-node/src/routes/aiConfig.js',
      'backend-node/src/services/aiConfigService.js',
      'backend-node/src/services/canvasModelCatalogService.js',
      'backend-node/src/services/modelPriceService.js',
      'backend-node/src/services/videoClient.js',
      'backend-node/src/services/videoService.js',
      'frontweb/src/components/AIConfigContent.vue',
      'frontweb/src/utils/homeQuickGeneration.js',
      'frontweb/src/utils/canvasModelCapabilities.js',
      'frontweb/src/views/FilmCreate.vue',
      'frontweb/src/views/FilmList.vue',
      'frontweb/src/views/FreeCreate.vue',
    ]),
  }),
  usmercari: Object.freeze({
    label: 'USMercari image',
    contract: 'usmercari-image-real-verification-v1',
    evidenceFile: 'usmercari-image-verification.json',
    clientFile: 'backend-node/src/services/usmercariImageClient.js',
    markers: /\busmercari_image\b|\bgpt-image-2-2-4k\b/,
    surfaceFiles: Object.freeze([
      'backend-node/src/routes/aiConfig.js',
      'backend-node/src/services/aiConfigService.js',
      'backend-node/src/services/canvasModelCatalogService.js',
      'backend-node/src/services/modelPriceService.js',
      'backend-node/src/services/imageClient.js',
      'backend-node/src/services/imageService.js',
      'backend-node/src/services/propImageGenerationService.js',
      'backend-node/src/services/usmercariVideoClient.js',
      'frontweb/src/components/AIConfigContent.vue',
      'frontweb/src/utils/homeQuickGeneration.js',
      'frontweb/src/utils/canvasModelCapabilities.js',
      'frontweb/src/views/BillingAdmin.vue',
      'frontweb/src/views/FilmCreate.vue',
    ]),
  }),
});

const TOAPIS_CASES = Object.freeze([
  Object.freeze({ id: 'fast-t2v-480', model: 'seedance-2-fast', mode: 't2v', resolution: '480p', duration: 5, audio: true }),
  Object.freeze({ id: 'fast-t2v-720', model: 'seedance-2-fast', mode: 't2v', resolution: '720p', duration: 5, audio: false }),
  Object.freeze({ id: 'mini-t2v-480', model: 'seedance-2-mini', mode: 't2v', resolution: '480p', duration: 4, audio: true }),
  Object.freeze({ id: 'mini-t2v-720', model: 'seedance-2-mini', mode: 't2v', resolution: '720p', duration: 4, audio: false }),
  Object.freeze({ id: 'fast-first-last-480', model: 'seedance-2-fast', mode: 'first-last', resolution: '480p', duration: 4, audio: false }),
  Object.freeze({ id: 'mini-first-last-480', model: 'seedance-2-mini', mode: 'first-last', resolution: '480p', duration: 4, audio: false }),
  Object.freeze({ id: 'fast-omni-480', model: 'seedance-2-fast', mode: 'omni', resolution: '480p', duration: 4, audio: false }),
  Object.freeze({ id: 'mini-omni-480', model: 'seedance-2-mini', mode: 'omni', resolution: '480p', duration: 4, audio: false }),
]);

const TOAPIS_PRICE_FLOORS = Object.freeze({
  'seedance-2-fast|480p': 0.584,
  'seedance-2-fast|720p': 0.584,
  'seedance-2-mini|480p': 0.3358,
  'seedance-2-mini|720p': 0.6789,
});

const USMERCARI_CASES = Object.freeze([
  Object.freeze({ model: 'gpt-image-2-2-4k', capability: 'text-to-image', resolution: '1k' }),
  Object.freeze({ model: 'gpt-image-2-2-4k', capability: 'text-to-image', resolution: '2k' }),
  Object.freeze({ model: 'gpt-image-2-2-4k', capability: 'image-to-image', resolution: '1k' }),
  Object.freeze({ model: 'nano-banana-2', capability: 'text-to-image', resolution: '1k' }),
  Object.freeze({ model: 'nano-banana-2', capability: 'text-to-image', resolution: '2k' }),
  Object.freeze({ model: 'nano-banana-2', capability: 'text-to-image', resolution: '4k' }),
  Object.freeze({ model: 'nano-banana-2', capability: 'image-to-image', resolution: '1k' }),
]);

const USMERCARI_PRICES = Object.freeze({
  'gpt-image-2-2-4k|1k': Object.freeze([0.08, 70]),
  'gpt-image-2-2-4k|2k': Object.freeze([0.10, 87]),
  'nano-banana-2|1k': Object.freeze([0.08, 70]),
  'nano-banana-2|2k': Object.freeze([0.10, 87]),
  'nano-banana-2|4k': Object.freeze([0.12, 105]),
});

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizedPath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function requireRootOwned(stat, label) {
  if (process.platform === 'win32') return;
  if (stat.uid !== 0 || stat.gid !== 0) fail(`${label} must be root:root owned`);
  if ((stat.mode & 0o022) !== 0) fail(`${label} must not be group/other writable`);
}

function secureDirectory(input, label, rootOwned = false) {
  if (!input || !path.isAbsolute(input)) fail(`${label} must be an absolute directory`);
  const resolved = path.resolve(input);
  const lstat = lstatOrNull(resolved);
  if (!lstat) fail(`${label} is missing or is not a directory`);
  if (lstat.isSymbolicLink()) fail(`${label} symlink is forbidden`);
  if (!lstat.isDirectory()) fail(`${label} is missing or is not a directory`);
  const real = fs.realpathSync.native(resolved);
  if (!samePath(real, resolved)) fail(`${label} realpath differs from the supplied path`);
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) fail(`${label} is not a directory`);
  if (rootOwned) requireRootOwned(stat, label);
  return real;
}

function secureFile(root, relative, label, options = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) fail(`${label} path is invalid`);
  if (options.basenameOnly && path.basename(relative) !== relative) fail(`${label} output_file must be a safe basename`);
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) fail(`${label} path escapes EVIDENCE_ROOT`);
  const lstat = lstatOrNull(target);
  if (!lstat) fail(`${label} is missing or is not a regular file`);
  if (lstat.isSymbolicLink()) fail(`${label} symlink is forbidden`);
  if (!lstat.isFile()) fail(`${label} is missing or is not a regular file`);
  const real = fs.realpathSync.native(target);
  if (!samePath(real, target) || !isInside(root, real)) fail(`${label} realpath escapes its trusted root`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) fail(`${label} is not a regular file`);
  if (options.rootOwned) requireRootOwned(stat, label);
  return { path: real, stat };
}

function candidateSource(candidate, relative, required = true) {
  const target = path.resolve(candidate, relative);
  if (!isInside(candidate, target)) fail(`candidate runtime path escapes CANDIDATE: ${relative}`);
  const lstat = lstatOrNull(target);
  if (!lstat) {
    if (required) fail(`candidate runtime gate is missing: ${relative}`);
    return '';
  }
  if (lstat.isSymbolicLink()) fail(`candidate runtime symlink is forbidden: ${relative}`);
  if (!lstat.isFile()) fail(`candidate runtime is not a regular file: ${relative}`);
  const real = fs.realpathSync.native(target);
  if (!samePath(real, target) || !isInside(candidate, real)) fail(`candidate runtime realpath escapes CANDIDATE: ${relative}`);
  return fs.readFileSync(real, 'utf8');
}

function stripComments(source) {
  const withoutHtml = String(source || '').replace(/<!--[\s\S]*?-->/g, (value) => '\n'.repeat((value.match(/\n/g) || []).length));
  let output = '';
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = 0; index < withoutHtml.length; index += 1) {
    const current = withoutHtml[index];
    const next = withoutHtml[index + 1];
    if (lineComment) {
      if (current === '\n') { lineComment = false; output += '\n'; } else output += ' ';
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') { output += '  '; blockComment = false; index += 1; }
      else output += current === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = '';
      continue;
    }
    if (current === '"' || current === "'" || current === '`') { quote = current; output += current; continue; }
    if (current === '/' && next === '/') { output += '  '; lineComment = true; index += 1; continue; }
    if (current === '/' && next === '*') { output += '  '; blockComment = true; index += 1; continue; }
    output += current;
  }
  return output;
}

function maskStrings(source) {
  let output = '';
  let quote = '';
  let escaped = false;
  for (const value of source) {
    if (quote) {
      output += value === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (value === '\\') escaped = true;
      else if (value === quote) quote = '';
      continue;
    }
    if (value === '"' || value === "'" || value === '`') {
      quote = value;
      output += ' ';
    } else output += value;
  }
  return output;
}

function functionScopes(source) {
  const code = maskStrings(source);
  const scopes = [];
  const declarations = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  for (const match of code.matchAll(declarations)) {
    const opening = match.index + match[0].lastIndexOf('{');
    let depth = 0;
    for (let index = opening; index < code.length; index += 1) {
      if (code[index] === '{') depth += 1;
      if (code[index] !== '}') continue;
      depth -= 1;
      if (depth === 0) {
        scopes.push({
          name: match[1],
          source: source.slice(opening + 1, index),
          code: code.slice(opening + 1, index),
        });
        break;
      }
    }
  }
  return scopes;
}

function firstIndex(source, patterns) {
  let result = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match && (result < 0 || match.index < result)) result = match.index;
  }
  return result;
}

function sideEffectIndex(scope, table) {
  const codeAt = firstIndex(scope.code, [
    /\btaskService\s*\.\s*(?:createTask|updateTask\w*)\s*\(/i,
    /\bcreditLedger\s*\.\s*(?:reserve|charge)\s*\(/i,
    /\breserveCredits\s*\(/i,
    /\b(?:imageClient|videoClient|toapisVideoClient|usmercariImageClient)\s*\.\s*call\w*Api\s*\(/i,
  ]);
  const sqlAt = firstIndex(scope.source, [
    new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+${table}\\b`, 'i'),
  ]);
  if (codeAt < 0) return sqlAt;
  if (sqlAt < 0) return codeAt;
  return Math.min(codeAt, sqlAt);
}

function requireCallsBeforeSideEffect(scope, calls, table, label) {
  const sideEffectAt = sideEffectIndex(scope, table);
  if (sideEffectAt < 0) fail(`${label} is not connected to a DB/task/credit/provider side effect`);
  for (const [pattern, name] of calls) {
    const callAt = firstIndex(scope.code, [pattern]);
    if (callAt < 0 || callAt > sideEffectAt) fail(`${label} ${name} gate runs after a DB/task/credit/provider side effect`);
  }
}

function hasSurface(candidate, provider) {
  const clientTarget = path.resolve(candidate, provider.clientFile);
  if (lstatOrNull(clientTarget)) {
    candidateSource(candidate, provider.clientFile);
    return true;
  }
  for (const relative of provider.surfaceFiles) {
    const source = candidateSource(candidate, relative, false);
    if (source && provider.markers.test(stripComments(source))) return true;
  }
  return false;
}

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) fail(message);
}

function balancedBlock(source, start, label) {
  const opening = source.indexOf('{', start);
  if (opening < 0) fail(`${label} model table is malformed`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const value = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (value === '\\') escaped = true;
      else if (value === quote) quote = '';
      continue;
    }
    if (value === '"' || value === "'" || value === '`') { quote = value; continue; }
    if (value === '{') depth += 1;
    if (value === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(opening + 1, index);
    }
  }
  fail(`${label} model table is unbalanced`);
}

function namedBlock(source, name, label) {
  const match = new RegExp(`['"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*:`).exec(source);
  if (!match) fail(`${label} client is missing model ${name}`);
  return balancedBlock(source, match.index + match[0].length, label);
}

function arrayValues(block, property, label) {
  const match = new RegExp(`${property}\\s*:\\s*(?:Object\\.freeze\\s*\\()?\\s*\\[([^\\]]*)\\]`, 'i').exec(block);
  if (!match) fail(`${label} client is missing ${property}`);
  return [...match[1].matchAll(/['"]([^'"]+)['"]|\b(\d+)\b/g)].map((item) => item[1] ?? Number(item[2]));
}

function sameValues(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function auditEvidenceBindingRuntime(candidate, surfaces) {
  const evidenceService = stripComments(candidateSource(candidate, 'backend-node/src/services/externalModelEvidenceService.js'));
  for (const token of [
    MANIFEST_CONTRACT,
    PROVIDERS.toapis.contract,
    PROVIDERS.usmercari.contract,
    'manifest.json',
    'evidence_contract',
    'evidence_sha256',
    'hasTrustedEvidenceBinding',
  ]) requirePattern(evidenceService, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `evidence binding runtime is missing ${token}`);
  if (/EXTERNAL_MODEL_EVIDENCE_(?:ROOT|ALLOWED_ROOT)|evidence[^\n]{0,40}process\.env/i.test(evidenceService)) {
    fail('evidence binding runtime must not accept evidence path environment overrides');
  }
  if (/NODE_TEST_CONTEXT|testEvidenceRoots|configureEvidenceRootsForTest/i.test(evidenceService)) {
    fail('evidence binding runtime must not expose a candidate-controlled test root hook');
  }
  requirePattern(evidenceService, /capabilities\.evidence_contract[\s\S]{0,180}trusted\.contract/, 'evidence binding runtime does not compare evidence_contract');
  requirePattern(evidenceService, /capabilities\.evidence_sha256[\s\S]{0,180}trusted\.sha256/, 'evidence binding runtime does not compare evidence_sha256');

  const catalog = stripComments(candidateSource(candidate, 'backend-node/src/services/canvasModelCatalogService.js'));
  const price = stripComments(candidateSource(candidate, 'backend-node/src/services/modelPriceService.js'));
  for (const [name, source] of [['catalog', catalog], ['model price', price]]) {
    requirePattern(source, /STRICT_VERIFIED_PROTOCOLS/, `${name} runtime gate is missing strict protocols`);
    requirePattern(source, /verification_status\s*(?:===|!==)\s*['"]verified['"]/, `${name} runtime gate is missing verification_status`);
    requirePattern(source, /hasConnectionCredential\s*\(/, `${name} runtime gate is missing credential validation`);
    requirePattern(source, /verified_capabilities/, `${name} runtime gate is missing verified_capabilities`);
    requirePattern(source, /hasTrustedEvidenceBinding\s*\(/, `${name} runtime gate is missing evidence binding`);
    requirePattern(source, /resolution_prices[\s\S]{0,240}credits/, `${name} runtime gate is missing exact resolution credits`);
  }
  if (surfaces.toapis) requirePattern(catalog, /toapis_video/, 'catalog runtime gate is missing ToAPIs strict protocol');
  if (surfaces.usmercari) requirePattern(catalog, /usmercari_image/, 'catalog runtime gate is missing USMercari strict protocol');
}

function auditToapisRuntime(candidate) {
  const client = stripComments(candidateSource(candidate, 'backend-node/src/services/toapisVideoClient.js'));
  const modelTableAt = client.indexOf('TOAPIS_VIDEO_MODELS');
  if (modelTableAt < 0) fail('ToAPIs client model table is missing');
  const table = balancedBlock(client, modelTableAt, 'ToAPIs');
  const modelKeys = [...table.matchAll(/['"](seedance-[^'"]+)['"]\s*:/g)].map((item) => item[1]);
  if (!sameValues(modelKeys, ['seedance-2-fast', 'seedance-2-mini'])) fail('ToAPIs client exposes an unexpected model set');
  const fast = namedBlock(table, 'seedance-2-fast', 'ToAPIs');
  const mini = namedBlock(table, 'seedance-2-mini', 'ToAPIs');
  if (!sameValues(arrayValues(fast, 'resolutions', 'ToAPIs Fast'), ['480p', '720p'])
      || !sameValues(arrayValues(mini, 'resolutions', 'ToAPIs Mini'), ['480p', '720p'])) {
    fail('ToAPIs client resolutions must be exactly 480p and 720p');
  }
  if (!sameValues(arrayValues(fast, 'durations', 'ToAPIs Fast'), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
      || !sameValues(arrayValues(mini, 'durations', 'ToAPIs Mini'), [4, 8, 10, 12, 15])) {
    fail('ToAPIs client duration tables do not match the protected contract');
  }
  requirePattern(client, /hostname\s*!==\s*['"]toapis\.com['"]/, 'ToAPIs client does not lock the official host');
  requirePattern(client, /protocol\s*!==\s*['"]https:['"]/, 'ToAPIs client does not require HTTPS');
  for (const role of ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio']) {
    requirePattern(client, new RegExp(`['"]${role}['"]`), `ToAPIs client is missing role ${role}`);
  }
  requirePattern(client, /\((?:firstFrame|first)\s*\|\|\s*(?:lastFrame|last)\)\s*&&\s*\([^\n]{0,200}(?:images|reference)/, 'ToAPIs client does not enforce frame/reference mutual exclusion');
  requirePattern(client, /(?:lastFrame|last)\s*&&\s*!\s*(?:firstFrame|first)/, 'ToAPIs client allows a last frame without a first frame');

  const dispatcher = stripComments(candidateSource(candidate, 'backend-node/src/services/videoClient.js'));
  const dispatchCondition = /\bif\s*\(\s*(?:protocol|proto)\s*===\s*['"]toapis_video['"]\s*\)\s*\{/.exec(dispatcher);
  if (!dispatchCondition) fail('ToAPIs runtime protocol dispatch is missing');
  const dispatchBlock = balancedBlock(dispatcher, dispatchCondition.index, 'ToAPIs dispatch');
  requirePattern(dispatchBlock, /callToapisVideoApi\s*\(/, 'ToAPIs runtime protocol dispatch is missing');
  const selector = functionScopes(dispatcher).find((scope) => scope.name === 'getDefaultVideoConfig');
  if (!selector) fail('ToAPIs video config selector is missing');
  for (const [pattern, message] of [
    [/verification_status\s*(?:===|!==)\s*['"]verified['"]/, 'ToAPIs video config selector does not require verified status'],
    [/hasConnectionCredential\s*\(/, 'ToAPIs video config selector does not require credentials'],
    [/verified_capabilities/, 'ToAPIs video config selector does not read verified capabilities'],
    [/hasTrustedEvidenceBinding\s*\(\s*preferred(?:Model)?\s*,\s*capabilities(?:\s*,\s*evidenceRoots)?\s*\)/, 'ToAPIs video config selector does not require the exact shared evidence binding'],
  ]) requirePattern(selector.source, pattern, message);

  const service = stripComments(candidateSource(candidate, 'backend-node/src/services/videoService.js'));
  const scopes = functionScopes(service);
  const ready = scopes.find((scope) => scope.name === 'toapisReadyState');
  if (!ready) fail('ToAPIs runtime gate toapisReadyState is missing');
  for (const [pattern, message] of [
    [/verification_status\s*(?:===|!==)\s*['"]verified['"]/, 'ToAPIs runtime gate does not require verified status'],
    [/hasConnectionCredential\s*\(/, 'ToAPIs runtime gate does not require credentials'],
    [/hasTrustedEvidenceBinding\s*\(/, 'ToAPIs runtime gate does not bind shared evidence'],
    [/MODEL_NOT_VERIFIED/, 'ToAPIs runtime gate is not fail closed'],
  ]) requirePattern(ready.source, pattern, message);
  const readyCapabilitySource = /verified_capabilities/.test(ready.source)
    ? ready.source
    : scopes.find((scope) => scope.name === 'verifiedCapabilitiesForModel')?.source || '';
  requirePattern(readyCapabilitySource, /verified_capabilities/, 'ToAPIs runtime gate does not read verified capabilities');
  if (readyCapabilitySource !== ready.source) {
    requirePattern(ready.source, /verifiedCapabilitiesForModel\s*\(/, 'ToAPIs runtime gate does not call the verified capabilities reader');
  }
  if (!scopes.some((scope) => scope.name === 'requireVerifiedToapisReferenceCapabilities')) fail('ToAPIs reference capability gate is missing');
  if (!scopes.some((scope) => scope.name === 'requireToapisResolutionPrice')) fail('ToAPIs resolution price gate is missing');
  const createScope = scopes.find((scope) => [
    /\btoapisReadyState\s*\(/,
    /\brequireVerifiedToapisReferenceCapabilities\s*\(/,
    /\brequireToapisResolutionPrice\s*\(/,
  ].every((pattern) => pattern.test(scope.code)) && sideEffectIndex(scope, 'video_generations') >= 0);
  if (!createScope) fail('ToAPIs runtime gates are not connected to the generation side-effect path');
  requireCallsBeforeSideEffect(createScope, [
    [/\btoapisReadyState\s*\(/, 'verified configuration/evidence'],
    [/\brequireVerifiedToapisReferenceCapabilities\s*\(/, 'reference capability'],
    [/\brequireToapisResolutionPrice\s*\(/, 'resolution price'],
  ], 'video_generations', 'ToAPIs runtime');
}

function auditUsmercariRuntime(candidate) {
  const client = stripComments(candidateSource(candidate, 'backend-node/src/services/usmercariImageClient.js'));
  const modelTableAt = client.indexOf('USMERCARI_IMAGE_MODELS');
  if (modelTableAt < 0) fail('USMercari image client model table is missing');
  const table = balancedBlock(client, modelTableAt, 'USMercari image');
  const modelKeys = [...table.matchAll(/['"]((?:gpt-image|nano-banana)[^'"]+)['"]\s*:/g)].map((item) => item[1]);
  if (!sameValues(modelKeys, ['gpt-image-2-2-4k', 'nano-banana-2'])) fail('USMercari image client exposes an unexpected model set');
  const gpt = namedBlock(table, 'gpt-image-2-2-4k', 'USMercari image');
  const nano = namedBlock(table, 'nano-banana-2', 'USMercari image');
  if (!sameValues(arrayValues(gpt, 'resolutions', 'USMercari GPT'), ['1k', '2k'])) fail('USMercari GPT 4K must never be exposed by the client');
  if (!sameValues(arrayValues(nano, 'resolutions', 'USMercari Nano'), ['1k', '2k', '4k'])) fail('USMercari Nano resolutions must be exactly 1K/2K/4K');
  requirePattern(client, /https:\/\/chat-ai\.mercarimx\.com/, 'USMercari image client is missing the official origin');
  const locksExactOrigin = /\.origin\s*!==\s*USMERCARI_IMAGE_ORIGIN/.test(client);
  const locksHostAndScheme = /hostname\s*!==\s*['"]chat-ai\.mercarimx\.com['"]/.test(client)
    && /protocol\s*!==\s*['"]https:['"]/.test(client);
  if (!locksExactOrigin && !locksHostAndScheme) fail('USMercari image client permits a non-official origin');
  if ((client.match(/normalizeUsmercariImageBaseUrl\s*\(/g) || []).length < 2
      || !/module\.exports[\s\S]*normalizeUsmercariImageBaseUrl/.test(client)) {
    fail('USMercari official origin normalizer is not exported and used by the request path');
  }

  const dispatcher = stripComments(candidateSource(candidate, 'backend-node/src/services/imageClient.js'));
  const dispatchCondition = /\bif\s*\(\s*(?:protocol|proto)\s*===\s*['"]usmercari_image['"]\s*\)\s*\{/.exec(dispatcher);
  if (!dispatchCondition) fail('USMercari image runtime protocol dispatch is missing');
  const dispatchBlock = balancedBlock(dispatcher, dispatchCondition.index, 'USMercari image dispatch');
  requirePattern(dispatchBlock, /callUsmercariImageApi\s*\(/, 'USMercari image runtime protocol dispatch is missing');
  const dispatcherScopes = functionScopes(dispatcher);
  const submitGate = dispatcherScopes.find((scope) => scope.name === 'assertUsmercariImageSubmitReady');
  if (!submitGate) fail('USMercari imageClient final submit gate is missing');
  for (const [pattern, message] of [
    [/verification_status\s*(?:===|!==)\s*['"]verified['"]/, 'USMercari imageClient submit gate does not require verified status'],
    [/hasConnectionCredential\s*\(/, 'USMercari imageClient submit gate does not require credentials'],
    [/hasTrustedEvidenceBinding\s*\(/, 'USMercari imageClient submit gate does not bind shared evidence'],
    [/supportsTextToImage/, 'USMercari imageClient submit gate does not require text-to-image evidence'],
    [/supportsImageReference/, 'USMercari imageClient submit gate does not protect image references'],
    [/maxReferences/, 'USMercari imageClient submit gate does not enforce reference limits'],
    [/resolutions/, 'USMercari imageClient submit gate does not enforce verified resolutions'],
    [/(?:calculateCharge|requireImageResolutionPrice|resolution_prices)\s*\(/, 'USMercari imageClient submit gate does not require the current resolution price'],
  ]) requirePattern(submitGate.source, pattern, message);
  const submitCapabilitySource = /verified_capabilities/.test(submitGate.source)
    ? submitGate.source
    : dispatcherScopes.find((scope) => scope.name === 'verifiedImageCapabilities')?.source || '';
  requirePattern(submitCapabilitySource, /verified_capabilities/, 'USMercari imageClient submit gate does not read verified capabilities');
  const submitPath = dispatcherScopes.find((scope) => scope.name === 'callImageApi');
  if (!submitPath) fail('USMercari imageClient provider submission path is missing');
  const submitGateAt = firstIndex(submitPath.code, [/\bassertUsmercariImageSubmitReady\s*\(/]);
  const providerSubmitAt = firstIndex(submitPath.code, [/\busmercariImageClient\s*\.\s*callUsmercariImageApi\s*\(/]);
  if (submitGateAt < 0 || providerSubmitAt < 0 || submitGateAt > providerSubmitAt) {
    fail('USMercari imageClient final gate must run before the provider submission');
  }
  const service = stripComments(candidateSource(candidate, 'backend-node/src/services/imageService.js'));
  for (const [pattern, message] of [
    [/usmercari_image/, 'USMercari image runtime gate is missing the strict protocol'],
    [/verification_status\s*(?:===|!==)\s*['"]verified['"]/, 'USMercari image runtime gate does not require verified status'],
    [/(?:resolveUsmercariApiKey|hasConnectionCredential)\s*\(/, 'USMercari image runtime gate does not require credentials'],
    [/verified_capabilities/, 'USMercari image runtime gate does not read verified capabilities'],
    [/hasTrustedEvidenceBinding\s*\(/, 'USMercari image runtime gate does not bind shared evidence'],
    [/supportsTextToImage/, 'USMercari image runtime gate does not require text-to-image evidence'],
    [/supportsImageReference/, 'USMercari image runtime gate does not protect image references'],
    [/MODEL_(?:NOT_VERIFIED|RESOLUTION_PRICE_REQUIRED)/, 'USMercari image runtime gate is not fail closed'],
  ]) requirePattern(service, pattern, message);
  const scopes = functionScopes(service);
  const gateScope = scopes.find((scope) => [
    /verification_status\s*(?:===|!==)\s*['"]verified['"]/,
    /(?:resolveUsmercariApiKey|hasConnectionCredential)\s*\(/,
    /hasTrustedEvidenceBinding\s*\(/,
    /supportsTextToImage/,
    /supportsImageReference/,
    /(?:resolution_prices|modelPriceService\s*\.\s*(?:calculateCharge|quoteCost)\s*\()/,
  ].every((pattern) => pattern.test(scope.source)));
  if (!gateScope) fail('USMercari image strict runtime gate is not contained in one executable function');
  const capabilitySource = /verified_capabilities/.test(gateScope.source)
    ? gateScope.source
    : scopes.find((scope) => scope.name === 'normalizeUsmercariCapabilities')?.source || '';
  requirePattern(capabilitySource, /verified_capabilities/, 'USMercari image runtime gate does not read verified capabilities');

  const gateCalls = [
    [/verification_status\s*(?:===|!==)/, 'verified status'],
    [/(?:resolveUsmercariApiKey|hasConnectionCredential)\s*\(/, 'credential'],
    [/(?:verified_capabilities|normalizeUsmercariCapabilities\s*\()/, 'verified capabilities'],
    [/hasTrustedEvidenceBinding\s*\(/, 'shared evidence binding'],
    [/supportsTextToImage/, 'text-to-image capability'],
    [/supportsImageReference/, 'image-reference capability'],
    [/(?:resolution_prices|modelPriceService\s*\.\s*(?:calculateCharge|quoteCost)\s*\()/, 'resolution price'],
  ];
  if (sideEffectIndex(gateScope, 'image_generations') >= 0) {
    requireCallsBeforeSideEffect(gateScope, gateCalls, 'image_generations', 'USMercari image runtime');
  } else {
    const escapedName = gateScope.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const caller = scopes.find((scope) => new RegExp(`\\b${escapedName}\\s*\\(`).test(scope.code)
      && sideEffectIndex(scope, 'image_generations') >= 0);
    if (!caller) fail('USMercari image strict runtime gate is not connected to the generation side-effect path');
    requireCallsBeforeSideEffect(caller, [
      [new RegExp(`\\b${escapedName}\\s*\\(`), 'verified configuration/capabilities/evidence/price'],
    ], 'image_generations', 'USMercari image runtime');
  }
}

function auditCallouts(candidate) {
  const home = stripComments(candidateSource(candidate, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue'));
  const homeBlock = /<span\b(?=[^>]*v-if\s*=\s*['"]canGenerate['"])(?=[^>]*class\s*=\s*['"][^'"]*billing-cost)[^>]*>[\s\S]*?<\/span>/i.exec(home)?.[0] || '';
  if (!homeBlock || !/本次预计扣除/.test(homeBlock) || !/estimatedCredits/.test(homeBlock)
      || !/积分待管理员配置/.test(homeBlock) || !/<strong\b/i.test(homeBlock)) {
    fail('HomeCanvas semantic credit callout is missing bold estimated credits or the unpriced fallback');
  }
  const film = stripComments(candidateSource(candidate, 'frontweb/src/views/FilmCreate.vue'));
  const blocks = film.match(/<span\b(?=[^>]*class\s*=\s*['"][^'"]*billing-cost)(?=[^>]*class\s*=\s*['"][^'"]*canvas-credit-callout-v1)[^>]*>[\s\S]*?<\/span>/gi) || [];
  if (blocks.length < 2 || blocks.some((block) => !/本次预计扣除/.test(block)
      || !/积分待管理员配置/.test(block) || !/<strong\b/i.test(block))) {
    fail('FilmCreate image/video semantic credit callouts are incomplete');
  }
}

function parseJsonBytes(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); } catch (_) { fail(`${label} is not valid JSON`); }
}

function readManifestEvidence(evidenceRoot, surfaces) {
  const manifestFile = secureFile(evidenceRoot, 'manifest.json', 'evidence manifest', { basenameOnly: true, rootOwned: true });
  const manifest = parseJsonBytes(fs.readFileSync(manifestFile.path), 'evidence manifest');
  if (manifest?.contract_version !== MANIFEST_CONTRACT) fail('evidence manifest contract_version is invalid');
  if (!manifest.evidence || typeof manifest.evidence !== 'object' || Array.isArray(manifest.evidence)) fail('evidence manifest entries are invalid');
  const knownContracts = new Set(Object.values(PROVIDERS).map((provider) => provider.contract));
  for (const contract of Object.keys(manifest.evidence)) {
    if (!knownContracts.has(contract)) fail(`evidence manifest contains an arbitrary contract: ${contract}`);
  }
  const output = {};
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    const required = surfaces[key];
    const record = manifest.evidence[provider.contract];
    if (!record) {
      if (required) fail(`${provider.label} fixed manifest entry is missing`);
      continue;
    }
    if (record.file !== provider.evidenceFile) fail(`${provider.label} manifest file must be ${provider.evidenceFile}`);
    const expectedSha = String(record.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha)) fail(`${provider.label} manifest SHA-256 is invalid`);
    const evidenceFile = secureFile(evidenceRoot, provider.evidenceFile, `${provider.label} evidence JSON`, { basenameOnly: true, rootOwned: true });
    const bytes = fs.readFileSync(evidenceFile.path);
    if (sha256(bytes) !== expectedSha) fail(`${provider.label} evidence JSON does not match the manifest SHA-256`);
    output[key] = { evidence: parseJsonBytes(bytes, `${provider.label} evidence JSON`), sha256: expectedSha };
  }
  return output;
}

function canonicalTimestamp(value, label) {
  const raw = String(value || '');
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) fail(`${label} timestamp is invalid`);
  if (new Date(timestamp).toISOString() !== raw) fail(`${label} timestamp must be canonical UTC ISO-8601`);
  return timestamp;
}

function auditFreshness(evidence, label, now) {
  const generatedAt = canonicalTimestamp(evidence.generated_at, `${label} generated_at`);
  const validUntil = canonicalTimestamp(evidence.valid_until, `${label} valid_until`);
  if (generatedAt > now) fail(`${label} evidence is generated in the future`);
  if (now - generatedAt > 24 * 60 * 60 * 1_000) fail(`${label} evidence is stale (maximum age is 24 hours)`);
  if (validUntil <= now) fail(`${label} evidence is expired`);
  if (validUntil <= generatedAt) fail(`${label} valid_until must be after generated_at`);
  if (validUntil - generatedAt > 7 * 24 * 60 * 60 * 1_000) fail(`${label} evidence validity window exceeds 7 days`);
  return { generatedAt, validUntil };
}

function moliUrl(value, label, provider = '', expectedFile = '') {
  const raw = String(value || '');
  let url;
  try { url = new URL(raw); } catch (_) { fail(`${label} must be a molimama HTTPS URL`); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.href !== raw
      || (provider ? host !== 'molimama.vip' : (host !== 'molimama.vip' && !host.endsWith('.molimama.vip')))) {
    fail(`${label} must be a molimama HTTPS URL`);
  }
  if (provider) {
    const expectedPath = `/verification-assets/${provider}/${encodeURIComponent(expectedFile)}`;
    if (url.search || url.hash || url.pathname !== expectedPath) {
      fail(`${label} does not map exactly to the protected public asset`);
    }
  }
  return url;
}

function auditAsset(evidenceRoot, descriptor, label, provider) {
  const outputFile = String(descriptor?.output_file || '');
  if (!outputFile || path.basename(outputFile) !== outputFile) fail(`${label} output_file must be a safe basename`);
  secureDirectory(path.join(evidenceRoot, 'public'), 'EVIDENCE_ROOT public directory', true);
  secureDirectory(path.join(evidenceRoot, 'public', provider), `EVIDENCE_ROOT public ${provider} directory`, true);
  const file = secureFile(
    evidenceRoot,
    path.join('public', provider, outputFile),
    `${label} public output_file`,
    { rootOwned: true },
  );
  const expectedBytes = Number(descriptor.bytes);
  const expectedSha = String(descriptor.sha256 || '').toLowerCase();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || file.stat.size !== expectedBytes) fail(`${label} asset bytes do not match the file`);
  if (!/^[a-f0-9]{64}$/.test(expectedSha)) fail(`${label} asset SHA-256 is invalid`);
  const bytes = fs.readFileSync(file.path);
  if (sha256(bytes) !== expectedSha) fail(`${label} asset SHA-256 does not match the file`);
  return { outputFile, expectedSha, path: file.path, bytes };
}

function exactRoles(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length) fail(`${label} role count is invalid`);
  const actual = value.map((entry) => String(entry?.role || '')).sort();
  if (!sameValues(actual, [...expected].sort())) fail(`${label} roles are invalid`);
  for (const entry of value) moliUrl(entry?.url, `${label} role URL`);
}

function round(value, precision = 6) {
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function equalNumber(left, right) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right))
    && Math.abs(Number(left) - Number(right)) < 1e-9;
}

function ceilDecimalProduct(value, multiplier) {
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) return NaN;
  const [whole, fraction = ''] = text.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`) * BigInt(multiplier);
  return Number((numerator + scale - 1n) / scale);
}

function auditToapisEvidence(evidenceRoot, envelope, now) {
  const evidence = envelope.evidence;
  if (evidence?.contract_version !== PROVIDERS.toapis.contract) fail('ToAPIs evidence contract_version is invalid');
  if (evidence.provider_origin !== 'https://toapis.com') fail('ToAPIs evidence provider origin is not official');
  const freshness = auditFreshness(evidence, 'ToAPIs', now);
  const results = Array.isArray(evidence.results) ? evidence.results : [];
  if (results.length !== TOAPIS_CASES.length) fail('ToAPIs evidence must contain exactly 8 cases');
  const byId = new Map(results.map((result) => [result?.id, result]));
  if (byId.size !== TOAPIS_CASES.length) fail('ToAPIs evidence contains a duplicate or unknown case');
  const tasks = new Set();
  const outputs = new Set();
  const hashes = new Set();
  const publicUrls = new Set();
  const billingWindows = [];
  for (const expected of TOAPIS_CASES) {
    const result = byId.get(expected.id);
    if (!result) fail(`ToAPIs case is missing: ${expected.id}`);
    if (result.status !== 'completed' || result.model !== expected.model || result.mode !== expected.mode
        || String(result.requested_resolution || '').toLowerCase() !== expected.resolution
        || Number(result.requested_duration) !== expected.duration) {
      fail(`ToAPIs case model/resolution/duration binding is invalid: ${expected.id}`);
    }
    const task = String(result.provider_task_id || '');
    if (!task || tasks.has(task)) fail(`ToAPIs provider task must be unique: ${expected.id}`);
    tasks.add(task);
    const request = result.request || {};
    if (request.model !== expected.model || String(request.resolution || '').toLowerCase() !== expected.resolution
        || Number(request.duration) !== expected.duration || request.aspect_ratio !== '16:9'
        || request.generate_audio !== expected.audio) {
      fail(`ToAPIs request model/resolution/duration/audio binding is invalid: ${expected.id}`);
    }
    if (expected.mode === 't2v') {
      if (request.image_with_roles != null || request.video_with_roles != null || request.audio_with_roles != null) fail(`ToAPIs t2v roles must be absent: ${expected.id}`);
    } else if (expected.mode === 'first-last') {
      exactRoles(request.image_with_roles, ['first_frame', 'last_frame'], `ToAPIs ${expected.id}`);
      if (request.video_with_roles != null || request.audio_with_roles != null) fail(`ToAPIs first/last roles are mixed with omni references: ${expected.id}`);
    } else {
      exactRoles(request.image_with_roles, ['reference_image'], `ToAPIs ${expected.id} image`);
      exactRoles(request.video_with_roles, ['reference_video'], `ToAPIs ${expected.id} video`);
      exactRoles(request.audio_with_roles, ['reference_audio'], `ToAPIs ${expected.id} audio`);
    }
    const artifact = result.artifact || {};
    const outputFile = String(artifact.output_file || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$/.test(outputFile)) {
      fail(`ToAPIs ${expected.id} output_file must be a safe .mp4 basename`);
    }
    const asset = auditAsset(evidenceRoot, artifact, `ToAPIs ${expected.id}`, 'toapis');
    moliUrl(artifact.public_url, `ToAPIs ${expected.id} public_url`, 'toapis', asset.outputFile);
    if (outputs.has(asset.outputFile) || hashes.has(asset.expectedSha) || publicUrls.has(artifact.public_url)) fail(`ToAPIs output asset must be unique: ${expected.id}`);
    outputs.add(asset.outputFile); hashes.add(asset.expectedSha); publicUrls.add(artifact.public_url);
    const probe = artifact.ffprobe || {};
    const width = Number(probe.width);
    const height = Number(probe.height);
    const duration = Number(probe.duration_seconds);
    const shortEdge = Math.min(width, height);
    const inBand = expected.resolution === '480p'
      ? shortEdge >= 400 && shortEdge <= 576
      : shortEdge >= 640 && shortEdge <= 800;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !inBand
        || !Number.isFinite(duration) || Math.abs(duration - expected.duration) > 1.5
        || !String(probe.video_codec || '') || !String(probe.format || '')) {
      fail(`ToAPIs ffprobe ${expected.resolution} evidence band is invalid: ${expected.id}`);
    }
    if (expected.audio && (probe.has_audio !== true || !String(probe.audio_codec || ''))) fail(`ToAPIs synchronous audio evidence is missing: ${expected.id}`);

    const billing = result.billing || {};
    const before = billing.before || {};
    const after = billing.after || {};
    const beforeAt = canonicalTimestamp(before.captured_at, `ToAPIs ${expected.id} billing before`);
    const afterAt = canonicalTimestamp(after.captured_at, `ToAPIs ${expected.id} billing after`);
    const usedBefore = Number(before.used_balance);
    const usedAfter = Number(after.used_balance);
    const creditsBefore = Number(before.used_credits);
    const creditsAfter = Number(after.used_credits);
    const debitedBalance = round(usedAfter - usedBefore);
    const debitedCredits = round(creditsAfter - creditsBefore);
    const rate = Number(billing.usd_cny_rate);
    if (!Number.isFinite(usedBefore) || !Number.isFinite(usedAfter) || !Number.isFinite(creditsBefore)
        || !Number.isFinite(creditsAfter) || debitedBalance <= 0 || debitedCredits <= 0
        || beforeAt >= afterAt || afterAt > freshness.generatedAt
        || !equalNumber(billing.debited_balance, debitedBalance)
        || !equalNumber(billing.debited_credits, debitedCredits)
        || !Number.isFinite(rate) || rate <= 0
        || !equalNumber(billing.cost_yuan, round(debitedBalance * rate))
        || billing.reviewed !== true || !String(billing.review_run_id || '')) {
      fail(`ToAPIs billing evidence is invalid: ${expected.id}`);
    }
    const reviewedAt = canonicalTimestamp(billing.reviewed_at, `ToAPIs ${expected.id} billing reviewed_at`);
    if (reviewedAt > freshness.generatedAt) fail(`ToAPIs billing review is later than evidence generation: ${expected.id}`);
    billingWindows.push({ beforeAt, afterAt, before, after, result });
  }
  billingWindows.sort((left, right) => left.beforeAt - right.beforeAt);
  const windows = new Set(billingWindows.map((item) => `${item.beforeAt}|${item.afterAt}`));
  if (windows.size !== billingWindows.length) fail('ToAPIs billing windows are duplicated');
  for (let index = 1; index < billingWindows.length; index += 1) {
    const previous = billingWindows[index - 1];
    const current = billingWindows[index];
    if (previous.afterAt > current.beforeAt
        || !equalNumber(previous.after.used_balance, current.before.used_balance)
        || !equalNumber(previous.after.used_credits, current.before.used_credits)) {
      fail('ToAPIs billing chain is not continuous');
    }
  }

  const review = evidence.cost_review || {};
  const reviewedAt = canonicalTimestamp(review.reviewed_at, 'ToAPIs cost review');
  const completed = Array.isArray(review.completed_before_run) ? review.completed_before_run : [];
  const submitted = Array.isArray(review.submitted_case_ids) ? review.submitted_case_ids : null;
  const runId = String(review.run_id || '');
  if (!runId || reviewedAt > freshness.generatedAt || !submitted || submitted.length !== 0
      || (review.post_count != null && Number(review.post_count) !== 0)
      || completed.length !== TOAPIS_CASES.length || new Set(completed).size !== completed.length
      || !TOAPIS_CASES.every((item) => completed.includes(item.id))
      || !results.every((item) => item.billing?.review_run_id === runId
        && item.billing?.reviewed_at === review.reviewed_at)) {
    fail('ToAPIs cost review must be a second run with zero POST submissions');
  }

  const pricing = Array.isArray(evidence.pricing) ? evidence.pricing : [];
  if (pricing.length !== Object.keys(TOAPIS_PRICE_FLOORS).length) fail('ToAPIs pricing must contain exactly 4 entries');
  const prices = new Map(pricing.map((item) => [`${item?.model}|${String(item?.resolution || '').toLowerCase()}`, item]));
  if (prices.size !== pricing.length) fail('ToAPIs pricing contains a duplicate entry');
  const floors = { ...TOAPIS_PRICE_FLOORS };
  for (const result of results) {
    const key = `${result.model}|${String(result.requested_resolution).toLowerCase()}`;
    const observed = Number(result.billing.cost_yuan) / Number(result.requested_duration);
    if (Object.hasOwn(floors, key) && Number.isFinite(observed) && observed > floors[key]) floors[key] = round(observed);
  }
  for (const [key, floor] of Object.entries(floors)) {
    const price = prices.get(key);
    if (!price || price.reviewed !== true || !equalNumber(price.cost_yuan_per_second, floor)
        || Number(price.credits_per_second) !== ceilDecimalProduct(floor, 875)) {
      fail(`ToAPIs exact price or credits are invalid: ${key}`);
    }
  }
}

function jpegError(message) {
  throw new Error(`baseline JPEG decode failed: ${message}`);
}

function jpegMarker(bytes, state) {
  if (state.offset >= bytes.length || bytes[state.offset] !== 0xff) jpegError('expected marker prefix');
  while (state.offset < bytes.length && bytes[state.offset] === 0xff) state.offset += 1;
  if (state.offset >= bytes.length) jpegError('truncated marker');
  const marker = bytes[state.offset];
  state.offset += 1;
  if (marker === 0x00 || marker === 0xff) jpegError('invalid marker');
  return marker;
}

function jpegSegment(bytes, state, label) {
  if (state.offset + 2 > bytes.length) jpegError(`truncated ${label} length`);
  const length = bytes.readUInt16BE(state.offset);
  if (length < 2 || state.offset + length > bytes.length) jpegError(`invalid ${label} length`);
  const segment = bytes.subarray(state.offset + 2, state.offset + length);
  state.offset += length;
  return segment;
}

function parseQuantizationTables(segment, tables) {
  let offset = 0;
  while (offset < segment.length) {
    const descriptor = segment[offset];
    offset += 1;
    const precision = descriptor >> 4;
    const id = descriptor & 0x0f;
    if (precision > 1 || id > 3 || tables.has(id)) jpegError('invalid or duplicate quantization table');
    const bytesPerValue = precision + 1;
    if (offset + 64 * bytesPerValue > segment.length) jpegError('truncated quantization table');
    const values = new Array(64);
    for (let index = 0; index < 64; index += 1) {
      values[index] = bytesPerValue === 1 ? segment[offset] : segment.readUInt16BE(offset);
      offset += bytesPerValue;
      if (values[index] === 0) jpegError('zero quantization value');
    }
    tables.set(id, values);
  }
}

function buildHuffmanTable(counts, values) {
  const byLength = new Array(17);
  let code = 0;
  let valueOffset = 0;
  for (let length = 1; length <= 16; length += 1) {
    const entries = new Map();
    const count = counts[length - 1];
    if (code + count > (1 << length)) jpegError('oversubscribed Huffman table');
    for (let index = 0; index < count; index += 1) {
      entries.set(code, values[valueOffset]);
      code += 1;
      valueOffset += 1;
    }
    byLength[length] = entries;
    code <<= 1;
  }
  return byLength;
}

function parseHuffmanTables(segment, tables) {
  let offset = 0;
  while (offset < segment.length) {
    if (offset + 17 > segment.length) jpegError('truncated Huffman table');
    const descriptor = segment[offset];
    offset += 1;
    const tableClass = descriptor >> 4;
    const id = descriptor & 0x0f;
    if (tableClass > 1 || id > 3) jpegError('invalid Huffman table selector');
    const counts = [...segment.subarray(offset, offset + 16)];
    offset += 16;
    const valueCount = counts.reduce((sum, value) => sum + value, 0);
    if (valueCount === 0 || valueCount > 256 || offset + valueCount > segment.length) jpegError('invalid Huffman table values');
    const key = `${tableClass}:${id}`;
    if (tables.has(key)) jpegError('duplicate Huffman table');
    const values = [...segment.subarray(offset, offset + valueCount)];
    offset += valueCount;
    tables.set(key, buildHuffmanTable(counts, values));
  }
}

function parseBaselineFrame(segment) {
  if (segment.length < 6 || segment[0] !== 8) jpegError('only 8-bit baseline frames are accepted');
  const height = segment.readUInt16BE(1);
  const width = segment.readUInt16BE(3);
  const componentCount = segment[5];
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4096 * 4096) jpegError('image dimensions exceed the release bound');
  if (![1, 3].includes(componentCount) || segment.length !== 6 + componentCount * 3) jpegError('unsupported frame component count');
  const components = [];
  const ids = new Set();
  let maxHorizontal = 0;
  let maxVertical = 0;
  for (let index = 0; index < componentCount; index += 1) {
    const offset = 6 + index * 3;
    const id = segment[offset];
    const horizontal = segment[offset + 1] >> 4;
    const vertical = segment[offset + 1] & 0x0f;
    const quantization = segment[offset + 2];
    if (ids.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4 || quantization > 3) {
      jpegError('invalid frame component');
    }
    ids.add(id);
    maxHorizontal = Math.max(maxHorizontal, horizontal);
    maxVertical = Math.max(maxVertical, vertical);
    components.push({ id, horizontal, vertical, quantization, dcPredictor: 0 });
  }
  if (componentCount === 1 && (components[0].horizontal !== 1 || components[0].vertical !== 1)) {
    jpegError('unsupported grayscale sampling');
  }
  if (!components.every((component) => maxHorizontal % component.horizontal === 0 && maxVertical % component.vertical === 0)) {
    jpegError('invalid component sampling factors');
  }
  return { width, height, components, maxHorizontal, maxVertical };
}

function parseBaselineScan(segment, frame, huffmanTables) {
  if (segment.length < 4) jpegError('truncated scan header');
  const componentCount = segment[0];
  if (componentCount !== frame.components.length || segment.length !== 4 + componentCount * 2) {
    jpegError('scan must contain every frame component exactly once');
  }
  const byId = new Map(frame.components.map((component) => [component.id, component]));
  const scanComponents = [];
  const ids = new Set();
  for (let index = 0; index < componentCount; index += 1) {
    const id = segment[1 + index * 2];
    const selector = segment[2 + index * 2];
    const component = byId.get(id);
    const dcTable = selector >> 4;
    const acTable = selector & 0x0f;
    if (!component || ids.has(id) || dcTable > 3 || acTable > 3
        || !huffmanTables.has(`0:${dcTable}`) || !huffmanTables.has(`1:${acTable}`)) {
      jpegError('invalid scan component or Huffman selector');
    }
    ids.add(id);
    scanComponents.push({ component, dcTable, acTable });
  }
  const tail = 1 + componentCount * 2;
  if (segment[tail] !== 0 || segment[tail + 1] !== 63 || segment[tail + 2] !== 0) {
    jpegError('progressive or successive scans are forbidden');
  }
  return scanComponents;
}

class JpegEntropyReader {
  constructor(bytes, offset) {
    this.bytes = bytes;
    this.offset = offset;
    this.currentByte = 0;
    this.bitsRemaining = 0;
  }

  dataByte() {
    if (this.offset >= this.bytes.length) jpegError('truncated entropy stream');
    const value = this.bytes[this.offset];
    this.offset += 1;
    if (value !== 0xff) return value;
    while (this.offset < this.bytes.length && this.bytes[this.offset] === 0xff) this.offset += 1;
    if (this.offset >= this.bytes.length) jpegError('truncated entropy marker');
    const marker = this.bytes[this.offset];
    this.offset += 1;
    if (marker === 0x00) return 0xff;
    jpegError(`unexpected marker 0x${marker.toString(16)} inside an entropy-coded block`);
  }

  bit() {
    if (this.bitsRemaining === 0) {
      this.currentByte = this.dataByte();
      this.bitsRemaining = 8;
    }
    this.bitsRemaining -= 1;
    return (this.currentByte >> this.bitsRemaining) & 1;
  }

  bits(count) {
    let value = 0;
    for (let index = 0; index < count; index += 1) value = value * 2 + this.bit();
    return value;
  }

  align() {
    if (this.bitsRemaining > 0) {
      const mask = (1 << this.bitsRemaining) - 1;
      if ((this.currentByte & mask) !== mask) jpegError('invalid entropy padding bits');
    }
    this.bitsRemaining = 0;
  }

  marker() {
    this.align();
    const state = { offset: this.offset };
    const marker = jpegMarker(this.bytes, state);
    this.offset = state.offset;
    return marker;
  }
}

function decodeHuffman(reader, table) {
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    code = code * 2 + reader.bit();
    const symbol = table[length].get(code);
    if (symbol !== undefined) return symbol;
  }
  jpegError('invalid Huffman code');
}

function receiveAndExtend(reader, size) {
  if (size === 0) return 0;
  const value = reader.bits(size);
  const threshold = 2 ** (size - 1);
  return value < threshold ? value + 1 - 2 ** size : value;
}

function decodeBaselineBlock(reader, scanComponent, quantizationTables, huffmanTables, state) {
  const component = scanComponent.component;
  const quantization = quantizationTables.get(component.quantization);
  if (!quantization) jpegError('missing quantization table');
  const dcSize = decodeHuffman(reader, huffmanTables.get(`0:${scanComponent.dcTable}`));
  if (dcSize > 11) jpegError('invalid baseline DC coefficient size');
  component.dcPredictor += receiveAndExtend(reader, dcSize);
  state.checksum = (Math.imul(state.checksum ^ (component.dcPredictor * quantization[0]), 16777619)) >>> 0;
  let coefficient = 1;
  while (coefficient < 64) {
    const symbol = decodeHuffman(reader, huffmanTables.get(`1:${scanComponent.acTable}`));
    const run = symbol >> 4;
    const size = symbol & 0x0f;
    if (size === 0) {
      if (run === 0) break;
      if (run !== 15 || coefficient + 16 > 64) jpegError('invalid baseline AC zero run');
      coefficient += 16;
      continue;
    }
    if (size > 10 || coefficient + run >= 64) jpegError('invalid baseline AC coefficient');
    coefficient += run;
    const value = receiveAndExtend(reader, size);
    state.checksum = (Math.imul(state.checksum ^ (value * quantization[coefficient]), 16777619)) >>> 0;
    coefficient += 1;
  }
  state.blocks += 1;
}

function decodeBaselineEntropy(bytes, offset, frame, scanComponents, quantizationTables, huffmanTables, restartInterval) {
  const reader = new JpegEntropyReader(bytes, offset);
  const columns = Math.ceil(frame.width / (8 * frame.maxHorizontal));
  const rows = Math.ceil(frame.height / (8 * frame.maxVertical));
  const totalMcus = columns * rows;
  const state = { blocks: 0, checksum: 2166136261 };
  let restart = 0;
  for (let mcu = 0; mcu < totalMcus; mcu += 1) {
    for (const scanComponent of scanComponents) {
      const { horizontal, vertical } = scanComponent.component;
      for (let block = 0; block < horizontal * vertical; block += 1) {
        decodeBaselineBlock(reader, scanComponent, quantizationTables, huffmanTables, state);
      }
    }
    if (restartInterval > 0 && (mcu + 1) % restartInterval === 0 && mcu + 1 < totalMcus) {
      const marker = reader.marker();
      if (marker !== 0xd0 + restart) jpegError('missing or out-of-order restart marker');
      restart = (restart + 1) & 7;
      for (const component of frame.components) component.dcPredictor = 0;
    }
  }
  if (reader.marker() !== 0xd9) jpegError('missing end-of-image marker');
  if (reader.offset !== bytes.length) jpegError('trailing bytes after end-of-image marker');
  const expectedBlocks = totalMcus * scanComponents.reduce(
    (sum, entry) => sum + entry.component.horizontal * entry.component.vertical,
    0,
  );
  if (state.blocks !== expectedBlocks) jpegError('not every image block was decoded');
  return { blocks: state.blocks, checksum: state.checksum };
}

function decodeBaselineJpeg(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > 64 * 1024 * 1024
      || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    jpegError('not a bounded JPEG file');
  }
  const state = { offset: 2 };
  const quantizationTables = new Map();
  const huffmanTables = new Map();
  let frame = null;
  let restartInterval = 0;
  let segmentCount = 0;
  while (state.offset < bytes.length) {
    if (segmentCount >= 256) jpegError('too many marker segments');
    segmentCount += 1;
    const marker = jpegMarker(bytes, state);
    if (marker === 0xd9) jpegError('image ended before its scan');
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) jpegError('unexpected standalone marker');
    const segment = jpegSegment(bytes, state, `marker 0x${marker.toString(16)}`);
    if (marker === 0xdb) parseQuantizationTables(segment, quantizationTables);
    else if (marker === 0xc4) parseHuffmanTables(segment, huffmanTables);
    else if (marker === 0xc0) {
      if (frame) jpegError('duplicate baseline frame');
      frame = parseBaselineFrame(segment);
    } else if (marker === 0xdd) {
      if (segment.length !== 2) jpegError('invalid restart interval');
      restartInterval = segment.readUInt16BE(0);
    } else if (marker === 0xda) {
      if (!frame) jpegError('scan appears before frame');
      if (!frame.components.every((component) => quantizationTables.has(component.quantization))) jpegError('frame references a missing quantization table');
      const scanComponents = parseBaselineScan(segment, frame, huffmanTables);
      const decoded = decodeBaselineEntropy(
        bytes,
        state.offset,
        frame,
        scanComponents,
        quantizationTables,
        huffmanTables,
        restartInterval,
      );
      return { format: 'jpeg', width: frame.width, height: frame.height, ...decoded };
    } else if ((marker >= 0xc1 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      jpegError('only baseline sequential JPEG is accepted');
    }
  }
  jpegError('missing image scan');
}

function auditImageBand(resolution, width, height, label) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) fail(`${label} image dimensions are invalid`);
  const edge = Math.max(width, height);
  if (resolution === '1k' && edge <= 1024) return;
  if (resolution === '2k' && edge > 1024 && edge <= 2048) return;
  if (resolution === '4k' && edge > 2048 && edge <= 4096) return;
  fail(`${label} ${resolution.toUpperCase()} image size band is invalid`);
}

function auditDecodedImage(asset, result, resolution, label) {
  let decoded;
  try {
    decoded = decodeBaselineJpeg(asset.bytes);
  } catch (_) {
    fail(`${label} cannot be fully decoded as a baseline JPEG image`);
  }
  const width = Number(decoded.width);
  const height = Number(decoded.height);
  if (String(result.format || '').trim().toLowerCase() !== decoded.format
      || Number(result.width) !== width || Number(result.height) !== height) {
    fail(`${label} decoded format or dimensions do not match the evidence declaration`);
  }
  if (String(result.content_type || '').trim().toLowerCase() !== 'image/jpeg') {
    fail(`${label} decoded format does not match the declared MIME content type`);
  }
  if (path.extname(asset.outputFile).toLowerCase() !== '.jpg') {
    fail(`${label} decoded format does not match the published file extension`);
  }
  auditImageBand(resolution, width, height, label);
}

function auditUsmercariEvidence(evidenceRoot, envelope, now) {
  const evidence = envelope.evidence;
  if (evidence?.contract_version !== PROVIDERS.usmercari.contract) fail('USMercari image evidence contract_version is invalid');
  if (evidence.provider_origin !== 'https://chat-ai.mercarimx.com') fail('USMercari image evidence official provider origin is invalid');
  auditFreshness(evidence, 'USMercari image', now);
  const results = Array.isArray(evidence.results) ? evidence.results : [];
  if (results.length !== USMERCARI_CASES.length) fail('USMercari image evidence must contain exactly 7 cases');
  const keyFor = (item) => `${item?.model}|${item?.capability}|${String(item?.requested_resolution || '').toLowerCase()}`;
  const byKey = new Map(results.map((item) => [keyFor(item), item]));
  if (byKey.size !== USMERCARI_CASES.length) fail('USMercari image evidence contains duplicate or extra cases');
  const outputs = new Set();
  const hashes = new Set();
  const publicUrls = new Set();
  const providerIdByModel = new Map();
  const modelByProviderId = new Map();
  for (const expected of USMERCARI_CASES) {
    const key = `${expected.model}|${expected.capability}|${expected.resolution}`;
    const result = byKey.get(key);
    if (!result || result.marker !== `${key}|verified` || result.model !== expected.model
        || result.capability !== expected.capability || String(result.requested_resolution).toLowerCase() !== expected.resolution
        || result.requested_aspect_ratio !== '1:1' || Number(result.quantity) !== 1
        || Number(result.reference_count) !== (expected.capability === 'image-to-image' ? 1 : 0)) {
      fail(`USMercari image real case binding is invalid: ${key}`);
    }
    const providerModelId = String(result.provider_model_id || '').trim();
    if (!providerModelId) fail(`USMercari image provider_model_id is missing: ${key}`);
    const priorId = providerIdByModel.get(expected.model);
    if (priorId && priorId !== providerModelId) fail(`USMercari image provider_model_id is not consistent for ${expected.model}`);
    const priorModel = modelByProviderId.get(providerModelId);
    if (priorModel && priorModel !== expected.model) fail(`USMercari image provider_model_id is reused across requested models`);
    providerIdByModel.set(expected.model, providerModelId);
    modelByProviderId.set(providerModelId, expected.model);
    if (expected.model === 'gpt-image-2-2-4k' && expected.resolution === '4k') fail('USMercari GPT 4K must never be opened');
    const asset = auditAsset(evidenceRoot, result, `USMercari image ${key}`, 'usmercari');
    moliUrl(result.public_url, `USMercari image ${key} public_url`, 'usmercari', asset.outputFile);
    if (outputs.has(asset.outputFile) || hashes.has(asset.expectedSha) || publicUrls.has(result.public_url)) fail(`USMercari image output must be unique: ${key}`);
    outputs.add(asset.outputFile); hashes.add(asset.expectedSha); publicUrls.add(result.public_url);
    auditDecodedImage(asset, result, expected.resolution, `USMercari image ${key}`);
  }
  const rejected = Array.isArray(evidence.rejected_capabilities) ? evidence.rejected_capabilities : [];
  const gpt4k = rejected.find((item) => item?.marker === 'gpt-image-2-2-4k|text-to-image|4k|failed');
  if (!gpt4k || Number(gpt4k.attempts) < 2 || ![400, 422].includes(Number(gpt4k.http_status))
      || !String(gpt4k.error_code || '')) {
    fail('USMercari GPT 4K independent rejection evidence is missing');
  }
  const pricing = Array.isArray(evidence.pricing) ? evidence.pricing : [];
  if (pricing.length !== Object.keys(USMERCARI_PRICES).length) fail('USMercari image pricing must contain exactly 5 entries');
  const prices = new Map(pricing.map((item) => [`${item?.model}|${String(item?.resolution || '').toLowerCase()}`, item]));
  if (prices.size !== pricing.length) fail('USMercari image pricing contains a duplicate entry');
  for (const [key, expected] of Object.entries(USMERCARI_PRICES)) {
    const price = prices.get(key);
    if (!price || price.reviewed !== true || !equalNumber(price.cost_yuan_per_image, expected[0])
        || Number(price.credits_per_image) !== expected[1]) {
      fail(`USMercari image exact price or credits are invalid: ${key}`);
    }
  }
}

function evidencePathEnvironmentNames(env) {
  return Object.keys(env).filter((name) => /evidence.*(?:path|root)|(?:path|root).*evidence|verify.*output.*dir/i.test(name));
}

function verifyExternalModelRelease(candidateArg, evidenceRootArg, options = {}) {
  const envNames = evidencePathEnvironmentNames(options.env || process.env);
  if (envNames.length) fail(`evidence path environment overrides are forbidden: ${envNames.join(', ')}`);
  const candidate = secureDirectory(candidateArg, 'CANDIDATE');
  const evidenceAllowedRoot = secureDirectory(path.dirname(path.resolve(evidenceRootArg)), 'EVIDENCE_ALLOWED_ROOT', true);
  const evidenceRoot = secureDirectory(evidenceRootArg, 'EVIDENCE_ROOT', true);
  if (!isInside(evidenceAllowedRoot, evidenceRoot)) fail('EVIDENCE_ROOT escapes EVIDENCE_ALLOWED_ROOT');
  const surfaces = {
    toapis: hasSurface(candidate, PROVIDERS.toapis),
    usmercari: hasSurface(candidate, PROVIDERS.usmercari),
  };
  if (!surfaces.toapis && !surfaces.usmercari) return { legacy: true, surfaces };
  auditEvidenceBindingRuntime(candidate, surfaces);
  if (surfaces.toapis) auditToapisRuntime(candidate);
  if (surfaces.usmercari) auditUsmercariRuntime(candidate);
  auditCallouts(candidate);
  const envelopes = readManifestEvidence(evidenceRoot, surfaces);
  const now = options.now == null ? Date.now() : Number(options.now);
  if (surfaces.toapis) auditToapisEvidence(evidenceRoot, envelopes.toapis, now);
  if (surfaces.usmercari) auditUsmercariEvidence(evidenceRoot, envelopes.usmercari, now);
  return { legacy: false, surfaces };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    process.stderr.write('Usage: verify-external-model-release.js CANDIDATE EVIDENCE_ROOT\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = verifyExternalModelRelease(argv[0], argv[1]);
    const providers = Object.entries(result.surfaces).filter(([, enabled]) => enabled).map(([name]) => name);
    process.stdout.write(`EXTERNAL_MODEL_RELEASE_OK ${result.legacy ? 'legacy' : `providers=${providers.join(',')}`}\n`);
  } catch (error) {
    process.stderr.write(`EXTERNAL_MODEL_RELEASE_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  MANIFEST_CONTRACT,
  PROVIDERS,
  TOAPIS_CASES,
  USMERCARI_CASES,
  decodeBaselineJpeg,
  verifyExternalModelRelease,
};
