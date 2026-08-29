'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT = 'model-ui-protection-v1';

function fail(message) {
  const error = new Error(`[${CONTRACT}] ${message}`);
  error.code = 'MODEL_UI_CONTRACT_FAILED';
  throw error;
}

function createSourceViews(value) {
  const source = String(value || '');
  let index = 0;
  let rawWithoutComments = '';
  let codeWithoutCommentsAndStrings = '';

  function blank(char) {
    return char === '\n' || char === '\r' ? char : ' ';
  }

  function copy(char) {
    rawWithoutComments += char;
    codeWithoutCommentsAndStrings += char;
  }

  function mask(char) {
    rawWithoutComments += char;
    codeWithoutCommentsAndStrings += blank(char);
  }

  function blankBoth(char) {
    const replacement = blank(char);
    rawWithoutComments += replacement;
    codeWithoutCommentsAndStrings += replacement;
  }

  function consumeQuoted(quote) {
    mask(source[index++]);
    while (index < source.length) {
      const char = source[index];
      mask(char);
      index += 1;
      if (char === '\\' && index < source.length) {
        mask(source[index++]);
      } else if (char === quote) {
        return;
      }
    }
  }

  function consumeComment(close, lineComment = false) {
    while (index < source.length) {
      if (!lineComment && source.startsWith(close, index)) {
        for (let offset = 0; offset < close.length; offset += 1) blankBoth(source[index + offset]);
        index += close.length;
        return;
      }
      const char = source[index];
      if (lineComment && (char === '\n' || char === '\r')) return;
      blankBoth(char);
      index += 1;
    }
  }

  function consumeTemplate() {
    mask(source[index++]);
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        mask(source[index++]);
        if (index < source.length) mask(source[index++]);
        continue;
      }
      if (char === '`') {
        mask(source[index++]);
        return;
      }
      if (char === '$' && source[index + 1] === '{') {
        copy('$');
        copy('{');
        index += 2;
        consumeCode(true);
        continue;
      }
      mask(char);
      index += 1;
    }
  }

  function isRegexStart() {
    let previous = rawWithoutComments.length - 1;
    while (previous >= 0 && /\s/.test(rawWithoutComments[previous])) previous -= 1;
    if (previous < 0) return true;
    const char = rawWithoutComments[previous];
    if ('([{,:;=!?&|+-*%^~<>'.includes(char)) return true;
    if (!/[A-Za-z0-9_$]/.test(char)) return false;
    let start = previous;
    while (start >= 0 && /[A-Za-z0-9_$]/.test(rawWithoutComments[start])) start -= 1;
    return /^(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/.test(
      rawWithoutComments.slice(start + 1, previous + 1),
    );
  }

  function consumeRegex() {
    let inCharacterClass = false;
    mask(source[index++]);
    while (index < source.length) {
      const char = source[index];
      mask(char);
      index += 1;
      if (char === '\\' && index < source.length) {
        mask(source[index++]);
      } else if (char === '[') {
        inCharacterClass = true;
      } else if (char === ']') {
        inCharacterClass = false;
      } else if (char === '/' && !inCharacterClass) {
        while (index < source.length && /[A-Za-z]/.test(source[index])) mask(source[index++]);
        return;
      }
    }
  }

  function consumeCode(templateExpression = false) {
    let braceDepth = templateExpression ? 1 : 0;
    while (index < source.length) {
      const char = source[index];
      if (templateExpression && char === '{') {
        braceDepth += 1;
        copy(char);
        index += 1;
        continue;
      }
      if (templateExpression && char === '}') {
        braceDepth -= 1;
        copy(char);
        index += 1;
        if (braceDepth === 0) return;
        continue;
      }
      if (char === '\'' || char === '"') {
        consumeQuoted(char);
        continue;
      }
      if (char === '`') {
        consumeTemplate();
        continue;
      }
      if (source.startsWith('//', index)) {
        blankBoth('/');
        blankBoth('/');
        index += 2;
        consumeComment('', true);
        continue;
      }
      if (source.startsWith('/*', index)) {
        blankBoth('/');
        blankBoth('*');
        index += 2;
        consumeComment('*/');
        continue;
      }
      if (source.startsWith('<!--', index)) {
        for (let offset = 0; offset < 4; offset += 1) blankBoth(source[index + offset]);
        index += 4;
        consumeComment('-->');
        continue;
      }
      if (char === '/' && isRegexStart()) {
        consumeRegex();
        continue;
      }
      copy(char);
      index += 1;
    }
  }

  consumeCode();
  return { rawWithoutComments, codeWithoutCommentsAndStrings };
}

function stripSourceComments(value) {
  return createSourceViews(value).rawWithoutComments;
}

function createVueSourceViews(value) {
  const source = String(value || '');
  const raw = source.split('');
  const code = source.split('').map((char) => blankCharacter(char));

  function blankRange(target, start, end) {
    for (let index = start; index < end; index += 1) target[index] = blankCharacter(source[index]);
  }

  const htmlComment = /<!--[\s\S]*?-->/g;
  for (let match = htmlComment.exec(source); match; match = htmlComment.exec(source)) {
    blankRange(raw, match.index, match.index + match[0].length);
  }

  const block = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (let match = block.exec(source); match; match = block.exec(source)) {
    if (raw[match.index] === ' ') continue;
    const contentOffset = match.index + match[0].indexOf(match[2]);
    const views = createSourceViews(match[2]);
    for (let offset = 0; offset < match[2].length; offset += 1) {
      raw[contentOffset + offset] = views.rawWithoutComments[offset];
      if (match[1].toLowerCase() === 'script') {
        code[contentOffset + offset] = views.codeWithoutCommentsAndStrings[offset];
      }
    }
  }

  return {
    rawWithoutComments: raw.join(''),
    codeWithoutCommentsAndStrings: code.join(''),
  };
}

function blankCharacter(char) {
  return char === '\n' || char === '\r' ? char : ' ';
}

function readSource(root, relativePath) {
  const filePath = path.join(root, ...relativePath.split('/'));
  if (!fs.existsSync(filePath)) fail(`缺少受保护文件: ${relativePath}`);
  const content = fs.readFileSync(filePath, 'utf8');
  return relativePath.endsWith('.vue') ? createVueSourceViews(content) : createSourceViews(content);
}

function requirePattern(content, relativePath, pattern, label) {
  if (!pattern.test(content)) fail(`${relativePath} 缺少合同结构: ${label}`);
}

function forbidPattern(content, relativePath, pattern, label) {
  if (pattern.test(content)) fail(`${relativePath} 禁止合同结构: ${label}`);
}

function requireCodePattern(source, relativePath, pattern, label) {
  requirePattern(source.codeWithoutCommentsAndStrings, relativePath, pattern, label);
}

function requireRawPattern(source, relativePath, pattern, label) {
  requirePattern(source.rawWithoutComments, relativePath, pattern, label);
}

function forbidCodePattern(source, relativePath, pattern, label) {
  forbidPattern(source.codeWithoutCommentsAndStrings, relativePath, pattern, label);
}

function forbidRawPattern(source, relativePath, pattern, label) {
  forbidPattern(source.rawWithoutComments, relativePath, pattern, label);
}

function extractFunctionRange(source, relativePath, functionName) {
  const content = source.codeWithoutCommentsAndStrings;
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`).exec(content);
  if (!declaration) fail(`${relativePath} 缺少合同函数: ${functionName}`);
  const openParen = content.indexOf('(', declaration.index);
  let parameterDepth = 0;
  let closeParen = -1;
  for (let index = openParen; index < content.length; index += 1) {
    if (content[index] === '(') parameterDepth += 1;
    if (content[index] === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        closeParen = index;
        break;
      }
    }
  }
  const openBrace = closeParen < 0 ? -1 : content.indexOf('{', closeParen + 1);
  if (openBrace < 0) fail(`${relativePath} 合同函数缺少函数体: ${functionName}`);
  let depth = 0;
  for (let index = openBrace; index < content.length; index += 1) {
    if (content[index] === '{') depth += 1;
    if (content[index] === '}') {
      depth -= 1;
      if (depth === 0) return { start: declaration.index, end: index + 1 };
    }
  }
  fail(`${relativePath} 合同函数未闭合: ${functionName}`);
}

function extractFunctionScope(source, relativePath, functionName) {
  const range = extractFunctionRange(source, relativePath, functionName);
  return source.codeWithoutCommentsAndStrings.slice(range.start, range.end);
}

function extractFunctionViews(source, relativePath, functionName) {
  const range = extractFunctionRange(source, relativePath, functionName);
  return {
    rawWithoutComments: source.rawWithoutComments.slice(range.start, range.end),
    codeWithoutCommentsAndStrings: source.codeWithoutCommentsAndStrings.slice(range.start, range.end),
  };
}

function requireFunctionPattern(source, relativePath, functionName, pattern, label) {
  requirePattern(extractFunctionScope(source, relativePath, functionName), relativePath, pattern, label);
}

function forbidFunctionPattern(source, relativePath, functionName, pattern, label) {
  forbidPattern(extractFunctionScope(source, relativePath, functionName), relativePath, pattern, label);
}

function requireFunctionExecutablePattern(source, relativePath, functionName, rawPattern, codePattern, label) {
  requireExecutablePattern(
    extractFunctionViews(source, relativePath, functionName),
    relativePath,
    rawPattern,
    codePattern,
    label,
  );
}

function requireCodeRegionPattern(source, relativePath, startPattern, endPattern, pattern, label) {
  const content = source.codeWithoutCommentsAndStrings;
  const start = startPattern.exec(content);
  if (!start) fail(`${relativePath} 缺少合同区域起点: ${label}`);
  const end = endPattern.exec(content.slice(start.index + start[0].length));
  if (!end) fail(`${relativePath} 缺少合同区域终点: ${label}`);
  const regionEnd = start.index + start[0].length + end.index;
  requirePattern(content.slice(start.index, regionEnd), relativePath, pattern, label);
}

function requireExecutablePattern(source, relativePath, rawPattern, codePattern, label) {
  const flags = rawPattern.flags.includes('g') ? rawPattern.flags : `${rawPattern.flags}g`;
  const matcher = new RegExp(rawPattern.source, flags);
  for (let match = matcher.exec(source.rawWithoutComments); match; match = matcher.exec(source.rawWithoutComments)) {
    const codeSlice = source.codeWithoutCommentsAndStrings.slice(match.index, match.index + match[0].length);
    if (codePattern.test(codeSlice)) return;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  fail(`${relativePath} 缺少合同结构: ${label}`);
}

function auditModelUiContract(releaseRoot) {
  const root = path.resolve(String(releaseRoot || ''));
  const aiConfigRoute = readSource(root, 'backend-node/src/routes/aiConfig.js');
  requireFunctionExecutablePattern(aiConfigRoute, 'backend-node/src/routes/aiConfig.js', 'listPublicAudioModels',
    /const models = publicModelNames\(aiConfigService\.listConfigs\(db, 'tts'\)\);[\s\S]{0,700}response\.success\(res, list\)/,
    /const models = publicModelNames\(aiConfigService\.listConfigs\(db,\s+\)\);[\s\S]{0,700}response\.success\(res, list\)/,
    'publicModelNames public audio model response');
  requireRawPattern(aiConfigRoute, 'backend-node/src/routes/aiConfig.js',
    /listPublicAudioModels:\s*listPublicAudioModels\(db, options\.billingEnabled\)/,
    'public audio model route projection');
  requireFunctionPattern(aiConfigRoute, 'backend-node/src/routes/aiConfig.js', 'publicModelNames',
    /const names = configs[\s\S]{0,900}JSON\.parse\(value\)[\s\S]{0,500}return \[\.\.\.new Set\(names\)\]/,
    'publicModelNames normalized unique projection');
  const modelPrice = readSource(root, 'backend-node/src/services/modelPriceService.js');
  requireFunctionPattern(modelPrice, 'backend-node/src/services/modelPriceService.js', 'isToken6688PerRequestVideo',
    /mediaModelSelection\.parseQualifiedSelection\(value\)[\s\S]{0,180}selected\?\.upstreamModel/,
    'token6688 billing model classification');
  requireFunctionPattern(modelPrice, 'backend-node/src/services/modelPriceService.js', 'billingUnit',
    /isToken6688PerRequestVideo\(value\)/,
    'token6688 request billing selection');
  requireFunctionPattern(modelPrice, 'backend-node/src/services/modelPriceService.js', 'set',
    /const publicNote = String\(options\.publicNote \?\? options\.public_note/,
    'public_note model price normalization');
  requireFunctionPattern(modelPrice, 'backend-node/src/services/modelPriceService.js', 'providerInfo',
    /return \{\s*provider,\s*provider_name:\s*String\(row\.name \|\| provider\)\.trim\(\),\s*provider_base_url:\s*String\(row\.base_url \|\|\s+\)\.trim\(\)/,
    'provider public metadata projection');
  requireFunctionPattern(modelPrice, 'backend-node/src/services/modelPriceService.js', 'addProvider',
    /const providers = item\.providers \|\| \(item\.providers = \[\]\)[\s\S]{0,300}providers\.push\(info\)/,
    'provider metadata aggregation');
  requireFunctionPattern(modelPrice, 'backend-node/src/services/modelPriceService.js', 'list',
    /const providers = row\.providers \|\| providersByModel\.get\(row\.model\.toLowerCase\(\)\) \|\| \[\][\s\S]{0,260}provider_base_url:\s*providers\[0\]\?\.provider_base_url/,
    'provider metadata list payload');
  requireRawPattern(modelPrice, 'backend-node/src/services/modelPriceService.js',
    /CREATE TABLE IF NOT EXISTS model_credit_prices\s*\([\s\S]*?\bdisplay_name TEXT\b[\s\S]*?\bpublic_note TEXT NOT NULL DEFAULT ''/,
    'display_name schema and public_note schema');
  requireRawPattern(modelPrice, 'backend-node/src/services/modelPriceService.js',
    /ON CONFLICT\(model\) DO UPDATE SET[\s\S]{0,240}\bdisplay_name = excluded\.display_name,[\s\S]{0,120}\bpublic_note = excluded\.public_note,/,
    'display_name and public_note upsert');
  requireCodePattern(modelPrice, 'backend-node/src/services/modelPriceService.js',
    /function listPublic\(db, options = \{\}\)[\s\S]*?const publicRows = list\(db\)[\s\S]*?return publicRows\.map\(\(row\) => \(\{[\s\S]{0,180}model:\s*row\.model,[\s\S]{0,120}display_name:\s*row\.display_name,[\s\S]{0,120}public_note:\s*row\.public_note,/,
    'listPublic preserves public price metadata');
  const canvasCatalog = readSource(root, 'backend-node/src/services/canvasModelCatalogService.js');
  requireFunctionPattern(canvasCatalog, 'backend-node/src/services/canvasModelCatalogService.js', 'list',
    /const prices = new Map\(modelPriceService\.list\(db\)[\s\S]{0,500}const verifiedIds = verifiedConfigIds\(db\)[\s\S]{0,5200}\(!verifiedIds \|\| aiConfigService\.isVerifiedConfig\(entry\.config\)\)/,
    'verified enabled catalog source');
  requireFunctionExecutablePattern(canvasCatalog, 'backend-node/src/services/canvasModelCatalogService.js', 'list',
    /aiConfigService\.isVerifiedConfig\(entry\.config\)/,
    /aiConfigService\.isVerifiedConfig\(/,
    'verified configuration filter');
  requireFunctionExecutablePattern(canvasCatalog, 'backend-node/src/services/canvasModelCatalogService.js', 'list',
    /\.filter\(\(row\) => row\.status\s*===\s*'enabled'\)/,
    /\.filter\(\(row\) => row\.status\s*===/,
    "enabled price filter: row.status === 'enabled'");
  requireCodePattern(canvasCatalog, 'backend-node/src/services/canvasModelCatalogService.js',
    /label:\s*price\?\.display_name\s*\|\|\s*model/,
    'display_name label mapping');
  requireCodePattern(canvasCatalog, 'backend-node/src/services/canvasModelCatalogService.js',
    /public_note:\s*price\?\.public_note\s*\|\|\s*null/,
    'public_note mapping');
  const aiConfigService = readSource(root, 'backend-node/src/services/aiConfigService.js');
  requireFunctionPattern(aiConfigService, 'backend-node/src/services/aiConfigService.js', 'rowToConfig',
    /verification_status:\s*String\(r\.verification_status\s*\|\|[\s\S]{0,80}verification_checked_at:\s*r\.verification_checked_at\s*\|\|\s*null,\s*verified_capabilities:\s*parseObject\(r\.verified_capabilities\),\s*verified_at:\s*r\.verified_at\s*\|\|\s*null,\s*verification_error:\s*r\.verification_error\s*\|\|\s*null,\s*verification_evidence:\s*r\.verification_evidence\s*\|\|\s*null/,
    'verification_status result mapping');
  const videoService = readSource(root, 'backend-node/src/services/videoService.js');
  requireFunctionPattern(videoService, 'backend-node/src/services/videoService.js', 'create',
    /billingModel = modelPrice\.canonicalModel\(billingModel\)[\s\S]{0,16000}model:\s*billingModel,[\s\S]{0,300}generationCost\.record\(db, \{[\s\S]{0,120}model:\s*billingModel/,
    'billing model reservation and cost payload');
  requireFunctionExecutablePattern(videoService, 'backend-node/src/services/videoService.js', 'create',
    /wan3State\s*\?\s*videoConfig\?\.provider\s*:\s*\(body\.provider\s*\|\|\s*videoConfig\?\.provider\s*\|\|\s*'chatfire'\),\s*prompt,\s*model,\s*duration/,
    /wan3State\s*\?\s*videoConfig\?\.provider\s*:\s*\(body\.provider\s*\|\|\s*videoConfig\?\.provider\s*\|\|\s*\),\s*prompt,\s*model,\s*duration/,
    'verified Wan3 provider pin with legacy provider fallback and upstream prompt, model, duration routing');
  const usmercari = readSource(root, 'backend-node/src/services/usmercariVideoClient.js');
  requireCodePattern(usmercari, 'backend-node/src/services/usmercariVideoClient.js',
    /const IMAGE_UPLOAD_TARGET_BYTES = 24 \* 1024 \* 1024;\s*const MEDIA_UPLOAD_MAX_ATTEMPTS = 2;[\s\S]{0,140}const RETRYABLE_MEDIA_UPLOAD_STATUSES = new Set\(\[429, 502, 503, 504\]\);/,
    'bounded media upload constants: IMAGE_UPLOAD_TARGET_BYTES, MEDIA_UPLOAD_MAX_ATTEMPTS, retryable 502');
  requireFunctionPattern(usmercari, 'backend-node/src/services/usmercariVideoClient.js', 'prepareMediaBytes',
    /\.jpeg\(\{ quality, mozjpeg: true \}\)[\s\S]{0,120}compressed\.length <= IMAGE_UPLOAD_TARGET_BYTES/,
    'oversized reference image preparation');
  requireFunctionPattern(usmercari, 'backend-node/src/services/usmercariVideoClient.js', 'uploadUsmercariMedia',
    /for \(let attempt = 1; attempt <= MEDIA_UPLOAD_MAX_ATTEMPTS; attempt \+= 1\)[\s\S]{0,700}attempt < MEDIA_UPLOAD_MAX_ATTEMPTS && RETRYABLE_MEDIA_UPLOAD_STATUSES\.has\(response\.status\)/,
    'bounded retryable media upload');
  const paidSubmission = usmercari.codeWithoutCommentsAndStrings.slice(
    usmercari.codeWithoutCommentsAndStrings.indexOf('async function callUsmercariVideoApi'),
    usmercari.codeWithoutCommentsAndStrings.indexOf('module.exports'),
  );
  forbidPattern(paidSubmission, 'backend-node/src/services/usmercariVideoClient.js',
    /for\s*\(\s*let\s+\w*attempt/i,
    'paid submission must not retry');
  requireRawPattern(extractFunctionViews(usmercari, 'backend-node/src/services/usmercariVideoClient.js', 'callUsmercariVideoApi'), 'backend-node/src/services/usmercariVideoClient.js',
    /error:\s*`USMercari[^`]*为避免重复扣费，不得自动重试[^`]*`/,
    'unknown paid submission error forbids automatic retry');
  const productionPreflight = readSource(root, 'backend-node/src/services/productionPreflightService.js');
  requireFunctionPattern(productionPreflight, 'backend-node/src/services/productionPreflightService.js', 'runProductionPreflight',
    /const configuredCategories = new Set\(modelPriceService\.listPublic\(db\)/,
    'scoped listPublic preflight catalog');
  forbidFunctionPattern(productionPreflight, 'backend-node/src/services/productionPreflightService.js', 'runProductionPreflight',
    /modelPriceService\.SUPPORTED_MODELS/,
    'fixed SUPPORTED_MODELS production catalog');
  const modelSelection = readSource(root, 'frontweb/src/utils/modelSelection.js');
  requireFunctionPattern(modelSelection, 'frontweb/src/utils/modelSelection.js', 'normalizeModelOption',
    /JSON\.parse\(value\)[\s\S]{0,120}return normalizeModelOption\(parsed\)[\s\S]{0,180}return value/,
    'normalizeModelOption JSON projection');
  const canvasCapabilities = readSource(root, 'frontweb/src/utils/canvasModelCapabilities.js');
  requireRawPattern(canvasCapabilities, 'frontweb/src/utils/canvasModelCapabilities.js',
    /const DEFAULTS = \{[\s\S]{0,700}video:\s*\{[\s\S]{0,500}maxAudioReferences:\s*0,[\s\S]{0,100}maxVideoReferences:\s*0,/,
    'video audio and video reference defaults');
  requireFunctionPattern(canvasCapabilities, 'frontweb/src/utils/canvasModelCapabilities.js', 'normalizeCapabilities',
    /const capabilities = \{ \.\.\.defaults, \.\.\.declared \}[\s\S]{0,1000}capabilities\[key\] = Number\.isInteger\(limit\)/,
    'normalized capability reference limits');
  requireFunctionPattern(canvasCapabilities, 'frontweb/src/utils/canvasModelCapabilities.js', 'normalizeCanvasModelCatalog',
    /normalizeQuickGenerationCatalog\(items\)[\s\S]{0,260}publicNote:\s*item\.publicNote,[\s\S]{0,80}note:\s*item\.publicNote/,
    'note public_note normalization');
  requireFunctionPattern(canvasCapabilities, 'frontweb/src/utils/canvasModelCapabilities.js', 'canvasModelOptions',
    /value:\s*item\.model,[\s\S]{0,180}label:/,
    'raw model label option mapping');
  const homeCanvasNode = readSource(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue');
  requireCodeRegionPattern(homeCanvasNode, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
    /const canGenerate = computed/, /const inputReferences = computed/,
      /const modelOptions = computed[\s\S]{0,220}ctx\?\.getFreeNodeModelOptions\?\.\(props\.data\.kind, props\.id\)[\s\S]{0,260}getFreeNodeModelMetadata\?\.\(props\.data\.kind, draft\.model\)[\s\S]{0,700}getFreeNodeEstimatedCredits\?\.\([\s\S]{0,220}draft\.resolution[\s\S]{0,260}const isGenerationRunning = computed/,
    'scoped free canvas model and generation state');
  requireRawPattern(homeCanvasNode, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
    /<button\s+[\s\S]{0,220}class="run-button"[\s\S]{0,180}:disabled="data\.status === 'running' \|\| !draft\.content\.trim\(\) \|\| estimatedCredits == null"[\s\S]{0,300}@click\.stop="runNode"/,
    'generation run disabled binding');
  requireRawPattern(homeCanvasNode, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
    /<span v-if="canGenerate" class="billing-cost canvas-credit-callout-v1" aria-live="polite">\s*<template v-if="estimatedCredits != null">本次预计扣除\s*<strong>\{\{ estimatedCredits \}\}<\/strong>\s*积分<\/template>\s*<template v-else>积分待管理员配置<\/template>/,
    'canvas credit callout canvas-credit-callout-v1 with 本次预计扣除 and 积分待管理员配置');
  forbidRawPattern(homeCanvasNode, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
    /class="billing-note"/,
    'legacy billing-note');
  const generationOptions = readSource(root, 'frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue');
  requireCodeRegionPattern(generationOptions, 'frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue',
    /const ctx = useCanvasContext\(\)/, /const videoDurationOptions = computed/,
    /const modelCatalog = ref\(\[\]\)[\s\S]{0,300}const imageModelOptions = computed\(\(\) => canvasModelOptions\(modelCatalog\.value,[\s\S]{0,220}const videoModelOptions = computed\(\(\) => canvasModelOptions\(modelCatalog\.value,[\s\S]{0,260}const selectedVideoModel = computed\(\(\) => \([\s\S]{0,180}canvasModelEntry\(modelCatalog\.value,[\s\S]{0,120}options\.value\.videoModel/,
    'selectedVideoModel scoped mapping');
  requireRawPattern(generationOptions, 'frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue',
    /<span v-if="selectedVideoModel\?\.publicNote && !compact" class="model-note">\{\{ selectedVideoModel\.publicNote \}\}<\/span>/,
    'selectedVideoModel publicNote binding');
  requireRawPattern(generationOptions, 'frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue',
    /<el-option v-for="option in videoModelOptions"[^>]*:label="option\.label"[^>]*:value="option\.value"/,
    'raw model option value');
  forbidCodePattern(generationOptions, 'frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue',
    /aiAPI\.list(?:Image|Video|Audio)Models/,
    'catalog bypass');
  const dramaCanvas = readSource(root, 'frontweb/src/views/DramaCanvas.vue');
  requireExecutablePattern(dramaCanvas, 'frontweb/src/views/DramaCanvas.vue',
    /^\s*const freeCanvasModelCatalogLoader = createCanvasModelCatalogLoader\(\s*\r?\n\s*\(\) => request\.get\('\/canvas\/model-catalog'\)\s*\r?\n\s*\)\s*$/m,
    /^\s*const freeCanvasModelCatalogLoader = createCanvasModelCatalogLoader\(\s*\r?\n\s*\(\) => request\.get\(\s+\)\s*\r?\n\s*\)\s*$/m,
    'request.get canvas/model-catalog call');
  requireFunctionPattern(dramaCanvas, 'frontweb/src/views/DramaCanvas.vue', 'getFreeNodeModelOptions',
    /return getFreeNodeModelOptionEntriesForNode\(kind, nodeOrId\)/,
    'getFreeNodeModelOptions catalog mapping');
  requireFunctionPattern(dramaCanvas, 'frontweb/src/views/DramaCanvas.vue', 'getFreeNodeModelOptionEntries',
    /return canvasModelOptions\(freeCanvasModelCatalog\.value, kind\)/,
    'getFreeNodeModelOptionEntries catalog mapping');
  requireCodeRegionPattern(dramaCanvas, 'frontweb/src/views/DramaCanvas.vue',
    /const freeNodeSelectedModelMetadata = computed/, /const freeNodeModelDecision = computed/,
    /const freeNodeSelectedModelNote = computed\(\(\) => String\(freeNodeSelectedModelMetadata\.value\?\.publicNote \|\|[\s\S]{0,40}\)\.trim\(\)\)/,
    'freeNodeSelectedModelNote computed mapping');
  requireRawPattern(dramaCanvas, 'frontweb/src/views/DramaCanvas.vue',
    /<p v-else-if="freeNodeSelectedModelNote" class="free-node-model-note">\{\{ freeNodeSelectedModelNote \}\}<\/p>/,
    'freeNodeSelectedModelNote template binding');
  const filmList = readSource(root, 'frontweb/src/views/FilmList.vue');
  requireFunctionPattern(filmList, 'frontweb/src/views/FilmList.vue', 'loadHomeGenerationConfig',
    /Promise\.allSettled\(\[[\s\S]{0,120}request\.get\([\s\S]{0,260}const rawCatalog = canvasCatalog\.status ===[\s\S]{0,260}homeGenerationCatalog\.value = normalizeQuickGenerationCatalog\(rawCatalog\)[\s\S]{0,180}homeModel\.value = homeModelOptions\.value\[0\]\?\.model/,
    'scoped home generation catalog load');
  requireCodeRegionPattern(filmList, 'frontweb/src/views/FilmList.vue',
    /const homeModelOptions = computed/, /const homeInsufficientCredits = computed/,
    /const homeSelectedModel = computed[\s\S]{0,180}homeModelOptions\.value\.find\(\(item\) => item\.model === homeModel\.value\)/,
    'scoped home public model note');
  requireRawPattern(filmList, 'frontweb/src/views/FilmList.vue',
    /<option[\s\S]{0,260}:value="item\.model"[\s\S]{0,220}\{\{\s*item\.label\s*\|\|\s*item\.model\s*\}\}/,
    'raw model value with catalog label');
  requireRawPattern(filmList, 'frontweb/src/views/FilmList.vue',
    /<p v-if="homeSelectedModel\?\.publicNote" class="home-composer__model-note">[\s\S]{0,120}\{\{ homeSelectedModel\.publicNote \}\}/,
    'home publicNote binding');
  requireCodePattern(filmList, 'frontweb/src/views/FilmList.vue',
    /homeModelOptions\.value\.find\(\(item\) => item\.model === homeModel\.value\)/,
    'raw model selection');
  const freeCreate = readSource(root, 'frontweb/src/views/FreeCreate.vue');
  requireCodeRegionPattern(freeCreate, 'frontweb/src/views/FreeCreate.vue',
    /const modelOptions = computed/, /const selectedCredits = computed/,
    /const selectedModel = computed[\s\S]{0,180}modelOptions\.value\.find\(\(item\) => item\.model === model\.value\)/,
    'scoped free create public model');
  requireRawPattern(freeCreate, 'frontweb/src/views/FreeCreate.vue',
    /<small v-if="selectedModel\?\.publicNote" class="model-public-note">[\s\S]{0,100}\{\{ selectedModel\.publicNote \}\}/,
    'free create publicNote binding');
  requireCodeRegionPattern(freeCreate, 'frontweb/src/views/FreeCreate.vue',
    /onMounted\(async \(\) => \{/, /function triggerRefImageUpload/,
    /Promise\.allSettled\(\[[\s\S]{0,100}request\.get\([\s\S]{0,180}generationCatalog\.value = normalizeQuickGenerationCatalog\([\s\S]{0,180}catalog\.status ===/,
    'scoped free create generation catalog load');
  requireRawPattern(freeCreate, 'frontweb/src/views/FreeCreate.vue',
    /<el-option[\s\S]{0,260}:label="item\.label \|\| item\.model"[\s\S]{0,180}:value="item\.model"/,
    'raw model value with catalog label');
  requireCodePattern(freeCreate, 'frontweb/src/views/FreeCreate.vue',
    /modelOptions\.value\.find\(\(item\) => item\.model === model\.value\)/,
    'raw model selection');
  const filmCreate = readSource(root, 'frontweb/src/views/FilmCreate.vue');
  requireFunctionPattern(filmCreate, 'frontweb/src/views/FilmCreate.vue', 'loadVideoModelOptions',
    /const catalogRows = await aiAPI\.listCanvasModels\(\)[\s\S]{0,220}videoModelCatalog\.value = normalizeCanvasModelCatalog\(Array\.isArray\(catalogRows\) \? catalogRows : \[\]\)/,
    'unified canvas model catalog load');
  requireFunctionExecutablePattern(filmCreate, 'frontweb/src/views/FilmCreate.vue', 'loadVideoModelOptions',
    /videoModelCatalogStatus\.value\s*=\s*'error'/,
    /videoModelCatalogStatus\.value\s*=/,
    'catalog failure boundary');
  requireFunctionPattern(filmCreate, 'frontweb/src/views/FilmCreate.vue', 'loadVideoModelOptions',
    /videoModelCatalog\.value = \[\][\s\S]{0,120}videoModelCatalogStatus\.value =/,
    'scoped fail-closed catalog reset');
  requireCodeRegionPattern(filmCreate, 'frontweb/src/views/FilmCreate.vue',
    /const videoModelOptions = computed/, /const imageModelCatalog = ref/,
    /const selectedVideoModelMetadata = computed[\s\S]{0,180}videoModelOptions\.value\.find\(\(item\) => item\.model === selectedVideoModel\.value\)[\s\S]{0,120}const selectedVideoModelPublicNote = computed\(\(\) => selectedVideoModelMetadata\.value\?\.publicNote/,
    'selectedVideoModel publicNote scoped mapping');
  requireRawPattern(filmCreate, 'frontweb/src/views/FilmCreate.vue',
    /v-for="item in videoModelOptions"[\s\S]{0,160}:label="item\.label"[\s\S]{0,120}:value="item\.model"[\s\S]{0,120}:title="item\.publicNote \|\| item\.label"/,
    'raw model option value');
  const billingAdmin = readSource(root, 'frontweb/src/views/BillingAdmin.vue');
  requireFunctionPattern(billingAdmin, 'frontweb/src/views/BillingAdmin.vue', 'providerEntries',
    /item\?\.provider \|\| item\?\.provider_name \|\| item\?\.provider_base_url[\s\S]{0,180}provider_name:\s*item\.provider_name,[\s\S]{0,100}provider_base_url:\s*item\.provider_base_url/,
    'scoped provider metadata entries');
  requireFunctionPattern(billingAdmin, 'frontweb/src/views/BillingAdmin.vue', 'providerLabel',
    /entry\.provider_name \|\| entry\.provider[\s\S]{0,120}entry\.provider_name !== entry\.provider/,
    'scoped provider display label');
  requireFunctionPattern(billingAdmin, 'frontweb/src/views/BillingAdmin.vue', 'providerBaseUrl',
    /providerEntries\(item\)\.map\(\(entry\) => entry\.provider_base_url\)/,
    'scoped provider base URL');
  requireRawPattern(billingAdmin, 'frontweb/src/views/BillingAdmin.vue',
    /<el-input v-model="item\.display_name" maxlength="120" show-word-limit[^>]*\/>/,
    'item display_name input');
  requireRawPattern(billingAdmin, 'frontweb/src/views/BillingAdmin.vue',
    /<el-input\s+v-model="item\.public_note"\s+type="textarea"[\s\S]{0,180}maxlength="500"[\s\S]{0,240}\/>/,
    'item public_note input');
  requireRawPattern(billingAdmin, 'frontweb/src/views/BillingAdmin.vue',
    /<el-input v-model\.trim="newModel\.display_name" maxlength="120" show-word-limit[^>]*\/>/,
    'newModel display_name input');
  requireRawPattern(billingAdmin, 'frontweb/src/views/BillingAdmin.vue',
    /<el-input\s+v-model\.trim="newModel\.public_note"\s+type="textarea"[\s\S]{0,180}maxlength="500"[\s\S]{0,240}\/>/,
    'newModel public_note input');
  requireRawPattern(billingAdmin, 'frontweb/src/views/BillingAdmin.vue',
    /<small class="model-provider" :title="providerBaseUrl\(item\)">\s*中转站：\{\{ providerLabel\(item\) \}\}\s*<\/small>/,
    'provider display');
  requireFunctionPattern(billingAdmin, 'frontweb/src/views/BillingAdmin.vue', 'saveModel',
    /updateModelPrice\(item\.model, \{[\s\S]{0,240}display_name:\s*item\.display_name,\s*public_note:\s*item\.public_note,/,
    'public_note scoped saveModel payload');
  requireFunctionPattern(billingAdmin, 'frontweb/src/views/BillingAdmin.vue', 'addModel',
    /updateModelPrice\(newModel\.model, \{[\s\S]{0,240}display_name:\s*newModel\.display_name,\s*public_note:\s*newModel\.public_note,/,
    'public_note scoped addModel payload');
  return { ready: true, contract: CONTRACT };
}

function runCli(argv) {
  try {
    const root = argv[0] || path.resolve(__dirname, '..', '..');
    process.stdout.write(`${JSON.stringify(auditModelUiContract(root))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ready: false,
      contract: CONTRACT,
      error: error.code || 'MODEL_UI_CONTRACT_FAILED',
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli(process.argv.slice(2));

module.exports = { CONTRACT, auditModelUiContract, createSourceViews, stripSourceComments };
