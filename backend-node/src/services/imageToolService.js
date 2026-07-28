const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile, spawnSync } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline: pipelineAsync } = require('node:stream/promises');
const { promisify } = require('node:util');
const sharp = require('sharp');

const assetService = require('./assetService');
const taskService = require('./taskService');
const execFileAsync = promisify(execFile);
const SMART_CUTOUT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SMART_CUTOUT_MAX_PIXELS = 40_000_000;
const AUDITED_REMBG_MODEL_HASHES = Object.freeze({
  u2netp: '309C8469258DDA742793DCE0EBEA8E6DD393174F89934733ECC8B14C76F4DDD8',
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
  return path.resolve(configured || path.join(process.cwd(), 'data', 'storage'));
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveSourcePath(asset, storageRoot) {
  if (!asset.local_path) fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '源图片没有可处理的本地文件');
  const sourcePath = path.resolve(
    path.isAbsolute(asset.local_path)
      ? asset.local_path
      : path.join(storageRoot, asset.local_path),
  );
  if (!isInside(storageRoot, sourcePath)) {
    fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '源图片不在允许的素材目录中');
  }
  if (!fs.existsSync(sourcePath)) fail('IMAGE_TOOL_SOURCE_UNAVAILABLE', '源图片文件不存在');
  return sourcePath;
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

function createConcurrencyLimiter(maxConcurrency, maxTenantConcurrency) {
  let active = 0;
  const activeByTenant = new Map();
  return {
    acquire(tenantId) {
      const tenantKey = String(tenantId || 'local');
      const tenantActive = activeByTenant.get(tenantKey) || 0;
      if (active >= maxConcurrency || tenantActive >= maxTenantConcurrency) {
        fail('IMAGE_TOOL_BUSY', '智能抠图任务繁忙，请稍后重试');
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
    limiter: createConcurrencyLimiter(maxConcurrency, maxTenantConcurrency),
  };
}

function resolveModelTools(
  explicitTools,
  env = process.env,
  auditedModelHashes = AUDITED_REMBG_MODEL_HASHES,
) {
  if (explicitTools) {
    return {
      smart_cutout: normalizeSmartCutoutTool(explicitTools.smart_cutout, auditedModelHashes),
    };
  }
  return {
    smart_cutout: normalizeSmartCutoutTool({
      command: String(env.IMAGE_TOOL_REMBG_PATH || '').trim(),
      engineVersion: String(env.IMAGE_TOOL_REMBG_VERSION || '').trim(),
      model: String(env.IMAGE_TOOL_REMBG_MODEL || 'u2netp').trim(),
      modelHome: String(env.IMAGE_TOOL_REMBG_MODEL_HOME || '').trim(),
      maxConcurrency: env.IMAGE_TOOL_REMBG_MAX_CONCURRENCY,
      maxTenantConcurrency: env.IMAGE_TOOL_REMBG_MAX_TENANT_CONCURRENCY,
    }, auditedModelHashes),
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
  return {
    smart_cutout: { ...available },
    selection_cutout: { ...available },
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
    && !(cutoutOperations.includes(operation) && modelTools.smart_cutout)) {
    fail('IMAGE_TOOL_OPERATION_UNAVAILABLE', '该图片工具尚未接通真实处理器');
  }
  const asset = requireOwnedImageAsset(db, request.assetId, context);
  const storageRoot = resolveStorageRoot(context.cfg);
  const sourcePath = resolveSourcePath(asset, storageRoot);
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
      const outputDir = resolveDerivedDir(sourcePath);
      fs.mkdirSync(outputDir, { recursive: true });
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
        const outputDir = resolveDerivedDir(sourcePath);
        fs.mkdirSync(outputDir, { recursive: true });
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

    let prepared;
    if (operation === 'crop') prepared = await runCrop(sourcePath, request.parameters || {});
    else if (operation === 'compress') prepared = await runCompress(sourcePath, request.parameters || {});
    else if (operation === 'mirror') prepared = await runMirror(sourcePath, request.parameters || {});
    else if (operation === 'rotate') prepared = await runRotate(sourcePath, request.parameters || {});
    else if (operation === 'adjust') prepared = await runAdjust(sourcePath, request.parameters || {});
    else prepared = await runLut(sourcePath, request.parameters || {});
    const outputDir = resolveDerivedDir(sourcePath);
    fs.mkdirSync(outputDir, { recursive: true });
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
