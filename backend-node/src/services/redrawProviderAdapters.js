const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function trim(value) {
  return String(value || '').trim();
}

function parseJson(raw, fallback = {}) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function storageRootFrom(cfg = {}) {
  const configured = cfg.storage?.local_path || cfg.storage?.localPath;
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  }
  return path.join(process.cwd(), 'data', 'storage');
}

function assertScopedAssetPath(localPath, versionDir) {
  const rel = trim(localPath).replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw codedError('REDRAW_ASSET_STORAGE_SCOPE_INVALID', 'provider returned redraw asset outside version storage scope');
  }
  const expectedPrefix = `redraw-assets/${versionDir}/`;
  if (!rel.startsWith(expectedPrefix)) {
    throw codedError('REDRAW_ASSET_STORAGE_SCOPE_INVALID', 'provider returned redraw asset outside version storage scope');
  }
  return rel;
}

function scopedAbsolutePath(storageRoot, localPath, versionDir) {
  const rel = assertScopedAssetPath(localPath, versionDir);
  return { rel, abs: path.join(storageRoot, rel) };
}

function cleanupScopedFile(storageRoot, localPath, versionDir) {
  if (!localPath) return;
  try {
    const { abs } = scopedAbsolutePath(storageRoot, localPath, versionDir);
    fs.rmSync(abs, { force: true });
  } catch (_) {}
}

function cleanupVerifiedFile(absolutePath) {
  if (!absolutePath) return;
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isFile()) {
      fs.rmSync(absolutePath, { force: true });
    } else if (stat.isSymbolicLink()) {
      fs.unlinkSync(absolutePath);
    }
  } catch (_) {}
}

function requirePositiveDimension(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw codedError('REDRAW_IMAGE_DIMENSIONS_REQUIRED', `redraw image ${name} must be a positive finite number`);
  }
  return number;
}

function optionalPositiveDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function defaultImageMetadataProbe(absolutePath) {
  const sharp = require('sharp');
  return sharp(absolutePath).metadata();
}

function defaultRealpathSync(targetPath) {
  return fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
}

function sameResolvedPath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathIsInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertNoReparsePath(absolutePath, expectedType, realpathSync) {
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'downloaded redraw image artifact path uses unsupported linked storage');
    }
    if (expectedType === 'dir' && !stat.isDirectory()) {
      throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'downloaded redraw image artifact path is not a directory');
    }
    if (expectedType === 'file' && !stat.isFile()) {
      throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'downloaded redraw image artifact path is not a regular file');
    }
    if (!sameResolvedPath(absolutePath, realpathSync(absolutePath))) {
      throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'downloaded redraw image artifact path uses unsupported linked storage');
    }
  } catch (error) {
    if (error?.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID') throw error;
    throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'downloaded redraw image artifact path failed storage validation');
  }
}

function ensurePlainDirectory(absolutePath, realpathSync) {
  if (!fs.existsSync(absolutePath)) {
    fs.mkdirSync(absolutePath, { recursive: true });
  }
  assertNoReparsePath(absolutePath, 'dir', realpathSync);
}

function ensureImageStorageDirectory(storageRoot, versionDir, realpathSync) {
  ensurePlainDirectory(storageRoot, realpathSync);
  const redrawRoot = path.join(storageRoot, 'redraw-assets');
  ensurePlainDirectory(redrawRoot, realpathSync);
  const versionRoot = path.join(redrawRoot, versionDir);
  ensurePlainDirectory(versionRoot, realpathSync);
  return versionRoot;
}

function assertNoReparsePathComponents(storageRoot, localPath, versionDir, realpathSync) {
  const rel = assertScopedAssetPath(localPath, versionDir);
  assertNoReparsePath(storageRoot, 'dir', realpathSync);
  let current = storageRoot;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    assertNoReparsePath(current, i === parts.length - 1 ? 'file' : 'dir', realpathSync);
  }
  return path.join(storageRoot, rel);
}

function assertRealpathInsideVersion(storageRoot, versionDir, absolutePath, realpathSync) {
  try {
    const storageReal = realpathSync(storageRoot);
    const versionReal = realpathSync(path.join(storageRoot, 'redraw-assets', versionDir));
    const fileReal = realpathSync(absolutePath);
    if (!pathIsInside(storageReal, versionReal) || !pathIsInside(versionReal, fileReal)) {
      throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'downloaded redraw image artifact failed storage containment validation');
    }
    return fileReal;
  } catch (error) {
    if (error?.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID') throw error;
    throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'downloaded redraw image artifact failed storage containment validation');
  }
}

function mimeFromImageFormat(format) {
  const normalized = String(format || '').toLowerCase();
  if (normalized === 'png') return 'image/png';
  if (normalized === 'jpeg' || normalized === 'jpg') return 'image/jpeg';
  if (normalized === 'webp') return 'image/webp';
  throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'downloaded redraw image artifact uses an unsupported image format');
}

function imageMimeFromPath(localPath) {
  const ext = path.extname(localPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  return null;
}

function extensionFromMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/png') return 'png';
  return 'png';
}

function requireMethod(deps, key, modulePath, method) {
  const service = deps[key] || require(modulePath);
  const fn = service?.[method];
  if (typeof fn !== 'function') {
    throw codedError('REDRAW_PROVIDER_DEPENDENCY_UNAVAILABLE', `${key}.${method} is unavailable`);
  }
  return fn.bind(service);
}

function providerTaskIdOf(result) {
  return result?.provider_task_id || result?.providerTaskId || result?.task_id || result?.taskId || null;
}

function providerCompletedError(error, providerTaskId) {
  const value = error instanceof Error ? error : new Error(String(error || 'post-provider processing failed'));
  value.provider_completed = true;
  value.provider_task_id = trim(value.provider_task_id || providerTaskId) || null;
  return value;
}

function localeVerifyUnknown(error, providerTaskId) {
  const value = providerCompletedError(
    error instanceof Error ? error : new Error(String(error || 'redraw locale verification is unknown')),
    providerTaskId,
  );
  value.code = 'REDRAW_LOCALE_VERIFY_UNKNOWN';
  value.unknown = true;
  return value;
}

function requireProviderTaskId(result, kind) {
  const providerTaskId = trim(providerTaskIdOf(result));
  if (!providerTaskId) {
    const code = kind === 'voice' ? 'REDRAW_VOICE_EVIDENCE_INCOMPLETE' : 'PROVIDER_STATUS_UNKNOWN';
    throw codedError(code, `${kind} provider completion is missing a provider task id`, {
      unknown: true,
      provider_completed: true,
      provider_task_id: null,
    });
  }
  return providerTaskId;
}

function imageUrlOf(result) {
  return result?.image_url || result?.imageUrl || result?.url || result?.asset_url || result?.assetUrl || null;
}

function isUnknownProviderResult(result) {
  const status = String(result?.status || '').toLowerCase();
  const code = String(result?.code || result?.error_code || '').toUpperCase();
  return result?.unknown === true
    || ['pending', 'processing', 'indeterminate', 'needs_attention', 'unknown'].includes(status)
    || ['UNKNOWN', 'PROVIDER_UNKNOWN', 'TASK_UNKNOWN', 'STATUS_UNKNOWN', 'INDETERMINATE'].includes(code);
}

function completedProviderStatus(status) {
  return ['completed', 'complete', 'succeeded', 'success', 'done'].includes(String(status || '').toLowerCase());
}

function configSupportsModel(config, model) {
  const models = Array.isArray(config?.model) ? config.model.map(String) : [];
  return String(config?.default_model || '') === String(model || '') || models.includes(String(model || ''));
}

function selectPinnedTtsConfig(db, normalized, injectedConfig, requirePin = false) {
  const pinnedId = Number(normalized.snapshot?.ai_service_config_id ?? normalized.snapshot?.aiServiceConfigId);
  const pinnedUpdatedAt = trim(normalized.snapshot?.config_updated_at ?? normalized.snapshot?.configUpdatedAt);
  if (requirePin && (!Number.isSafeInteger(pinnedId) || pinnedId <= 0 || !pinnedUpdatedAt)) {
    throw codedError('REDRAW_TTS_CONFIG_PIN_INVALID', 'TTS generation requires an exact persisted config pin');
  }
  let config;
  if (Number.isSafeInteger(pinnedId) && pinnedId > 0) {
    const aiConfigService = require('./aiConfigService');
    config = aiConfigService.getConfig(db, pinnedId);
  } else if (injectedConfig) {
    config = injectedConfig;
  } else {
    const { selectTtsConfig } = require('./ttsConfigSelectionService');
    config = selectTtsConfig(db, normalized.model);
  }
  const expectedProvider = trim(normalized.provider);
  if (!config || config.service_type && config.service_type !== 'tts' || config.is_active === false
    || expectedProvider && trim(config.provider) !== expectedProvider
    || !configSupportsModel(config, normalized.model)) {
    throw codedError('REDRAW_TTS_CONFIG_PIN_INVALID', 'TTS generation config does not match the persisted provider/model pin');
  }
  if (Number.isSafeInteger(pinnedId) && pinnedId > 0 && Number(config.id) !== pinnedId) {
    throw codedError('REDRAW_TTS_CONFIG_PIN_INVALID', 'TTS generation config id does not match the persisted pin');
  }
  if (Number.isSafeInteger(pinnedId) && pinnedId > 0
    && (!pinnedUpdatedAt || trim(config.updated_at) !== pinnedUpdatedAt)) {
    throw codedError('REDRAW_TTS_CONFIG_PIN_INVALID', 'TTS generation config version does not match the persisted pin');
  }
  return config;
}

function assertLocaleVerifierReady(localeVerifier, locale) {
  if (!localeVerifier || typeof localeVerifier.assertReady !== 'function') return;
  try {
    localeVerifier.assertReady(locale);
  } catch (error) {
    const value = codedError('REDRAW_LOCALE_VERIFY_UNKNOWN', error?.message || 'redraw locale verifier is not ready', {
      unknown: true,
    });
    value.cause = error;
    throw value;
  }
}

async function verifyCompletedLocale(localeVerifier, {
  requestId,
  audioPath,
  approvedText,
  locale,
  ttsInvocation,
}, providerTaskId) {
  if (!localeVerifier || typeof localeVerifier.verify !== 'function') {
    return { languageVerified: false, detectedLocale: null, evidence: null };
  }
  try {
    const evidence = await localeVerifier.verify({
      requestId,
      audioPath,
      approvedText,
      locale,
      ttsInvocation,
    });
    const detectedLocale = trim(evidence?.detectedLocale || evidence?.detected_locale);
    if (evidence?.languageVerified !== true && evidence?.language_verified !== true) {
      throw codedError('REDRAW_LOCALE_EVIDENCE_INVALID', 'redraw locale verifier returned untrusted evidence');
    }
    return {
      languageVerified: true,
      detectedLocale: detectedLocale || locale,
      evidence,
    };
  } catch (error) {
    throw localeVerifyUnknown(error, providerTaskId);
  }
}

function qualityOf(result, width, height) {
  const quality = result?.quality && typeof result.quality === 'object' ? { ...result.quality } : {};
  if (width != null && quality.width == null) quality.width = width;
  if (height != null && quality.height == null) quality.height = height;
  for (const key of ['mask_area_changed', 'non_mask_similarity']) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (result?.[key] != null && quality[key] == null) quality[key] = result[key];
    if (result?.[camel] != null && quality[key] == null) quality[key] = result[camel];
  }
  return quality;
}

function sourcePayloadOf(attempt = {}) {
  return parseJson(attempt.source_ref_json || attempt.sourceRefJson, {});
}

function sourceRefOf(attempt = {}, input = {}) {
  const payload = sourcePayloadOf(attempt);
  return attempt.source_ref
    || attempt.sourceRef
    || input.sourceRef
    || input.source_ref
    || payload.source_ref
    || payload.source
    || {};
}

function snapshotOf(attempt = {}) {
  const payload = sourcePayloadOf(attempt);
  return attempt.snapshot
    || payload.snapshot
    || {};
}

function inputText(input = {}, ...keys) {
  for (const key of keys) {
    const value = trim(input[key]);
    if (value) return value;
  }
  return '';
}

function buildImagePrompt(attempt = {}, input = {}, sourceRef = {}) {
  return trim(attempt.prompt)
    || inputText(input, 'prompt')
    || [attempt.localized_name, attempt.localizedName, input.localizedName, input.localized_name,
      attempt.localized_description, attempt.localizedDescription, input.localizedDescription,
      input.localized_description, sourceRef.prompt, sourceRef.description]
      .map(trim)
      .filter(Boolean)
      .join('\n');
}

function defaultNegativePrompt(kind) {
  if (kind === 'scene') return 'people, characters, watermark, text overlays, split panels, grids';
  return 'watermark, text overlays, split panels, grids';
}

function normalizeAssetRequest(request = {}) {
  const input = request.input || {};
  const attempt = request.attempt || request.asset || input.asset || {};
  const sourceRef = sourceRefOf(attempt, input);
  const snapshot = snapshotOf(attempt);
  const snapshotModel = trim(snapshot.model);
  const requestModel = trim(request.model);
  if (snapshotModel && requestModel && requestModel !== snapshotModel) {
    throw codedError('REDRAW_PROVIDER_MODEL_SNAPSHOT_MISMATCH', 'request model does not match persisted asset snapshot model');
  }
  const snapshotProvider = trim(snapshot.provider);
  const requestProvider = trim(request.provider);
  if (snapshotProvider && requestProvider && requestProvider !== snapshotProvider) {
    throw codedError('REDRAW_PROVIDER_MODEL_SNAPSHOT_MISMATCH', 'request provider does not match persisted asset snapshot provider');
  }
  const model = snapshotModel || requestModel;
  const provider = snapshotProvider || requestProvider || null;
  const kind = trim(attempt.kind || input.kind || request.kind);
  const versionId = request.versionId || request.version_id || attempt.version_id || attempt.versionId;
  return {
    input,
    attempt,
    sourceRef,
    snapshot,
    model,
    provider,
    kind,
    versionId,
    locale: request.locale || input.locale || null,
    market: request.market || input.market || null,
    prompt: buildImagePrompt(attempt, input, sourceRef),
    localizedName: trim(attempt.localized_name || attempt.localizedName || input.localizedName || input.localized_name),
    localizedDescription: trim(attempt.localized_description || attempt.localizedDescription
      || input.localizedDescription || input.localized_description),
    taskId: request.taskId || request.task_id || input.taskId || input.task_id || null,
  };
}

function createRedrawProviderAdapters(deps = {}) {
  const db = deps.db;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const cfg = deps.cfg || {};
  const imageMetadataProbe = deps.imageMetadataProbe || defaultImageMetadataProbe;
  const realpathSync = deps.realpathSync || defaultRealpathSync;

  async function localize(request = {}) {
    const model = trim(request.model);
    if (!model) throw codedError('REDRAW_PROVIDER_MODEL_REQUIRED', 'verified localization model is required');
    const generateText = requireMethod(deps, 'aiClient', './aiClient', 'generateText');
    const input = request.input || {};
    const systemPrompt = [
      'Return strict JSON only.',
      'Localize the supplied redraw source facts for the requested locale and market.',
      'Preserve shot IDs, shot order, timing, speakers, causal links, reversal beats, locked facts, and the hook.',
      'Return every supplied source-fact field unchanged and copy source_facts_hash into facts_hash.',
      'Return name_map, culture_map, glossary, and dialogue.',
      'dialogue must be [{"shot_id":"...","turns":[{"speaker_id":"...","localized_text":"...","start_ms":0,"end_ms":1,"emotion":null,"overlap_group":null}]}].',
      'For every dialogue turn preserve speaker_id, order, start_ms, end_ms, emotion, and overlap_group exactly; translate only localized_text.',
      'Do not omit, merge, split, reorder, or invent dialogue turns or source facts.',
      'Do not add provider task identifiers for synchronous text completion.',
    ].join('\n');
    const userPrompt = JSON.stringify({
      task_id: request.taskId ?? null,
      locale: request.locale || input.locale || null,
      market: request.market || input.market || null,
      source_facts_hash: input.source_facts_hash || null,
      source_facts: input.source_facts || {},
    });
    const raw = await generateText(db, log, 'text', userPrompt, systemPrompt, {
      model,
      json_mode: true,
      temperature: 0.2,
      min_max_tokens: 4096,
    });
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      throw codedError('REDRAW_PROVIDER_INVALID_JSON', `localization provider returned invalid JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw codedError('REDRAW_PROVIDER_INVALID_JSON', 'localization provider returned invalid JSON object');
    }
    return { provider_task_id: null, result: parsed, model };
  }

  async function downloadImageToScopedFile(imageUrl, storageRoot, versionDir, kind, taskId) {
    if (deps.uploadService?.downloadImageToLocal) {
      return {
        createdByAdapter: false,
        localPath: assertScopedAssetPath(await deps.uploadService.downloadImageToLocal(
          storageRoot,
          imageUrl,
          versionDir,
          log,
          `redraw_${kind}_${taskId || 'asset'}`,
          'redraw-assets',
        ), versionDir),
      };
    }
    ensureImageStorageDirectory(storageRoot, versionDir, realpathSync);
    const downloadPublicImage = deps.publicImageDownloader || require('./videoClient').downloadPublicImage;
    let downloaded;
    try {
      downloaded = await downloadPublicImage(imageUrl);
    } catch (error) {
      throw codedError('REDRAW_IMAGE_DOWNLOAD_FAILED', error.message || 'redraw image download failed');
    }
    const bytes = downloaded?.bytes;
    const mimeType = String(downloaded?.mimeType || '').toLowerCase();
    if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || !mimeType.startsWith('image/')) {
      throw codedError('REDRAW_IMAGE_DOWNLOAD_FAILED', 'redraw image downloader returned invalid image bytes');
    }
    const dirRel = `redraw-assets/${versionDir}`;
    const filename = `redraw_${kind}_${taskId || 'asset'}_${randomUUID().slice(0, 8)}.${extensionFromMime(mimeType)}`;
    const localPath = assertScopedAssetPath(`${dirRel}/${filename}`, versionDir);
    fs.writeFileSync(path.join(storageRoot, localPath), bytes);
    return { createdByAdapter: true, localPath };
  }

  async function generateImageAsset(request, normalized, storageRoot, versionDir) {
    const { attempt, input, kind, sourceRef, model, provider, prompt } = normalized;
    if (!prompt) throw codedError('REDRAW_PROVIDER_PROMPT_REQUIRED', 'redraw image prompt is required');
    const callImageApi = requireMethod(deps, 'imageClient', './imageClient', 'callImageApi');
    const createAsset = requireMethod(deps, 'assetService', './assetService', 'create');
    const imageResult = await callImageApi(db, log, {
      prompt,
      model,
      preferred_provider: provider || undefined,
      imageServiceType: `redraw_${kind}`,
      image_type: `redraw_${kind}`,
      image_gen_id: normalized.taskId,
      drama_id: attempt.drama_id || attempt.dramaId || input.dramaId || input.drama_id || null,
      character_id: attempt.character_id || attempt.characterId || input.characterId || input.character_id || null,
      reference_image_urls: sourceRef.reference_image_urls || sourceRef.references || undefined,
      system_prompt: JSON.stringify({
        context: {
          locale: normalized.locale,
          market: normalized.market,
          kind,
          source_ref: sourceRef,
        },
      }),
      user_negative_prompt: sourceRef.negative_prompt || attempt.negative_prompt || input.negative_prompt || defaultNegativePrompt(kind),
    });
    if (isUnknownProviderResult(imageResult)) {
      return {
        status: 'unknown',
        unknown: true,
        provider_task_id: providerTaskIdOf(imageResult),
        error: imageResult?.error || 'image provider task status unknown',
      };
    }
    if (imageResult?.error) {
      throw codedError('REDRAW_IMAGE_PROVIDER_FAILED', String(imageResult.error), {
        provider_task_id: providerTaskIdOf(imageResult),
      });
    }
    const imageUrl = imageUrlOf(imageResult);
    if (!imageUrl) throw codedError('REDRAW_IMAGE_PROVIDER_EMPTY_RESULT', 'image provider returned no image url');
    let localPath = null;
    let createdByAdapter = false;
    const downloaded = await downloadImageToScopedFile(imageUrl, storageRoot, versionDir, kind, normalized.taskId || attempt.id);
    localPath = downloaded.localPath;
    createdByAdapter = downloaded.createdByAdapter;
    const { abs: absolutePath } = scopedAbsolutePath(storageRoot, localPath, versionDir);
    let width;
    let height;
    let mimeType;
    let cleanupPath = null;
    try {
      assertNoReparsePathComponents(storageRoot, localPath, versionDir, realpathSync);
      const containedPath = assertRealpathInsideVersion(storageRoot, versionDir, absolutePath, realpathSync);
      cleanupPath = createdByAdapter ? containedPath : null;
      const probed = await imageMetadataProbe(containedPath);
      width = requirePositiveDimension(probed?.width, 'width');
      height = requirePositiveDimension(probed?.height, 'height');
      mimeType = mimeFromImageFormat(probed?.format);
      const extensionMime = imageMimeFromPath(localPath);
      if (extensionMime && extensionMime !== mimeType) {
        throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'downloaded redraw image artifact format conflicts with file extension');
      }
      const providerWidth = optionalPositiveDimension(imageResult.width ?? imageResult.metadata?.width ?? imageResult.quality?.width);
      const providerHeight = optionalPositiveDimension(imageResult.height ?? imageResult.metadata?.height ?? imageResult.quality?.height);
      if ((providerWidth != null && providerWidth !== width) || (providerHeight != null && providerHeight !== height)) {
        throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'redraw image artifact dimensions conflict with provider metadata');
      }
    } catch (error) {
      cleanupVerifiedFile(cleanupPath);
      if (error?.code === 'REDRAW_PROVIDER_ARTIFACT_INVALID') throw error;
      throw codedError('REDRAW_PROVIDER_ARTIFACT_INVALID', 'downloaded redraw image artifact is invalid or unreadable');
    }
    const providerTaskId = providerTaskIdOf(imageResult);
    const metadata = {
      source: 'redraw_provider_adapter',
      kind,
      model,
      provider,
      locale: normalized.locale,
      market: normalized.market,
      provider_task_id: providerTaskId,
      source_ref: sourceRef,
      quality: qualityOf(imageResult, width, height),
    };
    if (kind === 'character' && Array.isArray(imageResult.views || imageResult.metadata?.views)) {
      metadata.views = imageResult.views || imageResult.metadata.views;
    }
    let registered;
    try {
      registered = createAsset(db, log, {
        drama_id: attempt.drama_id || attempt.dramaId || input.dramaId || input.drama_id || null,
        storyboard_id: attempt.storyboard_id || attempt.storyboardId || input.storyboardId || input.storyboard_id || null,
        name: normalized.localizedName || attempt.name || input.name || `redraw ${kind}`,
        type: 'image',
        category: `redraw_${kind}`,
        url: imageUrl,
        local_path: localPath,
        mime_type: mimeType,
        width,
        height,
        image_gen_id: normalized.taskId,
        metadata,
      });
    } catch (error) {
      cleanupVerifiedFile(cleanupPath);
      throw error;
    }
    const result = {
      status: 'completed',
      asset_id: registered.id,
      readable: true,
      provider_task_id: providerTaskId,
      metadata,
    };
    if (kind === 'scene') {
      result.clean_plate = true;
      result.quality = metadata.quality;
      result.clean_plate_asset_id = registered.id;
    }
    return result;
  }

  function probeDuration(absolutePath) {
    const probe = deps.audioProbe || require('./mergedEpisodePostProcess').ffprobeDurationSec;
    return Number(probe(absolutePath));
  }

  async function generateVoiceAsset(request, normalized, storageRoot, versionDir) {
    const { attempt, input, sourceRef, model, provider } = normalized;
    const text = trim(attempt.prompt || input.prompt || attempt.localized_description || attempt.localizedDescription
      || input.localizedDescription || input.localized_description || sourceRef.text || sourceRef.prompt);
    if (!text) throw codedError('REDRAW_PROVIDER_PROMPT_REQUIRED', 'redraw voice text is required');
    const synthesize = requireMethod(deps, 'ttsService', './ttsService', 'synthesize');
    const createAsset = requireMethod(deps, 'assetService', './assetService', 'create');
    const voiceId = trim(sourceRef.voice_id || sourceRef.voiceId || attempt.voice_id || attempt.voiceId || input.voice_id || input.voiceId);
    const config = selectPinnedTtsConfig(db, normalized, deps.ttsConfig);
    assertLocaleVerifierReady(deps.localeVerifier, normalized.locale);
    const result = await synthesize(db, log, {
      text,
      storyboard_id: attempt.storyboard_id || attempt.storyboardId || input.storyboardId || input.storyboard_id || normalized.taskId,
      config: { ...config, default_model: model, model },
      storage_base: storageRoot,
      storage_subdir: `redraw-assets/${versionDir}`,
      voice_id: voiceId || undefined,
      locale: normalized.locale,
      market: normalized.market,
    });
    if (isUnknownProviderResult(result)) {
      return {
        status: 'unknown',
        unknown: true,
        provider_task_id: providerTaskIdOf(result),
        error: result?.error || 'voice provider task status unknown',
      };
    }
    if ((result?.status && !completedProviderStatus(result.status)) || result?.error) {
      throw codedError('REDRAW_VOICE_PROVIDER_FAILED', result?.error || 'voice provider did not complete successfully', {
        provider_task_id: providerTaskIdOf(result),
      });
    }
    const providerTaskId = requireProviderTaskId(result, 'voice');
    let localPath;
    let absolutePath;
    let duration;
    try {
      localPath = assertScopedAssetPath(result.local_path, versionDir);
      absolutePath = path.join(storageRoot, localPath);
      if (!fs.existsSync(absolutePath)) {
        throw codedError('ASSET_NOT_READABLE', 'downloaded redraw voice asset is not readable');
      }
      duration = Number(result?.duration ?? result?.metadata?.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        duration = probeDuration(absolutePath);
      }
      if (!Number.isFinite(duration) || duration <= 0) {
        cleanupScopedFile(storageRoot, localPath, versionDir);
        throw codedError('REDRAW_VOICE_DURATION_REQUIRED', 'redraw voice provider returned no positive duration');
      }
    } catch (error) {
      throw providerCompletedError(error, providerTaskId);
    }
    const providerStatus = trim(result.status).toLowerCase();
    const detectedLocale = trim(result.detected_locale || result.detectedLocale
      || result.metadata?.detected_locale || result.metadata?.detectedLocale);
    const languageVerified = result.language_verified === true || result.languageVerified === true
      || result.metadata?.language_verified === true || result.metadata?.languageVerified === true;
    const isCloned = result.is_cloned === true || result.cloned === true || result.voice_type === 'clone'
      || sourceRef.is_cloned === true || sourceRef.cloned === true || sourceRef.voice_type === 'clone';
    const authorizationAssetId = result.authorization_asset_id ?? result.authorizationAssetId
      ?? result.metadata?.authorization_asset_id ?? result.metadata?.authorizationAssetId
      ?? sourceRef.authorization_asset_id ?? sourceRef.authorizationAssetId ?? null;
    const actualProvider = trim(config?.provider || provider);
    const aiServiceConfigId = Number(config?.id);
    const configUpdatedAt = trim(config?.updated_at);
    const localeEvidence = await verifyCompletedLocale(deps.localeVerifier, {
      requestId: providerTaskId,
      audioPath: absolutePath,
      approvedText: text,
      locale: normalized.locale,
      ttsInvocation: {
        provider: actualProvider,
        model,
        aiServiceConfigId: Number.isSafeInteger(aiServiceConfigId) && aiServiceConfigId > 0 ? aiServiceConfigId : null,
        configUpdatedAt: configUpdatedAt || null,
        providerTaskId,
      },
    }, providerTaskId);
    const voiceEvidence = {
      locale: normalized.locale,
      market: normalized.market,
      provider: actualProvider,
      model,
      ai_service_config_id: Number.isSafeInteger(aiServiceConfigId) && aiServiceConfigId > 0
        ? aiServiceConfigId
        : null,
      config_updated_at: configUpdatedAt || null,
      voice_id: trim(result.voice_id || result.voiceId || voiceId),
      task_id: providerTaskId,
      terminal_status: providerStatus,
      audio_asset_id: null,
      duration_ms: Math.round(duration * 1000),
      real_generation_verified: completedProviderStatus(providerStatus) && Boolean(providerTaskId),
      language_verified: localeEvidence.languageVerified,
      detected_locale: localeEvidence.detectedLocale || null,
      locale_verifier: localeEvidence.evidence,
      is_cloned: isCloned,
      authorization_asset_id: authorizationAssetId,
    };
    const metadata = {
      source: 'redraw_provider_adapter',
      locale: normalized.locale,
      market: normalized.market,
      voice_id: voiceId || null,
      duration,
      provider_task_id: providerTaskId,
      model,
      provider: actualProvider,
      ai_service_config_id: Number.isSafeInteger(aiServiceConfigId) && aiServiceConfigId > 0
        ? aiServiceConfigId
        : null,
      config_updated_at: configUpdatedAt || null,
      detected_locale: localeEvidence.detectedLocale || null,
      language_verified: localeEvidence.languageVerified,
      locale_verifier: localeEvidence.evidence,
      is_cloned: isCloned,
      authorization_asset_id: authorizationAssetId,
    };
    let registered;
    try {
      registered = createAsset(db, log, {
        drama_id: attempt.drama_id || attempt.dramaId || input.dramaId || input.drama_id || null,
        storyboard_id: attempt.storyboard_id || attempt.storyboardId || input.storyboardId || input.storyboard_id || null,
        name: normalized.localizedName || attempt.name || input.name || 'redraw voice',
        type: 'audio',
        category: 'redraw_voice',
        url: result.audio_url || result.url || '',
        local_path: localPath,
        mime_type: 'audio/mpeg',
        duration,
        metadata,
      });
    } catch (error) {
      cleanupScopedFile(storageRoot, localPath, versionDir);
      throw providerCompletedError(error, providerTaskId);
    }
    voiceEvidence.audio_asset_id = Number(registered.id);
    return {
      status: 'completed',
      asset_id: registered.id,
      voice_asset_id: registered.id,
      readable: true,
      provider_task_id: providerTaskId,
      metadata,
      voice_evidence: voiceEvidence,
      duration,
    };
  }

  function dialogueContext(request = {}, normalized = {}) {
    const segment = request.segment || request.dialogueSegment || {};
    const required = [
      'tenant_id',
      'user_id',
      'version_id',
      'segment_id',
      'idempotency_key',
      'reservation_id',
    ];
    const ctx = {};
    for (const key of required) {
      const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const value = segment[key] ?? segment[camel];
      if (value == null || trim(value) === '') {
        throw codedError('REDRAW_DIALOGUE_CONTEXT_REQUIRED', 'redraw dialogue server segment context is required');
      }
      ctx[key] = key === 'version_id' ? Number(value) : trim(value);
    }
    if (!Number.isSafeInteger(ctx.version_id) || ctx.version_id <= 0) {
      throw codedError('REDRAW_DIALOGUE_CONTEXT_REQUIRED', 'redraw dialogue server segment context is required');
    }
    if (Number(normalized.versionId) !== ctx.version_id) {
      throw codedError('REDRAW_DIALOGUE_CONTEXT_REQUIRED', 'redraw dialogue version context mismatch');
    }
    const text = trim(segment.text || segment.localized_text || segment.localizedText);
    if (!text) throw codedError('REDRAW_PROVIDER_PROMPT_REQUIRED', 'redraw dialogue text is required');
    return {
      ...ctx,
      text,
      voice_id: trim(segment.voice_id || segment.voiceId),
      voice_snapshot: segment.voice_snapshot || segment.voiceSnapshot || {},
      shot_id: segment.shot_id || segment.shotId || null,
      turn_index: segment.turn_index ?? segment.turnIndex ?? null,
    };
  }

  async function generateDialogueAsset(request, normalized, storageRoot, versionDir) {
    const ctx = dialogueContext(request, normalized);
    const synthesize = requireMethod(deps, 'ttsService', './ttsService', 'synthesize');
    const createAsset = requireMethod(deps, 'assetService', './assetService', 'create');
    const voiceSnapshot = ctx.voice_snapshot && typeof ctx.voice_snapshot === 'object'
      ? ctx.voice_snapshot
      : {};
    const config = selectPinnedTtsConfig(db, {
      ...normalized,
      provider: voiceSnapshot.provider,
      snapshot: voiceSnapshot,
    }, deps.ttsConfig, true);
    assertLocaleVerifierReady(deps.localeVerifier, normalized.locale);
    const result = await synthesize(db, log, {
      text: ctx.text,
      storyboard_id: normalized.taskId || ctx.segment_id,
      config: { ...config, default_model: normalized.model, model: normalized.model },
      storage_base: storageRoot,
      storage_subdir: `redraw-assets/${versionDir}`,
      voice_id: ctx.voice_id || undefined,
      locale: normalized.locale,
      market: normalized.market,
    });
    if (isUnknownProviderResult(result)) {
      throw codedError('PROVIDER_STATUS_UNKNOWN', result?.error || 'dialogue provider task status unknown', {
        unknown: true,
        provider_task_id: providerTaskIdOf(result),
      });
    }
    const providerTaskId = requireProviderTaskId(result, 'dialogue');
    let localPath;
    let absolutePath;
    let duration;
    try {
      localPath = assertScopedAssetPath(result.local_path, versionDir);
      absolutePath = path.join(storageRoot, localPath);
      if (!fs.existsSync(absolutePath)) {
        throw codedError('ASSET_NOT_READABLE', 'downloaded redraw dialogue asset is not readable');
      }
      duration = Number(result?.duration ?? result?.metadata?.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        duration = probeDuration(absolutePath);
      }
      if (!Number.isFinite(duration) || duration <= 0) {
        cleanupScopedFile(storageRoot, localPath, versionDir);
        throw codedError('REDRAW_VOICE_DURATION_REQUIRED', 'redraw dialogue provider returned no positive duration');
      }
    } catch (error) {
      throw providerCompletedError(error, providerTaskId);
    }
    const invocationId = randomUUID();
    const dialogueMetadata = {
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      version_id: ctx.version_id,
      segment_id: ctx.segment_id,
      idempotency_key: ctx.idempotency_key,
      reservation_id: ctx.reservation_id,
      provider_task_id: providerTaskId,
      provider: trim(config.provider),
      model: normalized.model,
      ai_service_config_id: Number(config.id),
      config_updated_at: trim(config.updated_at),
      voice_snapshot: voiceSnapshot,
      invocation_id: invocationId,
    };
    const localeEvidence = await verifyCompletedLocale(deps.localeVerifier, {
      requestId: providerTaskId,
      audioPath: absolutePath,
      approvedText: ctx.text,
      locale: normalized.locale,
      ttsInvocation: {
        provider: trim(config.provider),
        model: normalized.model,
        aiServiceConfigId: Number(config.id),
        configUpdatedAt: trim(config.updated_at),
        providerTaskId,
      },
    }, providerTaskId);
    const metadata = {
      source: 'redraw_provider_adapter',
      kind: 'dialogue',
      invocation_id: invocationId,
      locale: normalized.locale,
      voice_id: ctx.voice_id || null,
      duration,
      provider_task_id: providerTaskId,
      model: normalized.model,
      provider: trim(config.provider),
      ai_service_config_id: Number(config.id),
      config_updated_at: trim(config.updated_at),
      detected_locale: localeEvidence.detectedLocale || null,
      language_verified: localeEvidence.languageVerified,
      locale_verifier: localeEvidence.evidence,
      voice_snapshot: voiceSnapshot,
      redraw_dialogue: dialogueMetadata,
    };
    let registered;
    try {
      registered = createAsset(db, log, {
        name: `redraw dialogue ${ctx.segment_id}`,
        type: 'audio',
        category: 'redraw_dialogue',
        url: result.audio_url || result.url || '',
        local_path: localPath,
        mime_type: 'audio/mpeg',
        duration,
        metadata,
      });
    } catch (error) {
      cleanupScopedFile(storageRoot, localPath, versionDir);
      throw providerCompletedError(error, providerTaskId);
    }
    return {
      status: 'completed',
      asset_id: registered.id,
      audio_asset_id: registered.id,
      readable: true,
      provider_task_id: providerTaskId,
      metadata,
      duration,
    };
  }

  async function generateAsset(request = {}) {
    const normalized = normalizeAssetRequest(request);
    const model = trim(normalized.model);
    if (!model) throw codedError('REDRAW_PROVIDER_MODEL_REQUIRED', 'verified asset model is required');
    const kind = normalized.kind;
    const versionId = normalized.versionId;
    if (!versionId) throw codedError('REDRAW_PROVIDER_VERSION_REQUIRED', 'redraw version id is required');
    const versionDir = `v${Number(versionId) || trim(versionId)}`;
    const storageRoot = storageRootFrom(cfg);
    if (kind === 'voice') return generateVoiceAsset(request, normalized, storageRoot, versionDir);
    if (kind === 'dialogue') return generateDialogueAsset(request, normalized, storageRoot, versionDir);
    if (['character', 'scene', 'prop'].includes(kind)) {
      return generateImageAsset(request, normalized, storageRoot, versionDir);
    }
    throw codedError('REDRAW_PROVIDER_KIND_UNSUPPORTED', `unsupported redraw asset kind: ${kind || 'unknown'}`);
  }

  return { localize, generateAsset };
}

module.exports = { createRedrawProviderAdapters };
