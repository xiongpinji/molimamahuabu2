const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  auditModelUiContract,
  createSourceViews,
  stripSourceComments,
} = require('../scripts/verify-model-ui-contract');

const root = path.resolve(__dirname, '..', '..');
const protectedFiles = [
  'backend-node/src/routes/aiConfig.js',
  'backend-node/src/services/aiConfigService.js',
  'backend-node/src/services/modelPriceService.js',
  'backend-node/src/services/productionPreflightService.js',
  'backend-node/src/services/canvasModelCatalogService.js',
  'backend-node/src/services/usmercariVideoClient.js',
  'backend-node/src/services/videoService.js',
  'frontweb/src/utils/modelSelection.js',
  'frontweb/src/utils/canvasModelCapabilities.js',
  'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
  'frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue',
  'frontweb/src/views/DramaCanvas.vue',
  'frontweb/src/views/FilmList.vue',
  'frontweb/src/views/FreeCreate.vue',
  'frontweb/src/views/FilmCreate.vue',
  'frontweb/src/views/BillingAdmin.vue',
];

function copyContractTree() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'model-ui-contract-'));
  for (const relative of protectedFiles) {
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  return target;
}

function mutateContractFile(target, relativePath, mutate) {
  const file = path.join(target, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation must change ${relativePath}`);
  fs.writeFileSync(file, mutated);
}

function assertMutationRejected(relativePath, mutate, expected) {
  const target = copyContractTree();
  try {
    mutateContractFile(target, relativePath, mutate);
    assert.throws(() => auditModelUiContract(target), expected);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

test('model UI gate accepts the current protected catalog chain', () => {
  assert.deepEqual(auditModelUiContract(root), {
    ready: true,
    contract: 'model-ui-protection-v1',
  });
});

test('model UI gate rejects removal of verification fields from config conversion', () => {
  const target = copyContractTree();
  try {
    const file = path.join(target, 'backend-node/src/services/aiConfigService.js');
    const source = fs.readFileSync(file, 'utf8')
      .replace("verification_status: String(r.verification_status || 'pending'),", '');
    fs.writeFileSync(file, source);
    assert.throws(() => auditModelUiContract(target), /verification_status/);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('model UI gate rejects node selectors that bypass the unified catalog', () => {
  const target = copyContractTree();
  try {
    const file = path.join(target, 'frontweb/src/views/DramaCanvas.vue');
    const source = fs.readFileSync(file, 'utf8')
      .replaceAll('getFreeNodeModelOptions', 'removedModelOptions');
    fs.writeFileSync(file, source);
    assert.throws(() => auditModelUiContract(target), /getFreeNodeModelOptions/);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('model UI gate rejects removal of the enabled-price boundary', () => {
  const target = copyContractTree();
  try {
    const file = path.join(target, 'backend-node/src/services/canvasModelCatalogService.js');
    const source = fs.readFileSync(file, 'utf8')
      .replace(".filter((row) => row.status === 'enabled')", '');
    fs.writeFileSync(file, source);
    assert.throws(() => auditModelUiContract(target), /status === 'enabled'/);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('model UI gate rejects using the canonical billing name as the provider routing model', () => {
  assertMutationRejected(
    'backend-node/src/services/videoService.js',
    (source) => source.replace(
      "wan3State ? videoConfig?.provider : (body.provider || videoConfig?.provider || 'chatfire'), prompt, model, duration",
      "wan3State ? videoConfig?.provider : (body.provider || videoConfig?.provider || 'chatfire'), prompt, billingModel || model, duration",
    ),
    /prompt, model, duration/,
  );
});

test('model UI gate rejects allowing a request provider to override the verified Wan3 provider', () => {
  assertMutationRejected(
    'backend-node/src/services/videoService.js',
    (source) => source.replace(
      "wan3State ? videoConfig?.provider : (body.provider || videoConfig?.provider || 'chatfire')",
      "body.provider || videoConfig?.provider || 'chatfire'",
    ),
    /verified Wan3 provider pin/,
  );
});

test('model UI gate rejects removal of USMercari oversized reference image preparation', () => {
  const target = copyContractTree();
  try {
    const file = path.join(target, 'backend-node/src/services/usmercariVideoClient.js');
    const source = fs.readFileSync(file, 'utf8')
      .replaceAll('IMAGE_UPLOAD_TARGET_BYTES', 'removedImageUploadTarget');
    fs.writeFileSync(file, source);
    assert.throws(() => auditModelUiContract(target), /IMAGE_UPLOAD_TARGET_BYTES/);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('model UI gate rejects removal of the bounded USMercari media upload retry', () => {
  const target = copyContractTree();
  try {
    const file = path.join(target, 'backend-node/src/services/usmercariVideoClient.js');
    const source = fs.readFileSync(file, 'utf8')
      .replaceAll('MEDIA_UPLOAD_MAX_ATTEMPTS', 'removedMediaUploadAttempts');
    fs.writeFileSync(file, source);
    assert.throws(() => auditModelUiContract(target), /MEDIA_UPLOAD_MAX_ATTEMPTS/);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('model UI gate rejects deleting or renaming public model metadata', () => {
  assertMutationRejected(
    'backend-node/src/services/modelPriceService.js',
    (source) => source.replaceAll('public_note', 'customer_note'),
    /public_note/,
  );
  assertMutationRejected(
    'frontweb/src/views/FreeCreate.vue',
    (source) => source.replace('selectedModel?.publicNote', 'selectedModel?.description'),
    /FreeCreate\.vue.*publicNote/,
  );
});

test('model UI gate rejects deleting backend or frontend canvas note mappings', () => {
  assertMutationRejected(
    'backend-node/src/services/canvasModelCatalogService.js',
    (source) => source.replace('public_note: price?.public_note || null,', ''),
    /canvasModelCatalogService\.js.*public_note/,
  );
  assertMutationRejected(
    'frontweb/src/utils/canvasModelCapabilities.js',
    (source) => source.replace('note: item.publicNote,', ''),
    /canvasModelCapabilities\.js.*note/,
  );
});

test('model UI gate rejects FilmCreate catalog removal or AI-list-only fallback', () => {
  assertMutationRejected(
    'frontweb/src/views/FilmCreate.vue',
    (source) => source.replace(
      'const catalogRows = await aiAPI.listCanvasModels()',
      'const catalogRows = await aiAPI.listVideoModels()',
    ),
    /FilmCreate\.vue.*unified canvas model catalog/,
  );
  assertMutationRejected(
    'frontweb/src/views/FilmCreate.vue',
    (source) => source.replace(
      'videoModelCatalog.value = normalizeCanvasModelCatalog(Array.isArray(catalogRows) ? catalogRows : [])',
      'videoModelCatalog.value = []',
    ),
    /FilmCreate\.vue.*unified canvas model catalog/,
  );
});

test('model UI gate rejects replacing the homepage raw model value with display_name', () => {
  assertMutationRejected(
    'frontweb/src/views/FilmList.vue',
    (source) => source.replace(':value="item.model"', ':value="item.display_name || item.model"'),
    /FilmList\.vue.*raw model/,
  );
});

test('model UI gate rejects administrator model payloads that omit public_note', () => {
  assertMutationRejected(
    'frontweb/src/views/BillingAdmin.vue',
    (source) => source.replace('public_note: item.public_note,', ''),
    /BillingAdmin\.vue.*public_note.*saveModel/,
  );
  assertMutationRejected(
    'frontweb/src/views/BillingAdmin.vue',
    (source) => source.replace('public_note: newModel.public_note,', ''),
    /BillingAdmin\.vue.*public_note.*addModel/,
  );
});

test('model UI gate rejects production preflight fixed model lists or non-public catalogs', () => {
  assertMutationRejected(
    'backend-node/src/services/productionPreflightService.js',
    (source) => source.replace('modelPriceService.listPublic(db)', 'modelPriceService.SUPPORTED_MODELS'),
    /productionPreflightService\.js.*listPublic/,
  );
  assertMutationRejected(
    'backend-node/src/services/productionPreflightService.js',
    (source) => source.replace('modelPriceService.listPublic(db)', 'modelPriceService.list(db)'),
    /productionPreflightService\.js.*listPublic/,
  );
});

test('model UI gate preserves one retry for free USMercari 502 media upload', () => {
  assertMutationRejected(
    'backend-node/src/services/usmercariVideoClient.js',
    (source) => source.replace(
      'RETRYABLE_MEDIA_UPLOAD_STATUSES = new Set([429, 502, 503, 504])',
      'RETRYABLE_MEDIA_UPLOAD_STATUSES = new Set([429, 503, 504])',
    ),
    /usmercariVideoClient\.js.*502/,
  );
});

test('model UI gate rejects retry loops around the paid USMercari submission', () => {
  assertMutationRejected(
    'backend-node/src/services/usmercariVideoClient.js',
    (source) => source.replace(
      'async function callUsmercariVideoApi(config, log, opts = {}) {',
      'async function callUsmercariVideoApi(config, log, opts = {}) {\n  for (let paidAttempt = 1; paidAttempt <= 2; paidAttempt += 1) {',
    ),
    /paid.*must not retry/i,
  );
});

test('model UI gate preserves canvas-credit-callout-v1 and its configured fallback', () => {
  assertMutationRejected(
    'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
    (source) => source.replace('canvas-credit-callout-v1', 'billing-note'),
    /canvas-credit-callout-v1/,
  );
  assertMutationRejected(
    'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
    (source) => source.replace('积分待管理员配置', '预计积分未知'),
    /积分待管理员配置/,
  );
});

test('source comment stripping removes executable-looking comments without corrupting strings or URLs', () => {
  const source = [
    'const secureUrl = "https://example.com/v1/media//path";',
    "const lineText = '// intersectFilmCreateVideoModels(fake)';",
    "const blockText = '/* request.get(fake) */';",
    'const templateUrl = `https://example.com/${path}`;',
    'const urlPattern = /https?:\\/\\/example\\.com/;',
    '// intersectFilmCreateVideoModels(commentOnly)',
    '/* request.get(\'/canvas/model-catalog\') */',
    '<!-- freeNodeSelectedModelNote -->',
  ].join('\n');

  const stripped = stripSourceComments(source);
  assert.match(stripped, /https:\/\/example\.com\/v1\/media\/\/path/);
  assert.match(stripped, /'\/\/ intersectFilmCreateVideoModels\(fake\)'/);
  assert.match(stripped, /'\/\* request\.get\(fake\) \*\/'/);
  assert.match(stripped, /`https:\/\/example\.com\/\$\{path\}`/);
  assert.match(stripped, /\/https\?:\\\/\\\/example\\\.com\//);
  assert.doesNotMatch(stripped, /intersectFilmCreateVideoModels\(commentOnly\)/);
  assert.doesNotMatch(stripped, /request\.get\('\/canvas\/model-catalog'\)/);
  assert.doesNotMatch(stripped, /freeNodeSelectedModelNote/);
});

test('model UI gate ignores FilmCreate catalog normalization hidden in line comments', () => {
  const realCall = 'videoModelCatalog.value = normalizeCanvasModelCatalog(Array.isArray(catalogRows) ? catalogRows : [])';
  assertMutationRejected(
    'frontweb/src/views/FilmCreate.vue',
    (source) => source.replace(
      realCall,
      `videoModelCatalog.value = []\n// ${realCall}`,
    ),
    /FilmCreate\.vue.*unified canvas model catalog/,
  );
});

test('model UI gate ignores FilmCreate catalog normalization hidden in ordinary strings', () => {
  const realCall = 'videoModelCatalog.value = normalizeCanvasModelCatalog(Array.isArray(catalogRows) ? catalogRows : [])';
  assertMutationRejected(
    'frontweb/src/views/FilmCreate.vue',
    (source) => source.replace(
      realCall,
      `videoModelCatalog.value = []\nconst oldContractText = "${realCall}"`,
    ),
    /FilmCreate\.vue.*unified canvas model catalog/,
  );
});

test('model UI gate ignores model catalog calls hidden in block comments', () => {
  assertMutationRejected(
    'frontweb/src/views/FilmCreate.vue',
    (source) => source.replace(
      'const catalogRows = await aiAPI.listCanvasModels()',
      'const catalogRows = await aiAPI.listVideoModels() /* aiAPI.listCanvasModels() */',
    ),
    /FilmCreate\.vue.*unified canvas model catalog/,
  );
});

test('model UI gate ignores Vue contract tokens hidden in HTML comments', () => {
  assertMutationRejected(
    'frontweb/src/views/DramaCanvas.vue',
    (source) => `${source.replaceAll('freeNodeSelectedModelNote', 'removedSelectedModelNote')}\n<!-- freeNodeSelectedModelNote -->`,
    /DramaCanvas\.vue.*freeNodeSelectedModelNote/,
  );
});

test('source code view masks ordinary and template text while preserving template expression code', () => {
  const source = [
    'const ordinary = "selectedVideoModelNote";',
    'const template = `selectedVideoModelNote ${selectedVideoModelNote}`;',
    'const secureUrl = "https://example.com/v1/media//path";',
    'const quotePattern = /["\']/g;',
    'const afterRegex = selectedVideoModelNote;',
    '// selectedVideoModelNote',
    '<!-- selectedVideoModelNote -->',
  ].join('\n');

  const views = createSourceViews(source);
  assert.match(views.rawWithoutComments, /"selectedVideoModelNote"/);
  assert.match(views.rawWithoutComments, /https:\/\/example\.com\/v1\/media\/\/path/);
  assert.doesNotMatch(views.codeWithoutCommentsAndStrings, /ordinary.*selectedVideoModelNote/);
  assert.match(views.codeWithoutCommentsAndStrings, /\$\{selectedVideoModelNote\}/);
  assert.doesNotMatch(views.codeWithoutCommentsAndStrings, /https:\/\/example\.com/);
  assert.match(views.codeWithoutCommentsAndStrings, /const afterRegex = selectedVideoModelNote/);
  assert.doesNotMatch(views.codeWithoutCommentsAndStrings, /quotePattern.*selectedVideoModelNote/);
});

test('model UI gate rejects backend call or identifier contracts hidden in ordinary strings', () => {
  assertMutationRejected(
    'backend-node/src/routes/aiConfig.js',
    (source) => `${source.replaceAll('publicModelNames', 'listAllowedPublicModels')}\nconst contractDecoy = "publicModelNames";`,
    /aiConfig\.js.*publicModelNames/,
  );
});

test('model UI gate rejects backend property mappings hidden in ordinary strings', () => {
  assertMutationRejected(
    'backend-node/src/services/aiConfigService.js',
    (source) => `${source.replace(
      "verification_status: String(r.verification_status || 'pending'),",
      'status: r.status || null,',
    )}\nconst contractDecoy = "verification_status: String(r.verification_status || 'pending')";`,
    /aiConfigService\.js.*verification_status/,
  );
});

test('model UI gate rejects SQL schema contracts hidden in ordinary strings', () => {
  assertMutationRejected(
    'backend-node/src/services/modelPriceService.js',
    (source) => `${source.replaceAll('display_name TEXT', 'display_title TEXT')}\nconst contractDecoy = "display_name TEXT";`,
    /modelPriceService\.js.*display_name schema/,
  );
});

test('model UI gate rejects executable string comparisons hidden in ordinary strings', () => {
  const contract = ".filter((row) => row.status === 'enabled')";
  assertMutationRejected(
    'backend-node/src/services/canvasModelCatalogService.js',
    (source) => `${source.replace(contract, ".filter((row) => row.status === 'disabled')")}\nconst contractDecoy = "${contract}";`,
    /canvasModelCatalogService\.js.*enabled price filter/,
  );
});

test('model UI gate rejects selectedVideoModel public note hidden in ordinary strings', () => {
  assertMutationRejected(
    'frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue',
    (source) => `${source.replaceAll('selectedVideoModel?.publicNote', 'selectedVideoModel?.description')}\nconst contractDecoy = "selectedVideoModel?.publicNote";`,
    /CanvasGenerationOptions\.vue.*publicNote/,
  );
});

test('model UI gate rejects Vue bindings hidden inside unrelated attribute strings', () => {
  const contract = ':disabled="data.status === \'running\' ||';
  assertMutationRejected(
    'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
    (source) => `${source.replace(contract, ':disabled="!draft.content.trim() ||')}\n<span data-contract='${contract}' />`,
    /HomeCanvasNode\.vue.*generation run disabled binding/,
  );
});

test('model UI gate rejects protected credit markup and text hidden in ordinary strings', () => {
  assertMutationRejected(
    'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
    (source) => `${source
      .replace('class="billing-cost canvas-credit-callout-v1"', 'class="billing-cost credit-callout"')
      .replace('本次预计扣除', '预计扣除')}\nconst contractDecoy = "canvas-credit-callout-v1 本次预计扣除";`,
    /HomeCanvasNode\.vue.*canvas credit callout/,
  );
});

test('model UI gate rejects admin v-model bindings hidden in ordinary strings', () => {
  const contract = 'v-model="item.public_note"';
  assertMutationRejected(
    'frontweb/src/views/BillingAdmin.vue',
    (source) => `${source.replace(contract, 'v-model="item.customer_note"')}\nconst contractDecoy = '${contract}';`,
    /BillingAdmin\.vue.*item public_note input/,
  );
});

test('model UI gate rejects publicModelNames moved out of the public audio response chain', () => {
  const liveProjection = "const models = publicModelNames(aiConfigService.listConfigs(db, 'tts'));";
  assertMutationRejected(
    'backend-node/src/routes/aiConfig.js',
    (source) => `${source.replace(liveProjection, 'const models = [];')}
function deadPublicAudioProjection(db, res) {
  const models = publicModelNames(aiConfigService.listConfigs(db, 'tts'));
  response.success(res, models);
}`,
    /aiConfig\.js.*public audio model response/,
  );
});

test('model UI gate rejects selectedVideoModel and catalog normalization moved into dead functions', () => {
  const selectedModel = `const selectedVideoModel = computed(() => (
  canvasModelEntry(modelCatalog.value, 'video', options.value.videoModel) || null
))`;
  assertMutationRejected(
    'frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue',
    (source) => {
      const sourceSelectedModel = source.includes(selectedModel)
        ? selectedModel
        : selectedModel.replaceAll('\n', '\r\n');
      const withoutLiveMapping = source.replace(
        sourceSelectedModel,
        'const selectedVideoModel = computed(() => null)',
      );
      assert.notEqual(withoutLiveMapping, source, 'mutation must replace the live selectedVideoModel mapping');
      return withoutLiveMapping.replace('</script>', `function deadSelectedVideoModelContract() {
  ${selectedModel}
  return selectedVideoModel
}
</script>`);
    },
    /CanvasGenerationOptions\.vue.*selectedVideoModel scoped mapping/,
  );

  const catalogNormalization = 'videoModelCatalog.value = normalizeCanvasModelCatalog(Array.isArray(catalogRows) ? catalogRows : [])';
  assertMutationRejected(
    'frontweb/src/views/FilmCreate.vue',
    (source) => source
      .replace(catalogNormalization, 'videoModelCatalog.value = []')
      .replace('</script>', `function deadFilmCreateCatalogNormalization(catalogRows) {
  ${catalogNormalization}
}
</script>`),
    /FilmCreate\.vue.*unified canvas model catalog/,
  );
});

test('model UI gate rejects admin public_note payload moved into dead code', () => {
  assertMutationRejected(
    'frontweb/src/views/BillingAdmin.vue',
    (source) => source
      .replace('public_note: item.public_note,', 'description: item.public_note,')
      .replace('</script>', `function deadSaveModelPayload(item) {
  return { public_note: item.public_note }
}
</script>`),
    /BillingAdmin\.vue.*scoped saveModel payload/,
  );
});

test('model UI gate rejects preflight listPublic moved into dead code', () => {
  assertMutationRejected(
    'backend-node/src/services/productionPreflightService.js',
    (source) => source
      .replace('const configuredCategories = new Set(modelPriceService.listPublic(db)', 'const configuredCategories = new Set(modelPriceService.list(db)')
      .replace('module.exports = {', `function deadConfiguredCategories(db) {
  const configuredCategories = new Set(modelPriceService.listPublic(db));
  return configuredCategories;
}

module.exports = {`),
    /productionPreflightService\.js.*scoped listPublic preflight catalog/,
  );
});
