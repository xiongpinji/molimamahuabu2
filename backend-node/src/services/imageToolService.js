const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile, spawnSync } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline: pipelineAsync } = require('node:stream/promises');
const { promisify } = require('node:util');
const sharp = require('sharp');

const assetService = require('./assetService');
const storageLayout = require('./storageLayout');
const taskService = require('./taskService');
const execFileAsync = promisify(execFile);
const SMART_CUTOUT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SMART_CUTOUT_MAX_PIXELS = 40_000_000;
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
  return {
    smart_cutout: { ...available },
    selection_cutout: { ...available },
    upscale,
  };
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

async function runUpscaleUnlocked(sourcePath, outputPath, prepared, tool, log) {
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
    log?.error?.('upscale processing failed', {
      error: String(error.stderr || error.message || '').trim().slice(-400),
      exitCode: error.code,
      signal: error.signal,
    });
    fail(
      'IMAGE_TOOL_PROCESSING_FAILED',
      error.killed || error.signal === 'SIGTERM' ? '高清增强处理超时' : '高清增强处理失败',
    );
  }
  if (!fs.existsSync(outputPath)) {
    fail('IMAGE_TOOL_PROCESSING_FAILED', '高清增强处理失败');
  }
  try {
    const outputSize = fs.statSync(outputPath).size;
    if (outputSize <= 0 || outputSize > SMART_CUTOUT_MAX_OUTPUT_BYTES) {
      fail('IMAGE_TOOL_PROCESSING_FAILED', '高清增强产物校验失败');
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
      fail('IMAGE_TOOL_PROCESSING_FAILED', '高清增强产物校验失败');
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
    log?.error?.('upscale output validation failed', {
      error: String(error.message || '').trim().slice(-400),
    });
    fail('IMAGE_TOOL_PROCESSING_FAILED', '高清增强产物校验失败');
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
  const deterministicOperations = ['crop', 'compress', 'mirror', 'rotate', 'grid_crop', 'adjust', 'lut'];
  const cutoutOperations = ['smart_cutout', 'selection_cutout'];
  if (!deterministicOperations.includes(operation)
    && !(cutoutOperations.includes(operation) && modelTools.smart_cutout)
    && !(operation === 'upscale' && modelTools.upscale)) {
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
  resolveModelTools,
};
