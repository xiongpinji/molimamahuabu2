const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');

const assetService = require('./assetService');
const taskService = require('./taskService');

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
      engine: 'sharp',
      engineVersion: sharp.versions.sharp,
      taskId: task.id,
      createdAt: new Date().toISOString(),
    },
  });
}

async function createOperation(db, log, request, context = {}) {
  const operation = String(request.operation || '').trim();
  if (!['crop', 'compress', 'mirror', 'grid_crop', 'adjust', 'lut'].includes(operation)) {
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

    let prepared;
    if (operation === 'crop') prepared = await runCrop(sourcePath, request.parameters || {});
    else if (operation === 'compress') prepared = await runCompress(sourcePath, request.parameters || {});
    else if (operation === 'mirror') prepared = await runMirror(sourcePath, request.parameters || {});
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
    } else if (operation === 'adjust') {
      pipeline = prepared.source
        .modulate({
          brightness: prepared.normalized.brightness,
          saturation: prepared.normalized.saturation,
        })
        .linear(
          prepared.normalized.contrast,
          128 * (1 - prepared.normalized.contrast),
        )
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
};
