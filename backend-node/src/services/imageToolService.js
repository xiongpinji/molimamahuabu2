const fs = require('node:fs');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile, spawnSync } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline: pipelineAsync } = require('node:stream/promises');
const { promisify } = require('node:util');
const sharp = require('sharp');

const assetService = require('./assetService');
const imageClient = require('./imageClient');
const storageLayout = require('./storageLayout');
const taskService = require('./taskService');
const execFileAsync = promisify(execFile);
const SMART_CUTOUT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SMART_CUTOUT_MAX_PIXELS = 40_000_000;
const OUTPAINT_MAX_REDIRECTS = 3;
const OUTPAINT_DOWNLOAD_TIMEOUT_MS = 30_000;
const REALESRGAN_ENGINE_VERSION = '0.2.5.0';
const AUDITED_REMBG_MODEL_HASHES = Object.freeze({
  u2netp: '309C8469258DDA742793DCE0EBEA8E6DD393174F89934733ECC8B14C76F4DDD8',
});
const AUDITED_REALESRGAN_FILES = Object.freeze({
  executable: '07E49F7CBB4EDE01AE4DD4C399D3A7E5846E3D2085C3128EFF881E55CB7B1A0C',
  runtime: Object.freeze({
    'vcomp140.dll': '8F72EF2E483465444B2059FC6744D6CB22CD8D8A27F6FA56BEFD2A42DCD0F78B',
  }),
  models: Object.freeze({
    'realesrgan-x4plus.bin': '713EE713B0353AFAA27976F0563A64A5043BD70B9BD8936C2E26E25EBCDBCDDF',
    'realesrgan-x4plus.param': '35330ECECCEA33B6C397A72548E788D5D53BECEE4734C50B7FADA36E89F10A86',
  }),
});

const FORMAT_INFO = {
  jpeg: { extension: '.jpg', mimeType: 'image/jpeg' },
  png: { extension: '.png', mimeType: 'image/png' },
  webp: { extension: '.webp', mimeType: 'image/webp' },
};

const OUTPAINT_SIZES = Object.freeze({
  '16:9': '1536x864',
  '9:16': '864x1536',
  '1:1': '1024x1024',
  '4:3': '1280x960',
  '3:4': '960x1280',
});

const OUTPAINT_DIRECTIONS = Object.freeze({
  auto: '根据原图构图向最自然的边界扩展',
  left: '仅向左延伸画布',
  right: '仅向右延伸画布',
  top: '仅向上延伸画布',
  bottom: '仅向下延伸画布',
  all: '向四周均匀延伸画布',
});

const LUT_PRESETS = Object.freeze({
  cinematic: [
    [1.05, -0.02, -0.03],
    [-0.02, 1.03, -0.01],
    [-0.04, 0.02, 1.08],
  ],
  warm: [
    [1.08, 0.02, 0],
    [0.01, 1.02, 0],
    [0, -0.02, 0.94],
  ],
  cool: [
    [0.96, 0, 0.02],
    [0, 1.01, 0.01],
    [0, 0.02, 1.08],
  ],
  mono: [
    [0.299, 0.587, 0.114],
    [0.299, 0.587, 0.114],
    [0.299, 0.587, 0.114],
  ],
});

const DETAIL_ENHANCE_PRESETS = Object.freeze({
  natural: 0.8,
  balanced: 1.2,
  strong: 1.8,
});
const REFERENCE_IMAGE_OPERATIONS = Object.freeze(['outpaint', 'markup_retouch']);
const MARKUP_MAX_STROKES = 16;
const MARKUP_MAX_POINTS_PER_STROKE = 128;
const MARKUP_COLORS = new Set(['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6']);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function resolveStorageRoot(cfg) {
  const configured = cfg?.storage?.local_path;
  const resolved = path.resolve(configured || path.join(process.cwd(), 'data', 'storage'));
  try {
    return fs.realpathSync.native(resolved);
  } catch (_) {
    return resolved;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function samePath(left, right) {
  const normalize = process.platform === 'win32'
    ? (value) => value.toLowerCase()
    : (value) => value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function resolveSourcePath(asset, storageRoot, allowedRoot) {
  if (!asset.local_path) fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '源图片没有可处理的本地文件');
  const sourcePath = path.resolve(
    path.isAbsolute(asset.local_path)
      ? asset.local_path
      : path.join(storageRoot, asset.local_path),
  );
  if (!isInside(storageRoot, sourcePath)) {
    fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '源图片不在允许的素材目录中');
  }
  try {
    const realAllowedRoot = fs.realpathSync.native(allowedRoot);
    const realSourcePath = fs.realpathSync.native(sourcePath);
    if (
      !samePath(realAllowedRoot, allowedRoot)
      || (
        !isInside(storageRoot, realAllowedRoot)
        && !samePath(storageRoot, realAllowedRoot)
      )
    ) {
      fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '源图片不在允许的素材目录中');
    }
    if (
      !isInside(storageRoot, realSourcePath)
      || !isInside(realAllowedRoot, realSourcePath)
      || !fs.statSync(realSourcePath).isFile()
    ) {
      fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '源图片不在当前项目的素材目录中');
    }
    return realSourcePath;
  } catch (error) {
    if (error.code === 'IMAGE_TOOL_SOURCE_UNAVAILABLE') throw error;
    fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '源图片文件不存在');
  }
}

function resolveDerivedDir(sourcePath) {
  const sourceDir = path.dirname(sourcePath);
  let current = sourceDir;
  let derivedDir = null;
  while (path.basename(current).toLowerCase() === 'derived') {
    derivedDir = current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return derivedDir || path.join(sourceDir, 'derived');
}

function ensureDerivedDir(sourcePath, allowedRoot) {
  const derivedDir = resolveDerivedDir(sourcePath);
  fs.mkdirSync(derivedDir, { recursive: true });
  const realAllowedRoot = fs.realpathSync.native(allowedRoot);
  const realDerivedDir = fs.realpathSync.native(derivedDir);
  if (
    !samePath(realAllowedRoot, allowedRoot)
    || !isInside(realAllowedRoot, realDerivedDir)
  ) {
    fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '派生素材目录不在当前项目中');
  }
  return realDerivedDir;
}

function requireOwnedImageAsset(db, assetId, context) {
  const asset = assetService.getById(db, assetId);
  if (!asset || asset.type !== 'image') fail('IMAGE_TOOL_ASSET_NOT_FOUND', '图片素材不存在');
  if (!context.publicPlatformEnabled) return asset;
  const owned = context.tenantId
    ? db.prepare(`SELECT id FROM dramas
        WHERE id = ? AND deleted_at IS NULL
          AND (tenant_id = ? OR (tenant_id IS NULL AND user_id = ?))`)
      .get(asset.drama_id, context.tenantId, context.userId)
    : db.prepare('SELECT id FROM dramas WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .get(asset.drama_id, context.userId);
  if (!owned) fail('IMAGE_TOOL_ASSET_NOT_FOUND', '图片素材不存在');
  return asset;
}

function requireInteger(value, name, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    fail('IMAGE_TOOL_INVALID_INPUT', `${name} 参数无效`);
  }
  return parsed;
}

function requireNumber(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    fail('IMAGE_TOOL_INVALID_INPUT', `${name} 参数必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return parsed;
}

function cropParameters(parameters, metadata) {
  const left = requireInteger(parameters.left, 'left', 0);
  const top = requireInteger(parameters.top, 'top', 0);
  const width = requireInteger(parameters.width, 'width', 1);
  const height = requireInteger(parameters.height, 'height', 1);
  if (left + width > metadata.width || top + height > metadata.height) {
    fail('IMAGE_TOOL_INVALID_INPUT', '裁剪范围超出源图片');
  }
  return { left, top, width, height };
}

function resultUrl(storageRoot, resultPath) {
  const relative = path.relative(storageRoot, resultPath).split(path.sep).join('/');
  return `/static/${relative}`;
}

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fileSha256(filePath) {
  const hash = createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex').toUpperCase();
}

function createConcurrencyLimiter(maxConcurrency, maxTenantConcurrency, busyMessage) {
  let active = 0;
  const activeByTenant = new Map();
  return {
    acquire(tenantId) {
      const tenantKey = String(tenantId || 'local');
      const tenantActive = activeByTenant.get(tenantKey) || 0;
      if (active >= maxConcurrency || tenantActive >= maxTenantConcurrency) {
        fail('IMAGE_TOOL_BUSY', busyMessage);
      }
      active += 1;
      activeByTenant.set(tenantKey, tenantActive + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        const remaining = (activeByTenant.get(tenantKey) || 1) - 1;
        if (remaining > 0) activeByTenant.set(tenantKey, remaining);
        else activeByTenant.delete(tenantKey);
      };
    },
  };
}

function normalizeSmartCutoutTool(tool, auditedModelHashes = AUDITED_REMBG_MODEL_HASHES) {
  if (!tool?.command || !path.isAbsolute(tool.command) || !fs.existsSync(tool.command)) return null;
  try {
    if (!fs.statSync(tool.command).isFile()) return null;
    fs.accessSync(tool.command, fs.constants.R_OK);
  } catch (_) {
    return null;
  }
  const model = String(tool.model || 'u2netp').trim();
  const expectedModelSha256 = String(auditedModelHashes?.[model] || '').trim().toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(expectedModelSha256)) return null;
  const expectedVersion = String(tool.engineVersion || '').trim();
  if (!expectedVersion) return null;
  const modelHome = String(tool.modelHome || '').trim();
  if (!modelHome || !path.isAbsolute(modelHome)) return null;
  const modelPath = path.join(modelHome, `${model}.onnx`);
  try {
    if (!fs.statSync(modelPath).isFile()) return null;
    fs.accessSync(modelPath, fs.constants.R_OK);
    if (fileSha256(modelPath) !== expectedModelSha256) return null;
  } catch (_) {
    return null;
  }
  const args = Array.isArray(tool.args) ? tool.args.map(String) : [];
  const childEnv = { ...process.env, U2NET_HOME: modelHome };
  const probe = spawnSync(tool.command, [...args, '--version'], {
    env: childEnv,
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  if (probe.error || probe.status !== 0) return null;
  const versionMatch = `${probe.stdout || ''}\n${probe.stderr || ''}`
    .match(/\brembg\b[^\d]*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
  const engineVersion = versionMatch?.[1] || '';
  if (!engineVersion || engineVersion !== expectedVersion) return null;
  const maxConcurrency = positiveLimit(tool.maxConcurrency, 1);
  const maxTenantConcurrency = Math.min(
    positiveLimit(tool.maxTenantConcurrency, 1),
    maxConcurrency,
  );
  return {
    command: tool.command,
    args,
    engine: 'rembg',
    engineVersion,
    model,
    modelHome,
    modelSha256: expectedModelSha256,
    limiter: createConcurrencyLimiter(
      maxConcurrency,
      maxTenantConcurrency,
      '智能抠图任务繁忙，请稍后重试',
    ),
  };
}

function normalizeUpscaleTool(tool, auditedFiles = AUDITED_REALESRGAN_FILES) {
  if (!tool?.command || !path.isAbsolute(tool.command) || !fs.existsSync(tool.command)) return null;
  const expectedExecutableSha256 = String(auditedFiles?.executable || '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(expectedExecutableSha256)) return null;
  const packageRoot = String(tool.packageRoot || '').trim();
  const modelDir = String(tool.modelDir || '').trim();
  const model = String(tool.model || 'realesrgan-x4plus').trim();
  const engineVersion = String(tool.engineVersion || '').trim();
  if (
    engineVersion !== REALESRGAN_ENGINE_VERSION
    || !path.isAbsolute(packageRoot)
    || !path.isAbsolute(modelDir)
  ) return null;
  try {
    const commandPath = fs.realpathSync.native(tool.command);
    const packagePath = fs.realpathSync.native(packageRoot);
    const modelPath = fs.realpathSync.native(modelDir);
    if (
      !samePath(path.dirname(commandPath), packagePath)
      || !samePath(modelPath, fs.realpathSync.native(path.join(packageRoot, 'models')))
      || !fs.statSync(commandPath).isFile()
      || fileSha256(commandPath) !== expectedExecutableSha256
    ) {
      return null;
    }
    if (!fs.statSync(packageRoot).isDirectory() || !fs.statSync(modelDir).isDirectory()) return null;
    for (const [name, expectedHash] of Object.entries(auditedFiles.runtime || {})) {
      const runtimePath = path.join(packageRoot, name);
      if (
        !/^[A-F0-9]{64}$/.test(String(expectedHash).toUpperCase())
        || !fs.statSync(runtimePath).isFile()
        || fileSha256(runtimePath) !== String(expectedHash).toUpperCase()
      ) return null;
    }
    for (const extension of ['bin', 'param']) {
      const name = `${model}.${extension}`;
      const expectedHash = String(auditedFiles.models?.[name] || '').toUpperCase();
      const modelPath = path.join(modelDir, name);
      if (
        !/^[A-F0-9]{64}$/.test(expectedHash)
        || !fs.statSync(modelPath).isFile()
        || fileSha256(modelPath) !== expectedHash
      ) return null;
    }
  } catch (_) {
    return null;
  }
  const args = Array.isArray(tool.args) ? tool.args.map(String) : [];
  const probe = spawnSync(tool.command, [...args, '-h'], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  const probeOutput = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  if (probe.error || !/Usage:.*realesrgan/is.test(probeOutput)) return null;
  const maxConcurrency = positiveLimit(tool.maxConcurrency, 1);
  const maxTenantConcurrency = Math.min(
    positiveLimit(tool.maxTenantConcurrency, 1),
    maxConcurrency,
  );
  return {
    command: tool.command,
    args,
    engine: 'realesrgan-ncnn-vulkan',
    engineVersion,
    executableSha256: expectedExecutableSha256,
    model,
    modelDir,
    modelSha256: {
      bin: String(auditedFiles.models[`${model}.bin`]).toUpperCase(),
      param: String(auditedFiles.models[`${model}.param`]).toUpperCase(),
    },
    packageRoot,
    limiter: createConcurrencyLimiter(
      maxConcurrency,
      maxTenantConcurrency,
      '高清增强任务繁忙，请稍后重试',
    ),
  };
}

function resolveModelTools(
  explicitTools,
  env = process.env,
  auditedModelHashes = AUDITED_REMBG_MODEL_HASHES,
  auditedUpscaleFiles = AUDITED_REALESRGAN_FILES,
) {
  if (explicitTools) {
    return {
      smart_cutout: normalizeSmartCutoutTool(explicitTools.smart_cutout, auditedModelHashes),
      upscale: normalizeUpscaleTool(explicitTools.upscale, auditedUpscaleFiles),
    };
  }
  const upscaleCommand = String(env.IMAGE_TOOL_REALESRGAN_PATH || '').trim();
  const upscalePackageRoot = String(
    env.IMAGE_TOOL_REALESRGAN_PACKAGE_ROOT || path.dirname(upscaleCommand),
  ).trim();
  return {
    smart_cutout: normalizeSmartCutoutTool({
      command: String(env.IMAGE_TOOL_REMBG_PATH || '').trim(),
      engineVersion: String(env.IMAGE_TOOL_REMBG_VERSION || '').trim(),
      model: String(env.IMAGE_TOOL_REMBG_MODEL || 'u2netp').trim(),
      modelHome: String(env.IMAGE_TOOL_REMBG_MODEL_HOME || '').trim(),
      maxConcurrency: env.IMAGE_TOOL_REMBG_MAX_CONCURRENCY,
      maxTenantConcurrency: env.IMAGE_TOOL_REMBG_MAX_TENANT_CONCURRENCY,
    }, auditedModelHashes),
    upscale: normalizeUpscaleTool({
      command: upscaleCommand,
      engineVersion: String(env.IMAGE_TOOL_REALESRGAN_VERSION || '').trim(),
      model: String(env.IMAGE_TOOL_REALESRGAN_MODEL || 'realesrgan-x4plus').trim(),
      packageRoot: upscalePackageRoot,
      modelDir: String(
        env.IMAGE_TOOL_REALESRGAN_MODEL_DIR || path.join(upscalePackageRoot, 'models'),
      ).trim(),
      maxConcurrency: env.IMAGE_TOOL_REALESRGAN_MAX_CONCURRENCY,
      maxTenantConcurrency: env.IMAGE_TOOL_REALESRGAN_MAX_TENANT_CONCURRENCY,
    }, auditedUpscaleFiles),
  };
}

function modelCapabilities(modelTools) {
  const smartCutout = modelTools?.smart_cutout;
  const available = smartCutout
    ? {
      available: true,
      engine: smartCutout.engine,
      engineVersion: smartCutout.engineVersion,
      model: smartCutout.model,
      modelSha256: smartCutout.modelSha256,
    }
    : {
      available: false,
      reason: '未配置已通过许可证审计的本地 rembg 与 U²-Net 模型',
    };
  const upscale = modelTools?.upscale
    ? {
      available: true,
      engine: modelTools.upscale.engine,
      engineVersion: modelTools.upscale.engineVersion,
      executableSha256: modelTools.upscale.executableSha256,
      model: modelTools.upscale.model,
      modelSha256: modelTools.upscale.modelSha256,
      scales: [2, 3, 4],
    }
    : {
      available: false,
      reason: '未配置已通过许可证审计的 Real-ESRGAN 本地引擎与模型',
    };
  const detailEnhance = modelTools?.upscale
    ? {
      available: true,
      engine: `${modelTools.upscale.engine}+sharp`,
      engineVersion: modelTools.upscale.engineVersion,
      executableSha256: modelTools.upscale.executableSha256,
      model: modelTools.upscale.model,
      modelSha256: modelTools.upscale.modelSha256,
      presets: Object.keys(DETAIL_ENHANCE_PRESETS),
      preservesDimensions: true,
    }
    : {
      ...upscale,
      reason: '未配置已通过许可证审计的 Real-ESRGAN 细节增强引擎与模型',
    };
  return {
    smart_cutout: { ...available },
    selection_cutout: { ...available },
    upscale,
    detail_enhance: detailEnhance,
  };
}

function normalizeReferenceImageTool(tool) {
  if (!tool || typeof tool.generate !== 'function') return null;
  const engine = String(tool.engine || 'provider-image-edit').trim();
  const provider = String(tool.provider || '').trim();
  const protocol = String(tool.protocol || provider).trim();
  const model = String(tool.model || '').trim();
  if (!engine || !provider || !protocol || !model) return null;
  const operations = (Array.isArray(tool.operations) ? tool.operations : ['outpaint'])
    .map((operation) => String(operation || '').trim())
    .filter((operation, index, values) => (
      REFERENCE_IMAGE_OPERATIONS.includes(operation)
      && values.indexOf(operation) === index
    ));
  if (operations.length === 0) return null;
  return {
    engine,
    provider,
    protocol,
    model,
    operations,
    generate: tool.generate,
    limiter: createConcurrencyLimiter(
      positiveLimit(tool.maxConcurrency, 1),
      positiveLimit(tool.maxTenantConcurrency, 1),
      '供应商图片编辑任务繁忙，请稍后重试',
    ),
  };
}

function resolveReferenceImageTool(db, log, explicitTool) {
  if (explicitTool) return normalizeReferenceImageTool(explicitTool);
  if (!db) return null;
  const capability = imageClient.getReferenceImageCapability(db, 'storyboard_image');
  if (!capability.available) return null;
  return normalizeReferenceImageTool({
    ...capability,
    async generate(request) {
      const referenceImages = (
        Array.isArray(request.referenceImages)
          ? request.referenceImages
          : [request.referenceImage]
      ).filter(Boolean);
      if (referenceImages.length === 0 || referenceImages.length > 2) {
        fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '参考图数量无效');
      }
      const relativeReferences = referenceImages.map((referenceImage) => {
        const relative = path.relative(request.storageRoot, referenceImage);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '参考图不在允许的素材目录中');
        }
        return relative.replace(/\\/g, '/');
      });
      return imageClient.callImageApi(db, log, {
        prompt: request.prompt,
        model: capability.model,
        preferred_provider: capability.provider,
        size: request.size || OUTPAINT_SIZES[request.aspectRatio],
        drama_id: request.dramaId,
        image_gen_id: request.taskId,
        imageServiceType: 'storyboard_image',
        reference_image_urls: relativeReferences,
        storage_local_path: request.storageRoot,
        system_prompt: request.systemPrompt
          || 'Image 1: source image whose subject, identity, style, lighting, and existing composition must be preserved.',
      });
    },
  });
}

function referenceImageCapabilities(referenceImageTool, unavailableReason) {
  const outpaintAvailable = referenceImageTool?.operations.includes('outpaint');
  const markupRetouchAvailable = referenceImageTool?.operations.includes('markup_retouch');
  const common = referenceImageTool
    ? {
      engine: referenceImageTool.engine,
      provider: referenceImageTool.provider,
      protocol: referenceImageTool.protocol,
      model: referenceImageTool.model,
    }
    : {};
  return {
    outpaint: outpaintAvailable
      ? {
        available: true,
        ...common,
        aspectRatios: Object.keys(OUTPAINT_SIZES),
        directions: Object.keys(OUTPAINT_DIRECTIONS),
      }
      : {
        available: false,
        reason: unavailableReason || '未配置已显式声明且通过审计的扩图模型',
      },
    markup_retouch: markupRetouchAvailable
      ? {
        available: true,
        ...common,
        maxStrokes: MARKUP_MAX_STROKES,
        maxPointsPerStroke: MARKUP_MAX_POINTS_PER_STROKE,
        preservesDimensions: true,
      }
      : {
        available: false,
        reason: unavailableReason || '未配置已显式声明且通过审计的标记修图模型',
      },
  };
}

function normalizeOutpaintParameters(parameters) {
  const aspectRatio = String(parameters.aspectRatio || '').trim();
  const direction = String(parameters.direction || '').trim();
  const prompt = String(parameters.prompt || '').trim();
  if (!OUTPAINT_SIZES[aspectRatio]) {
    fail('IMAGE_TOOL_INVALID_INPUT', 'aspectRatio 参数无效');
  }
  if (!OUTPAINT_DIRECTIONS[direction]) {
    fail('IMAGE_TOOL_INVALID_INPUT', 'direction 参数无效');
  }
  if (prompt.length > 500) {
    fail('IMAGE_TOOL_INVALID_INPUT', '扩图补充描述不能超过 500 字');
  }
  return { aspectRatio, direction, prompt };
}

function buildOutpaintPrompt(parameters) {
  const extra = parameters.prompt
    ? `补充要求：${parameters.prompt}。`
    : '';
  return [
    `基于输入原图进行扩图，目标画幅为 ${parameters.aspectRatio}，${OUTPAINT_DIRECTIONS[parameters.direction]}。`,
    '保留原图已有主体、人物身份、面部、服装、姿势、画风、光线、透视和原有画面内容，不要裁掉或重绘原图中心内容。',
    '只在新增画布区域自然补全连续环境、纹理与光影，边缘衔接必须无缝，输出一张连续完整图片，不要拼图、边框、文字或水印。',
    extra,
  ].filter(Boolean).join('\n');
}

function normalizeMarkupRetouchParameters(parameters) {
  const instruction = String(parameters.instruction || '').trim();
  if (!instruction || instruction.length > 500) {
    fail('IMAGE_TOOL_INVALID_INPUT', '修图指令必须为 1 到 500 个字符');
  }
  if (
    !Array.isArray(parameters.strokes)
    || parameters.strokes.length === 0
    || parameters.strokes.length > MARKUP_MAX_STROKES
  ) {
    fail('IMAGE_TOOL_INVALID_INPUT', `标记笔迹必须为 1 到 ${MARKUP_MAX_STROKES} 条`);
  }
  let pointCount = 0;
  const strokes = parameters.strokes.map((stroke) => {
    const color = String(stroke?.color || '').trim().toLowerCase();
    const width = Number(stroke?.width);
    if (!MARKUP_COLORS.has(color)) {
      fail('IMAGE_TOOL_INVALID_INPUT', '标记颜色不在允许范围内');
    }
    if (!Number.isFinite(width) || width < 0.005 || width > 0.08) {
      fail('IMAGE_TOOL_INVALID_INPUT', '标记笔宽参数无效');
    }
    if (
      !Array.isArray(stroke?.points)
      || stroke.points.length < 2
      || stroke.points.length > MARKUP_MAX_POINTS_PER_STROKE
    ) {
      fail(
        'IMAGE_TOOL_INVALID_INPUT',
        `每条标记笔迹必须包含 2 到 ${MARKUP_MAX_POINTS_PER_STROKE} 个点`,
      );
    }
    const points = stroke.points.map((point) => {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (
        !Number.isFinite(x)
        || !Number.isFinite(y)
        || x < 0
        || x > 1
        || y < 0
        || y > 1
      ) {
        fail('IMAGE_TOOL_INVALID_INPUT', '标记坐标必须位于图片范围内');
      }
      return {
        x: Number(x.toFixed(5)),
        y: Number(y.toFixed(5)),
      };
    });
    pointCount += points.length;
    return {
      color,
      width: Number(width.toFixed(5)),
      points,
    };
  });
  return {
    instruction,
    strokes,
    summary: {
      instruction,
      strokeCount: strokes.length,
      pointCount,
      preserveDimensions: true,
    },
  };
}

function buildMarkupReferenceSvg(parameters, width, height) {
  const minDimension = Math.min(width, height);
  const polylines = parameters.strokes.map((stroke) => {
    const points = stroke.points
      .map((point) => `${(point.x * width).toFixed(2)},${(point.y * height).toFixed(2)}`)
      .join(' ');
    const strokeWidth = Math.max(2, stroke.width * minDimension).toFixed(2);
    return `<polyline points="${points}" fill="none" stroke="${stroke.color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${polylines}</svg>`,
  );
}

async function createMarkupReference(sourcePath, outputDir, parameters, metadata) {
  const outputPath = path.join(outputDir, `markup-reference-${randomUUID()}.png`);
  try {
    const outputInfo = await sharp(sourcePath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    })
      .composite([{
        input: buildMarkupReferenceSvg(parameters, metadata.width, metadata.height),
        blend: 'over',
      }])
      .png()
      .toFile(outputPath);
    if (
      outputInfo.size <= 0
      || outputInfo.size > SMART_CUTOUT_MAX_OUTPUT_BYTES
      || outputInfo.width !== metadata.width
      || outputInfo.height !== metadata.height
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '标记参考图校验失败');
    }
    return outputPath;
  } catch (error) {
    if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
    if (String(error?.code || '').startsWith('IMAGE_TOOL_')) throw error;
    fail('IMAGE_TOOL_PROCESSING_FAILED', '标记参考图生成失败');
  }
}

function buildMarkupRetouchPrompt(parameters) {
  return [
    '图一是必须保留的原图，图二是同一张图叠加了彩色标记的编辑说明图。',
    `只修改图二标记覆盖的区域：${parameters.instruction}。`,
    '输出中必须移除全部彩色标记，不得保留涂鸦、线框、箭头、文字或水印。',
    '标记区域之外的人物身份、面部、服装、姿势、构图、透视、画风、纹理和光线保持不变。',
    '输出一张完整连续图片，不要拼图、边框或前后对比图。',
  ].join('\n');
}

function isPrivateNetworkAddress(address) {
  const normalized = String(address || '').toLowerCase().split('%')[0];
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const candidate = mappedIpv4 || normalized;
  const family = net.isIP(candidate);
  if (family === 4) {
    const parts = candidate.split('.').map(Number);
    const [first, second] = parts;
    return first === 0
      || first === 10
      || first === 127
      || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 192 && second === 0)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51)
      || (first === 203 && second === 0);
  }
  if (family === 6) {
    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('ff')
      || normalized.startsWith('2001:db8:');
  }
  return true;
}

async function resolveOutpaintHttpsTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果地址无效');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || !parsed.hostname
  ) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果地址无效');
  }
  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch (_) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果地址不可访问');
  }
  if (
    addresses.length === 0
    || addresses.some((entry) => isPrivateNetworkAddress(entry.address))
  ) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果地址不可访问');
  }
  return { parsed, ...addresses[0] };
}

async function streamOutpaintHttpsToFile(rawUrl, outputPath, maxBytes, redirectCount = 0) {
  if (redirectCount > OUTPAINT_MAX_REDIRECTS) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果重定向次数过多');
  }
  const target = await resolveOutpaintHttpsTarget(rawUrl);
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:',
      hostname: target.parsed.hostname,
      port: target.parsed.port || 443,
      path: `${target.parsed.pathname}${target.parsed.search}`,
      method: 'GET',
      headers: {
        Accept: 'image/png,image/jpeg,image/webp',
        'User-Agent': 'MoliMama-ImageTool/1.0',
      },
      timeout: OUTPAINT_DOWNLOAD_TIMEOUT_MS,
      lookup: (_hostname, _options, callback) => {
        callback(null, target.address, target.family);
      },
      ...(net.isIP(target.parsed.hostname)
        ? {}
        : { servername: target.parsed.hostname }),
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        let nextUrl;
        try {
          nextUrl = new URL(response.headers.location, target.parsed).toString();
        } catch (_) {
          reject(Object.assign(
            new Error('invalid redirect'),
            { code: 'IMAGE_TOOL_PROCESSING_FAILED' },
          ));
          return;
        }
        streamOutpaintHttpsToFile(nextUrl, outputPath, maxBytes, redirectCount + 1)
          .then(resolve, reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(Object.assign(
          new Error('unexpected download status'),
          { code: 'IMAGE_TOOL_PROCESSING_FAILED' },
        ));
        return;
      }
      const contentLength = Number(response.headers['content-length'] || 0);
      if (contentLength > maxBytes) {
        response.resume();
        reject(Object.assign(
          new Error('download too large'),
          { code: 'IMAGE_TOOL_PROCESSING_FAILED' },
        ));
        return;
      }
      const contentType = String(response.headers['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (
        contentType
        && !['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream']
          .includes(contentType)
      ) {
        response.resume();
        reject(Object.assign(
          new Error('unexpected content type'),
          { code: 'IMAGE_TOOL_PROCESSING_FAILED' },
        ));
        return;
      }
      let size = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > maxBytes) {
            callback(Object.assign(
              new Error('download too large'),
              { code: 'IMAGE_TOOL_PROCESSING_FAILED' },
            ));
            return;
          }
          callback(null, chunk);
        },
      });
      pipelineAsync(
        response,
        limiter,
        fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }),
      ).then(() => resolve(size), reject);
    });
    request.on('timeout', () => request.destroy(new Error('download timeout')));
    request.on('error', reject);
    request.end();
  });
}

async function saveOutpaintResult(imageUrl, outputDir, allowedRoot, options = {}) {
  const maxBytes = positiveLimit(options.maxBytes, SMART_CUTOUT_MAX_OUTPUT_BYTES);
  const outputPrefix = options.operation === 'markup_retouch'
    ? 'markup-provider-download'
    : 'outpaint';
  let realAllowedRoot;
  let realOutputDir;
  try {
    realAllowedRoot = fs.realpathSync.native(allowedRoot);
    realOutputDir = fs.realpathSync.native(outputDir);
  } catch (_) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果目录不可用');
  }
  if (
    !samePath(realAllowedRoot, allowedRoot)
    || !isInside(realAllowedRoot, realOutputDir)
  ) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果目录不在当前项目中');
  }
  const outputPath = path.join(realOutputDir, `${outputPrefix}-${randomUUID()}.image`);
  try {
    if (String(imageUrl || '').startsWith('data:')) {
      const match = String(imageUrl).match(
        /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/,
      );
      if (!match) fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果格式无效');
      const estimatedBytes = Math.floor((match[2].length * 3) / 4);
      if (estimatedBytes > maxBytes) {
        fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果超过大小限制');
      }
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length <= 0 || buffer.length > maxBytes) {
        fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果超过大小限制');
      }
      fs.writeFileSync(outputPath, buffer, { flag: 'wx', mode: 0o600 });
    } else {
      await streamOutpaintHttpsToFile(imageUrl, outputPath, maxBytes);
    }
    const realOutputPath = fs.realpathSync.native(outputPath);
    if (
      !isInside(realOutputDir, realOutputPath)
      || !fs.statSync(realOutputPath).isFile()
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果不在当前项目中');
    }
    return realOutputPath;
  } catch (error) {
    if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
    if (String(error?.code || '').startsWith('IMAGE_TOOL_')) throw error;
    fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果保存失败');
  }
}

async function runOutpaint({
  db,
  log,
  asset,
  request,
  task,
  sourcePath,
  storageRoot,
  allowedRoot,
  referenceImageTool,
  tenantId,
}) {
  const sourceMetadata = await sharp(sourcePath, { limitInputPixels: SMART_CUTOUT_MAX_PIXELS })
    .metadata();
  if (!FORMAT_INFO[sourceMetadata.format] || !sourceMetadata.width || !sourceMetadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const parameters = normalizeOutpaintParameters(request.parameters || {});
  const release = referenceImageTool.limiter.acquire(tenantId);
  let outputPath = null;
  try {
    const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
    const result = await taskService.withTaskHeartbeat(
      db,
      task.id,
      '正在等待参考图扩展服务...',
      () => referenceImageTool.generate({
        prompt: buildOutpaintPrompt(parameters),
        aspectRatio: parameters.aspectRatio,
        referenceImage: sourcePath,
        dramaId: asset.drama_id,
        taskId: task.id,
        storageRoot,
      }),
    );
    if (!result?.image_url || result.error) {
      log.warn('image outpaint provider failed', {
        provider: referenceImageTool.provider,
        protocol: referenceImageTool.protocol,
        model: referenceImageTool.model,
        reason: 'provider returned no image',
      });
      fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图处理失败');
    }
    outputPath = await saveOutpaintResult(
      result.image_url,
      outputDir,
      allowedRoot,
    );
    const outputSize = fs.statSync(outputPath).size;
    if (outputSize <= 0 || outputSize > SMART_CUTOUT_MAX_OUTPUT_BYTES) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图产物校验失败');
    }
    const outputMetadata = await sharp(outputPath, {
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    }).metadata();
    const format = FORMAT_INFO[outputMetadata.format];
    if (!format || !outputMetadata.width || !outputMetadata.height) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图结果格式无效');
    }
    if (outputMetadata.width * outputMetadata.height > SMART_CUTOUT_MAX_PIXELS) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图产物超过像素限制');
    }
    const [targetWidth, targetHeight] = OUTPAINT_SIZES[parameters.aspectRatio]
      .split('x')
      .map(Number);
    const targetRatio = targetWidth / targetHeight;
    const outputRatio = outputMetadata.width / outputMetadata.height;
    if (Math.abs(outputRatio - targetRatio) / targetRatio > 0.03) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图产物与目标画幅不符');
    }
    if (
      outputMetadata.width < sourceMetadata.width
      || outputMetadata.height < sourceMetadata.height
      || (
        outputMetadata.width === sourceMetadata.width
        && outputMetadata.height === sourceMetadata.height
      )
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图产物没有扩展原画布');
    }
    await sharp(outputPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    }).stats();
    const finalPath = path.join(
      path.dirname(outputPath),
      `${path.parse(outputPath).name}${format.extension}`,
    );
    fs.renameSync(outputPath, finalPath);
    outputPath = finalPath;
    return {
      outputPath,
      format,
      outputInfo: {
        size: outputSize,
        width: outputMetadata.width,
        height: outputMetadata.height,
      },
      parameters,
    };
  } catch (error) {
    if (outputPath && fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
    if (error?.code === 'IMAGE_TOOL_SOURCE_UNAVAILABLE') throw error;
    log.warn('image outpaint failed', {
      provider: referenceImageTool.provider,
      protocol: referenceImageTool.protocol,
      model: referenceImageTool.model,
      reason: 'provider request or output validation failed',
    });
    fail('IMAGE_TOOL_PROCESSING_FAILED', '扩图处理失败');
  } finally {
    release();
  }
}

async function runMarkupRetouch({
  db,
  log,
  asset,
  request,
  task,
  sourcePath,
  storageRoot,
  allowedRoot,
  referenceImageTool,
  tenantId,
}) {
  let sourceMetadata;
  try {
    sourceMetadata = await sharp(sourcePath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    }).metadata();
  } catch {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  if (!FORMAT_INFO[sourceMetadata.format] || !sourceMetadata.width || !sourceMetadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const parameters = normalizeMarkupRetouchParameters(request.parameters || {});
  const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
  let release;
  let markedReferencePath = null;
  let providerDownloadPath = null;
  let outputPath = null;
  try {
    release = referenceImageTool.limiter.acquire(tenantId);
    markedReferencePath = await createMarkupReference(
      sourcePath,
      outputDir,
      parameters,
      sourceMetadata,
    );
    const result = await taskService.withTaskHeartbeat(
      db,
      task.id,
      '正在执行标记区域修图...',
      () => referenceImageTool.generate({
        prompt: buildMarkupRetouchPrompt(parameters),
        size: `${sourceMetadata.width}x${sourceMetadata.height}`,
        referenceImages: [sourcePath, markedReferencePath],
        dramaId: asset.drama_id,
        taskId: task.id,
        storageRoot,
        systemPrompt: 'Image 1 is the untouched source. Image 2 is the same image with visual marks that identify the only region allowed to change.',
      }),
    );
    if (!result?.image_url || result.error) {
      log.warn('image markup retouch provider failed', {
        provider: referenceImageTool.provider,
        protocol: referenceImageTool.protocol,
        model: referenceImageTool.model,
        reason: 'provider returned no image',
      });
      fail('IMAGE_TOOL_PROCESSING_FAILED', '标记修图处理失败');
    }
    providerDownloadPath = await saveOutpaintResult(
      result.image_url,
      outputDir,
      allowedRoot,
      { operation: 'markup_retouch' },
    );
    const providerMetadata = await sharp(providerDownloadPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    }).metadata();
    if (
      !FORMAT_INFO[providerMetadata.format]
      || !providerMetadata.width
      || !providerMetadata.height
      || providerMetadata.width * providerMetadata.height > SMART_CUTOUT_MAX_PIXELS
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '标记修图结果格式无效');
    }
    const sourceRatio = sourceMetadata.width / sourceMetadata.height;
    const providerRatio = providerMetadata.width / providerMetadata.height;
    if (Math.abs(providerRatio - sourceRatio) / sourceRatio > 0.03) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '标记修图结果画幅与原图不符');
    }
    outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}.png`);
    const outputInfo = await sharp(providerDownloadPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    })
      .resize(sourceMetadata.width, sourceMetadata.height, {
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toFile(outputPath);
    if (
      outputInfo.size <= 0
      || outputInfo.size > SMART_CUTOUT_MAX_OUTPUT_BYTES
      || outputInfo.width !== sourceMetadata.width
      || outputInfo.height !== sourceMetadata.height
      || fileSha256(outputPath) === fileSha256(sourcePath)
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '标记修图产物校验失败');
    }
    return {
      outputPath,
      format: FORMAT_INFO.png,
      outputInfo,
      parameters: parameters.summary,
    };
  } catch (error) {
    if (outputPath && fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
    if ([
      'IMAGE_TOOL_INVALID_INPUT',
      'IMAGE_TOOL_SOURCE_UNAVAILABLE',
      'IMAGE_TOOL_UNSUPPORTED_IMAGE',
      'IMAGE_TOOL_BUSY',
    ].includes(error?.code)) {
      throw error;
    }
    log.warn('image markup retouch failed', {
      provider: referenceImageTool.provider,
      protocol: referenceImageTool.protocol,
      model: referenceImageTool.model,
      reason: 'provider request or output validation failed',
    });
    fail('IMAGE_TOOL_PROCESSING_FAILED', '标记修图处理失败');
  } finally {
    release?.();
    for (const temporaryPath of [markedReferencePath, providerDownloadPath]) {
      if (temporaryPath && fs.existsSync(temporaryPath)) {
        fs.rmSync(temporaryPath, { force: true });
      }
    }
  }
}

async function runSmartCutoutUnlocked(sourcePath, outputPath, tool, log) {
  const childEnv = { ...process.env };
  if (tool.modelHome) childEnv.U2NET_HOME = tool.modelHome;
  try {
    await execFileAsync(
      tool.command,
      [...tool.args, 'i', '-m', tool.model, sourcePath, outputPath],
      {
        env: childEnv,
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().slice(-400);
    log?.error?.('smart cutout processing failed', {
      error: detail,
      exitCode: error.code,
      signal: error.signal,
    });
    const reason = error.killed || error.signal === 'SIGTERM'
      ? '智能抠图处理超时'
      : '智能抠图处理失败，请检查本地引擎配置';
    fail('IMAGE_TOOL_PROCESSING_FAILED', reason);
  }
  if (!fs.existsSync(outputPath)) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', '智能抠图未生成输出文件');
  }
  let metadata;
  let outputSize;
  try {
    outputSize = fs.statSync(outputPath).size;
    if (outputSize > SMART_CUTOUT_MAX_OUTPUT_BYTES) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '智能抠图产物超过大小限制');
    }
    const output = sharp(outputPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    });
    metadata = await output.metadata();
    if (
      !metadata.width
      || !metadata.height
      || metadata.width * metadata.height > SMART_CUTOUT_MAX_PIXELS
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '智能抠图产物超过像素限制');
    }
    await output.stats();
  } catch (error) {
    log?.error?.('smart cutout output validation failed', {
      error: String(error.message || '').trim().slice(-400),
    });
    fail('IMAGE_TOOL_PROCESSING_FAILED', '智能抠图产物校验失败');
  }
  if (metadata.format !== 'png' || !metadata.hasAlpha || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', '智能抠图产物不是有效的透明 PNG');
  }
  return {
    format: FORMAT_INFO.png,
    normalized: { model: tool.model },
    outputInfo: {
      size: outputSize,
      width: metadata.width,
      height: metadata.height,
    },
    engine: tool.engine,
    engineVersion: tool.engineVersion,
  };
}

async function prepareUpscaleSource(sourcePath, parameters) {
  const source = sharp(sourcePath, {
    failOn: 'warning',
    limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
  });
  const metadata = await source.metadata();
  if (!FORMAT_INFO[metadata.format] || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const scale = requireInteger(parameters.scale ?? 2, 'scale', 2);
  if (scale > 4) fail('IMAGE_TOOL_INVALID_INPUT', 'scale 参数不能大于 4');
  const width = metadata.width * scale;
  const height = metadata.height * scale;
  if (width * height > SMART_CUTOUT_MAX_PIXELS) {
    fail('IMAGE_TOOL_INVALID_INPUT', '高清增强产物超过像素限制');
  }
  return {
    normalized: { scale },
    expectedWidth: width,
    expectedHeight: height,
  };
}

async function runUpscaleUnlocked(
  sourcePath,
  outputPath,
  prepared,
  tool,
  log,
  operationLabel = '高清增强',
) {
  try {
    await execFileAsync(
      tool.command,
      [
        ...tool.args,
        '-i', sourcePath,
        '-o', outputPath,
        '-n', tool.model,
        '-s', String(prepared.normalized.scale),
        '-m', tool.modelDir,
        '-f', 'png',
      ],
      {
        cwd: tool.packageRoot,
        timeout: 300_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
    );
  } catch (error) {
    log?.error?.('Real-ESRGAN processing failed', {
      error: String(error.stderr || error.message || '').trim().slice(-400),
      exitCode: error.code,
      signal: error.signal,
    });
    fail(
      'IMAGE_TOOL_PROCESSING_FAILED',
      error.killed || error.signal === 'SIGTERM'
        ? `${operationLabel}处理超时`
        : `${operationLabel}处理失败`,
    );
  }
  if (!fs.existsSync(outputPath)) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', `${operationLabel}处理失败`);
  }
  try {
    const outputSize = fs.statSync(outputPath).size;
    if (outputSize <= 0 || outputSize > SMART_CUTOUT_MAX_OUTPUT_BYTES) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', `${operationLabel}产物校验失败`);
    }
    const output = sharp(outputPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    });
    const metadata = await output.metadata();
    if (
      metadata.format !== 'png'
      || metadata.width !== prepared.expectedWidth
      || metadata.height !== prepared.expectedHeight
      || metadata.width * metadata.height > SMART_CUTOUT_MAX_PIXELS
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', `${operationLabel}产物校验失败`);
    }
    await output.stats();
    return {
      format: FORMAT_INFO.png,
      normalized: {
        ...prepared.normalized,
        model: tool.model,
      },
      outputInfo: {
        size: outputSize,
        width: metadata.width,
        height: metadata.height,
      },
      engine: tool.engine,
      engineVersion: tool.engineVersion,
    };
  } catch (error) {
    log?.error?.('Real-ESRGAN output validation failed', {
      error: String(error.message || '').trim().slice(-400),
    });
    fail('IMAGE_TOOL_PROCESSING_FAILED', `${operationLabel}产物校验失败`);
  }
}

async function prepareDetailEnhanceSource(sourcePath, parameters) {
  const preset = String(parameters.preset || 'balanced').trim().toLowerCase();
  if (!DETAIL_ENHANCE_PRESETS[preset]) {
    fail(
      'IMAGE_TOOL_INVALID_INPUT',
      'preset 参数仅支持 natural、balanced 或 strong',
    );
  }
  const metadata = await sharp(sourcePath, {
    failOn: 'warning',
    limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
  }).metadata();
  if (!FORMAT_INFO[metadata.format] || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const expectedWidth = metadata.width * 2;
  const expectedHeight = metadata.height * 2;
  if (expectedWidth * expectedHeight > SMART_CUTOUT_MAX_PIXELS) {
    fail('IMAGE_TOOL_INVALID_INPUT', '细节纹理增强临时产物超过像素限制');
  }
  return {
    preset,
    width: metadata.width,
    height: metadata.height,
    upscale: {
      normalized: { scale: 2 },
      expectedWidth,
      expectedHeight,
    },
  };
}

async function runDetailEnhanceUnlocked({
  sourcePath,
  intermediatePath,
  outputPath,
  prepared,
  tool,
  log,
}) {
  try {
    await runUpscaleUnlocked(
      sourcePath,
      intermediatePath,
      prepared.upscale,
      tool,
      log,
      '细节纹理增强',
    );
    const outputInfo = await sharp(intermediatePath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    })
      .resize(prepared.width, prepared.height, { kernel: 'lanczos3' })
      .sharpen(DETAIL_ENHANCE_PRESETS[prepared.preset])
      .png()
      .toFile(outputPath);
    const metadata = await sharp(outputPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    }).metadata();
    if (
      metadata.format !== 'png'
      || metadata.width !== prepared.width
      || metadata.height !== prepared.height
      || outputInfo.size <= 0
      || outputInfo.size > SMART_CUTOUT_MAX_OUTPUT_BYTES
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '细节纹理增强处理失败');
    }
    await sharp(outputPath).stats();
    return {
      format: FORMAT_INFO.png,
      normalized: {
        preset: prepared.preset,
        scale: 2,
        model: tool.model,
        preserveDimensions: true,
      },
      outputInfo: {
        size: outputInfo.size,
        width: metadata.width,
        height: metadata.height,
      },
      engine: `${tool.engine}+sharp`,
      engineVersion: `${tool.engineVersion}+sharp-${sharp.versions.sharp}`,
    };
  } catch (error) {
    if (
      error?.code === 'IMAGE_TOOL_PROCESSING_FAILED'
      && /^细节纹理增强处理/.test(error.message)
    ) {
      throw error;
    }
    log?.error?.('detail enhance processing failed', {
      error: String(error?.message || error).trim().slice(-400),
    });
    fail('IMAGE_TOOL_PROCESSING_FAILED', '细节纹理增强处理失败');
  } finally {
    if (fs.existsSync(intermediatePath)) fs.rmSync(intermediatePath, { force: true });
  }
}

function sanitizeUpscaleError(error, log) {
  if (String(error?.code || '').startsWith('IMAGE_TOOL_')) return error;
  log.error('image tool upscale processing', {
    error: String(error?.message || error),
  });
  return Object.assign(
    new Error('高清增强处理失败'),
    { code: 'IMAGE_TOOL_PROCESSING_FAILED' },
  );
}

function sanitizeDetailEnhanceError(error, log) {
  if (String(error?.code || '').startsWith('IMAGE_TOOL_')) return error;
  log.error('image tool detail enhance processing', {
    error: String(error?.message || error),
  });
  return Object.assign(
    new Error('细节纹理增强处理失败'),
    { code: 'IMAGE_TOOL_PROCESSING_FAILED' },
  );
}

async function writeLimitedSelectionPng(source, selection, outputPath) {
  let size = 0;
  const sizeLimiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > SMART_CUTOUT_MAX_OUTPUT_BYTES) {
        callback(Object.assign(
          new Error('框选抠图临时产物超过大小限制'),
          { code: 'IMAGE_TOOL_PROCESSING_FAILED' },
        ));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipelineAsync(
    source.extract(selection).png(),
    sizeLimiter,
    fs.createWriteStream(outputPath, { flags: 'wx' }),
  );
}

function sanitizeCutoutError(error, operation, log) {
  if (String(error?.code || '').startsWith('IMAGE_TOOL_')) return error;
  log.error('image tool cutout processing', {
    operation,
    error: String(error?.message || error),
  });
  return Object.assign(
    new Error(operation === 'selection_cutout' ? '框选抠图处理失败' : '智能抠图处理失败'),
    { code: 'IMAGE_TOOL_PROCESSING_FAILED' },
  );
}

async function runCrop(sourcePath, parameters) {
  const source = sharp(sourcePath);
  const metadata = await source.metadata();
  const format = FORMAT_INFO[metadata.format];
  if (!format || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const normalized = cropParameters(parameters, metadata);
  return { source, metadata, format, normalized };
}

async function runCompress(sourcePath, parameters) {
  const source = sharp(sourcePath);
  const metadata = await source.metadata();
  if (!FORMAT_INFO[metadata.format] || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const formatName = String(parameters.format || metadata.format).toLowerCase();
  const format = FORMAT_INFO[formatName];
  if (!format) fail('IMAGE_TOOL_INVALID_INPUT', 'format 参数仅支持 jpeg、png 或 webp');
  const quality = requireInteger(parameters.quality ?? 80, 'quality', 1);
  if (quality > 100) fail('IMAGE_TOOL_INVALID_INPUT', 'quality 参数不能大于 100');
  return {
    source,
    metadata,
    format,
    normalized: { format: formatName, quality },
  };
}

async function runMirror(sourcePath, parameters) {
  const source = sharp(sourcePath);
  const metadata = await source.metadata();
  const format = FORMAT_INFO[metadata.format];
  if (!format || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const direction = String(parameters.direction || '').toLowerCase();
  if (!['horizontal', 'vertical'].includes(direction)) {
    fail('IMAGE_TOOL_INVALID_INPUT', 'direction 参数仅支持 horizontal 或 vertical');
  }
  return { source, metadata, format, normalized: { direction } };
}

async function runRotate(sourcePath, parameters) {
  const source = sharp(sourcePath);
  const metadata = await source.metadata();
  const format = FORMAT_INFO[metadata.format];
  if (!format || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const angle = Number(parameters.angle);
  if (![90, 180, 270].includes(angle)) {
    fail('IMAGE_TOOL_INVALID_INPUT', 'angle 参数仅支持 90、180 或 270');
  }
  return { source, metadata, format, normalized: { angle } };
}

async function runGridCrop(sourcePath, parameters) {
  const metadata = await sharp(sourcePath).metadata();
  const format = FORMAT_INFO[metadata.format];
  if (!format || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const rows = requireInteger(parameters.rows, 'rows', 1);
  const columns = requireInteger(parameters.columns, 'columns', 1);
  if (rows * columns > 25) fail('IMAGE_TOOL_INVALID_INPUT', '宫格数量不能超过 25');
  if (rows > metadata.height || columns > metadata.width) {
    fail('IMAGE_TOOL_INVALID_INPUT', '宫格数量不能超过图片像素尺寸');
  }
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    const top = Math.floor((row * metadata.height) / rows);
    const bottom = Math.floor(((row + 1) * metadata.height) / rows);
    for (let column = 0; column < columns; column += 1) {
      const left = Math.floor((column * metadata.width) / columns);
      const right = Math.floor(((column + 1) * metadata.width) / columns);
      cells.push({
        row,
        column,
        left,
        top,
        width: right - left,
        height: bottom - top,
      });
    }
  }
  return { metadata, format, normalized: { rows, columns }, cells };
}

async function runAdjust(sourcePath, parameters) {
  const source = sharp(sourcePath);
  const metadata = await source.metadata();
  const format = FORMAT_INFO[metadata.format];
  if (!format || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  return {
    source,
    metadata,
    format,
    normalized: {
      brightness: requireNumber(parameters.brightness ?? 1, 'brightness', 0.1, 3),
      saturation: requireNumber(parameters.saturation ?? 1, 'saturation', 0, 3),
      contrast: requireNumber(parameters.contrast ?? 1, 'contrast', 0.1, 3),
      temperature: requireNumber(parameters.temperature ?? 0, 'temperature', -1, 1),
    },
  };
}

async function runLut(sourcePath, parameters) {
  const source = sharp(sourcePath);
  const metadata = await source.metadata();
  const format = FORMAT_INFO[metadata.format];
  if (!format || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const preset = String(parameters.preset || '').toLowerCase();
  if (!LUT_PRESETS[preset]) {
    fail('IMAGE_TOOL_INVALID_INPUT', 'preset 参数仅支持 cinematic、warm、cool 或 mono');
  }
  return {
    source,
    metadata,
    format,
    normalized: { preset },
    matrix: LUT_PRESETS[preset],
  };
}

function createDerivedAsset(db, log, {
  asset,
  request,
  operation,
  task,
  format,
  outputPath,
  outputInfo,
  parameters,
  suffix,
  storageRoot,
  engine = 'sharp',
  engineVersion = sharp.versions.sharp,
}) {
  const url = resultUrl(storageRoot, outputPath);
  return assetService.create(db, log, {
    drama_id: asset.drama_id,
    storyboard_id: asset.storyboard_id,
    name: `${path.parse(asset.name || 'image').name}-${suffix || operation}${format.extension}`,
    type: 'image',
    category: asset.category || 'canvas',
    url,
    local_path: outputPath,
    file_size: outputInfo.size,
    mime_type: format.mimeType,
    width: outputInfo.width,
    height: outputInfo.height,
    metadata: {
      sourceAssetId: asset.id,
      sourceNodeId: request.sourceNodeId || null,
      operation,
      parameters,
      engine,
      engineVersion,
      taskId: task.id,
      createdAt: new Date().toISOString(),
    },
  });
}

async function createOperation(db, log, request, context = {}) {
  const operation = String(request.operation || '').trim();
  const modelTools = context.modelTools || resolveModelTools(undefined, context.env);
  const referenceImageTool = context.referenceImageTool || null;
  const deterministicOperations = ['crop', 'compress', 'mirror', 'rotate', 'grid_crop', 'adjust', 'lut'];
  const cutoutOperations = ['smart_cutout', 'selection_cutout'];
  if (!deterministicOperations.includes(operation)
    && !(cutoutOperations.includes(operation) && modelTools.smart_cutout)
    && !(operation === 'upscale' && modelTools.upscale)
    && !(operation === 'detail_enhance' && modelTools.upscale)
    && !(
      operation === 'outpaint'
      && referenceImageTool?.operations.includes('outpaint')
    )
    && !(
      operation === 'markup_retouch'
      && referenceImageTool?.operations.includes('markup_retouch')
    )) {
    fail('IMAGE_TOOL_OPERATION_UNAVAILABLE', '该图片工具尚未接通真实处理器');
  }
  const asset = requireOwnedImageAsset(db, request.assetId, context);
  const storageRoot = resolveStorageRoot(context.cfg);
  const allowedRoot = context.publicPlatformEnabled
    ? path.join(storageRoot, storageLayout.getProjectStorageSubdir(db, asset.drama_id))
    : storageRoot;
  const sourcePath = resolveSourcePath(asset, storageRoot, allowedRoot);
  const task = taskService.createTask(
    db,
    log,
    `image_tool_${operation}`,
    String(request.sourceNodeId || asset.id),
  );
  if (context.tenantId || context.userId) {
    db.prepare('UPDATE async_tasks SET tenant_id = ?, user_id = ? WHERE id = ?')
      .run(context.tenantId || null, context.userId || null, task.id);
  }
  taskService.updateTaskStatus(db, task.id, 'processing', 10, '正在处理图片');

  const outputPaths = [];
  try {
    if (operation === 'grid_crop') {
      const prepared = await runGridCrop(sourcePath, request.parameters || {});
      const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
      const outputRecords = [];
      for (const cell of prepared.cells) {
        const outputPath = path.join(
          outputDir,
          `${Date.now()}-${randomUUID()}${prepared.format.extension}`,
        );
        outputPaths.push(outputPath);
        const outputInfo = await sharp(sourcePath)
          .extract(cell)
          .toFormat(prepared.metadata.format)
          .toFile(outputPath);
        const parameters = {
          ...prepared.normalized,
          row: cell.row,
          column: cell.column,
        };
        outputRecords.push({
          cell,
          outputPath,
          outputInfo,
          parameters,
        });
      }
      let result;
      db.transaction(() => {
        const resultAssets = outputRecords.map((record) => {
          const resultAsset = createDerivedAsset(db, log, {
            asset,
            request,
            operation,
            task,
            format: prepared.format,
            outputPath: record.outputPath,
            outputInfo: record.outputInfo,
            parameters: record.parameters,
            suffix: `grid-${record.cell.row + 1}-${record.cell.column + 1}`,
            storageRoot,
          });
          return {
            id: resultAsset.id,
            url: resultAsset.url,
            row: record.cell.row,
            column: record.cell.column,
          };
        });
        result = {
          taskId: task.id,
          status: 'success',
          sourceAssetId: asset.id,
          resultAssetId: resultAssets[0].id,
          resultUrl: resultAssets[0].url,
          resultAssets,
          operation,
        };
        taskService.updateTaskResult(db, task.id, result);
      })();
      return result;
    }

    if (cutoutOperations.includes(operation)) {
      const release = modelTools.smart_cutout.limiter.acquire(context.tenantId);
      try {
        const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
        const outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}.png`);
        outputPaths.push(outputPath);
        let cutoutSourcePath = sourcePath;
        let selection = null;
        if (operation === 'selection_cutout') {
          const source = sharp(sourcePath, { limitInputPixels: SMART_CUTOUT_MAX_PIXELS });
          const metadata = await source.metadata();
          if (!FORMAT_INFO[metadata.format] || !metadata.width || !metadata.height) {
            fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
          }
          selection = cropParameters(request.parameters || {}, metadata);
          if (selection.width * selection.height > SMART_CUTOUT_MAX_PIXELS) {
            fail('IMAGE_TOOL_INVALID_INPUT', '框选范围超过像素限制');
          }
          cutoutSourcePath = path.join(
            outputDir,
            `${Date.now()}-${randomUUID()}-selection.png`,
          );
          outputPaths.push(cutoutSourcePath);
          await writeLimitedSelectionPng(source, selection, cutoutSourcePath);
        }
        const prepared = await runSmartCutoutUnlocked(
          cutoutSourcePath,
          outputPath,
          modelTools.smart_cutout,
          log,
        );
        if (selection) {
          prepared.normalized = { ...prepared.normalized, ...selection };
          fs.rmSync(cutoutSourcePath, { force: true });
        }
        let result;
        db.transaction(() => {
          const resultAsset = createDerivedAsset(db, log, {
            asset,
            request,
            operation,
            task,
            format: prepared.format,
            outputPath,
            outputInfo: prepared.outputInfo,
            parameters: prepared.normalized,
            storageRoot,
            engine: prepared.engine,
            engineVersion: prepared.engineVersion,
          });
          result = {
            taskId: task.id,
            status: 'success',
            sourceAssetId: asset.id,
            resultAssetId: resultAsset.id,
            resultUrl: resultAsset.url,
            operation,
          };
          taskService.updateTaskResult(db, task.id, result);
        })();
        return result;
      } catch (error) {
        throw sanitizeCutoutError(error, operation, log);
      } finally {
        release();
      }
    }

    if (operation === 'upscale') {
      const release = modelTools.upscale.limiter.acquire(context.tenantId);
      try {
        const preparedSource = await prepareUpscaleSource(
          sourcePath,
          request.parameters || {},
        );
        const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
        const outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}.png`);
        outputPaths.push(outputPath);
        const prepared = await runUpscaleUnlocked(
          sourcePath,
          outputPath,
          preparedSource,
          modelTools.upscale,
          log,
        );
        let result;
        db.transaction(() => {
          const resultAsset = createDerivedAsset(db, log, {
            asset,
            request,
            operation,
            task,
            format: prepared.format,
            outputPath,
            outputInfo: prepared.outputInfo,
            parameters: prepared.normalized,
            storageRoot,
            engine: prepared.engine,
            engineVersion: prepared.engineVersion,
          });
          result = {
            taskId: task.id,
            status: 'success',
            sourceAssetId: asset.id,
            resultAssetId: resultAsset.id,
            resultUrl: resultAsset.url,
            operation,
          };
          taskService.updateTaskResult(db, task.id, result);
        })();
        return result;
      } catch (error) {
        throw sanitizeUpscaleError(error, log);
      } finally {
        release();
      }
    }

    if (operation === 'detail_enhance') {
      let release;
      try {
        try {
          release = modelTools.upscale.limiter.acquire(context.tenantId);
        } catch (error) {
          if (error?.code === 'IMAGE_TOOL_BUSY') {
            fail('IMAGE_TOOL_BUSY', '细节纹理增强任务繁忙，请稍后重试');
          }
          throw error;
        }
        const preparedSource = await prepareDetailEnhanceSource(
          sourcePath,
          request.parameters || {},
        );
        const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
        const intermediatePath = path.join(
          outputDir,
          `${Date.now()}-${randomUUID()}-detail-enhance-upscale.png`,
        );
        const outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}.png`);
        outputPaths.push(intermediatePath, outputPath);
        const prepared = await runDetailEnhanceUnlocked({
          sourcePath,
          intermediatePath,
          outputPath,
          prepared: preparedSource,
          tool: modelTools.upscale,
          log,
        });
        let result;
        db.transaction(() => {
          const resultAsset = createDerivedAsset(db, log, {
            asset,
            request,
            operation,
            task,
            format: prepared.format,
            outputPath,
            outputInfo: prepared.outputInfo,
            parameters: prepared.normalized,
            storageRoot,
            engine: prepared.engine,
            engineVersion: prepared.engineVersion,
          });
          result = {
            taskId: task.id,
            status: 'success',
            sourceAssetId: asset.id,
            resultAssetId: resultAsset.id,
            resultUrl: resultAsset.url,
            operation,
          };
          taskService.updateTaskResult(db, task.id, result);
        })();
        return result;
      } catch (error) {
        throw sanitizeDetailEnhanceError(error, log);
      } finally {
        release?.();
      }
    }

    if (operation === 'outpaint') {
      const prepared = await runOutpaint({
        db,
        log,
        asset,
        request,
        task,
        sourcePath,
        storageRoot,
        allowedRoot,
        referenceImageTool,
        tenantId: context.tenantId,
      });
      outputPaths.push(prepared.outputPath);
      let result;
      db.transaction(() => {
        const resultAsset = createDerivedAsset(db, log, {
          asset,
          request,
          operation,
          task,
          format: prepared.format,
          outputPath: prepared.outputPath,
          outputInfo: prepared.outputInfo,
          parameters: prepared.parameters,
          storageRoot,
          engine: referenceImageTool.engine,
          engineVersion: `${referenceImageTool.protocol}:${referenceImageTool.model}`,
        });
        result = {
          taskId: task.id,
          status: 'success',
          sourceAssetId: asset.id,
          resultAssetId: resultAsset.id,
          resultUrl: resultAsset.url,
          operation,
        };
        taskService.updateTaskResult(db, task.id, result);
      })();
      return result;
    }

    if (operation === 'markup_retouch') {
      const prepared = await runMarkupRetouch({
        db,
        log,
        asset,
        request,
        task,
        sourcePath,
        storageRoot,
        allowedRoot,
        referenceImageTool,
        tenantId: context.tenantId,
      });
      outputPaths.push(prepared.outputPath);
      let result;
      db.transaction(() => {
        const resultAsset = createDerivedAsset(db, log, {
          asset,
          request,
          operation,
          task,
          format: prepared.format,
          outputPath: prepared.outputPath,
          outputInfo: prepared.outputInfo,
          parameters: prepared.parameters,
          suffix: 'markup-retouch',
          storageRoot,
          engine: referenceImageTool.engine,
          engineVersion: `${referenceImageTool.protocol}:${referenceImageTool.model}`,
        });
        result = {
          taskId: task.id,
          status: 'success',
          sourceAssetId: asset.id,
          resultAssetId: resultAsset.id,
          resultUrl: resultAsset.url,
          operation,
        };
        taskService.updateTaskResult(db, task.id, result);
      })();
      return result;
    }

    let prepared;
    if (operation === 'crop') prepared = await runCrop(sourcePath, request.parameters || {});
    else if (operation === 'compress') prepared = await runCompress(sourcePath, request.parameters || {});
    else if (operation === 'mirror') prepared = await runMirror(sourcePath, request.parameters || {});
    else if (operation === 'rotate') prepared = await runRotate(sourcePath, request.parameters || {});
    else if (operation === 'adjust') prepared = await runAdjust(sourcePath, request.parameters || {});
    else prepared = await runLut(sourcePath, request.parameters || {});
    const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
    const outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}${prepared.format.extension}`);
    outputPaths.push(outputPath);
    let pipeline;
    if (operation === 'crop') {
      pipeline = prepared.source.extract(prepared.normalized).toFormat(prepared.metadata.format);
    } else if (operation === 'compress') {
      pipeline = prepared.source.toFormat(
        prepared.normalized.format,
        { quality: prepared.normalized.quality },
      );
    } else if (operation === 'mirror') {
      pipeline = prepared.normalized.direction === 'horizontal'
        ? prepared.source.flop()
        : prepared.source.flip();
      pipeline = pipeline.toFormat(prepared.metadata.format);
    } else if (operation === 'rotate') {
      pipeline = prepared.source
        .rotate(prepared.normalized.angle)
        .toFormat(prepared.metadata.format);
    } else if (operation === 'adjust') {
      const redGain = 1 + (prepared.normalized.temperature * 0.15);
      const blueGain = 1 - (prepared.normalized.temperature * 0.15);
      pipeline = prepared.source
        .modulate({
          brightness: prepared.normalized.brightness,
          saturation: prepared.normalized.saturation,
        })
        .linear(
          prepared.normalized.contrast,
          128 * (1 - prepared.normalized.contrast),
        )
        .recomb([
          [redGain, 0, 0],
          [0, 1, 0],
          [0, 0, blueGain],
        ])
        .toFormat(prepared.metadata.format);
    } else {
      pipeline = prepared.source
        .recomb(prepared.matrix)
        .toFormat(prepared.metadata.format);
    }
    const outputInfo = await pipeline.toFile(outputPath);
    let result;
    db.transaction(() => {
      const resultAsset = createDerivedAsset(db, log, {
        asset,
        request,
        operation,
        task,
        format: prepared.format,
        outputPath,
        outputInfo,
        parameters: prepared.normalized,
        storageRoot,
      });
      result = {
        taskId: task.id,
        status: 'success',
        sourceAssetId: asset.id,
        resultAssetId: resultAsset.id,
        resultUrl: resultAsset.url,
        operation,
      };
      taskService.updateTaskResult(db, task.id, result);
    })();
    return result;
  } catch (error) {
    for (const outputPath of outputPaths) {
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
    }
    taskService.updateTaskError(db, task.id, error.message);
    throw error;
  }
}

function getOperation(db, taskId, context = {}) {
  const task = taskService.getTask(db, taskId);
  if (!task || !String(task.type || '').startsWith('image_tool_')) return null;
  if (!context.publicPlatformEnabled) return task;
  if (!context.tenantId && !context.userId) return null;
  if (context.tenantId) {
    return String(task.tenant_id || '') === String(context.tenantId) ? task : null;
  }
  return String(task.user_id || '') === String(context.userId || '') ? task : null;
}

module.exports = {
  createOperation,
  getOperation,
  modelCapabilities,
  referenceImageCapabilities,
  resolveModelTools,
  resolveReferenceImageTool,
  saveOutpaintResult,
};
