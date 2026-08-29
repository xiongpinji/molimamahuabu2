#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_CONTRACT = 'external-model-release-evidence-manifest-v1';
// Paid evidence is refreshed only when the provider wire adapter or exact
// evidence producer changes. Shared catalog/billing/UI files are still audited
// below on every release, but do not make unrelated providers pay to re-prove
// an unchanged upstream request/response contract.
const FRESHNESS_SURFACES = Object.freeze({
  toapis: Object.freeze([
    'backend-node/src/services/toapisVideoClient.js',
    'backend-node/scripts/verify-toapis-video-models.js',
  ]),
  toapisWan3: Object.freeze([
    'backend-node/src/services/toapisWan3VideoClient.js',
    'backend-node/scripts/verify-toapis-wan3-video.js',
  ]),
  toapisPrivateAvatar: Object.freeze([
    'backend-node/src/services/toapisVideoClient.js',
    'backend-node/src/services/toapisPrivateAvatarService.js',
    'backend-node/src/services/videoService.js',
    'backend-node/scripts/verify-toapis-private-avatar-video.js',
  ]),
  usmercari: Object.freeze([
    'backend-node/src/services/usmercariImageClient.js',
    'backend-node/scripts/verify-usmercari-image-models.js',
  ]),
  lingjing: Object.freeze([
    'backend-node/src/services/lingjingVideoClient.js',
    'backend-node/scripts/verify-lingjing-video-model.js',
  ]),
});
const TRUSTED_UNCHANGED_TOAPIS_STANDARD_SURFACE_SHA256 = Object.freeze({
  'backend-node/src/services/toapisVideoClient.js': '2d6825dab8cb036bc32069793118ea5656f3dff528dec92df0f467291d555d7b',
  'backend-node/scripts/verify-toapis-video-models.js': 'eb8bf4259c4f55b4d7d61a1d18b5de1ad261a5b573414f5a8fdade659b0bdd3d',
});
const PROVIDERS = Object.freeze({
  toapis: Object.freeze({
    label: 'ToAPIs',
    contract: 'toapis-video-real-verification-v1',
    evidenceFile: 'toapis-video-verification.json',
    privateAvatarContract: 'toapis-private-avatar-video-verification-v1',
    privateAvatarEvidenceFile: 'toapis-private-avatar-verification.json',
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
  toapisWan3: Object.freeze({
    label: 'ToAPIs Wan 3.0 video',
    contract: 'toapis-wan3-video-real-verification-v1',
    evidenceFile: 'toapis-wan3-video-verification.json',
    clientFile: 'backend-node/src/services/toapisWan3VideoClient.js',
    markers: /\bwan3\.0-video\b|\btoapis_wan3_video\b/,
    surfaceFiles: Object.freeze([
      'backend-node/src/routes/aiConfig.js',
      'backend-node/src/services/aiConfigService.js',
      'backend-node/src/services/canvasModelCatalogService.js',
      'backend-node/src/services/externalModelEvidenceService.js',
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
  lingjing: Object.freeze({
    label: 'Lingjing video',
    contract: 'lingjing-video-real-verification-v1',
    evidenceFile: 'lingjing-video-verification.json',
    clientFile: 'backend-node/src/services/lingjingVideoClient.js',
    markers: /\blingjing_open\b|\blingjing-video-v1\b/,
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
const TOAPIS_PRIVATE_AVATAR_CASES = Object.freeze([
  Object.freeze({ id: 'fast-avatar-480-4s', model: 'seedance-2-fast', resolution: '480p', duration: 4 }),
  Object.freeze({ id: 'mini-avatar-480-4s', model: 'seedance-2-mini', resolution: '480p', duration: 4 }),
]);
const TOAPIS_WAN3_CASE = Object.freeze({
  id: 'wan3-t2v-480p-2s-no-audio',
  model: 'wan3.0-video',
  mode: 't2v',
  resolution: '480p',
  ratio: '16:9',
  duration: 2,
  audio: false,
});

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

const LINGJING_CASE = Object.freeze({
  id: 'relay-image-4s',
  model: 'lingjing-video-v1',
  upstreamModel: 'relay',
  mode: 'omni',
  duration: 4,
  aspectRatio: '16:9',
});
const LINGJING_DURATIONS = Object.freeze([4, 5, 6, 8, 10, 11, 15]);
const LINGJING_RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);

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
  if (stat.isDirectory() && (stat.mode & 0o555) !== 0o555) {
    fail(`${label} must be runtime-readable and traversable`);
  }
  if (stat.isFile() && (stat.mode & 0o444) !== 0o444) {
    fail(`${label} must be runtime-readable`);
  }
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

function protectedSurfaceChanged(candidate, expectedCurrent, files) {
  return files.some((relative) => {
    const candidateText = candidateSource(candidate, relative, false);
    const currentText = candidateSource(expectedCurrent, relative, false);
    return candidateText !== currentText;
  });
}

function sourceSha256(root, relative) {
  const canonicalSource = candidateSource(root, relative, false).replace(/\r\n?/g, '\n');
  return sha256(Buffer.from(canonicalSource, 'utf8'));
}

function trustedUnchangedToapisStandardSurface(candidate, expectedCurrent) {
  return FRESHNESS_SURFACES.toapis.every((relative) => {
    const candidateText = candidateSource(candidate, relative, false);
    const currentText = candidateSource(expectedCurrent, relative, false);
    return candidateText === currentText
      && sourceSha256(candidate, relative) === TRUSTED_UNCHANGED_TOAPIS_STANDARD_SURFACE_SHA256[relative];
  });
}

function freshnessRequirements(candidate, expectedCurrent, surfaces) {
  const toapis = surfaces.toapis
    && (protectedSurfaceChanged(candidate, expectedCurrent, FRESHNESS_SURFACES.toapis)
      || !trustedUnchangedToapisStandardSurface(candidate, expectedCurrent));
  return {
    toapis,
    toapisPrivateAvatar: protectedSurfaceChanged(candidate, expectedCurrent, FRESHNESS_SURFACES.toapisPrivateAvatar),
    toapisWan3: Boolean(surfaces.toapisWan3)
      && protectedSurfaceChanged(candidate, expectedCurrent, FRESHNESS_SURFACES.toapisWan3),
    usmercari: protectedSurfaceChanged(candidate, expectedCurrent, FRESHNESS_SURFACES.usmercari),
    lingjing: protectedSurfaceChanged(candidate, expectedCurrent, FRESHNESS_SURFACES.lingjing),
  };
}

function canStartRegexLiteral(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if ('([{,:;=!?&|+-*%^~<>'.includes(source[cursor])) return true;
  const prefix = source.slice(0, cursor + 1);
  return /(?:^|[^\w$])(?:return|throw|case|delete|typeof|void|new|in|of|yield|await)\s*$/.test(prefix);
}

function stripComments(source) {
  const withoutHtml = String(source || '').replace(/<!--[\s\S]*?-->/g, (value) => '\n'.repeat((value.match(/\n/g) || []).length));
  let output = '';
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
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
    if (regex) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '[') regexClass = true;
      else if (current === ']') regexClass = false;
      else if (current === '/' && !regexClass) regex = false;
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
    if (current === '/' && canStartRegexLiteral(withoutHtml, index)) {
      regex = true;
      regexClass = false;
      escaped = false;
      output += current;
      continue;
    }
    output += current;
  }
  return output;
}

function maskStrings(source) {
  let output = '';
  let quote = '';
  let regex = false;
  let regexClass = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const value = source[index];
    if (quote) {
      output += value === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (value === '\\') escaped = true;
      else if (value === quote) quote = '';
      continue;
    }
    if (regex) {
      output += value === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (value === '\\') escaped = true;
      else if (value === '[') regexClass = true;
      else if (value === ']') regexClass = false;
      else if (value === '/' && !regexClass) regex = false;
      continue;
    }
    if (value === '"' || value === "'" || value === '`') {
      quote = value;
      output += ' ';
    } else if (value === '/' && canStartRegexLiteral(source, index)) {
      regex = true;
      regexClass = false;
      escaped = false;
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
  if (surfaces.toapisWan3) {
    requirePattern(evidenceService, new RegExp(PROVIDERS.toapisWan3.contract),
      `evidence binding runtime is missing ${PROVIDERS.toapisWan3.contract}`);
  }
  if (surfaces.lingjing) {
    requirePattern(evidenceService, new RegExp(PROVIDERS.lingjing.contract), `evidence binding runtime is missing ${PROVIDERS.lingjing.contract}`);
  }
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
  if (surfaces.lingjing) requirePattern(catalog, /lingjing_open/, 'catalog runtime gate is missing Lingjing strict protocol');
}

function auditLingjingRuntime(candidate) {
  const client = stripComments(candidateSource(candidate, 'backend-node/src/services/lingjingVideoClient.js'));
  for (const [pattern, message] of [
    [/PUBLIC_MODEL\s*=\s*['"]lingjing-video-v1['"]/, 'Lingjing client public model is not locked'],
    [/UPSTREAM_MODEL\s*=\s*['"]relay['"]/, 'Lingjing client upstream model is not locked'],
    [/OFFICIAL_ORIGIN\s*=\s*['"]https:\/\/seed\.alimyun\.xyz['"]/, 'Lingjing client official origin is not locked'],
    [/\/api\/open\/v1/, 'Lingjing client official API path is not locked'],
    [/DURATIONS\s*=\s*Object\.freeze\s*\(\s*\[4,\s*5,\s*6,\s*8,\s*10,\s*11,\s*15\]\s*\)/, 'Lingjing client durations differ from the reviewed contract'],
    [/RATIOS\s*=\s*Object\.freeze\s*\(\s*\[['"]16:9['"],\s*['"]9:16['"],\s*['"]1:1['"],\s*['"]4:3['"],\s*['"]3:4['"],\s*['"]21:9['"]\]\s*\)/, 'Lingjing client ratios differ from the reviewed contract'],
    [/MAX_IMAGE_REFERENCES\s*=\s*9/, 'Lingjing client image-reference limit is not 9'],
    [/hostname\s*!==\s*['"]seed\.alimyun\.xyz['"]/, 'Lingjing client does not lock the official host'],
    [/protocol\s*!==\s*['"]https:['"]/, 'Lingjing client does not require HTTPS'],
    [/buildLingjingUploadUrl\s*\(/, 'Lingjing client upload endpoint is missing'],
    [/buildLingjingCreateUrl\s*\(/, 'Lingjing client create endpoint is missing'],
    [/buildLingjingStatusUrl\s*\(/, 'Lingjing client status endpoint is missing'],
    [/buildLingjingDownloadUrl\s*\(/, 'Lingjing client download endpoint is missing'],
    [/captureAudit/, 'Lingjing client cannot capture the paid verification audit receipt'],
    [/request_body_sha256/, 'Lingjing client audit receipt is missing the normalized request digest'],
    [/creation_response_sha256/, 'Lingjing client audit receipt is missing the creation response digest'],
    [/terminal_response_sha256/, 'Lingjing client audit receipt is missing the terminal response digest'],
    [/reference_sha256/, 'Lingjing client audit receipt is missing the uploaded reference binding'],
    [/supplier_cost_unavailable/, 'Lingjing client audit receipt is missing the supplier cost declaration'],
  ]) requirePattern(client, pattern, message);

  const dispatcher = stripComments(candidateSource(candidate, 'backend-node/src/services/videoClient.js'));
  const dispatch = /\bif\s*\(\s*protocol\s*===\s*['"]lingjing_open['"]\s*\)\s*\{/.exec(dispatcher);
  if (!dispatch) fail('Lingjing runtime protocol dispatch is missing');
  const dispatchBlock = balancedBlock(dispatcher, dispatch.index, 'Lingjing dispatch');
  const submitGateAt = firstIndex(dispatchBlock, [/\bassertLingjingVideoSubmitReady\s*\(/]);
  const submitAt = firstIndex(dispatchBlock, [/\bcallLingjingVideoApi\s*\(/]);
  if (submitGateAt < 0 || submitAt < 0 || submitGateAt > submitAt) {
    fail('Lingjing final verified/evidence/capability/price gate must run before provider submission');
  }
  const scopes = functionScopes(dispatcher);
  const submitGate = scopes.find((scope) => scope.name === 'assertLingjingVideoSubmitReady');
  if (!submitGate) fail('Lingjing final submit gate is missing');
  for (const [pattern, message] of [
    [/verification_status\s*(?:===|!==)\s*['"]verified['"]/, 'Lingjing submit gate does not require verified status'],
    [/hasConnectionCredential\s*\(/, 'Lingjing submit gate does not require credentials'],
    [/verified_capabilities|capabilities/, 'Lingjing submit gate does not read verified capabilities'],
    [/hasTrustedEvidenceBinding\s*\(/, 'Lingjing submit gate does not bind shared evidence'],
    [/MAX_IMAGE_REFERENCES/, 'Lingjing submit gate does not enforce the official image-reference ceiling'],
    [/MODEL_PRICE_NOT_CONFIGURED/, 'Lingjing submit gate does not fail closed on missing price'],
    [/calculateCharge\s*\(/, 'Lingjing submit gate does not recompute the exact charge'],
  ]) requirePattern(submitGate.source, pattern, message);

  const service = stripComments(candidateSource(candidate, 'backend-node/src/services/videoService.js'));
  const serviceScopes = functionScopes(service);
  const ready = serviceScopes.find((scope) => scope.name === 'lingjingReadyState');
  if (!ready) fail('Lingjing create-time ready gate is missing');
  for (const [pattern, message] of [
    [/verification_status\s*(?:===|!==)\s*['"]verified['"]/, 'Lingjing create-time gate does not require verified status'],
    [/hasConnectionCredential\s*\(/, 'Lingjing create-time gate does not require credentials'],
    [/verifiedCapabilitiesForModel\s*\(|verified_capabilities/, 'Lingjing create-time gate does not read verified capabilities'],
    [/hasTrustedEvidenceBinding\s*\(/, 'Lingjing create-time gate does not bind shared evidence'],
    [/MODEL_NOT_VERIFIED/, 'Lingjing create-time gate is not fail closed'],
  ]) requirePattern(ready.source, pattern, message);
  const createScope = serviceScopes.find((scope) => /\blingjingReadyState\s*\(/.test(scope.code)
    && sideEffectIndex(scope, 'video_generations') >= 0);
  if (!createScope) fail('Lingjing create-time gate is not connected to the generation side-effect path');
  requireCallsBeforeSideEffect(createScope, [
    [/\blingjingReadyState\s*\(/, 'verified configuration/capability/evidence'],
  ], 'video_generations', 'Lingjing runtime');
}

function auditToapisRuntime(candidate, options = {}) {
  const client = stripComments(candidateSource(candidate, 'backend-node/src/services/toapisVideoClient.js'));
  const clientScopes = functionScopes(client);
  const createClient = clientScopes.find((scope) => scope.name === 'callToapisVideoApi');
  const taskClient = clientScopes.find((scope) => scope.name === 'fetchToapisTask');
  if (!createClient || !taskClient) fail('ToAPIs request client functions are incomplete');
  requirePattern(createClient.source,
    /String\s*\(\s*requestOpts\.apiKey\s*\|\|\s*['"]['"]\s*\)\.trim\s*\(\s*\)\s*\|\|\s*resolveToapisApiKey\s*\(\s*config\s*\)/,
    'ToAPIs submission client does not prioritize an explicit request key');
  requirePattern(taskClient.source,
    /String\s*\(\s*opts\.apiKey\s*\|\|\s*['"]['"]\s*\)\.trim\s*\(\s*\)\s*\|\|\s*resolveToapisApiKey\s*\(\s*config\s*\)/,
    'ToAPIs polling client does not prioritize an explicit request key');
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
  requirePattern(client, /hostname\s*!==\s*['"]toapis\.xyz['"]/, 'ToAPIs client does not lock the official host');
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

  if (options.auditEvidenceProducer === true) {
  const verifier = stripComments(candidateSource(candidate, 'backend-node/scripts/verify-toapis-video-models.js'));
  const verifierScopes = functionScopes(verifier);
  const paidRun = verifierScopes.find((scope) => scope.name === 'runVerification');
  const capabilityBuilder = verifierScopes.find((scope) => scope.name === 'buildVerifiedCapabilities');
  const recorder = verifierScopes.find((scope) => scope.name === 'recordVerificationResult');
  const evidenceBinding = verifierScopes.find((scope) => scope.name === 'evidenceBindingForFile');
  const publisher = verifierScopes.find((scope) => scope.name === 'publishVerifiedEvidence');
  const configIdsReader = verifierScopes.find((scope) => scope.name === 'requireVerificationConfigIds');
  const configValidator = verifierScopes.find((scope) => scope.name === 'validateVerificationConfigs');
  const configFingerprint = verifierScopes.find((scope) => scope.name === 'verificationConfigFingerprint');
  const clientReader = verifierScopes.find((scope) => scope.name === 'verificationClientForModel');
  const balancePreflight = verifierScopes.find((scope) => scope.name === 'preflightVerificationBalances');
  const caseProcessor = verifierScopes.find((scope) => scope.name === 'processCase');
  const taskPoller = verifierScopes.find((scope) => scope.name === 'waitForTask');
  if (!paidRun || !capabilityBuilder || !recorder || !evidenceBinding || !publisher
      || !configIdsReader || !configValidator || !configFingerprint
      || !clientReader || !balancePreflight || !caseProcessor || !taskPoller) {
    fail('ToAPIs paid verification evidence-binding workflow is incomplete');
  }

  for (const [token, label] of [
    ['TOAPIS_VERIFY_FAST_CONFIG_ID', 'FAST'],
    ['TOAPIS_VERIFY_MINI_CONFIG_ID', 'MINI'],
  ]) {
    requirePattern(configIdsReader.source, new RegExp(`\\b${token}\\b`),
      `ToAPIs paid verification does not require the ${label} target config id`);
  }
  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    const escapedModel = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    requirePattern(configIdsReader.source,
      new RegExp(`Number\\.isInteger\\s*\\(\\s*configIds\\s*\\[\\s*['"]${escapedModel}['"]\\s*\\]\\s*\\)`),
      `ToAPIs paid verification does not validate the ${model} target config id`);
  }
  requirePattern(configIdsReader.source,
    /configIds\s*\[\s*['"]seedance-2-fast['"]\s*\]\s*===\s*configIds\s*\[\s*['"]seedance-2-mini['"]\s*\]/,
    'ToAPIs FAST and MINI paid verification config ids are not required to be distinct');

  const configIdsIndex = paidRun.source.indexOf('requireVerificationConfigIds');
  const configSnapshotsIndex = paidRun.source.indexOf('validateVerificationConfigs');
  const verificationClientsIndex = paidRun.source.indexOf('verificationClients');
  const balancePreflightIndex = paidRun.source.indexOf('preflightVerificationBalances');
  const caseLoopIndex = paidRun.source.indexOf('for (const item of selectedCases)');
  requirePattern(paidRun.source, /const\s+configIds\s*=\s*requireVerificationConfigIds\s*\(/,
    'ToAPIs paid verification does not require split target config ids');
  requirePattern(paidRun.source,
    /const\s+configSnapshots\s*=\s*validateVerificationConfigs\s*\(\s*\{\s*configIds\s*\}\s*\)/,
    'ToAPIs paid verification does not validate split target configs before submission');
  requirePattern(paidRun.source,
    /Object\.fromEntries\s*\(\s*configSnapshots\.map\s*\(/,
    'ToAPIs paid verification does not build model-specific clients from the validated split configs');
  requirePattern(paidRun.source,
    /context\.preflightBalances\s*=\s*await\s+preflightVerificationBalances\s*\(/,
    'ToAPIs paid verification does not preflight every selected model balance before submission');
  if (configIdsIndex < 0 || configSnapshotsIndex < 0 || verificationClientsIndex < 0
      || balancePreflightIndex < 0 || caseLoopIndex < 0
      || configIdsIndex > verificationClientsIndex || configSnapshotsIndex > verificationClientsIndex
      || verificationClientsIndex > balancePreflightIndex || balancePreflightIndex > caseLoopIndex) {
    fail('ToAPIs split target configs and balances must be validated before any paid verification case runs');
  }
  if (/\brequireApiKey\b|\bTOAPIS_API_KEY\b/.test(verifier)) {
    fail('ToAPIs paid verification must not fall back to one global provider key');
  }
  requirePattern(paidRun.source,
    /publishVerifiedEvidence\s*\([\s\S]{0,500}\{\s*configIds\s*,\s*configSnapshots\s*,\s*evidencePath\s*\}\s*\)/,
    'ToAPIs paid verification does not bind final evidence to both target config snapshots');

  requirePattern(configValidator.source, /openVerificationDb\s*\([\s\S]{0,160}\{\s*readonly\s*:\s*true\s*\}/,
    'ToAPIs split target configs are not validated through a read-only preflight');
  requirePattern(configValidator.source, /assertDedicatedVerificationConfig\s*\(/,
    'ToAPIs split target configs are not validated as dedicated model routes');
  requirePattern(configValidator.source, /verificationConfigFingerprint\s*\(/,
    'ToAPIs split target configs are not fingerprinted before paid verification');
  requirePattern(configValidator.source, /apiKey\s*=\s*String\s*\(\s*config\?*\.api_key/,
    'ToAPIs split target config credentials are not loaded from their database rows');
  requirePattern(configValidator.source,
    /snapshots\s*\[\s*0\s*\]\.apiKey\s*===\s*snapshots\s*\[\s*1\s*\]\.apiKey/,
    'ToAPIs FAST and MINI paid verification keys are not required to be distinct');
  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    requirePattern(configValidator.source, new RegExp(`['"]${model}['"]`),
      `ToAPIs config preflight does not include ${model}`);
  }
  requirePattern(clientReader.source, /context\?*\.verificationClients\?*\.\[\s*model\s*\]/,
    'ToAPIs paid verification does not select credentials by logical model');
  requirePattern(clientReader.source, /client\.config\?*\.api_key\s*!==\s*client\.apiKey/,
    'ToAPIs paid verification does not bind the selected client config to its model key');
  for (const [pattern, message] of [
    [/new\s+Set\s*\(/, 'ToAPIs balance preflight does not cover each selected model exactly once'],
    [/verificationClientForModel\s*\(/, 'ToAPIs balance preflight does not use model-bound credentials'],
    [/fetchBalance\s*\)\s*\(\s*client\.apiKey|fetchBalance\s*\(\s*client\.apiKey/, 'ToAPIs balance preflight does not query each model-bound key'],
  ]) requirePattern(balancePreflight.source, pattern, message);
  requirePattern(caseProcessor.source, /verificationClientForModel\s*\(\s*context\s*,\s*item\.model\s*\)/,
    'ToAPIs paid case does not select its model-bound client');
  requirePattern(caseProcessor.source, /client\.config/,
    'ToAPIs paid case does not submit and poll through its model-bound config');
  requirePattern(caseProcessor.source, /client\.apiKey/,
    'ToAPIs paid case does not measure billing through its model-bound key');
  if (/\bcontext(?:\?\.|\.)preflightBalances\b|\bpreflightBalances\s*\?\./.test(caseProcessor.source)) {
    fail('ToAPIs paid case reuses a stale balance preflight instead of a fresh per-case billing baseline');
  }
  const freshBalancePattern = /const\s+balanceBefore\s*=\s*await\s*\(\s*deps\.fetchBalance\s*\|\|\s*fetchBalance\s*\)\s*\(\s*client\.apiKey\s*,\s*deps\.fetchImpl\s*\)\s*;/;
  requirePattern(caseProcessor.source, freshBalancePattern,
    'ToAPIs paid case does not capture a fresh model-bound balance immediately before submission');
  const freshBalanceIndex = caseProcessor.source.search(freshBalancePattern);
  const submissionIndex = caseProcessor.source.search(/\b(?:createTask|callToapisVideoApi)\b/);
  if (submissionIndex < 0 || freshBalanceIndex > submissionIndex) {
    fail('ToAPIs paid case captures its billing baseline after the provider submission can start');
  }
  requirePattern(caseProcessor.source,
    /callToapisVideoApi\s*\)?\s*\([\s\S]{0,350}\{\s*fetchImpl\s*:\s*deps\.fetchImpl\s*,\s*apiKey\s*:\s*client\.apiKey\s*\}/,
    'ToAPIs paid submission does not pass its model-bound request key');
  requirePattern(caseProcessor.source,
    /waitForTask\s*\([\s\S]{0,500}\{\s*(?:\.\.\.deps\s*,\s*)?apiKey\s*:\s*client\.apiKey\s*\}/,
    'ToAPIs paid polling does not select its model-bound request key');
  requirePattern(taskPoller.source,
    /fetchToapisTask\s*\)?\s*\([\s\S]{0,300}\{[\s\S]{0,200}apiKey\s*:\s*deps\.apiKey[\s\S]{0,100}\}/,
    'ToAPIs paid polling does not forward its model-bound request key');
  requirePattern(configFingerprint.source, /createHash\s*\(\s*['"]sha256['"]\s*\)/,
    'ToAPIs config fingerprint is not SHA-256');
  for (const field of [
    'id', 'service_type', 'provider', 'api_protocol', 'base_url', 'api_key', 'model', 'default_model',
    'logical_model_id', 'endpoint', 'query_endpoint', 'settings', 'is_active', 'canary_paused', 'failover_enabled',
  ]) {
    requirePattern(configFingerprint.source, new RegExp(`\\b${field}\\s*:`),
      `ToAPIs config fingerprint does not bind ${field}`);
  }

  requirePattern(publisher.source, /hasCompleteRequiredMatrix\s*\(/,
    'ToAPIs final evidence can be published before all real cases are reviewed');
  requirePattern(publisher.source, /hasCompletePricing\s*\(/,
    'ToAPIs final evidence can be published before pricing is reviewed');
  const publishIndex = publisher.source.indexOf('writeJsonAtomic');
  if (publishIndex < 0
      || publisher.source.indexOf('hasCompleteRequiredMatrix') > publishIndex
      || publisher.source.indexOf('hasCompletePricing') > publishIndex) {
    fail('ToAPIs final evidence is written before review and pricing gates');
  }
  requirePattern(publisher.source, /restoreEvidenceFile\s*\(/,
    'ToAPIs final evidence is not restored when DB binding writeback fails');
  const recorderCallIndex = publisher.source.indexOf('return recorder');
  if (recorderCallIndex < 0) fail('ToAPIs final publisher does not call the split config recorder');
  const recorderCallSource = publisher.source.slice(recorderCallIndex, recorderCallIndex + 700);
  for (const [pattern, message] of [
    [/configIds\s*:\s*options\.configIds/, 'ToAPIs final publisher does not forward both target config ids'],
    [/configSnapshots\s*:\s*options\.configSnapshots/, 'ToAPIs final publisher does not forward both target config snapshots'],
    [/evidencePath(?:\s*:\s*evidencePath)?\s*[,}]/, 'ToAPIs final publisher does not forward the final evidence path'],
  ]) requirePattern(recorderCallSource, pattern, message);
  if (/\brecordVerificationResult\s*\(/.test(paidRun.source)) {
    fail('ToAPIs workflow failures can still invalidate an existing trusted verification');
  }
  requirePattern(evidenceBinding.source, /createHash\s*\(\s*['"]sha256['"]\s*\)/,
    'ToAPIs evidence binding does not hash the final evidence bytes');
  requirePattern(capabilityBuilder.source, /normalizeEvidenceBinding\s*\(/,
    'ToAPIs verified capabilities do not require a normalized evidence binding');
  requirePattern(capabilityBuilder.source, /\.\.\.binding/,
    'ToAPIs verified capabilities do not persist the final evidence binding');
  requirePattern(recorder.source, /db\.transaction\s*\(/,
    'ToAPIs config evidence binding is not written transactionally');
  requirePattern(recorder.source, /\.immediate\s*\(\s*\)/,
    'ToAPIs split config evidence binding is not committed in one immediate transaction');
  requirePattern(recorder.source, /configSnapshots\s*=\s*new\s+Map\s*\(/,
    'ToAPIs config evidence binding does not require both preflight snapshots');
  requirePattern(recorder.source, /configSnapshots\.size\s*!==\s*2/,
    'ToAPIs config evidence binding does not require exactly two preflight snapshots');
  requirePattern(recorder.source,
    /snapshot(?:\?\.|\.)fingerprint\s*!==\s*verificationConfigFingerprint\s*\(\s*config\s*\)/,
    'ToAPIs config evidence binding does not reject config drift after paid verification');
  requirePattern(recorder.source, /capabilities\s*:\s*\{\s*\[\s*model\s*\]\s*:\s*capabilities\s*\[\s*model\s*\]\s*\}/,
    'ToAPIs config evidence binding does not isolate each model capability to its dedicated config');
  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    requirePattern(recorder.source, new RegExp(`['"]${model}['"]`),
      `ToAPIs config writeback does not verify ${model}`);
  }
  }

  const preflight = stripComments(candidateSource(candidate, 'backend-node/src/services/productionPreflightService.js'));
  const preflightScopes = functionScopes(preflight);
  const bindingCheck = preflightScopes.find((scope) => scope.name === 'externalModelEvidenceBindingsReady');
  const productionPreflight = preflightScopes.find((scope) => scope.name === 'runProductionPreflight');
  if (!bindingCheck || !productionPreflight) fail('ToAPIs production DB/evidence preflight is missing');
  requirePattern(bindingCheck.source, /mediaModelSelection\.orderedModels\s*\(/,
    'ToAPIs production preflight does not inspect every configured model');
  requirePattern(bindingCheck.source, /hasTrustedEvidenceBinding\s*\(/,
    'ToAPIs production preflight does not validate exact evidence bindings');
  if (/Object\.hasOwn\s*\([^)]*capabilitiesByModel/.test(bindingCheck.source)) {
    fail('ToAPIs production preflight skips configured models with missing capabilities');
  }
  requirePattern(productionPreflight.source, /externalModelEvidenceBindingsReady\s*\(/,
    'ToAPIs production preflight does not execute the evidence binding audit');
  requirePattern(productionPreflight.source, /['"]external_model_evidence_binding['"]/,
    'ToAPIs production preflight does not expose a blocking evidence check');
}

function auditToapisWan3Runtime(candidate, options = {}) {
  const client = stripComments(candidateSource(candidate, 'backend-node/src/services/toapisWan3VideoClient.js'));
  const sharedClient = stripComments(candidateSource(candidate, 'backend-node/src/services/toapisVideoClient.js'));
  const scopes = functionScopes(client);
  const validator = scopes.find((scope) => scope.name === 'validateToapisWan3VideoOptions');
  const bodyBuilder = scopes.find((scope) => scope.name === 'buildToapisWan3VideoBody');
  const submitter = scopes.find((scope) => scope.name === 'callToapisWan3VideoApi');
  const poller = scopes.find((scope) => scope.name === 'fetchToapisWan3Task');
  const unknown = scopes.find((scope) => scope.name === 'indeterminateCreateError');
  const keyResolver = scopes.find((scope) => scope.name === 'resolveToapisWan3ApiKey');
  const durationValidator = scopes.find((scope) => scope.name === 'validateReferenceDurations');
  if (!validator || !bodyBuilder || !submitter || !poller || !unknown || !keyResolver || !durationValidator) {
    fail('ToAPIs Wan 3.0 request client functions are incomplete');
  }
  for (const [pattern, message] of [
    [/TOAPIS_WAN3_MODEL\s*=\s*['"]wan3\.0-video['"]/, 'ToAPIs Wan 3.0 model is not locked'],
    [/aspectRatios\s*:\s*Object\.freeze\s*\(\s*\[['"]adaptive['"],\s*['"]16:9['"],\s*['"]9:16['"],\s*['"]1:1['"],\s*['"]4:3['"],\s*['"]3:4['"]\]\s*\)/, 'ToAPIs Wan 3.0 ratios differ from the reviewed contract'],
    [/durations\s*:\s*Object\.freeze\s*\(\s*Array\.from\s*\(\s*\{\s*length\s*:\s*29\s*\}/, 'ToAPIs Wan 3.0 duration range is not 2 through 30 seconds'],
    [/resolutions\s*:\s*Object\.freeze\s*\(\s*\[['"]480p['"],\s*['"]720p['"],\s*['"]1080p['"]\]\s*\)/, 'ToAPIs Wan 3.0 resolutions differ from the reviewed contract'],
    [/maxReferences\s*:\s*10\b/, 'ToAPIs Wan 3.0 image-reference limit is not 10'],
    [/maxVideoReferences\s*:\s*5\b/, 'ToAPIs Wan 3.0 video-reference limit is not 5'],
    [/maxAudioReferences\s*:\s*5\b/, 'ToAPIs Wan 3.0 audio-reference limit is not 5'],
    [/maxReferenceMediaDurationSeconds\s*:\s*15\b/, 'ToAPIs Wan 3.0 reference-media duration limit is not 15 seconds'],
    [/supportsFirstFrame\s*:\s*true/, 'ToAPIs Wan 3.0 first-frame capability is missing'],
    [/supportsLastFrame\s*:\s*true/, 'ToAPIs Wan 3.0 last-frame capability is missing'],
    [/supportsAudio\s*:\s*true/, 'ToAPIs Wan 3.0 output-audio capability is missing'],
  ]) requirePattern(client, pattern, message);
  requirePattern(sharedClient, /hostname\s*!==\s*['"]toapis\.xyz['"]/, 'ToAPIs Wan 3.0 shared URL normalizer does not lock the official host');
  requirePattern(sharedClient, /protocol\s*!==\s*['"]https:['"]/, 'ToAPIs Wan 3.0 shared URL normalizer does not require HTTPS');

  for (const [pattern, message] of [
    [/opts\.duration\s*==\s*null/, 'ToAPIs Wan 3.0 validation does not require an explicit duration'],
    [/Number\.isSafeInteger\s*\(\s*duration\s*\)/, 'ToAPIs Wan 3.0 duration validation does not require an integer'],
    [/images\.length\s*>\s*TOAPIS_WAN3_SPEC\.maxReferences/, 'ToAPIs Wan 3.0 image-reference ceiling is not enforced'],
    [/videos\.length\s*>\s*TOAPIS_WAN3_SPEC\.maxVideoReferences/, 'ToAPIs Wan 3.0 video-reference ceiling is not enforced'],
    [/audio\.length\s*>\s*TOAPIS_WAN3_SPEC\.maxAudioReferences/, 'ToAPIs Wan 3.0 audio-reference ceiling is not enforced'],
    [/validateReferenceDurations\s*\(\s*videos\s*,\s*opts\.reference_video_durations/, 'ToAPIs Wan 3.0 video-reference duration is not fail closed'],
    [/validateReferenceDurations\s*\(\s*audio\s*,\s*opts\.reference_audio_durations/, 'ToAPIs Wan 3.0 audio-reference duration is not fail closed'],
    [/\(firstFrame\s*\|\|\s*lastFrame\)\s*&&\s*\(images\.length\s*\|\|\s*videos\.length\s*\|\|\s*audio\.length\)/, 'ToAPIs Wan 3.0 does not enforce frame/reference mutual exclusion'],
    [/lastFrame\s*&&\s*!firstFrame/, 'ToAPIs Wan 3.0 allows a last frame without a first frame'],
    [/parsed\.protocol\s*!==\s*['"]https:['"]/, 'ToAPIs Wan 3.0 references are not restricted to HTTPS'],
    [/isPrivateHost\s*\(\s*parsed\.hostname\s*\)/, 'ToAPIs Wan 3.0 references are not protected from private hosts'],
  ]) requirePattern(client, pattern, message);

  for (const [pattern, message] of [
    [/reference_images/, 'ToAPIs Wan 3.0 request body is missing reference_images'],
    [/video_list/, 'ToAPIs Wan 3.0 request body is missing video_list'],
    [/audio_with_roles/, 'ToAPIs Wan 3.0 request body is missing audio_with_roles'],
    [/image_with_roles/, 'ToAPIs Wan 3.0 request body is missing image_with_roles'],
    [/['"]first_frame['"]/, 'ToAPIs Wan 3.0 request body is missing first_frame'],
    [/['"]last_frame['"]/, 'ToAPIs Wan 3.0 request body is missing last_frame'],
    [/client_business_id/, 'ToAPIs Wan 3.0 request body is missing a recovery identifier'],
  ]) requirePattern(bodyBuilder.source, pattern, message);

  requirePattern(durationValidator.source,
    /total\s*>\s*TOAPIS_WAN3_SPEC\.maxReferenceMediaDurationSeconds/,
    'ToAPIs Wan 3.0 reference-media total duration is not enforced');
  if (/\bTOAPIS_API_KEY\b/.test(keyResolver.source)) {
    fail('ToAPIs Wan 3.0 key resolver must not inherit the legacy global ToAPIs key');
  }
  const explicitKeyIndex = keyResolver.source.indexOf('explicitApiKey');
  const configKeyIndex = keyResolver.source.indexOf('config.api_key');
  const wanEnvKeyIndex = keyResolver.source.indexOf('TOAPIS_WAN3_API_KEY');
  if (explicitKeyIndex < 0 || configKeyIndex < 0 || wanEnvKeyIndex < 0
      || explicitKeyIndex > configKeyIndex || configKeyIndex > wanEnvKeyIndex) {
    fail('ToAPIs Wan 3.0 key priority must be request key, config key, then Wan-only environment key');
  }
  requirePattern(submitter.source,
    /resolveToapisWan3ApiKey\s*\(\s*config\s*,\s*requestOpts\.apiKey\s*\)/,
    'ToAPIs Wan 3.0 submission does not use the isolated request/config key resolver');
  for (const [pattern, message] of [
    [/!body\.client_business_id/, 'ToAPIs Wan 3.0 submission does not require a stable recovery id'],
    [/RECOVERY_ID_REQUIRED/, 'ToAPIs Wan 3.0 recovery-id failure is not fail closed'],
    [/\/v1\/videos\/generations/, 'ToAPIs Wan 3.0 official generation path is missing'],
    [/method\s*:\s*['"]POST['"]/, 'ToAPIs Wan 3.0 submission is not a POST'],
    [/response\.status\s*===\s*408\s*\|\|\s*response\.status\s*>=\s*500/, 'ToAPIs Wan 3.0 does not classify ambiguous HTTP failures'],
    [/TOAPIS_WAN3_TASK_ID_MISSING/, 'ToAPIs Wan 3.0 missing task id is not indeterminate'],
  ]) requirePattern(submitter.source, pattern, message);
  if (/\bretry\b/i.test(submitter.source)) fail('ToAPIs Wan 3.0 submission must not retry an unknown request');
  requirePattern(unknown.source, /indeterminate\s*:\s*true/, 'ToAPIs Wan 3.0 unknown result is not marked indeterminate');
  requirePattern(unknown.source, /requestBodySent\s*:\s*true/, 'ToAPIs Wan 3.0 unknown result does not preserve submission state');
  for (const [pattern, message] of [
    [/parseToapisTask\s*\(/, 'ToAPIs Wan 3.0 polling does not use the protected task parser'],
    [/\/v1\/videos\/generations\/\$\{encodeURIComponent\(id\)\}/, 'ToAPIs Wan 3.0 polling path is not locked to the provider task id'],
    [/method\s*:\s*['"]GET['"]/, 'ToAPIs Wan 3.0 polling is not read only'],
    [/queryFailed\s*:\s*true/, 'ToAPIs Wan 3.0 polling does not preserve query uncertainty'],
    [/terminalFailure\s*:\s*true/, 'ToAPIs Wan 3.0 polling does not identify provider terminal failure'],
    [/artifactUnreadable\s*:\s*true/, 'ToAPIs Wan 3.0 polling does not hold unreadable artifacts for review'],
  ]) requirePattern(poller.source, pattern, message);
  requirePattern(poller.source, /resolveToapisWan3ApiKey\s*\(\s*config\s*,\s*opts\.apiKey\s*\)/,
    'ToAPIs Wan 3.0 polling does not use the isolated request/config key resolver');

  if (options.auditEvidenceProducer !== true) return;
  const verifier = stripComments(candidateSource(candidate, 'backend-node/scripts/verify-toapis-wan3-video.js'));
  const verifierScopes = functionScopes(verifier);
  const run = verifierScopes.find((scope) => scope.name === 'runWan3Verification');
  const resume = verifierScopes.find((scope) => scope.name === 'decideWan3ResumeAction');
  const evidence = verifierScopes.find((scope) => scope.name === 'buildWan3Evidence');
  const budget = verifierScopes.find((scope) => scope.name === 'requireBudget');
  const balanceGate = verifierScopes.find((scope) => scope.name === 'assertBalanceCanCover');
  const billingCheckpoint = verifierScopes.find((scope) => scope.name === 'hasWan3BillingCheckpoint');
  const taskWaiter = verifierScopes.find((scope) => scope.name === 'waitForTask');
  if (!run || !resume || !evidence || !budget || !balanceGate || !billingCheckpoint || !taskWaiter) {
    fail('ToAPIs Wan 3.0 paid verification workflow is incomplete');
  }
  for (const token of [
    'toapis-wan3-video-real-verification-v1',
    'wan3-t2v-480p-2s-no-audio',
    'TOAPIS_WAN3_EXPECTED_COST_YUAN',
    'TOAPIS_WAN3_HARD_CAP_YUAN',
    'TOAPIS_USD_CNY_RATE',
  ]) requirePattern(verifier, new RegExp(token), `ToAPIs Wan 3.0 paid verification is missing ${token}`);
  requirePattern(resume.source, /provider_task_id[\s\S]{0,160}hasCompleteWan3Artifact[\s\S]{0,80}return\s+['"]finalize['"]/, 'ToAPIs Wan 3.0 verifier cannot safely finalize a downloaded artifact');
  requirePattern(resume.source, /provider_task_id[\s\S]{0,160}return\s+['"]poll['"]/, 'ToAPIs Wan 3.0 verifier cannot safely resume a known task');
  requirePattern(resume.source, /return\s+['"]stop['"]/, 'ToAPIs Wan 3.0 verifier does not stop an unknown submission');
  requirePattern(budget.source, /expectedCostYuan\s*>\s*hardCapYuan/, 'ToAPIs Wan 3.0 verifier does not fail before an over-budget submission');
  requirePattern(balanceGate.source, /remain_balance/, 'ToAPIs Wan 3.0 verifier does not require a balance preflight');
  requirePattern(billingCheckpoint.source, /billing\?\.after[\s\S]{0,600}cost_yuan/, 'ToAPIs Wan 3.0 verifier does not recognize a durable billing checkpoint');
  requirePattern(taskWaiter.source, /provider_task_id|taskId/, 'ToAPIs Wan 3.0 verifier does not poll the accepted task id');
  requirePattern(run.source, /action\s*===\s*['"]complete['"][\s\S]{0,240}writeJsonAtomic\(paths\.evidencePath\s*,\s*evidence\)/, 'ToAPIs Wan 3.0 verifier does not restore a missing evidence file');
  requirePattern(run.source, /!hasWan3BillingCheckpoint\(state\.case\.billing\)[\s\S]{0,600}cost_yuan[\s\S]{0,200}writeJsonAtomic\(paths\.statePath\s*,\s*state\)/, 'ToAPIs Wan 3.0 verifier does not persist billing before final evidence');

  const balanceAt = run.source.indexOf('fetchBalance');
  const submittingAt = run.source.indexOf("status: 'submitting'");
  const durableAt = run.source.indexOf('writeJsonAtomic(paths.statePath, state)', submittingAt);
  const submitAt = firstIndex(run.source, [/\bdeps\.createTask\b/, /\bcallToapisWan3VideoApi\b/]);
  if (balanceAt < 0 || submittingAt < 0 || durableAt < 0 || submitAt < 0
      || balanceAt > submitAt || submittingAt > submitAt || durableAt > submitAt) {
    fail('ToAPIs Wan 3.0 verifier must preflight balance and durably record submitting before POST');
  }
  for (const [pattern, message] of [
    [/created\?\.indeterminate/, 'ToAPIs Wan 3.0 verifier does not handle an indeterminate submission'],
    [/state\.case\.status\s*=\s*['"]indeterminate['"]/, 'ToAPIs Wan 3.0 verifier does not persist indeterminate state'],
    [/writeJsonAtomic\s*\(\s*paths\.statePath\s*,\s*state\s*\)/, 'ToAPIs Wan 3.0 verifier does not durably persist state'],
    [/downloadAndInspect/, 'ToAPIs Wan 3.0 verifier does not validate a readable artifact'],
    [/calculateBalanceDelta/, 'ToAPIs Wan 3.0 verifier does not reconcile billing'],
    [/costYuan\s*>\s*budget\.hardCapYuan/, 'ToAPIs Wan 3.0 verifier does not enforce the actual-cost hard cap'],
  ]) requirePattern(run.source, pattern, message);
  requirePattern(evidence.source, /contract_version\s*:\s*EVIDENCE_VERSION/, 'ToAPIs Wan 3.0 evidence does not bind the dedicated contract');
  requirePattern(evidence.source, /results\s*:\s*\[/, 'ToAPIs Wan 3.0 evidence does not publish a real result array');
  requirePattern(evidence.source, /verified_capabilities/, 'ToAPIs Wan 3.0 evidence does not bind verified capabilities');
}

function auditToapisPrivateAvatarProducer(candidate) {
  const verifier = stripComments(candidateSource(candidate, 'backend-node/scripts/verify-toapis-private-avatar-video.js'));
  const scopes = functionScopes(verifier);
  const requiredScopes = Object.fromEntries([
    'runPrivateAvatarVerification',
    'cliInput',
    'verificationClientForModel',
    'bindAndValidateState',
    'assertNoUnknownSubmission',
    'normalizeCostBudget',
    'assertActualCostWithinBudget',
    'ensureAvatar',
    'processCase',
  ].map((name) => [name, scopes.find((scope) => scope.name === name)]));
  if (Object.values(requiredScopes).some((scope) => !scope)) {
    fail('ToAPIs private-avatar split-key verification workflow is incomplete');
  }
  const run = requiredScopes.runPrivateAvatarVerification;
  const cli = requiredScopes.cliInput;
  const clientReader = requiredScopes.verificationClientForModel;
  const stateBinding = requiredScopes.bindAndValidateState;
  const unknownGate = requiredScopes.assertNoUnknownSubmission;
  const budgetBuilder = requiredScopes.normalizeCostBudget;
  const actualBudgetGate = requiredScopes.assertActualCostWithinBudget;
  const avatar = requiredScopes.ensureAvatar;
  const caseProcessor = requiredScopes.processCase;

  const globalKeyReferences = [...verifier.matchAll(/\bTOAPIS_API_KEY\b/g)].length;
  requirePattern(run.source,
    /const\s+executionEnv\s*=\s*input\.env\s*\|\|\s*process\.env[\s\S]{0,180}if\s*\(\s*String\s*\(\s*executionEnv\.TOAPIS_API_KEY\s*\|\|\s*['"]['"]\s*\)\.trim\s*\(\s*\)\s*\)\s*\{[\s\S]{0,180}throw\s+new\s+Error/,
    'ToAPIs private-avatar verification does not reject the global provider key before any provider work');
  if (globalKeyReferences !== 2 || /process\.env\.TOAPIS_API_KEY/.test(verifier)) {
    fail('ToAPIs private-avatar verification must not fall back to one global provider key');
  }

  requirePattern(verifier,
    /requireVerificationConfigIds\s*,\s*validateVerificationConfigs[\s\S]{0,120}require\s*\(\s*['"]\.\/verify-toapis-video-models['"]\s*\)/,
    'ToAPIs private-avatar verification does not reuse the reviewed read-only split config validator');
  for (const [token, label] of [
    ['TOAPIS_VERIFY_FAST_CONFIG_ID', 'FAST'],
    ['TOAPIS_VERIFY_MINI_CONFIG_ID', 'MINI'],
  ]) {
    requirePattern(cli.source, new RegExp(`\\b${token}\\b`),
      `ToAPIs private-avatar verification does not require the ${label} target config id`);
    requirePattern(run.source, new RegExp(`\\b${token}\\b`),
      `ToAPIs private-avatar verification does not forward the ${label} target config id`);
  }
  requirePattern(run.source,
    /const\s+configSnapshots\s*=\s*\(\s*injected\.validateConfigs\s*\|\|\s*validateVerificationConfigs\s*\)\s*\(\s*\{[\s\S]{0,180}\bconfigIds\b[\s\S]{0,180}\bdatabasePath\b/,
    'ToAPIs private-avatar verification bypasses the read-only database model binding');
  requirePattern(run.source,
    /Object\.fromEntries\s*\(\s*configSnapshots\.map\s*\(\s*\(\s*\{\s*model\s*,\s*apiKey\s*\}\s*\)\s*=>\s*\[\s*model\s*,\s*\{[\s\S]{0,180}apiKey[\s\S]{0,180}api_key\s*:\s*apiKey/,
    'ToAPIs private-avatar verification does not build one model-bound client per validated config');
  requirePattern(clientReader.source, /context\.verificationClients\?*\.\[\s*model\s*\]/,
    'ToAPIs private-avatar verification does not select credentials by case model');
  requirePattern(clientReader.source, /client\.config\?*\.api_key\s*!==\s*client\.apiKey/,
    'ToAPIs private-avatar verification does not bind each client config to its database key');

  requirePattern(stateBinding.source, /configFingerprints\s*\(\s*configSnapshots\s*\)/,
    'ToAPIs private-avatar verification does not derive split config fingerprints');
  for (const token of ['provider_origin', 'config_fingerprints', 'config_fingerprint']) {
    requirePattern(stateBinding.source, new RegExp(`\\b${token}\\b`),
      `ToAPIs private-avatar state is not bound to ${token}`);
  }
  requirePattern(run.source, /const\s+fingerprints\s*=\s*bindAndValidateState\s*\(\s*state\s*,\s*configSnapshots\s*\)/,
    'ToAPIs private-avatar verification does not bind resumable state to both config fingerprints');
  requirePattern(caseProcessor.source, /config_fingerprint\s*:\s*context\.configFingerprints\s*\[\s*item\.model\s*\]/,
    'ToAPIs private-avatar evidence cases are not bound to their model config fingerprints');

  for (const token of ['submitting', 'indeterminate']) {
    requirePattern(unknownGate.source, new RegExp(`['"]${token}['"]`),
      `ToAPIs private-avatar unknown-state gate does not block ${token} submissions`);
  }
  requirePattern(run.source, /assertNoUnknownSubmission\s*\(\s*state\s*\)/,
    'ToAPIs private-avatar verification does not stop before resuming an unknown submission');
  requirePattern(caseProcessor.source,
    /entry\.submission_state\s*=\s*['"]submitting['"][\s\S]{0,160}context\.save\s*\(\s*\)[\s\S]{0,260}(?:deps\.callVideo|callToapisVideoApi)/,
    'ToAPIs private-avatar submission intent is not durably recorded before POST');
  requirePattern(caseProcessor.source,
    /result\.indeterminate[\s\S]{0,180}entry\.submission_state\s*=\s*['"]indeterminate['"][\s\S]{0,180}context\.save\s*\(\s*\)[\s\S]{0,120}throw/,
    'ToAPIs private-avatar unknown submission result is not persisted and stopped');
  const count = (source, pattern) => [...source.matchAll(pattern)].length;
  if (count(caseProcessor.source, /\bdeps\.callVideo\s*\(/g) !== 1
      || count(avatar.source, /\bdeps\.createGroup\s*\(/g) !== 1
      || count(avatar.source, /\bdeps\.createAsset\s*\(/g) !== 1) {
    fail('ToAPIs private-avatar paid submissions must be single-attempt with no automatic retry');
  }
  requirePattern(avatar.source,
    /const\s+client\s*=\s*verificationClientForModel\s*\(\s*context\s*,\s*['"]seedance-2-fast['"]\s*\)/,
    'ToAPIs private-avatar asset preparation does not select the FAST model client');
  for (const [operation, limit] of [
    ['createGroup', 360],
    ['createAsset', 360],
    ['fetchAsset', 260],
  ]) {
    requirePattern(avatar.source,
      new RegExp(`deps\\.${operation}\\s*\\(\\s*client\\.config[\\s\\S]{0,${limit}}apiKey\\s*:\\s*client\\.apiKey`),
      `ToAPIs private-avatar ${operation} does not use the FAST model key`);
  }

  for (const token of ['expectedCosts', 'caseHardCaps', 'aggregateHardCapYuan', 'usdCnyRate']) {
    requirePattern(budgetBuilder.source, new RegExp(`\\b${token}\\b`),
      `ToAPIs private-avatar RMB budget is missing ${token}`);
  }
  requirePattern(budgetBuilder.source, /projected\s*>\s*aggregateHardCapYuan/,
    'ToAPIs private-avatar expected total cost does not enforce the RMB hard cap');
  requirePattern(actualBudgetGate.source, /actual\s*>\s*caseCap/,
    'ToAPIs private-avatar actual cost does not enforce the per-case RMB hard cap');
  requirePattern(actualBudgetGate.source, /projected\s*>\s*context\.costBudget\.aggregateHardCapYuan/,
    'ToAPIs private-avatar actual cost does not enforce the aggregate RMB hard cap');
  const actualBudgetCalls = [...caseProcessor.source.matchAll(/assertActualCostWithinBudget\s*\(\s*item\s*,\s*context\s*\)/g)];
  if (actualBudgetCalls.length !== 2) {
    fail('ToAPIs private-avatar paid case must enforce actual RMB cost gates on resume and after provider billing');
  }
  const resumeIndex = caseProcessor.source.search(/if\s*\(\s*entry\?\.status\s*===\s*['"]completed['"]\s*\)/);
  const resumeReturnIndex = caseProcessor.source.indexOf('return entry', resumeIndex);
  const resumeGateIndex = actualBudgetCalls[0].index;
  if (resumeIndex < 0 || resumeReturnIndex < 0 || !(resumeIndex < resumeGateIndex && resumeGateIndex < resumeReturnIndex)) {
    fail('ToAPIs private-avatar completed resume path must validate actual RMB cost before returning');
  }
  const actualCostIndex = caseProcessor.source.indexOf('entry.billing.cost_yuan');
  const completedStatusIndex = caseProcessor.source.search(/entry\.status\s*=\s*['"]completed['"]/);
  const postBillingGateIndex = actualBudgetCalls[1].index;
  if (actualCostIndex < 0 || completedStatusIndex < 0
      || !(actualCostIndex < postBillingGateIndex && postBillingGateIndex < completedStatusIndex)) {
    fail('ToAPIs private-avatar paid case must validate actual RMB cost after billing and before completed status');
  }

  const configIdsIndex = run.source.indexOf('requireVerificationConfigIds');
  const configsIndex = run.source.indexOf('validateVerificationConfigs');
  const clientsIndex = run.source.indexOf('verificationClients');
  const stateBindingIndex = run.source.indexOf('bindAndValidateState');
  const unknownIndex = run.source.indexOf('assertNoUnknownSubmission');
  const budgetIndex = run.source.indexOf('normalizeCostBudget');
  const preflightPattern = /for\s*\(\s*const\s+item\s+of\s+CASES\s*\)\s*\{[\s\S]{0,260}verificationClientForModel\s*\(\s*context\s*,\s*item\.model\s*\)[\s\S]{0,220}await\s+deps\.fetchBalance\s*\(\s*client\.apiKey\s*,\s*deps\.fetchImpl\s*\)/;
  const preflightIndex = run.source.search(preflightPattern);
  const avatarIndex = run.source.indexOf('await ensureAvatar');
  if ([configIdsIndex, configsIndex, clientsIndex, stateBindingIndex, unknownIndex, budgetIndex, preflightIndex, avatarIndex]
    .some((index) => index < 0)
      || !(configIdsIndex < configsIndex && configsIndex < clientsIndex
        && clientsIndex < stateBindingIndex && stateBindingIndex < unknownIndex
        && unknownIndex < budgetIndex && budgetIndex < preflightIndex && preflightIndex < avatarIndex)) {
    fail('ToAPIs private-avatar split configs, state, budget and both balance GETs must pass before any provider POST');
  }
  requirePattern(caseProcessor.source,
    /const\s+client\s*=\s*verificationClientForModel\s*\(\s*context\s*,\s*item\.model\s*\)/,
    'ToAPIs private-avatar case does not select its model-bound client');
  const caseBalancePattern = /before\s*:\s*await\s+deps\.fetchBalance\s*\(\s*client\.apiKey\s*,\s*deps\.fetchImpl\s*\)/;
  const caseBalanceIndex = caseProcessor.source.search(caseBalancePattern);
  const caseSubmitIndex = caseProcessor.source.search(/\bdeps\.callVideo\s*\(/);
  if (caseBalanceIndex < 0 || caseSubmitIndex < 0 || caseBalanceIndex > caseSubmitIndex) {
    fail('ToAPIs private-avatar case must take a fresh model-bound balance immediately before submission');
  }
  requirePattern(caseProcessor.source,
    /deps\.callVideo\s*\([\s\S]{0,380}client\.config[\s\S]{0,380}apiKey\s*:\s*client\.apiKey/,
    'ToAPIs private-avatar submission does not use its case model key');
  requirePattern(caseProcessor.source,
    /deps\.fetchTask\s*\([\s\S]{0,220}client\.config[\s\S]{0,220}apiKey\s*:\s*client\.apiKey/,
    'ToAPIs private-avatar polling does not use its case model key');
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
  const knownContracts = new Set(Object.values(PROVIDERS).flatMap((provider) => [
    provider.contract,
    provider.privateAvatarContract,
  ].filter(Boolean)));
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
    if (required && provider.privateAvatarContract) {
      const avatarRecord = manifest.evidence[provider.privateAvatarContract];
      if (!avatarRecord) fail(`${provider.label} private-avatar fixed manifest entry is missing`);
      if (avatarRecord.file !== provider.privateAvatarEvidenceFile) {
        fail(`${provider.label} private-avatar manifest file must be ${provider.privateAvatarEvidenceFile}`);
      }
      const avatarSha = String(avatarRecord.sha256 || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(avatarSha)) fail(`${provider.label} private-avatar manifest SHA-256 is invalid`);
      const avatarFile = secureFile(evidenceRoot, provider.privateAvatarEvidenceFile, `${provider.label} private-avatar evidence JSON`, { basenameOnly: true, rootOwned: true });
      const avatarBytes = fs.readFileSync(avatarFile.path);
      if (sha256(avatarBytes) !== avatarSha) fail(`${provider.label} private-avatar evidence JSON does not match the manifest SHA-256`);
      output[`${key}PrivateAvatar`] = { evidence: parseJsonBytes(avatarBytes, `${provider.label} private-avatar evidence JSON`), sha256: avatarSha };
    }
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

function auditFreshness(evidence, label, now, requireRecent = true) {
  const generatedAt = canonicalTimestamp(evidence.generated_at, `${label} generated_at`);
  const validUntil = canonicalTimestamp(evidence.valid_until, `${label} valid_until`);
  if (generatedAt > now) fail(`${label} evidence is generated in the future`);
  if (requireRecent && now - generatedAt > 24 * 60 * 60 * 1_000) fail(`${label} evidence is stale (maximum age is 24 hours)`);
  if (requireRecent && validUntil <= now) fail(`${label} evidence is expired`);
  if (validUntil <= generatedAt) fail(`${label} valid_until must be after generated_at`);
  if (validUntil - generatedAt > 7 * 24 * 60 * 60 * 1_000) fail(`${label} evidence validity window exceeds 7 days`);
  return { generatedAt, validUntil };
}

function auditGeneratedAtFreshnessOnly(evidence, label, now, requireRecent = true) {
  const generatedAt = canonicalTimestamp(evidence.generated_at, `${label} generated_at`);
  if (generatedAt > now) fail(`${label} evidence is generated in the future`);
  if (requireRecent && now - generatedAt > 24 * 60 * 60 * 1_000) fail(`${label} evidence is stale (maximum age is 24 hours)`);
  return { generatedAt };
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

function speedStats(values) {
  return {
    sample_count: values.length,
    min_generation_elapsed_seconds: Math.min(...values),
    max_generation_elapsed_seconds: Math.max(...values),
    avg_generation_elapsed_seconds: round(values.reduce((sum, value) => sum + value, 0) / values.length, 3),
  };
}

function expectedToapisSpeedEvidence(results) {
  const cases = TOAPIS_CASES.map((expected) => {
    const result = results.find((item) => item?.id === expected.id);
    return {
      id: expected.id,
      model: expected.model,
      resolution: expected.resolution,
      mode: expected.mode,
      submit_latency_ms: Number(result?.speed?.submit_latency_ms),
      generation_elapsed_seconds: Number(result?.speed?.generation_elapsed_seconds),
      started_at: result?.started_at,
      completed_at: result?.completed_at,
    };
  });
  return {
    measurement_basis: 'actual_verification_run_not_provider_sla',
    cases,
    model_summary: Object.fromEntries(['seedance-2-fast', 'seedance-2-mini'].map((model) => {
      const values = cases
        .filter((item) => item.model === model && Number.isFinite(item.generation_elapsed_seconds))
        .map((item) => item.generation_elapsed_seconds);
      return [model, values.length ? speedStats(values) : {
        sample_count: 0,
        min_generation_elapsed_seconds: null,
        max_generation_elapsed_seconds: null,
        avg_generation_elapsed_seconds: null,
      }];
    })),
  };
}

function auditToapisSpeedEvidence(evidence, results, freshness) {
  const expected = expectedToapisSpeedEvidence(results);
  if (JSON.stringify(evidence?.speed_evidence || null) !== JSON.stringify(expected)) {
    fail('ToAPIs speed evidence summary does not match measured case evidence');
  }
  for (const result of results) {
    const startedAt = canonicalTimestamp(result.started_at, `ToAPIs ${result.id} started_at`);
    const completedAt = canonicalTimestamp(result.completed_at, `ToAPIs ${result.id} completed_at`);
    const submitLatencyMs = Number(result.speed?.submit_latency_ms);
    const generationElapsedSeconds = Number(result.speed?.generation_elapsed_seconds);
    if (startedAt >= completedAt || completedAt > freshness.generatedAt
        || !Number.isSafeInteger(submitLatencyMs) || submitLatencyMs < 0
        || !Number.isFinite(generationElapsedSeconds) || generationElapsedSeconds <= 0
        || !equalNumber(generationElapsedSeconds, round((completedAt - startedAt) / 1000))) {
      fail(`ToAPIs measured speed evidence is invalid: ${result.id}`);
    }
  }
}

function auditToapisEvidence(evidenceRoot, envelope, now, requireRecent = true) {
  const evidence = envelope.evidence;
  if (evidence?.contract_version !== PROVIDERS.toapis.contract) fail('ToAPIs evidence contract_version is invalid');
  if (evidence.provider_origin !== 'https://toapis.xyz') fail('ToAPIs evidence provider origin is not official');
  const freshness = auditFreshness(evidence, 'ToAPIs', now, requireRecent);
  const results = Array.isArray(evidence.results) ? evidence.results : [];
  if (results.length !== TOAPIS_CASES.length) fail('ToAPIs evidence must contain exactly 8 cases');
  const byId = new Map(results.map((result) => [result?.id, result]));
  if (byId.size !== TOAPIS_CASES.length) fail('ToAPIs evidence contains a duplicate or unknown case');
  auditToapisSpeedEvidence(evidence, results, freshness);
  const tasks = new Set();
  const outputs = new Set();
  const hashes = new Set();
  const publicUrls = new Set();
  const billingChains = new Map();
  const fingerprintsByModel = new Map();
  const modelsByFingerprint = new Map();
  for (const expected of TOAPIS_CASES) {
    const result = byId.get(expected.id);
    if (!result) fail(`ToAPIs case is missing: ${expected.id}`);
    if (result.status !== 'completed' || result.model !== expected.model || result.mode !== expected.mode
        || String(result.requested_resolution || '').toLowerCase() !== expected.resolution
        || Number(result.requested_duration) !== expected.duration) {
      fail(`ToAPIs case model/resolution/duration binding is invalid: ${expected.id}`);
    }
    const configFingerprint = String(result.config_fingerprint || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/i.test(configFingerprint)) {
      fail(`ToAPIs config fingerprint is missing or invalid: ${expected.id}`);
    }
    const existingFingerprint = fingerprintsByModel.get(expected.model);
    if (existingFingerprint && existingFingerprint !== configFingerprint) {
      fail(`ToAPIs model uses multiple config fingerprints: ${expected.model}`);
    }
    const existingModel = modelsByFingerprint.get(configFingerprint);
    if (existingModel && existingModel !== expected.model) {
      fail('ToAPIs FAST and MINI config fingerprints must be distinct');
    }
    fingerprintsByModel.set(expected.model, configFingerprint);
    modelsByFingerprint.set(configFingerprint, expected.model);
    if (!billingChains.has(configFingerprint)) billingChains.set(configFingerprint, []);
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
    billingChains.get(configFingerprint).push({ beforeAt, afterAt, before, after, result });
  }
  if (fingerprintsByModel.size !== 2 || modelsByFingerprint.size !== 2) {
    fail('ToAPIs FAST and MINI config fingerprints must be distinct');
  }
  for (const billingWindows of billingChains.values()) {
    billingWindows.sort((left, right) => left.beforeAt - right.beforeAt);
    const windows = new Set(billingWindows.map((item) => `${item.beforeAt}|${item.afterAt}`));
    if (windows.size !== billingWindows.length) fail('ToAPIs billing windows are duplicated inside one config fingerprint');
    for (let index = 1; index < billingWindows.length; index += 1) {
      const previous = billingWindows[index - 1];
      const current = billingWindows[index];
      if (previous.afterAt > current.beforeAt
          || !equalNumber(previous.after.used_balance, current.before.used_balance)
          || !equalNumber(previous.after.used_credits, current.before.used_credits)) {
        fail('ToAPIs billing chain is not continuous inside one config fingerprint');
      }
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

function auditToapisWan3Evidence(evidenceRoot, envelope, now, requireRecent = true) {
  const evidence = envelope?.evidence;
  if (evidence?.contract_version !== PROVIDERS.toapisWan3.contract) {
    fail('ToAPIs Wan 3.0 evidence contract_version is invalid');
  }
  if (evidence.provider_origin !== 'https://toapis.xyz') {
    fail('ToAPIs Wan 3.0 evidence provider origin is not official');
  }
  const freshness = auditGeneratedAtFreshnessOnly(evidence, 'ToAPIs Wan 3.0', now, requireRecent);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(evidence.run_id || ''))) {
    fail('ToAPIs Wan 3.0 run id is invalid');
  }
  const results = Array.isArray(evidence.results) ? evidence.results : [];
  if (results.length !== 1) fail('ToAPIs Wan 3.0 evidence must contain exactly one real case');
  const result = results[0];
  for (const [key, value] of Object.entries({
    id: TOAPIS_WAN3_CASE.id,
    model: TOAPIS_WAN3_CASE.model,
    mode: TOAPIS_WAN3_CASE.mode,
    requested_resolution: TOAPIS_WAN3_CASE.resolution,
    requested_ratio: TOAPIS_WAN3_CASE.ratio,
    requested_duration: TOAPIS_WAN3_CASE.duration,
    requested_audio: TOAPIS_WAN3_CASE.audio,
    status: 'completed',
    submission_state: 'accepted',
  })) {
    if (result?.[key] !== value) fail(`ToAPIs Wan 3.0 ${key} evidence is invalid`);
  }
  if (Number(result.post_count) !== 1) fail('ToAPIs Wan 3.0 paid evidence must contain exactly one POST submission');
  if (!String(result.provider_task_id || '').trim()) fail('ToAPIs Wan 3.0 provider task id is missing');
  const recoveryTaskId = String(result.recovery_task_id || '');
  if (!/^wan3-verify-[A-Za-z0-9._-]+$/.test(recoveryTaskId)) fail('ToAPIs Wan 3.0 recovery task id is invalid');
  if (!String(result.config_id || '').trim()) fail('ToAPIs Wan 3.0 target config id is missing');
  if (!/^[a-f0-9]{64}$/.test(String(result.config_fingerprint || ''))) {
    fail('ToAPIs Wan 3.0 config fingerprint is invalid');
  }

  const request = result.request;
  if (!request || request.model !== TOAPIS_WAN3_CASE.model
      || request.duration !== TOAPIS_WAN3_CASE.duration
      || request.ratio !== TOAPIS_WAN3_CASE.ratio
      || request.resolution !== TOAPIS_WAN3_CASE.resolution
      || request.audio !== TOAPIS_WAN3_CASE.audio
      || request.client_business_id !== recoveryTaskId
      || !String(request.prompt || '').trim()) {
    fail('ToAPIs Wan 3.0 request binding is invalid');
  }
  if (sha256(Buffer.from(JSON.stringify(request), 'utf8')) !== result.request_sha256) {
    fail('ToAPIs Wan 3.0 request digest does not match the submitted request');
  }
  const startedAt = canonicalTimestamp(result.started_at, 'ToAPIs Wan 3.0 started_at');
  const acceptedAt = canonicalTimestamp(result.accepted_at, 'ToAPIs Wan 3.0 accepted_at');
  const completedAt = canonicalTimestamp(result.completed_at, 'ToAPIs Wan 3.0 completed_at');
  if (startedAt >= acceptedAt || acceptedAt >= completedAt || completedAt > freshness.generatedAt) {
    fail('ToAPIs Wan 3.0 task timeline is invalid');
  }

  const artifact = result.artifact || {};
  const safeTaskId = String(result.provider_task_id).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safeTaskId || artifact.output_file !== `${TOAPIS_WAN3_CASE.id}-${safeTaskId}.mp4`) {
    fail('ToAPIs Wan 3.0 task-to-artifact binding is invalid');
  }
  const inspected = auditAsset(evidenceRoot, artifact, 'ToAPIs Wan 3.0 artifact', 'toapis');
  moliUrl(artifact.public_url, 'ToAPIs Wan 3.0 artifact public_url', 'toapis', inspected.outputFile);
  if (artifact.content_type !== 'video/mp4') fail('ToAPIs Wan 3.0 artifact content type is invalid');
  const probe = artifact.ffprobe || {};
  const width = Number(probe.width);
  const height = Number(probe.height);
  const duration = Number(probe.duration_seconds);
  const ratio = width / height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || height < 440 || height > 520
      || ratio < 1.7 || ratio > 1.85 || !Number.isFinite(duration) || duration < 1.5 || duration > 3.5
      || !String(probe.video_codec || '') || probe.has_audio !== false
      || (probe.audio_codec != null && String(probe.audio_codec).trim())) {
    fail('ToAPIs Wan 3.0 ffprobe evidence is invalid');
  }

  const billing = result.billing || {};
  const expectedCost = Number(billing.expected_cost_yuan);
  const hardCap = Number(billing.hard_cap_yuan);
  const before = billing.before || {};
  const after = billing.after || {};
  const beforeAt = canonicalTimestamp(before.captured_at, 'ToAPIs Wan 3.0 balance before');
  const afterAt = canonicalTimestamp(after.captured_at, 'ToAPIs Wan 3.0 balance after');
  const debitedBalance = round(Number(after.used_balance) - Number(before.used_balance));
  const debitedCredits = round(Number(after.used_credits) - Number(before.used_credits));
  const usdCnyRate = Number(billing.usd_cny_rate);
  const costYuan = round(debitedBalance * usdCnyRate);
  if (!Number.isFinite(expectedCost) || expectedCost <= 0
      || !Number.isFinite(hardCap) || hardCap <= 0 || expectedCost > hardCap
      || beforeAt >= afterAt || beforeAt > startedAt || afterAt < completedAt || afterAt > freshness.generatedAt
      || !Number.isFinite(debitedBalance) || debitedBalance <= 0
      || !Number.isFinite(debitedCredits) || debitedCredits <= 0
      || !equalNumber(billing.debited_balance, debitedBalance)
      || !equalNumber(billing.debited_credits, debitedCredits)
      || billing.provider_currency !== 'USD'
      || !Number.isFinite(usdCnyRate) || usdCnyRate <= 0
      || !equalNumber(billing.cost_yuan, costYuan) || costYuan > hardCap) {
    fail('ToAPIs Wan 3.0 billing evidence is invalid');
  }

  const capabilities = evidence.verified_capabilities || {};
  if (capabilities.model !== TOAPIS_WAN3_CASE.model
      || capabilities.text_to_video !== true
      || !sameValues(capabilities.resolutions || [], [TOAPIS_WAN3_CASE.resolution])
      || !sameValues(capabilities.durations || [], [TOAPIS_WAN3_CASE.duration])
      || !sameValues(capabilities.ratios || [], [TOAPIS_WAN3_CASE.ratio])
      || !sameValues(capabilities.audio_values || [], [TOAPIS_WAN3_CASE.audio])) {
    fail('ToAPIs Wan 3.0 verified capabilities exceed the paid evidence');
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

function auditUsmercariEvidence(evidenceRoot, envelope, now, requireRecent = true) {
  const evidence = envelope.evidence;
  if (evidence?.contract_version !== PROVIDERS.usmercari.contract) fail('USMercari image evidence contract_version is invalid');
  if (evidence.provider_origin !== 'https://chat-ai.mercarimx.com') fail('USMercari image evidence official provider origin is invalid');
  auditFreshness(evidence, 'USMercari image', now, requireRecent);
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

function auditLingjingEvidence(evidenceRoot, envelope, now, requireRecent = true) {
  const evidence = envelope.evidence;
  if (evidence?.contract_version !== PROVIDERS.lingjing.contract) fail('Lingjing video evidence contract_version is invalid');
  if (evidence.provider_origin !== 'https://seed.alimyun.xyz') fail('Lingjing video evidence official provider origin is invalid');
  const freshness = auditFreshness(evidence, 'Lingjing video', now, requireRecent);
  const results = Array.isArray(evidence.results) ? evidence.results : [];
  if (results.length !== 1) fail('Lingjing video evidence must contain exactly one paid 4-second image-reference case');
  const result = results[0] || {};
  if (result.id !== LINGJING_CASE.id || result.model !== LINGJING_CASE.model
      || result.upstream_model !== LINGJING_CASE.upstreamModel || result.mode !== LINGJING_CASE.mode
      || Number(result.requested_duration) !== LINGJING_CASE.duration
      || result.requested_aspect_ratio !== LINGJING_CASE.aspectRatio
      || result.requested_resolution !== null || Number(result.reference_count) !== 1
      || result.status !== 'completed' || result.submission_state !== 'accepted') {
    fail('Lingjing video real-case model/mode/duration/reference binding is invalid');
  }
  const taskId = String(result.provider_task_id || '').trim();
  if (!taskId) fail('Lingjing video provider task id is missing');
  const requestId = String(result.request_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    fail('Lingjing video request_id must be a UUID v4');
  }
  const request = result.request || {};
  if (request.model_key !== LINGJING_CASE.upstreamModel
      || Number(request.duration) !== LINGJING_CASE.duration
      || request.ratio !== LINGJING_CASE.aspectRatio
      || Number(request.reference_count) !== 1
      || request.request_id !== requestId
      || Object.prototype.hasOwnProperty.call(request, 'resolution')) {
    fail('Lingjing video provider request binding is invalid');
  }
  const providerAudit = result.provider_audit || {};
  const uploads = Array.isArray(providerAudit.uploads) ? providerAudit.uploads : [];
  const upload = uploads[0] || {};
  const supplierCostFields = Array.isArray(providerAudit.supplier_cost_fields)
    ? providerAudit.supplier_cost_fields : [];
  const supplierCostUnavailable = providerAudit.supplier_cost_unavailable === true;
  if (!/^[a-f0-9]{64}$/.test(String(providerAudit.request_body_sha256 || ''))) {
    fail('Lingjing video normalized request digest is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(String(providerAudit.creation_response_sha256 || ''))
      || Number(providerAudit.creation_http_status) < 200 || Number(providerAudit.creation_http_status) >= 300
      || !/^[a-f0-9]{64}$/.test(String(providerAudit.terminal_response_sha256 || ''))
      || Number(providerAudit.terminal_http_status) < 200 || Number(providerAudit.terminal_http_status) >= 300) {
    fail('Lingjing video creation or terminal response digest binding is invalid');
  }
  if (uploads.length !== 1
      || !/^[a-f0-9]{64}$/.test(String(upload.reference_sha256 || ''))
      || !/^uploads\/[A-Za-z0-9._/-]+$/.test(String(upload.upload_path || ''))
      || String(upload.upload_path || '').includes('..')
      || !/^[a-f0-9]{64}$/.test(String(upload.upload_response_sha256 || ''))
      || Number(upload.upload_http_status) < 200 || Number(upload.upload_http_status) >= 300) {
    fail('Lingjing video reference upload binding is invalid');
  }
  if ((supplierCostUnavailable && supplierCostFields.length !== 0)
      || (!supplierCostUnavailable && supplierCostFields.length === 0)
      || supplierCostFields.some((field) => !['creation', 'terminal'].includes(field?.source)
        || !['cost', 'credits', 'credits_used', 'charged_credits', 'charge', 'charged_amount', 'amount'].includes(field?.field)
        || !['number', 'string'].includes(typeof field?.value))) {
    fail('Lingjing video supplier cost receipt declaration is invalid');
  }

  const scope = evidence.verification_scope || {};
  const capability = scope.documented_capabilities || {};
  const expectedCase = { duration: 4, aspect_ratio: '16:9', reference_images: 1, resolution: null };
  if (scope.public_model !== LINGJING_CASE.model || scope.upstream_model !== LINGJING_CASE.upstreamModel
      || JSON.stringify(scope.real_case) !== JSON.stringify(expectedCase)
      || !sameValues(capability.durations || [], LINGJING_DURATIONS)
      || !sameValues(capability.aspect_ratios || [], LINGJING_RATIOS)
      || !Array.isArray(capability.resolutions) || capability.resolutions.length !== 0
      || Number(capability.max_image_references) !== 9
      || Number(capability.max_video_references) !== 0
      || Number(capability.max_audio_references) !== 0
      || capability.supports_first_frame !== false || capability.supports_last_frame !== false
      || capability.supports_audio !== false
      || !/^[a-f0-9]{64}$/.test(String(scope.reference_image_sha256 || ''))) {
    fail('Lingjing video documented capability evidence is invalid');
  }
  if (upload.reference_sha256 !== scope.reference_image_sha256) {
    fail('Lingjing video reference upload SHA-256 binding is invalid');
  }

  const artifact = result.artifact || {};
  const outputFile = String(artifact.output_file || '');
  const expectedOutput = `${LINGJING_CASE.id}-${taskId}.mp4`.replace(/[^A-Za-z0-9._~-]+/g, '-');
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4$/.test(outputFile)
      || outputFile !== expectedOutput || artifact.content_type !== 'video/mp4') {
    fail('Lingjing video output must be a safe MP4 artifact');
  }
  const asset = auditAsset(evidenceRoot, artifact, 'Lingjing video relay-image-4s', 'lingjing');
  moliUrl(artifact.public_url, 'Lingjing video public_url', 'lingjing', asset.outputFile);
  const probe = artifact.ffprobe || {};
  const width = Number(probe.width);
  const height = Number(probe.height);
  const duration = Number(probe.duration_seconds);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 64 || height < 64
      || Math.abs((width / height) - (16 / 9)) > 0.12
      || !Number.isFinite(duration) || Math.abs(duration - 4) > 2
      || !String(probe.video_codec || '') || !String(probe.format || '')
      || typeof probe.has_audio !== 'boolean'
      || (probe.has_audio ? !String(probe.audio_codec || '').trim() : probe.audio_codec !== null)) {
    fail('Lingjing video ffprobe evidence is invalid');
  }

  const startedAt = canonicalTimestamp(result.started_at, 'Lingjing video started_at');
  const completedAt = canonicalTimestamp(result.completed_at, 'Lingjing video completed_at');
  const speed = result.speed || {};
  if (startedAt >= completedAt || completedAt > freshness.generatedAt
      || !Number.isSafeInteger(Number(speed.submit_latency_ms)) || Number(speed.submit_latency_ms) < 0
      || !Number.isFinite(Number(speed.generation_elapsed_seconds)) || Number(speed.generation_elapsed_seconds) <= 0
      || !equalNumber(speed.generation_elapsed_seconds, round((completedAt - startedAt) / 1000))
      || !Number.isSafeInteger(Number(speed.download_latency_ms)) || Number(speed.download_latency_ms) < 0
      || !Number.isFinite(Number(speed.total_elapsed_seconds))
      || Number(speed.total_elapsed_seconds) < Number(speed.generation_elapsed_seconds)) {
    fail('Lingjing video measured speed evidence is invalid');
  }
  const expectedSpeed = {
    measurement_basis: 'actual_paid_verification_run_not_provider_sla',
    cases: [{
      id: result.id,
      model: result.model,
      submit_latency_ms: speed.submit_latency_ms,
      generation_elapsed_seconds: speed.generation_elapsed_seconds,
      download_latency_ms: speed.download_latency_ms,
      total_elapsed_seconds: speed.total_elapsed_seconds,
    }],
  };
  if (JSON.stringify(evidence.speed_evidence || null) !== JSON.stringify(expectedSpeed)) {
    fail('Lingjing video speed summary does not match the measured result');
  }

  const pricing = evidence.pricing || {};
  const capturedAt = canonicalTimestamp(pricing.captured_at, 'Lingjing video pricing captured_at');
  if (capturedAt > freshness.generatedAt
      || pricing.provider_settings_url !== 'https://seed.alimyun.xyz/api/public/settings'
      || !/^[a-f0-9]{64}$/.test(String(pricing.response_sha256 || ''))
      || pricing.model_key !== 'relay' || pricing.public_model !== LINGJING_CASE.model
      || pricing.billing_mode !== 'per_second'
      || !equalNumber(pricing.price_per_second_credits, 1)
      || !equalNumber(pricing.rmb_per_credit, 0.17)
      || !equalNumber(pricing.cost_yuan_per_second, 0.17)
      || Number(pricing.credits_per_second) !== ceilDecimalProduct('0.17', 875)
      || pricing.reviewed !== true) {
    fail('Lingjing video exact reviewed price is invalid');
  }
}

function auditToapisPrivateAvatarEvidence(evidenceRoot, envelope, now, requireRecent = true) {
  const evidence = envelope.evidence;
  if (evidence?.contract_version !== PROVIDERS.toapis.privateAvatarContract) fail('ToAPIs private-avatar evidence contract_version is invalid');
  auditGeneratedAtFreshnessOnly(evidence, 'ToAPIs private-avatar', now, requireRecent);
  if (!String(evidence.audit_run_id || '').trim()) fail('ToAPIs private-avatar evidence audit_run_id is missing');
  const source = evidence.source || {};
  if (!String(source.identity || '').trim() || !String(source.file_name || '').trim()
      || Number(source.bytes) <= 0 || !/^[a-f0-9]{64}$/.test(String(source.sha256 || '').toLowerCase())) {
    fail('ToAPIs private-avatar source identity/file SHA binding is invalid');
  }
  const avatar = evidence.avatar || {};
  if (avatar.status !== 'active' || !String(avatar.group_id || '').trim()
      || !/^pa_[A-Za-z0-9_-]+$/.test(String(avatar.asset_id || ''))
      || !/^asset:\/\/pa_[A-Za-z0-9_-]+$/.test(String(avatar.asset_url || ''))) {
    fail('ToAPIs private-avatar active group/asset asset://pa_ binding is invalid');
  }
  const cases = Array.isArray(evidence.cases) ? evidence.cases : [];
  const byId = new Map(cases.map((item) => [item?.id, item]));
  if (cases.length !== TOAPIS_PRIVATE_AVATAR_CASES.length || byId.size !== cases.length) {
    fail('ToAPIs private-avatar evidence must contain exactly two unique cases');
  }
  const tasks = new Set();
  let totalCostYuan = 0;
  for (const expected of TOAPIS_PRIVATE_AVATAR_CASES) {
    const item = byId.get(expected.id);
    if (!item) fail(`ToAPIs private-avatar case is missing: ${expected.id}`);
    if (item.status !== 'completed' || item.model !== expected.model
        || String(item.resolution || '').toLowerCase() !== expected.resolution
        || Number(item.duration) !== expected.duration) {
      fail(`ToAPIs private-avatar case binding is invalid: ${expected.id}`);
    }
    const task = String(item.provider_task_id || '');
    if (!task || tasks.has(task)) fail(`ToAPIs private-avatar provider task must be unique: ${expected.id}`);
    tasks.add(task);
    const submittedAt = canonicalTimestamp(item.submitted_at, `ToAPIs private-avatar ${expected.id} submitted_at`);
    const completedAt = canonicalTimestamp(item.completed_at, `ToAPIs private-avatar ${expected.id} completed_at`);
    const generationElapsed = Number(item.speed?.generation_elapsed_seconds);
    if (submittedAt >= completedAt || !Number.isFinite(generationElapsed) || generationElapsed <= 0
        || !Number.isSafeInteger(Number(item.speed?.submit_latency_ms)) || Number(item.speed.submit_latency_ms) < 0) {
      fail(`ToAPIs private-avatar speed evidence is invalid: ${expected.id}`);
    }
    const costYuan = Number(item.billing?.cost_yuan);
    const expectedCostYuan = Number(item.billing?.expected_cost_yuan);
    const caseHardCapYuan = Number(item.billing?.case_hard_cap_yuan);
    if (Number(item.billing?.debited_balance) <= 0 || Number(item.billing?.debited_credits) <= 0
        || !Number.isFinite(costYuan) || costYuan <= 0
        || !Number.isFinite(expectedCostYuan) || expectedCostYuan <= 0
        || !Number.isFinite(caseHardCapYuan) || caseHardCapYuan <= 0
        || expectedCostYuan > caseHardCapYuan || costYuan > caseHardCapYuan) {
      fail(`ToAPIs private-avatar billing evidence is invalid: ${expected.id}`);
    }
    totalCostYuan = round(totalCostYuan + costYuan);
    const artifact = item.artifact || {};
    const outputFile = String(artifact.output_file || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$/.test(outputFile)
        || !/^video\//i.test(String(artifact.content_type || ''))
        || Number(artifact.bytes) <= 1024
        || !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || '').toLowerCase())) {
      fail(`ToAPIs private-avatar artifact is invalid: ${expected.id}`);
    }
    auditAsset(evidenceRoot, artifact, `ToAPIs private-avatar ${expected.id}`, 'toapis');
    const probe = artifact.ffprobe || {};
    const width = Number(probe.width);
    const height = Number(probe.height);
    const duration = Number(probe.duration_seconds);
    const shortEdge = Math.min(width, height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || shortEdge < 400 || shortEdge > 576
        || !Number.isFinite(duration) || Math.abs(duration - 4) > 1.5
        || !String(probe.video_codec || '')) {
      fail(`ToAPIs private-avatar ffprobe evidence is invalid: ${expected.id}`);
    }
  }
  const summary = evidence.summary || {};
  const summaryTotalCostYuan = Number(summary.total_cost_yuan);
  const aggregateHardCapYuan = Number(summary.aggregate_hard_cap_yuan);
  if (Number(summary.case_count) !== TOAPIS_PRIVATE_AVATAR_CASES.length
      || Number(summary.total_debited_balance) <= 0
      || Number(summary.total_debited_credits) <= 0
      || !Number.isFinite(summaryTotalCostYuan) || summaryTotalCostYuan <= 0
      || !equalNumber(summaryTotalCostYuan, totalCostYuan)
      || !Number.isFinite(aggregateHardCapYuan) || aggregateHardCapYuan <= 0
      || summaryTotalCostYuan > aggregateHardCapYuan) {
    fail('ToAPIs private-avatar summary must bind two positive-billing cases');
  }
}

function evidencePathEnvironmentNames(env) {
  return Object.keys(env).filter((name) => /evidence.*(?:path|root)|(?:path|root).*evidence|verify.*output.*dir/i.test(name));
}

function verifyExternalModelRelease(candidateArg, evidenceRootArg, expectedCurrentArg, options = {}) {
  const envNames = evidencePathEnvironmentNames(options.env || process.env);
  if (envNames.length) fail(`evidence path environment overrides are forbidden: ${envNames.join(', ')}`);
  const candidate = secureDirectory(candidateArg, 'CANDIDATE');
  const expectedCurrent = secureDirectory(expectedCurrentArg, 'EXPECTED_CURRENT');
  const evidenceAllowedRoot = secureDirectory(path.dirname(path.resolve(evidenceRootArg)), 'EVIDENCE_ALLOWED_ROOT', true);
  const evidenceRoot = secureDirectory(evidenceRootArg, 'EVIDENCE_ROOT', true);
  if (!isInside(evidenceAllowedRoot, evidenceRoot)) fail('EVIDENCE_ROOT escapes EVIDENCE_ALLOWED_ROOT');
  const surfaces = {
    toapis: hasSurface(candidate, PROVIDERS.toapis),
    toapisWan3: hasSurface(candidate, PROVIDERS.toapisWan3),
    usmercari: hasSurface(candidate, PROVIDERS.usmercari),
    lingjing: hasSurface(candidate, PROVIDERS.lingjing),
  };
  if (!surfaces.toapis && !surfaces.toapisWan3 && !surfaces.usmercari && !surfaces.lingjing) {
    return { legacy: true, surfaces };
  }
  const freshnessRequired = freshnessRequirements(candidate, expectedCurrent, surfaces);
  auditEvidenceBindingRuntime(candidate, surfaces);
  if (surfaces.toapis) auditToapisRuntime(candidate, {
    auditEvidenceProducer: freshnessRequired.toapis || freshnessRequired.toapisPrivateAvatar,
  });
  if (surfaces.toapisWan3) auditToapisWan3Runtime(candidate, {
    auditEvidenceProducer: freshnessRequired.toapisWan3,
  });
  if (freshnessRequired.toapisPrivateAvatar) auditToapisPrivateAvatarProducer(candidate);
  if (surfaces.usmercari) auditUsmercariRuntime(candidate);
  if (surfaces.lingjing) auditLingjingRuntime(candidate);
  auditCallouts(candidate);
  const envelopes = readManifestEvidence(evidenceRoot, surfaces);
  const now = options.now == null ? Date.now() : Number(options.now);
  if (surfaces.toapis) {
    auditToapisEvidence(evidenceRoot, envelopes.toapis, now, freshnessRequired.toapis);
    auditToapisPrivateAvatarEvidence(evidenceRoot, envelopes.toapisPrivateAvatar, now, freshnessRequired.toapisPrivateAvatar);
  }
  if (surfaces.toapisWan3) {
    auditToapisWan3Evidence(evidenceRoot, envelopes.toapisWan3, now, freshnessRequired.toapisWan3);
  }
  if (surfaces.usmercari) auditUsmercariEvidence(evidenceRoot, envelopes.usmercari, now, freshnessRequired.usmercari);
  if (surfaces.lingjing) auditLingjingEvidence(evidenceRoot, envelopes.lingjing, now, freshnessRequired.lingjing);
  return { legacy: false, surfaces, freshnessRequired };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('Usage: verify-external-model-release.js CANDIDATE EVIDENCE_ROOT EXPECTED_CURRENT\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = verifyExternalModelRelease(argv[0], argv[1], argv[2]);
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
  LINGJING_CASE,
  TOAPIS_CASES,
  TOAPIS_WAN3_CASE,
  USMERCARI_CASES,
  auditLingjingRuntime,
  auditToapisWan3Evidence,
  auditToapisWan3Runtime,
  decodeBaselineJpeg,
  freshnessRequirements,
  verifyExternalModelRelease,
};
