const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_RETENTION = 6;

function backupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function nearestExistingPath(value) {
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function ensureFreeSpace(backupDir, minFreeBytes) {
  if (!Number.isFinite(minFreeBytes) || minFreeBytes < 0) {
    throw backupError('INVALID_BACKUP_OPTIONS', '最小剩余空间必须是非负数');
  }
  const stats = fs.statfsSync(nearestExistingPath(backupDir));
  const available = stats.bavail * stats.bsize;
  if (available < minFreeBytes) {
    throw backupError(
      'DATA_BACKUP_LOW_SPACE',
      `备份空间不足：需要至少 ${minFreeBytes} 字节，当前可用 ${available} 字节`,
    );
  }
}

function manifestPathFor(backupPath) {
  return `${backupPath}.json`;
}

function readManifest(backupPath) {
  const manifestPath = manifestPathFor(backupPath);
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function sqliteQuickCheck(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.pragma('quick_check', { simple: true });
  } finally {
    db.close();
  }
}

function verifyBackup(backupPath) {
  const errors = [];
  if (!fs.existsSync(backupPath)) {
    return { valid: false, errors: ['backup_missing'] };
  }
  let manifest;
  try {
    manifest = readManifest(backupPath);
  } catch {
    return { valid: false, errors: ['manifest_invalid'] };
  }
  if (!manifest) {
    return { valid: false, errors: ['manifest_missing'] };
  }
  if (sha256(backupPath) !== manifest.sha256) errors.push('sha256_mismatch');

  try {
    const integrity = sqliteQuickCheck(backupPath);
    if (integrity !== 'ok') errors.push('sqlite_integrity_failed');
  } catch {
    errors.push('sqlite_open_failed');
  }

  return {
    valid: errors.length === 0,
    errors,
    manifest,
  };
}

function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter((name) => name.endsWith('.sqlite.json'))
    .map((name) => {
      const manifestPath = path.join(backupDir, name);
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return {
          ...manifest,
          backupPath: path.join(backupDir, manifest.file),
          manifestPath,
        };
      } catch {
        const backupPath = manifestPath.slice(0, -'.json'.length);
        return {
          id: path.basename(backupPath, '.sqlite'),
          file: path.basename(backupPath),
          created_at: fs.statSync(manifestPath).mtime.toISOString(),
          integrity: 'invalid_manifest',
          backupPath,
          manifestPath,
        };
      }
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function pruneBackups(backupDir, retention) {
  if (!Number.isSafeInteger(retention) || retention < 1) {
    throw backupError('INVALID_BACKUP_OPTIONS', '备份保留数量必须是正整数');
  }
  const backups = listBackups(backupDir);
  for (const backup of backups.slice(retention)) {
    fs.rmSync(backup.backupPath, { force: true });
    fs.rmSync(backup.manifestPath, { force: true });
  }
}

async function createBackup({
  dbPath,
  backupDir,
  retention = DEFAULT_RETENTION,
  minFreeBytes = 0,
  now = new Date(),
}) {
  if (!fs.existsSync(dbPath)) {
    throw backupError('DATABASE_NOT_FOUND', `数据库不存在：${dbPath}`);
  }
  ensureFreeSpace(backupDir, minFreeBytes);
  fs.mkdirSync(backupDir, { recursive: true });

  const createdAt = now.toISOString();
  const id = `database-${createdAt.replace(/[-:.]/g, '')}`;
  const backupPath = path.join(backupDir, `${id}.sqlite`);
  const manifestPath = manifestPathFor(backupPath);
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    await source.backup(backupPath);
    const integrity = sqliteQuickCheck(backupPath);
    if (integrity !== 'ok') {
      throw backupError('DATA_BACKUP_INTEGRITY_FAILED', '备份 SQLite quick_check 未通过');
    }

    const manifest = {
      id,
      file: path.basename(backupPath),
      created_at: createdAt,
      size_bytes: fs.statSync(backupPath).size,
      sha256: sha256(backupPath),
      integrity: 'ok',
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const verification = verifyBackup(backupPath);
    if (!verification.valid) {
      throw backupError(
        'DATA_BACKUP_VERIFICATION_FAILED',
        `备份校验失败：${verification.errors.join(', ')}`,
      );
    }
    pruneBackups(backupDir, retention);
    return {
      backupPath,
      manifestPath,
      manifest,
      backups: listBackups(backupDir),
    };
  } catch (error) {
    fs.rmSync(backupPath, { force: true });
    fs.rmSync(manifestPath, { force: true });
    if (error.code === 'ENOSPC' || error.code === 'EIO') throw error;
    throw error;
  } finally {
    source.close();
  }
}

function restoreDrill({ backupPath, targetPath }) {
  if (fs.existsSync(targetPath)) {
    throw backupError('RESTORE_TARGET_EXISTS', `恢复演练目标已存在：${targetPath}`);
  }
  const sourceVerification = verifyBackup(backupPath);
  if (!sourceVerification.valid) {
    throw backupError(
      'DATA_BACKUP_VERIFICATION_FAILED',
      `源备份校验失败：${sourceVerification.errors.join(', ')}`,
    );
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(backupPath, targetPath, fs.constants.COPYFILE_EXCL);
  try {
    const integrity = sqliteQuickCheck(targetPath);
    const hashMatches = sha256(targetPath) === sourceVerification.manifest.sha256;
    return {
      valid: integrity === 'ok' && hashMatches,
      targetPath,
      integrity,
      hashMatches,
    };
  } catch (error) {
    fs.rmSync(targetPath, { force: true });
    throw error;
  }
}

module.exports = {
  DEFAULT_RETENTION,
  createBackup,
  listBackups,
  restoreDrill,
  verifyBackup,
};
