'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TARGETS = [
  'backend-node/src/db/migrate.js',
  'backend-node/src/services/videoClient.js',
  'backend-node/src/services/videoService.js',
];

const SPLIT_SQL_STATEMENTS = `function splitSqlStatements(sql) {
  const statements = [];
  let buffer = '';
  let inTrigger = false;
  for (const line of sql.split(/\\r?\\n/)) {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    if (!inTrigger && upper.startsWith('CREATE TRIGGER')) inTrigger = true;
    buffer += \`\${line}\\n\`;
    if (inTrigger) {
      if (upper.endsWith('END;')) {
        statements.push(buffer.trim().replace(/;$/, ''));
        buffer = '';
        inTrigger = false;
      }
      continue;
    }
    if (trimmed.endsWith(';')) {
      statements.push(buffer.trim().replace(/;$/, ''));
      buffer = '';
    }
  }
  const tail = buffer.trim();
  if (tail) statements.push(tail.replace(/;$/, ''));
  return statements.filter((statement) => statement.length > 0);
}`;

function compatibilityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePath(value) {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase();
}

function secureTargets(candidateRoot) {
  const root = fs.realpathSync(candidateRoot);
  const rootStat = fs.lstatSync(candidateRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw compatibilityError('LIVE_COMPAT_TARGET_INVALID', '候选根目录必须是普通目录');
  }
  const normalizedRoot = `${normalizePath(root)}/`;
  return TARGETS.map((relativePath) => {
    const target = path.resolve(root, ...relativePath.split('/'));
    let stat;
    let real;
    try {
      stat = fs.lstatSync(target);
      real = fs.realpathSync(target);
    } catch (_) {
      throw compatibilityError('LIVE_COMPAT_TARGET_INVALID', `候选缺少兼容目标: ${relativePath}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()
        || normalizePath(real) !== normalizePath(target)
        || !normalizePath(real).startsWith(normalizedRoot)) {
      throw compatibilityError('LIVE_COMPAT_TARGET_INVALID', `候选兼容目标不是根目录内普通文件: ${relativePath}`);
    }
    return { relativePath, target };
  });
}

function preserveEol(original, normalized) {
  return original.includes('\r\n') ? normalized.replaceAll('\n', '\r\n') : normalized;
}

function migrateTransform(source) {
  const normalized = source.replaceAll('\r\n', '\n');
  const hasFunction = normalized.includes('function splitSqlStatements(sql) {');
  const hasCall = normalized.includes('const statements = splitSqlStatements(sql);');
  if (hasFunction && hasCall) return { status: 'ready', content: source };
  if (hasFunction || hasCall) {
    throw compatibilityError('UNSUPPORTED_LIVE_DRIFT', '迁移执行器兼容形态不完整');
  }
  const legacy = /const statements = sql\s*\n\s*\.split\(';'\)\s*\n\s*\.map\(\(s\) => s\.trim\(\)\)\s*\n\s*\.filter\(\(s\) => s\.length > 0\);/;
  if (!legacy.test(normalized)) {
    throw compatibilityError('UNSUPPORTED_LIVE_DRIFT', '迁移执行器不是已批准的旧形态');
  }
  const replaced = normalized.replace(legacy, 'const statements = splitSqlStatements(sql);');
  const anchor = '\n/**';
  const anchorIndex = replaced.indexOf(anchor, replaced.indexOf('function runMigrations'));
  if (anchorIndex < 0) {
    throw compatibilityError('UNSUPPORTED_LIVE_DRIFT', '迁移执行器缺少安全插入锚点');
  }
  const content = `${replaced.slice(0, anchorIndex)}\n\n${SPLIT_SQL_STATEMENTS}\n${replaced.slice(anchorIndex)}`;
  return { status: 'repair', content: preserveEol(source, content) };
}

function videoClientTransform(source) {
  const normalized = source.replaceAll('\r\n', '\n');
  const start = normalized.indexOf('function configSupportsVideoModel(config, preferredModel) {');
  const nextFunction = /\nfunction [A-Za-z0-9_$]+\(/g;
  nextFunction.lastIndex = start + 1;
  const boundary = nextFunction.exec(normalized);
  const end = boundary?.index ?? -1;
  if (start < 0 || end < 0) {
    throw compatibilityError('UNSUPPORTED_LIVE_DRIFT', '视频模型匹配函数缺少安全边界');
  }
  const region = normalized.slice(start, end);
  if (region.includes('config?.logical_model_id,')) return { status: 'ready', content: source };
  const anchor = '    config?.default_model,';
  if (region.split(anchor).length !== 2) {
    throw compatibilityError('UNSUPPORTED_LIVE_DRIFT', '视频模型匹配函数不是已批准的旧形态');
  }
  const repairedRegion = region.replace(anchor, `${anchor}\n    config?.logical_model_id,`);
  const content = `${normalized.slice(0, start)}${repairedRegion}${normalized.slice(end)}`;
  return { status: 'repair', content: preserveEol(source, content) };
}

function videoServiceTransform(source) {
  const normalized = source.replaceAll('\r\n', '\n');
  const start = normalized.indexOf('async function finalizeSuccessfulVideo(');
  const end = normalized.indexOf('\n  const deliveryWarning =', start);
  if (start < 0 || end < 0) {
    throw compatibilityError('UNSUPPORTED_LIVE_DRIFT', '视频完成处理函数缺少安全边界');
  }
  const region = normalized.slice(start, end);
  const repairedLine = '      setVideoGenNeedsAttention(db, videoGenId, row.task_id, message, now);';
  if (region.includes(repairedLine)
      && !region.includes(".run('processing', message.slice(0, 500), now, videoGenId);")) {
    return { status: 'ready', content: source };
  }
  const legacy = `      db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
        .run('processing', message.slice(0, 500), now, videoGenId);
      markVideoCostUnknown(db, log, row);
      if (row.task_id) taskService.updateTaskStatus(db, row.task_id, 'processing', 90, message);`;
  if (region.split(legacy).length !== 2) {
    throw compatibilityError('UNSUPPORTED_LIVE_DRIFT', '视频不可读产物处理不是已批准的旧形态');
  }
  const repairedRegion = region.replace(
    legacy,
    `${repairedLine}\n      markVideoCostUnknown(db, log, row);`,
  );
  const content = `${normalized.slice(0, start)}${repairedRegion}${normalized.slice(end)}`;
  return { status: 'repair', content: preserveEol(source, content) };
}

const TRANSFORMS = {
  'backend-node/src/db/migrate.js': migrateTransform,
  'backend-node/src/services/videoClient.js': videoClientTransform,
  'backend-node/src/services/videoService.js': videoServiceTransform,
};

function prepare(candidateRoot) {
  return secureTargets(candidateRoot).map(({ relativePath, target }) => {
    const source = fs.readFileSync(target, 'utf8');
    const result = TRANSFORMS[relativePath](source);
    return { relativePath, target, source, ...result };
  });
}

function inspectProviderTaskLiveCompatibility(candidateRoot) {
  const prepared = prepare(candidateRoot);
  const pendingPaths = prepared
    .filter(({ status }) => status === 'repair')
    .map(({ relativePath }) => relativePath);
  return { ready: pendingPaths.length === 0, pendingPaths };
}

function applyProviderTaskLiveCompatibility(candidateRoot) {
  const prepared = prepare(candidateRoot);
  const changed = prepared.filter(({ status }) => status === 'repair');
  for (const item of changed) fs.writeFileSync(item.target, item.content);
  return { ready: true, changedPaths: changed.map(({ relativePath }) => relativePath) };
}

function parseArguments(argv) {
  let candidateRoot = null;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check') {
      check = true;
    } else if (argv[index] === '--candidate' && argv[index + 1]) {
      candidateRoot = argv[index + 1];
      index += 1;
    } else {
      throw compatibilityError('INVALID_ARGUMENTS', '仅支持 --candidate PATH 与 --check');
    }
  }
  if (!candidateRoot) throw compatibilityError('INVALID_ARGUMENTS', '缺少 --candidate PATH');
  return { candidateRoot, check };
}

function runCli(argv) {
  try {
    const { candidateRoot, check } = parseArguments(argv);
    const result = check
      ? inspectProviderTaskLiveCompatibility(candidateRoot)
      : applyProviderTaskLiveCompatibility(candidateRoot);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (check && !result.ready) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ready: false,
      error: error.code || 'LIVE_COMPAT_FAILED',
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli(process.argv.slice(2));

module.exports = {
  TARGETS,
  applyProviderTaskLiveCompatibility,
  inspectProviderTaskLiveCompatibility,
};
