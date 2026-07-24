const path = require('path');
const { loadConfig } = require('../src/config');
const {
  createBackup,
  listBackups,
  restoreDrill,
  verifyBackup,
} = require('../src/services/databaseBackupService');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2];
  const config = loadConfig();
  const dbPath = path.resolve(process.cwd(), config.database?.path || '');
  const backupDir = path.resolve(
    process.cwd(),
    option('--backup-dir', process.env.DATA_BACKUP_DIR || './data/backups'),
  );

  if (command === 'create') {
    const result = await createBackup({
      dbPath,
      backupDir,
      retention: Number(option('--retention', process.env.DATA_BACKUP_RETENTION || 6)),
      minFreeBytes: Number(
        option('--min-free-bytes', process.env.DATA_BACKUP_MIN_FREE_BYTES || 10 * 1024 ** 3),
      ),
    });
    process.stdout.write(`${JSON.stringify({
      created: result.manifest,
      backups: result.backups,
    }, null, 2)}\n`);
    return;
  }

  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(listBackups(backupDir), null, 2)}\n`);
    return;
  }

  if (command === 'verify') {
    const backupPath = path.resolve(option('--backup', ''));
    const result = verifyBackup(backupPath);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  if (command === 'restore-drill') {
    const backupPath = path.resolve(option('--backup', ''));
    const targetPath = path.resolve(option('--target', ''));
    const result = restoreDrill({ backupPath, targetPath });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  throw new Error(
    '用法：database-backup.js create|list|verify|restore-drill [--backup 路径] [--target 新路径]',
  );
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error.code || 'DATABASE_BACKUP_FAILED',
    message: error.message,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
