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
  teal_orange: [
    [1.08, 0.02, -0.08],
    [-0.03, 1.04, 0],
    [-0.08, 0.04, 1.12],
  ],
  film_fade: [
    [0.94, 0.05, 0.02],
    [0.03, 0.94, 0.03],
    [0.05, 0.04, 0.9],
  ],
  silver_screen: [
    [0.72, 0.24, 0.08],
    [0.2, 0.72, 0.1],
    [0.14, 0.22, 0.7],
  ],
  vintage_brown: [
    [1.08, 0.08, -0.04],
    [0.04, 0.96, -0.02],
    [0.02, 0.04, 0.82],
  ],
  forest: [
    [0.94, 0.03, 0],
    [0.02, 1.08, 0.02],
    [0, 0.02, 0.92],
  ],
  pastel: [
    [1.03, 0.03, 0.01],
    [0.02, 1.02, 0.02],
    [0.02, 0.03, 1.04],
  ],
  skin_natural: [
    [1.05, 0.02, 0],
    [0.01, 1.01, 0],
    [0, 0.01, 0.98],
  ],
});

const DETAIL_ENHANCE_PRESETS = Object.freeze({
  natural: 0.8,
  balanced: 1.2,
  strong: 1.8,
});
const CINEMATIC_RELIGHT_PRESETS = Object.freeze({
  cinematic: '电影感光影，克制的明暗层次与自然色彩分离',
  golden_hour: '黄金时刻暖光，柔和轮廓光与自然长阴影',
  moonlight: '月夜冷调光影，保留可读暗部与自然高光',
  studio_soft: '影棚柔光，均匀柔和的人物或主体塑形',
  high_contrast: '高反差戏剧光，明确主次但保留关键细节',
});
const REFERENCE_IMAGE_OPERATIONS = Object.freeze([
  'outpaint',
  'markup_retouch',
  'upscale',
  'detail_enhance',
  'cinematic_relight',
  'panorama',
  'panorama_scene',
  'image_ideation',
  'angle_ideation',
  'character_views',
  'narrative_grid',
  'frame_forward',
  'frame_backward',
]);
const PANORAMA_OUTPUT_SIZE = '3840x1920';
const REFERENCE_VARIATION_CONFIGS = Object.freeze({
  image_ideation: {
    label: '画面联想',
    goal: '基于输入图片进行画面联想，生成一张具有新意但叙事连贯的替代画面',
    outputSize: 'source',
  },
  angle_ideation: {
    label: '角度联想',
    goal: '基于输入图片联想一个合理的新机位，生成同一时刻、同一场景的替代视角',
    outputSize: 'source',
  },
  character_views: {
    label: '角色三视图',
    goal: '基于输入角色生成正面、侧面、背面和 3/4 视角的统一角色设定图',
    outputSize: '2048x1536',
  },
  narrative_grid: {
    label: '多机位叙事九宫格',
    goal: '基于输入画面生成连续的 3×3 多机位叙事九宫格',
    outputSize: '3072x3072',
  },
  frame_forward: {
    label: '画面推演-3秒后',
    goal: '推演输入画面约 3 秒后的同一镜头画面',
    outputSize: 'source',
  },
  frame_backward: {
    label: '画面推演-5秒前',
    goal: '反向推演输入画面约 5 秒前的同一镜头画面',
    outputSize: 'source',
  },
});
const MARKUP_MAX_STROKES = 16;
const MARKUP_MAX_POINTS_PER_STROKE = 128;
const MARKUP_COLORS = new Set(['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6']);
const MARKUP_KINDS = new Set([
  'brush',
  'line',
  'arrow',
  'rectangle',
  'ellipse',
  'mosaic',
  'number',
  'text',
]);

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
  let localPath = asset.local_path;
  if (!localPath && String(asset.url || '').startsWith('/static/')) {
    try {
      localPath = decodeURIComponent(String(asset.url).slice('/static/'.length));
    } catch (_) {
      fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '源图片地址无效');
    }
  }
  if (!localPath) fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '源图片没有可处理的本地文件');
  const sourcePath = path.resolve(
    path.isAbsolute(localPath)
      ? localPath
      : path.join(storageRoot, localPath),
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
  const cinematicRelightAvailable = referenceImageTool?.operations.includes('cinematic_relight');
  const panoramaAvailable = referenceImageTool?.operations.includes('panorama');
  const panoramaSceneAvailable = referenceImageTool?.operations.includes('panorama_scene');
  const variationCapability = (operation, label, extra = {}) => (
    referenceImageTool?.operations.includes(operation)
      ? { available: true, ...common, ...extra }
      : {
        available: false,
        reason: unavailableReason || `未配置已显式声明且通过审计的${label}模型`,
      }
  );
  const common = referenceImageTool
    ? {
      engine: referenceImageTool.engine,
      provider: referenceImageTool.provider,
      protocol: referenceImageTool.protocol,
      model: referenceImageTool.model,
    }
    : {};
  return {
    ...(referenceImageTool?.operations.includes('upscale') ? {
      upscale: variationCapability('upscale', '远程高清增强', {
        scales: [2, 3, 4],
        remote: true,
      }),
    } : {}),
    ...(referenceImageTool?.operations.includes('detail_enhance') ? {
      detail_enhance: variationCapability('detail_enhance', '远程细节增强', {
        presets: Object.keys(DETAIL_ENHANCE_PRESETS),
        preservesDimensions: true,
        remote: true,
      }),
    } : {}),
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
    markup_retouch: {
      available: true,
      ...(markupRetouchAvailable
        ? common
        : {
          engine: 'sharp',
          providerAvailable: false,
          providerReason: unavailableReason || '未配置已显式声明且通过审计的标记修图模型',
        }),
      ...(markupRetouchAvailable ? { providerAvailable: true } : {}),
      modes: ['markup_only', ...(markupRetouchAvailable ? ['retouch'] : [])],
      maxStrokes: MARKUP_MAX_STROKES,
      maxPointsPerStroke: MARKUP_MAX_POINTS_PER_STROKE,
      preservesDimensions: true,
    },
    cinematic_relight: cinematicRelightAvailable
      ? {
        available: true,
        ...common,
        presets: Object.keys(CINEMATIC_RELIGHT_PRESETS),
        intensityRange: [1, 5],
        preservesDimensions: true,
      }
      : {
        available: false,
        reason: unavailableReason || '未配置已显式声明且通过审计的电影光影校正模型',
      },
    panorama: panoramaAvailable
      ? {
        available: true,
        ...common,
        projection: 'equirectangular',
        outputSize: PANORAMA_OUTPUT_SIZE,
      }
      : {
        available: false,
        reason: unavailableReason || '未配置已显式声明且通过审计的全景模型能力',
      },
    panorama_scene: panoramaSceneAvailable
      ? {
        available: true,
        ...common,
        projection: 'equirectangular',
        outputSize: PANORAMA_OUTPUT_SIZE,
      }
      : {
        available: false,
        reason: unavailableReason || '未配置已显式声明且通过审计的全景场景模型',
      },
    image_ideation: variationCapability('image_ideation', '画面联想', {
      preservesDimensions: true,
    }),
    angle_ideation: variationCapability('angle_ideation', '角度联想', {
      preservesDimensions: true,
    }),
    character_views: variationCapability('character_views', '角色三视图', {
      outputSize: '2048x1536',
    }),
    narrative_grid: variationCapability('narrative_grid', '多机位叙事九宫格', {
      outputSize: '3072x3072',
    }),
    frame_forward: variationCapability('frame_forward', '画面推演-3秒后', {
      preservesDimensions: true,
    }),
    frame_backward: variationCapability('frame_backward', '画面推演-5秒前', {
      preservesDimensions: true,
    }),
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
  const top = requireInteger(parameters.top ?? 25, 'top', 0);
  const bottom = requireInteger(parameters.bottom ?? 25, 'bottom', 0);
  const left = requireInteger(parameters.left ?? 25, 'left', 0);
  const right = requireInteger(parameters.right ?? 25, 'right', 0);
  if ([top, bottom, left, right].some((value) => value > 100)) {
    fail('IMAGE_TOOL_INVALID_INPUT', '扩图边界比例必须在 0 到 100 之间');
  }
  if (top + bottom + left + right === 0) {
    fail('IMAGE_TOOL_INVALID_INPUT', '至少需要扩展一个方向');
  }
  return { aspectRatio, direction, top, bottom, left, right, prompt };
}

function buildOutpaintPrompt(parameters) {
  const extra = parameters.prompt
    ? `补充要求：${parameters.prompt}。`
    : '';
  return [
    `基于输入原图进行扩图，目标画幅为 ${parameters.aspectRatio}，${OUTPAINT_DIRECTIONS[parameters.direction]}。`,
    `新增画布比例：上方 ${parameters.top}%，下方 ${parameters.bottom}%，左侧 ${parameters.left}%，右侧 ${parameters.right}%。`,
    '保留原图已有主体、人物身份、面部、服装、姿势、画风、光线、透视和原有画面内容，不要裁掉或重绘原图中心内容。',
    '只在新增画布区域自然补全连续环境、纹理与光影，边缘衔接必须无缝，输出一张连续完整图片，不要拼图、边框、文字或水印。',
    extra,
  ].filter(Boolean).join('\n');
}

function normalizeCinematicRelightParameters(parameters) {
  if (typeof parameters.preset !== 'string') {
    fail('IMAGE_TOOL_INVALID_INPUT', 'preset 参数无效');
  }
  if (typeof parameters.intensity !== 'number') {
    fail('IMAGE_TOOL_INVALID_INPUT', 'intensity 必须是 1 到 5 的整数');
  }
  const rawDescription = parameters.description === undefined ? '' : parameters.description;
  if (typeof rawDescription !== 'string') {
    fail('IMAGE_TOOL_INVALID_INPUT', '光影补充要求必须是字符串');
  }
  const preset = parameters.preset.trim();
  const intensity = parameters.intensity;
  const description = rawDescription.trim();
  if (!CINEMATIC_RELIGHT_PRESETS[preset]) {
    fail('IMAGE_TOOL_INVALID_INPUT', 'preset 参数无效');
  }
  if (!Number.isInteger(intensity) || intensity < 1 || intensity > 5) {
    fail('IMAGE_TOOL_INVALID_INPUT', 'intensity 必须是 1 到 5 的整数');
  }
  if (description.length > 300) {
    fail('IMAGE_TOOL_INVALID_INPUT', '光影补充要求不能超过 300 字');
  }
  return { preset, intensity, description };
}

function buildCinematicRelightPrompt(parameters) {
  const extra = parameters.description
    ? `补充要求：${parameters.description}。`
    : '';
  return [
    '基于输入原图执行电影级光影校正，只调整照明、曝光、色温、阴影、高光与氛围。',
    `光影预设：${CINEMATIC_RELIGHT_PRESETS[parameters.preset]}；强度 ${parameters.intensity}/5。`,
    '必须保持人物身份、面部、发型、服装、姿势、物体、构图、镜头、透视、纹理、画风和画面尺寸不变。',
    '不得增加、删除或移动主体，不得改写背景结构，不要拼图、边框、文字、水印或前后对比图。',
    extra,
  ].filter(Boolean).join('\n');
}

function normalizePanoramaParameters(parameters) {
  const rawDescription = parameters.description === undefined ? '' : parameters.description;
  if (typeof rawDescription !== 'string') {
    fail('IMAGE_TOOL_INVALID_INPUT', '全景补充要求必须是字符串');
  }
  const description = rawDescription.trim();
  if (description.length > 300) {
    fail('IMAGE_TOOL_INVALID_INPUT', '全景补充要求不能超过 300 字');
  }
  return { description };
}

function buildPanoramaPrompt(operation, parameters) {
  const extra = parameters.description
    ? `补充要求：${parameters.description}。`
    : '';
  const goal = operation === 'panorama_scene'
    ? '以输入图片为场景参考，生成一个可环视的完整 360° 环境'
    : '将输入图片转换为完整的 360° 全景画面';
  return [
    `${goal}，输出必须是单张 2:1 等距柱状投影（equirectangular panorama）。`,
    '保持输入图中的主体身份、关键物体、场景线索、画风、材质、光线与空间关系。',
    '补全相机四周、天空和地面，地平线保持水平；左右边缘必须无缝连续，顶部与底部符合球面投影。',
    '不要输出普通广角图、立方体六面图、拼图、分栏、边框、文字、水印或前后对比图。',
    extra,
  ].filter(Boolean).join('\n');
}

function normalizeReferenceVariationParameters(parameters) {
  const rawDescription = parameters.description === undefined ? '' : parameters.description;
  if (typeof rawDescription !== 'string') {
    fail('IMAGE_TOOL_INVALID_INPUT', '补充要求必须是字符串');
  }
  const description = rawDescription.trim();
  if (description.length > 300) {
    fail('IMAGE_TOOL_INVALID_INPUT', '补充要求不能超过 300 字');
  }
  return { description };
}

function buildReferenceVariationPrompt(operation, parameters) {
  const config = REFERENCE_VARIATION_CONFIGS[operation];
  const structuredSheet = ['character_views', 'narrative_grid'].includes(operation);
  return [
    `${config.goal}。`,
    '保持主体身份、关键物体、画风、材质、光线逻辑和空间关系，不要生成前后对比图。',
    structuredSheet
      ? '只输出一张结构清晰的完整设定图，不要添加标题、边框、说明文字或水印。'
      : '只输出一张完整画面，不要输出拼图、分栏、边框、文字或水印。',
    parameters.description ? `补充要求：${parameters.description}。` : '',
  ].filter(Boolean).join('\n');
}

function normalizeMarkupRetouchParameters(parameters) {
  const mode = parameters.mode === 'markup_only' ? 'markup_only' : 'retouch';
  const instruction = String(parameters.instruction || '').trim();
  if ((mode === 'retouch' && !instruction) || instruction.length > 500) {
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
    const kind = MARKUP_KINDS.has(stroke?.kind) ? stroke.kind : 'brush';
    const label = String(stroke?.label || '').trim();
    const color = String(stroke?.color || '').trim().toLowerCase();
    const width = Number(stroke?.width);
    if (!MARKUP_COLORS.has(color)) {
      fail('IMAGE_TOOL_INVALID_INPUT', '标记颜色不在允许范围内');
    }
    if (!Number.isFinite(width) || width < 0.005 || width > 0.08) {
      fail('IMAGE_TOOL_INVALID_INPUT', '标记笔宽参数无效');
    }
    if (label.length > 32 || (['number', 'text'].includes(kind) && !label)) {
      fail('IMAGE_TOOL_INVALID_INPUT', '文字标记必须为 1 到 32 个字符');
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
      kind,
      ...(label ? { label } : {}),
      color,
      width: Number(width.toFixed(5)),
      points,
    };
  });
  return {
    mode,
    instruction,
    strokes,
    summary: {
      mode,
      instruction,
      strokeCount: strokes.length,
      pointCount,
      preserveDimensions: true,
    },
  };
}

function escapeMarkupXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildMarkupReferenceSvg(parameters, width, height) {
  const minDimension = Math.min(width, height);
  const polylines = parameters.strokes.map((stroke) => {
    const points = stroke.points
      .map((point) => `${(point.x * width).toFixed(2)},${(point.y * height).toFixed(2)}`)
      .join(' ');
    const strokeWidth = Math.max(2, stroke.width * minDimension).toFixed(2);
    if (['number', 'text'].includes(stroke.kind)) {
      const point = stroke.points[0];
      const fontSize = Math.max(16, stroke.width * minDimension * 4).toFixed(2);
      return `<text x="${(point.x * width).toFixed(2)}" y="${(point.y * height).toFixed(2)}" fill="${stroke.color}" font-size="${fontSize}" font-family="sans-serif" font-weight="700">${escapeMarkupXml(stroke.label)}</text>`;
    }
    if (stroke.kind === 'mosaic') {
      return `<polyline points="${points}" fill="none" stroke="${stroke.color}" stroke-opacity="0.65" stroke-width="${Math.max(12, Number(strokeWidth) * 3).toFixed(2)}" stroke-linecap="square" stroke-linejoin="round"/>`;
    }
    return `<polyline points="${points}" fill="none" stroke="${stroke.color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${polylines}</svg>`,
  );
}

function normalizeSelectionBrushParameters(parameters, metadata) {
  if (
    !Array.isArray(parameters.brushStrokes)
    || parameters.brushStrokes.length === 0
    || parameters.brushStrokes.length > MARKUP_MAX_STROKES
  ) {
    fail('IMAGE_TOOL_INVALID_INPUT', `画笔选区必须包含 1 到 ${MARKUP_MAX_STROKES} 条笔迹`);
  }
  const strokes = parameters.brushStrokes.map((stroke) => {
    const width = Number(stroke?.width);
    if (!Number.isFinite(width) || width < 0.005 || width > 0.2) {
      fail('IMAGE_TOOL_INVALID_INPUT', '画笔选区笔宽参数无效');
    }
    if (
      !Array.isArray(stroke?.points)
      || stroke.points.length < 2
      || stroke.points.length > MARKUP_MAX_POINTS_PER_STROKE
    ) {
      fail(
        'IMAGE_TOOL_INVALID_INPUT',
        `每条画笔选区必须包含 2 到 ${MARKUP_MAX_POINTS_PER_STROKE} 个点`,
      );
    }
    const points = stroke.points.map((point) => {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        fail('IMAGE_TOOL_INVALID_INPUT', '画笔选区坐标必须位于图片范围内');
      }
      return { x: Number(x.toFixed(5)), y: Number(y.toFixed(5)) };
    });
    return { width: Number(width.toFixed(5)), points };
  });
  const points = strokes.flatMap((stroke) => stroke.points);
  const padding = Math.max(...strokes.map((stroke) => stroke.width)) / 2;
  const minX = Math.max(0, Math.min(...points.map((point) => point.x)) - padding);
  const minY = Math.max(0, Math.min(...points.map((point) => point.y)) - padding);
  const maxX = Math.min(1, Math.max(...points.map((point) => point.x)) + padding);
  const maxY = Math.min(1, Math.max(...points.map((point) => point.y)) + padding);
  const left = Math.floor(minX * metadata.width);
  const top = Math.floor(minY * metadata.height);
  const right = Math.max(left + 1, Math.ceil(maxX * metadata.width));
  const bottom = Math.max(top + 1, Math.ceil(maxY * metadata.height));
  return {
    selection: {
      left,
      top,
      width: Math.min(metadata.width, right) - left,
      height: Math.min(metadata.height, bottom) - top,
    },
    strokes,
  };
}

function buildSelectionBrushMaskSvg(strokes, metadata, selection) {
  const minDimension = Math.min(metadata.width, metadata.height);
  const polylines = strokes.map((stroke) => {
    const points = stroke.points.map((point) => (
      `${((point.x * metadata.width) - selection.left).toFixed(2)},${((point.y * metadata.height) - selection.top).toFixed(2)}`
    )).join(' ');
    const strokeWidth = Math.max(2, stroke.width * minDimension).toFixed(2);
    return `<polyline points="${points}" fill="none" stroke="#fff" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${selection.width}" height="${selection.height}" viewBox="0 0 ${selection.width} ${selection.height}">${polylines}</svg>`,
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

function createPinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
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
      lookup: createPinnedLookup(target.address, target.family),
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
  const outputPrefix = {
    markup_retouch: 'markup-provider-download',
    cinematic_relight: 'relight-provider-download',
    panorama: 'panorama-provider-download',
    panorama_scene: 'panorama-scene-provider-download',
    image_ideation: 'image-ideation-provider-download',
    angle_ideation: 'angle-ideation-provider-download',
    character_views: 'character-views-provider-download',
    narrative_grid: 'narrative-grid-provider-download',
    frame_forward: 'frame-forward-provider-download',
    frame_backward: 'frame-backward-provider-download',
  }[options.operation] || 'outpaint';
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
  if (parameters.mode === 'retouch' && !referenceImageTool?.operations.includes('markup_retouch')) {
    fail('IMAGE_TOOL_NOT_CONFIGURED', '未配置可用的标记修图模型');
  }
  const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
  let release;
  let markedReferencePath = null;
  let providerDownloadPath = null;
  let outputPath = null;
  try {
    if (parameters.mode === 'retouch') {
      release = referenceImageTool.limiter.acquire(tenantId);
    }
    markedReferencePath = await createMarkupReference(
      sourcePath,
      outputDir,
      parameters,
      sourceMetadata,
    );
    if (parameters.mode === 'markup_only') {
      outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}.png`);
      fs.renameSync(markedReferencePath, outputPath);
      markedReferencePath = null;
      const outputInfo = await sharp(outputPath, {
        failOn: 'warning',
        limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
      }).metadata();
      return {
        outputPath,
        format: FORMAT_INFO.png,
        outputInfo: {
          size: fs.statSync(outputPath).size,
          width: outputInfo.width,
          height: outputInfo.height,
        },
        parameters: parameters.summary,
        engine: 'sharp',
        engineVersion: `sharp-${sharp.versions.sharp}`,
      };
    }
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
      engine: referenceImageTool.engine,
      engineVersion: `${referenceImageTool.protocol}:${referenceImageTool.model}`,
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
      provider: referenceImageTool?.provider,
      protocol: referenceImageTool?.protocol,
      model: referenceImageTool?.model,
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

async function runCinematicRelight({
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
  const parameters = normalizeCinematicRelightParameters(request.parameters || {});
  const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
  let release;
  let providerDownloadPath = null;
  let outputPath = null;
  try {
    release = referenceImageTool.limiter.acquire(tenantId);
    const result = await taskService.withTaskHeartbeat(
      db,
      task.id,
      '正在执行电影级光影校正...',
      () => referenceImageTool.generate({
        prompt: buildCinematicRelightPrompt(parameters),
        size: `${sourceMetadata.width}x${sourceMetadata.height}`,
        referenceImage: sourcePath,
        dramaId: asset.drama_id,
        taskId: task.id,
        storageRoot,
        systemPrompt: 'The source image is the immutable content reference. Preserve identity, geometry, composition, texture, style, and dimensions; change only lighting.',
      }),
    );
    if (!result?.image_url || result.error) {
      log.warn('image cinematic relight provider failed', {
        provider: referenceImageTool.provider,
        protocol: referenceImageTool.protocol,
        model: referenceImageTool.model,
        reason: 'provider returned no image',
      });
      fail('IMAGE_TOOL_PROCESSING_FAILED', '电影级光影校正处理失败');
    }
    providerDownloadPath = await saveOutpaintResult(
      result.image_url,
      outputDir,
      allowedRoot,
      { operation: 'cinematic_relight' },
    );
    if (fileSha256(providerDownloadPath) === fileSha256(sourcePath)) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '电影级光影校正产物校验失败');
    }
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
      fail('IMAGE_TOOL_PROCESSING_FAILED', '电影级光影校正结果格式无效');
    }
    const sourceRatio = sourceMetadata.width / sourceMetadata.height;
    const providerRatio = providerMetadata.width / providerMetadata.height;
    if (Math.abs(providerRatio - sourceRatio) / sourceRatio > 0.03) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '电影级光影校正结果画幅与原图不符');
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
      fail('IMAGE_TOOL_PROCESSING_FAILED', '电影级光影校正产物校验失败');
    }
    await sharp(outputPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    }).stats();
    return {
      outputPath,
      format: FORMAT_INFO.png,
      outputInfo,
      parameters: {
        ...parameters,
        preserveDimensions: true,
      },
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
    log.warn('image cinematic relight failed', {
      provider: referenceImageTool.provider,
      protocol: referenceImageTool.protocol,
      model: referenceImageTool.model,
      reason: 'provider request or output validation failed',
    });
    fail('IMAGE_TOOL_PROCESSING_FAILED', '电影级光影校正处理失败');
  } finally {
    release?.();
    if (providerDownloadPath && fs.existsSync(providerDownloadPath)) {
      fs.rmSync(providerDownloadPath, { force: true });
    }
  }
}

async function runReferenceEnhance({
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
  operation,
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

  let parameters;
  let targetWidth;
  let targetHeight;
  let prompt;
  let progressMessage;
  let failureMessage;
  if (operation === 'upscale') {
    const prepared = await prepareUpscaleSource(sourcePath, request.parameters || {});
    parameters = prepared.normalized;
    targetWidth = prepared.expectedWidth;
    targetHeight = prepared.expectedHeight;
    progressMessage = '正在通过远程模型执行高清增强...';
    failureMessage = '高清增强处理失败';
    prompt = [
      `对输入图片执行 ${parameters.scale} 倍高清增强，目标尺寸 ${targetWidth}×${targetHeight}。`,
      '恢复真实纹理、边缘与微小细节，减少压缩噪点、锯齿和模糊。',
      '严格保持人物身份、面部、文字、物体、构图、镜头、比例、颜色、光影和画风不变。',
      '不得增加、删除或移动任何主体，不得生成拼图、边框、水印或前后对比图。',
    ].join('\n');
  } else {
    const preset = String(request.parameters?.preset || 'balanced').trim().toLowerCase();
    if (!DETAIL_ENHANCE_PRESETS[preset]) {
      fail('IMAGE_TOOL_INVALID_INPUT', 'preset 参数仅支持 natural、balanced 或 strong');
    }
    const presetLabel = {
      natural: '自然',
      balanced: '标准',
      strong: '强烈',
    }[preset];
    parameters = { preset, preserveDimensions: true };
    targetWidth = sourceMetadata.width;
    targetHeight = sourceMetadata.height;
    progressMessage = '正在通过远程模型执行细节纹理增强...';
    failureMessage = '细节纹理增强处理失败';
    prompt = [
      `对输入图片执行${presetLabel}强度的细节纹理增强，保持原尺寸 ${targetWidth}×${targetHeight}。`,
      '改善可见纹理、局部清晰度、边缘层次和轻微压缩噪点，不做内容重绘。',
      '严格保持人物身份、面部、文字、物体、构图、镜头、比例、颜色、光影和画风不变。',
      '不得增加、删除或移动任何主体，不得生成拼图、边框、水印或前后对比图。',
    ].join('\n');
  }

  const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
  let release;
  let providerDownloadPath = null;
  let outputPath = null;
  try {
    release = referenceImageTool.limiter.acquire(tenantId);
    const result = await taskService.withTaskHeartbeat(
      db,
      task.id,
      progressMessage,
      () => referenceImageTool.generate({
        prompt,
        size: `${targetWidth}x${targetHeight}`,
        referenceImage: sourcePath,
        dramaId: asset.drama_id,
        taskId: task.id,
        storageRoot,
        systemPrompt: 'The source image is immutable content reference. Improve only fidelity and visible detail while preserving identity, geometry, composition, text, colors, lighting, and style.',
      }),
    );
    if (!result?.image_url || result.error) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    providerDownloadPath = await saveOutpaintResult(
      result.image_url,
      outputDir,
      allowedRoot,
      { operation },
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
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    const sourceRatio = sourceMetadata.width / sourceMetadata.height;
    const providerRatio = providerMetadata.width / providerMetadata.height;
    if (Math.abs(providerRatio - sourceRatio) / sourceRatio > 0.03) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}.png`);
    const outputInfo = await sharp(providerDownloadPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    })
      .resize(targetWidth, targetHeight, {
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toFile(outputPath);
    if (
      outputInfo.size <= 0
      || outputInfo.size > SMART_CUTOUT_MAX_OUTPUT_BYTES
      || outputInfo.width !== targetWidth
      || outputInfo.height !== targetHeight
      || fileSha256(outputPath) === fileSha256(sourcePath)
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    await sharp(outputPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    }).stats();
    return {
      outputPath,
      format: FORMAT_INFO.png,
      outputInfo,
      parameters,
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
    log.warn('image reference enhance failed', {
      operation,
      provider: referenceImageTool.provider,
      protocol: referenceImageTool.protocol,
      model: referenceImageTool.model,
      reason: 'provider request or output validation failed',
    });
    fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
  } finally {
    release?.();
    if (providerDownloadPath && fs.existsSync(providerDownloadPath)) {
      fs.rmSync(providerDownloadPath, { force: true });
    }
  }
}

async function runPanorama({
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
  operation,
}) {
  const failureMessage = operation === 'panorama_scene'
    ? '全景场景生成失败'
    : '720全景处理失败';
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
  const parameters = normalizePanoramaParameters(request.parameters || {});
  const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
  let release;
  let providerDownloadPath = null;
  let outputPath = null;
  try {
    release = referenceImageTool.limiter.acquire(tenantId);
    const result = await taskService.withTaskHeartbeat(
      db,
      task.id,
      operation === 'panorama_scene' ? '正在生成全景场景...' : '正在生成720全景...',
      () => referenceImageTool.generate({
        prompt: buildPanoramaPrompt(operation, parameters),
        size: PANORAMA_OUTPUT_SIZE,
        referenceImage: sourcePath,
        dramaId: asset.drama_id,
        taskId: task.id,
        storageRoot,
        systemPrompt: 'The source image is the visual reference. Create one seamless 360-degree 2:1 equirectangular panorama; never create a collage, labels, borders, or comparison image.',
      }),
    );
    if (!result?.image_url || result.error) {
      log.warn('image panorama provider failed', {
        operation,
        provider: referenceImageTool.provider,
        protocol: referenceImageTool.protocol,
        model: referenceImageTool.model,
        reason: 'provider returned no image',
      });
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    providerDownloadPath = await saveOutpaintResult(
      result.image_url,
      outputDir,
      allowedRoot,
      { operation },
    );
    if (fileSha256(providerDownloadPath) === fileSha256(sourcePath)) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
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
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}.png`);
    const outputInfo = await sharp(providerDownloadPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    })
      .resize(3840, 1920, {
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toFile(outputPath);
    if (
      outputInfo.size <= 0
      || outputInfo.size > SMART_CUTOUT_MAX_OUTPUT_BYTES
      || outputInfo.width !== 3840
      || outputInfo.height !== 1920
      || fileSha256(outputPath) === fileSha256(sourcePath)
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    await sharp(outputPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    }).stats();
    return {
      outputPath,
      format: FORMAT_INFO.png,
      outputInfo,
      parameters: {
        ...parameters,
        projection: 'equirectangular',
        outputSize: PANORAMA_OUTPUT_SIZE,
      },
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
    log.warn('image panorama failed', {
      operation,
      provider: referenceImageTool.provider,
      protocol: referenceImageTool.protocol,
      model: referenceImageTool.model,
      reason: 'provider request or output validation failed',
    });
    fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
  } finally {
    release?.();
    if (providerDownloadPath && fs.existsSync(providerDownloadPath)) {
      fs.rmSync(providerDownloadPath, { force: true });
    }
  }
}

async function runReferenceVariation({
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
  operation,
}) {
  const config = REFERENCE_VARIATION_CONFIGS[operation];
  const failureMessage = `${config.label}失败`;
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
  const parameters = normalizeReferenceVariationParameters(request.parameters || {});
  const outputSize = config.outputSize === 'source'
    ? `${sourceMetadata.width}x${sourceMetadata.height}`
    : config.outputSize;
  const [targetWidth, targetHeight] = outputSize.split('x').map(Number);
  const outputDir = ensureDerivedDir(sourcePath, allowedRoot);
  let release;
  let providerDownloadPath = null;
  let outputPath = null;
  try {
    release = referenceImageTool.limiter.acquire(tenantId);
    const result = await taskService.withTaskHeartbeat(
      db,
      task.id,
      `正在生成${config.label}...`,
      () => referenceImageTool.generate({
        prompt: buildReferenceVariationPrompt(operation, parameters),
        size: outputSize,
        referenceImage: sourcePath,
        dramaId: asset.drama_id,
        taskId: task.id,
        storageRoot,
        systemPrompt: ['character_views', 'narrative_grid'].includes(operation)
          ? 'The source image is the visual reference. Create one structured multi-panel sheet while preserving subject identity and visual continuity; never add labels, captions, decorative borders, watermarks, or a before-and-after comparison.'
          : 'The source image is the visual reference. Create one coherent alternative image while preserving subject identity and visual continuity; never create a collage, labels, borders, or comparison image.',
      }),
    );
    if (!result?.image_url || result.error) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    providerDownloadPath = await saveOutpaintResult(
      result.image_url,
      outputDir,
      allowedRoot,
      { operation },
    );
    if (fileSha256(providerDownloadPath) === fileSha256(sourcePath)) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
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
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    const sourceRatio = targetWidth / targetHeight;
    const providerRatio = providerMetadata.width / providerMetadata.height;
    if (Math.abs(providerRatio - sourceRatio) / sourceRatio > 0.01) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}.png`);
    const outputInfo = await sharp(providerDownloadPath, {
      failOn: 'warning',
      limitInputPixels: SMART_CUTOUT_MAX_PIXELS,
    })
      .resize(targetWidth, targetHeight, {
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toFile(outputPath);
    if (
      outputInfo.size <= 0
      || outputInfo.size > SMART_CUTOUT_MAX_OUTPUT_BYTES
      || outputInfo.width !== targetWidth
      || outputInfo.height !== targetHeight
      || fileSha256(outputPath) === fileSha256(sourcePath)
    ) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
    }
    return {
      outputPath,
      format: FORMAT_INFO.png,
      outputInfo,
      parameters: { ...parameters, outputSize },
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
    log.warn('image reference variation failed', {
      operation,
      provider: referenceImageTool.provider,
      protocol: referenceImageTool.protocol,
      model: referenceImageTool.model,
      reason: 'provider request or output validation failed',
    });
    fail('IMAGE_TOOL_PROCESSING_FAILED', failureMessage);
  } finally {
    release?.();
    if (providerDownloadPath && fs.existsSync(providerDownloadPath)) {
      fs.rmSync(providerDownloadPath, { force: true });
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

function sanitizeDeterministicError(error, operation, log) {
  if (String(error?.code || '').startsWith('IMAGE_TOOL_')) return error;
  log.error('image tool deterministic processing failed', {
    operation,
    error: String(error?.message || error),
  });
  return Object.assign(
    new Error('图片处理失败'),
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
  const spacing = requireInteger(parameters.spacing ?? 0, 'spacing', 0);
  if (rows * columns > 49) fail('IMAGE_TOOL_INVALID_INPUT', '宫格数量不能超过 49');
  if (rows > metadata.height || columns > metadata.width) {
    fail('IMAGE_TOOL_INVALID_INPUT', '宫格数量不能超过图片像素尺寸');
  }
  if (
    spacing >= Math.floor(metadata.width / columns)
    || spacing >= Math.floor(metadata.height / rows)
  ) {
    fail('IMAGE_TOOL_INVALID_INPUT', '宫格间距必须小于单格尺寸');
  }
  const allCellKeys = new Set(Array.from(
    { length: rows * columns },
    (_, index) => `${Math.floor(index / columns)}:${index % columns}`,
  ));
  const selectedCells = parameters.selectedCells === undefined
    ? [...allCellKeys]
    : parameters.selectedCells;
  if (
    !Array.isArray(selectedCells)
    || selectedCells.length === 0
    || selectedCells.some((key) => typeof key !== 'string' || !allCellKeys.has(key))
    || new Set(selectedCells).size !== selectedCells.length
  ) {
    fail('IMAGE_TOOL_INVALID_INPUT', 'selectedCells 必须包含至少一个有效且不重复的宫格坐标');
  }
  const selectedCellKeys = new Set(selectedCells);
  const cells = [];
  const spacingBefore = Math.floor(spacing / 2);
  const spacingAfter = spacing - spacingBefore;
  for (let row = 0; row < rows; row += 1) {
    const cellTop = Math.floor((row * metadata.height) / rows);
    const cellBottom = Math.floor(((row + 1) * metadata.height) / rows);
    for (let column = 0; column < columns; column += 1) {
      const cellLeft = Math.floor((column * metadata.width) / columns);
      const cellRight = Math.floor(((column + 1) * metadata.width) / columns);
      const key = `${row}:${column}`;
      if (!selectedCellKeys.has(key)) continue;
      cells.push({
        row,
        column,
        left: cellLeft + spacingBefore,
        top: cellTop + spacingBefore,
        width: cellRight - cellLeft - spacingBefore - spacingAfter,
        height: cellBottom - cellTop - spacingBefore - spacingAfter,
      });
    }
  }
  return {
    metadata,
    format,
    normalized: { rows, columns, spacing, selectedCells },
    cells,
  };
}

async function runAdjust(sourcePath, parameters) {
  const source = sharp(sourcePath);
  const metadata = await source.metadata();
  const format = FORMAT_INFO[metadata.format];
  if (!format || !metadata.width || !metadata.height) {
    fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
  }
  const curves = parameters.curves ?? {};
  const normalizedCurves = {};
  for (const channel of ['rgb', 'red', 'green', 'blue']) {
    const points = curves[channel] ?? [[0, 0], [0.5, 0.5], [1, 1]];
    if (
      !Array.isArray(points)
      || points.length < 2
      || points.some((point) => (
        !Array.isArray(point)
        || point.length !== 2
        || point.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
      ))
    ) {
      fail('IMAGE_TOOL_INVALID_INPUT', `curves.${channel} 必须是 0–1 范围的曲线坐标`);
    }
    normalizedCurves[channel] = points;
  }
  return {
    source,
    metadata,
    format,
    normalized: {
      exposure: requireNumber(parameters.exposure ?? 0, 'exposure', -2, 2),
      brightness: requireNumber(parameters.brightness ?? 1, 'brightness', 0.1, 3),
      vibrance: requireNumber(parameters.vibrance ?? 1, 'vibrance', 0, 2),
      saturation: requireNumber(parameters.saturation ?? 1, 'saturation', 0, 3),
      contrast: requireNumber(parameters.contrast ?? 1, 'contrast', 0.1, 3),
      highlights: requireNumber(parameters.highlights ?? 0, 'highlights', -1, 1),
      shadows: requireNumber(parameters.shadows ?? 0, 'shadows', -1, 1),
      whites: requireNumber(parameters.whites ?? 0, 'whites', -1, 1),
      blacks: requireNumber(parameters.blacks ?? 0, 'blacks', -1, 1),
      temperature: requireNumber(parameters.temperature ?? 0, 'temperature', -1, 1),
      tint: requireNumber(parameters.tint ?? 0, 'tint', -1, 1),
      hue: requireNumber(parameters.hue ?? 0, 'hue', -180, 180),
      sharpness: requireNumber(parameters.sharpness ?? 0, 'sharpness', 0, 1),
      clarity: requireNumber(parameters.clarity ?? 0, 'clarity', 0, 1),
      grain: requireNumber(parameters.grain ?? 0, 'grain', 0, 1),
      blur: requireNumber(parameters.blur ?? 0, 'blur', 0, 2),
      vignette: requireNumber(parameters.vignette ?? 0, 'vignette', 0, 1),
      softLight: requireNumber(parameters.softLight ?? 0, 'softLight', 0, 1),
      glow: requireNumber(parameters.glow ?? 0, 'glow', 0, 1),
      curves: normalizedCurves,
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
  const intensity = requireNumber(parameters.intensity ?? 1, 'intensity', 0, 1);
  const manual = {
    exposure: requireNumber(parameters.manual?.exposure ?? 0, 'manual.exposure', -1, 1),
    contrast: requireNumber(parameters.manual?.contrast ?? 1, 'manual.contrast', 0.5, 1.5),
    saturation: requireNumber(parameters.manual?.saturation ?? 1, 'manual.saturation', 0, 2),
    temperature: requireNumber(parameters.manual?.temperature ?? 0, 'manual.temperature', -1, 1),
  };
  if (preset === 'custom') {
    const size = requireInteger(parameters.customLut?.size, 'customLut.size', 2);
    if (size > 17) fail('IMAGE_TOOL_INVALID_INPUT', '3D LUT 尺寸不能超过 17');
    const values = parameters.customLut?.values;
    if (
      !Array.isArray(values)
      || values.length !== size ** 3
      || values.some((entry) => (
        !Array.isArray(entry)
        || entry.length !== 3
        || entry.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1)
      ))
    ) {
      fail('IMAGE_TOOL_INVALID_INPUT', '3D LUT 数据无效');
    }
    return {
      source,
      metadata,
      format,
      normalized: {
        preset,
        intensity,
        manual,
        customLut: {
          name: String(parameters.customLut?.name || '自定义 LUT').slice(0, 80),
          size,
        },
      },
      customLut: {
        size,
        values: values.map((entry) => entry.map(Number)),
      },
    };
  }
  if (!LUT_PRESETS[preset]) {
    fail('IMAGE_TOOL_INVALID_INPUT', 'preset 参数不受支持');
  }
  const matrix = LUT_PRESETS[preset].map((row, rowIndex) => (
    row.map((value, columnIndex) => {
      const identity = rowIndex === columnIndex ? 1 : 0;
      return identity + ((value - identity) * intensity);
    })
  ));
  return {
    source,
    metadata,
    format,
    normalized: { preset, intensity, manual },
    matrix,
  };
}

function interpolateCubeLutChannel(values, size, red, green, blue, channel) {
  const scaled = [red, green, blue].map((value) => (value / 255) * (size - 1));
  const lower = scaled.map(Math.floor);
  const upper = lower.map((value) => Math.min(size - 1, value + 1));
  const ratio = scaled.map((value, index) => value - lower[index]);
  const sample = (r, g, b) => values[(b * size * size) + (g * size) + r][channel];
  const lerp = (start, end, amount) => start + ((end - start) * amount);
  const c00 = lerp(sample(lower[0], lower[1], lower[2]), sample(upper[0], lower[1], lower[2]), ratio[0]);
  const c10 = lerp(sample(lower[0], upper[1], lower[2]), sample(upper[0], upper[1], lower[2]), ratio[0]);
  const c01 = lerp(sample(lower[0], lower[1], upper[2]), sample(upper[0], lower[1], upper[2]), ratio[0]);
  const c11 = lerp(sample(lower[0], upper[1], upper[2]), sample(upper[0], upper[1], upper[2]), ratio[0]);
  return lerp(lerp(c00, c10, ratio[1]), lerp(c01, c11, ratio[1]), ratio[2]);
}

async function applyCustomCubeLut(sourcePath, customLut, intensity) {
  const { data, info } = await sharp(sourcePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const original = [data[offset], data[offset + 1], data[offset + 2]];
    for (let channel = 0; channel < 3; channel += 1) {
      const transformed = interpolateCubeLutChannel(
        customLut.values,
        customLut.size,
        original[0],
        original[1],
        original[2],
        channel,
      ) * 255;
      data[offset + channel] = Math.round(original[channel] + ((transformed - original[channel]) * intensity));
    }
  }
  return sharp(data, { raw: info });
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
  const isLocalMarkup = operation === 'markup_retouch'
    && String(request.parameters?.mode || '').trim() === 'markup_only';
  const modelTools = context.modelTools || resolveModelTools(undefined, context.env);
  const referenceImageTool = context.referenceImageTool || null;
  const deterministicOperations = ['crop', 'compress', 'mirror', 'rotate', 'grid_crop', 'adjust', 'lut'];
  const cutoutOperations = ['smart_cutout', 'selection_cutout'];
  if (!deterministicOperations.includes(operation)
    && !(cutoutOperations.includes(operation) && modelTools.smart_cutout)
    && !(operation === 'upscale' && modelTools.upscale)
    && !(operation === 'detail_enhance' && modelTools.upscale)
    && !(
      ['upscale', 'detail_enhance'].includes(operation)
      && referenceImageTool?.operations.includes(operation)
    )
    && !(
      operation === 'outpaint'
      && referenceImageTool?.operations.includes('outpaint')
    )
    && !(
      operation === 'markup_retouch'
      && (
        isLocalMarkup
        || referenceImageTool?.operations.includes('markup_retouch')
      )
    )
    && !(
      operation === 'cinematic_relight'
      && referenceImageTool?.operations.includes('cinematic_relight')
    )
    && !(
      ['panorama', 'panorama_scene'].includes(operation)
      && referenceImageTool?.operations.includes(operation)
    )
    && !(
      Object.hasOwn(REFERENCE_VARIATION_CONFIGS, operation)
      && referenceImageTool?.operations.includes(operation)
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
  context.onTaskCreated?.(task);

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
        let brushSelection = null;
        if (operation === 'selection_cutout') {
          const source = sharp(sourcePath, { limitInputPixels: SMART_CUTOUT_MAX_PIXELS });
          const metadata = await source.metadata();
          if (!FORMAT_INFO[metadata.format] || !metadata.width || !metadata.height) {
            fail('IMAGE_TOOL_UNSUPPORTED_IMAGE', '仅支持 PNG、JPEG 和 WebP 图片');
          }
          if (request.parameters?.selectionMode === 'brush') {
            brushSelection = normalizeSelectionBrushParameters(request.parameters, metadata);
            selection = brushSelection.selection;
          } else {
            selection = cropParameters(request.parameters || {}, metadata);
          }
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
        if (brushSelection) {
          const masked = await sharp(outputPath)
            .composite([{
              input: buildSelectionBrushMaskSvg(
                brushSelection.strokes,
                await sharp(sourcePath).metadata(),
                selection,
              ),
              blend: 'dest-in',
            }])
            .png()
            .toBuffer({ resolveWithObject: true });
          fs.writeFileSync(outputPath, masked.data);
          prepared.outputInfo = masked.info;
          prepared.normalized = {
            ...prepared.normalized,
            selectionMode: 'brush',
            brushStrokes: brushSelection.strokes,
          };
        }
        if (selection) {
          prepared.normalized = {
            ...prepared.normalized,
            selectionMode: brushSelection ? 'brush' : 'rectangle',
            ...selection,
          };
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

    if (
      ['upscale', 'detail_enhance'].includes(operation)
      && referenceImageTool?.operations.includes(operation)
    ) {
      const prepared = await runReferenceEnhance({
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
        operation,
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
    }

    if (operation === 'cinematic_relight') {
      const prepared = await runCinematicRelight({
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
          suffix: 'cinematic-relight',
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

    if (['panorama', 'panorama_scene'].includes(operation)) {
      const prepared = await runPanorama({
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
        operation,
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
          suffix: operation === 'panorama_scene' ? 'panorama-scene' : 'panorama',
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

    if (Object.hasOwn(REFERENCE_VARIATION_CONFIGS, operation)) {
      const prepared = await runReferenceVariation({
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
        operation,
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
          suffix: operation.replaceAll('_', '-'),
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
      const greenGain = 1 + (prepared.normalized.tint * 0.12);
      const toneBrightness = 1
        + (prepared.normalized.highlights * 0.08)
        + (prepared.normalized.shadows * 0.12)
        + (prepared.normalized.whites * 0.08)
        + (prepared.normalized.blacks * 0.08);
      const brightness = prepared.normalized.brightness
        * (2 ** prepared.normalized.exposure)
        * toneBrightness;
      const saturation = prepared.normalized.saturation * prepared.normalized.vibrance;
      const curveMidpoint = (channel) => (
        prepared.normalized.curves[channel].find((point) => point[0] === 0.5)?.[1] ?? 0.5
      );
      const rgbMidpoint = curveMidpoint('rgb');
      const curveGamma = Math.min(3, Math.max(1, Math.log(0.5) / Math.log(rgbMidpoint)));
      const curveGains = ['red', 'green', 'blue'].map(
        (channel) => Math.min(1.5, Math.max(0.5, curveMidpoint(channel) / 0.5)),
      );
      const toneContrast = prepared.normalized.contrast
        + ((prepared.normalized.whites - prepared.normalized.blacks) * 0.08);
      pipeline = prepared.source
        .modulate({
          brightness,
          saturation,
          hue: prepared.normalized.hue,
        })
        .linear(
          toneContrast,
          128 * (1 - toneContrast),
        )
        .recomb([
          [redGain * curveGains[0], 0, 0],
          [0, greenGain * curveGains[1], 0],
          [0, 0, blueGain * curveGains[2]],
        ])
        .gamma(curveGamma);
      const detailAmount = Math.max(
        prepared.normalized.sharpness,
        prepared.normalized.clarity,
      );
      if (detailAmount > 0) {
        pipeline = pipeline.sharpen(0.5 + (detailAmount * 1.5));
      }
      const effectBlur = prepared.normalized.blur
        + (prepared.normalized.softLight * 0.7)
        + (prepared.normalized.glow * 0.45);
      if (effectBlur >= 0.3) {
        pipeline = pipeline.blur(Math.min(2, effectBlur));
      }
      if (prepared.normalized.grain > 0) {
        const grainAmount = prepared.normalized.grain * 7;
        pipeline = pipeline.linear(
          1 + (grainAmount / 100),
          -(grainAmount / 2),
        );
      }
      if (prepared.normalized.vignette > 0) {
        const opacity = Math.round(prepared.normalized.vignette * 180);
        const vignette = Buffer.from(
          `<svg width="${prepared.metadata.width}" height="${prepared.metadata.height}"><defs><radialGradient id="v"><stop offset="55%" stop-color="black" stop-opacity="0"/><stop offset="100%" stop-color="black" stop-opacity="${opacity / 255}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`,
        );
        pipeline = pipeline.composite([{ input: vignette, blend: 'over' }]);
      }
      pipeline = pipeline.toFormat(prepared.metadata.format);
    } else {
      pipeline = prepared.customLut
        ? (await applyCustomCubeLut(
          sourcePath,
          prepared.customLut,
          prepared.normalized.intensity,
        )).toFormat(prepared.metadata.format)
        : prepared.source.recomb(prepared.matrix);
      const lutManual = prepared.normalized.manual;
      const manualRed = 1 + (lutManual.temperature * 0.08);
      const manualBlue = 1 - (lutManual.temperature * 0.08);
      pipeline = pipeline
        .modulate({
          brightness: 2 ** lutManual.exposure,
          saturation: lutManual.saturation,
        })
        .linear(lutManual.contrast, 128 * (1 - lutManual.contrast));
      if (lutManual.temperature !== 0) {
        pipeline = pipeline.recomb([
          [manualRed, 0, 0],
          [0, 1, 0],
          [0, 0, manualBlue],
        ]);
      }
      pipeline = pipeline.toFormat(prepared.metadata.format);
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
    const exposedError = deterministicOperations.includes(operation)
      ? sanitizeDeterministicError(error, operation, log)
      : error;
    taskService.updateTaskError(db, task.id, exposedError.message);
    throw exposedError;
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
  createPinnedLookup,
};
