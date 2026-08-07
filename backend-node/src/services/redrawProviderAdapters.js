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

function requirePositiveDimension(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw codedError('REDRAW_IMAGE_DIMENSIONS_REQUIRED', `redraw image ${name} must be a positive finite number`);
  }
  return number;
}

function mimeFromPath(localPath, fallback) {
  const ext = path.extname(localPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.png') return 'image/png';
  return fallback;
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

function snapshotOf(attempt = {}, input = {}) {
  const payload = sourcePayloadOf(attempt);
  return attempt.snapshot
    || payload.snapshot
    || input.snapshot
    || input.generationSnapshot
    || input.generation_snapshot
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
  const snapshot = snapshotOf(attempt, input);
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

  async function localize(request = {}) {
    const model = trim(request.model);
    if (!model) throw codedError('REDRAW_PROVIDER_MODEL_REQUIRED', 'verified localization model is required');
    const generateText = requireMethod(deps, 'aiClient', './aiClient', 'generateText');
    const input = request.input || {};
    const systemPrompt = [
      'Return strict JSON only.',
      'Localize the supplied redraw source facts for the requested locale and market.',
      'Preserve shot IDs, shot order, timing, speakers, causal links, reversal beats, locked facts, and the hook.',
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
      return assertScopedAssetPath(await deps.uploadService.downloadImageToLocal(
        storageRoot,
        imageUrl,
        versionDir,
        log,
        `redraw_${kind}_${taskId || 'asset'}`,
        'redraw-assets',
      ), versionDir);
    }
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
    const dirAbs = path.join(storageRoot, dirRel);
    fs.mkdirSync(dirAbs, { recursive: true });
    const filename = `redraw_${kind}_${taskId || 'asset'}_${randomUUID().slice(0, 8)}.${extensionFromMime(mimeType)}`;
    const localPath = assertScopedAssetPath(`${dirRel}/${filename}`, versionDir);
    fs.writeFileSync(path.join(storageRoot, localPath), bytes);
    return localPath;
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
    localPath = await downloadImageToScopedFile(imageUrl, storageRoot, versionDir, kind, normalized.taskId || attempt.id);
    const absolutePath = path.join(storageRoot, localPath);
    if (!fs.existsSync(absolutePath)) throw codedError('ASSET_NOT_READABLE', 'downloaded redraw asset is not readable');
    let width;
    let height;
    try {
      width = requirePositiveDimension(
        imageResult.width ?? imageResult.metadata?.width ?? imageResult.quality?.width,
        'width',
      );
      height = requirePositiveDimension(
        imageResult.height ?? imageResult.metadata?.height ?? imageResult.quality?.height,
        'height',
      );
    } catch (error) {
      cleanupScopedFile(storageRoot, localPath, versionDir);
      throw error;
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
        mime_type: mimeFromPath(localPath, 'image/png'),
        width,
        height,
        image_gen_id: normalized.taskId,
        metadata,
      });
    } catch (error) {
      cleanupScopedFile(storageRoot, localPath, versionDir);
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
    const { attempt, input, sourceRef, model } = normalized;
    const text = trim(attempt.prompt || input.prompt || attempt.localized_description || attempt.localizedDescription
      || input.localizedDescription || input.localized_description || sourceRef.text || sourceRef.prompt);
    if (!text) throw codedError('REDRAW_PROVIDER_PROMPT_REQUIRED', 'redraw voice text is required');
    const synthesize = requireMethod(deps, 'ttsService', './ttsService', 'synthesize');
    const createAsset = requireMethod(deps, 'assetService', './assetService', 'create');
    const voiceId = trim(sourceRef.voice_id || sourceRef.voiceId || attempt.voice_id || attempt.voiceId || input.voice_id || input.voiceId);
    const config = deps.ttsConfig || (() => {
      const { selectTtsConfig } = require('./ttsConfigSelectionService');
      return selectTtsConfig(db, model);
    })();
    const result = await synthesize(db, log, {
      text,
      storyboard_id: attempt.storyboard_id || attempt.storyboardId || input.storyboardId || input.storyboard_id || normalized.taskId,
      config: { ...config, default_model: model, model },
      storage_base: storageRoot,
      storage_subdir: `redraw-assets/${versionDir}`,
      voice_id: voiceId || undefined,
      locale: normalized.locale,
    });
    if (isUnknownProviderResult(result)) {
      return {
        status: 'unknown',
        unknown: true,
        provider_task_id: providerTaskIdOf(result),
        error: result?.error || 'voice provider task status unknown',
      };
    }
    const localPath = assertScopedAssetPath(result.local_path, versionDir);
    const absolutePath = path.join(storageRoot, localPath);
    if (!fs.existsSync(absolutePath)) {
      throw codedError('ASSET_NOT_READABLE', 'downloaded redraw voice asset is not readable');
    }
    let duration = Number(result?.duration ?? result?.metadata?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      duration = probeDuration(absolutePath);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      cleanupScopedFile(storageRoot, localPath, versionDir);
      throw codedError('REDRAW_VOICE_DURATION_REQUIRED', 'redraw voice provider returned no positive duration');
    }
    const providerTaskId = providerTaskIdOf(result);
    const metadata = {
      source: 'redraw_provider_adapter',
      locale: normalized.locale,
      voice_id: voiceId || null,
      duration,
      provider_task_id: providerTaskId,
      model,
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
      throw error;
    }
    return {
      status: 'completed',
      asset_id: registered.id,
      voice_asset_id: registered.id,
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
    if (['character', 'scene', 'prop'].includes(kind)) {
      return generateImageAsset(request, normalized, storageRoot, versionDir);
    }
    throw codedError('REDRAW_PROVIDER_KIND_UNSUPPORTED', `unsupported redraw asset kind: ${kind || 'unknown'}`);
  }

  return { localize, generateAsset };
}

module.exports = { createRedrawProviderAdapters };
