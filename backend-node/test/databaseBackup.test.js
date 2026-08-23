const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  createBackup,
  listBackups,
  restoreDrill,
  verifyBackup,
} = require('../src/services/databaseBackupService');

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'molimama-backup-'));
  const dbPath = path.join(root, 'source.sqlite');
  const backupDir = path.join(root, 'backups');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO sample (value) VALUES (?)').run('茉莉妈妈');
  db.close();
  return { root, dbPath, backupDir };
}

test('创建一致性备份后立即生成可验证清单', async () => {
  const fixture = createFixture();
  try {
    const result = await createBackup({
      dbPath: fixture.dbPath,
      backupDir: fixture.backupDir,
      minFreeBytes: 0,
      now: new Date('2026-07-24T08:00:00.000Z'),
    });

    assert.equal(fs.existsSync(result.backupPath), true);
    assert.equal(fs.existsSync(result.manifestPath), true);
    assert.equal(result.manifest.integrity, 'ok');
    assert.equal(result.manifest.sha256.length, 64);
    assert.equal(result.backups.length, 1);
    assert.equal(verifyBackup(result.backupPath).valid, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('备份被篡改后校验失败', async () => {
  const fixture = createFixture();
  try {
    const result = await createBackup({
      dbPath: fixture.dbPath,
      backupDir: fixture.backupDir,
      minFreeBytes: 0,
    });
    fs.appendFileSync(result.backupPath, 'tampered');

    const verification = verifyBackup(result.backupPath);
    assert.equal(verification.valid, false);
    assert.equal(verification.errors.includes('sha256_mismatch'), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('清单损坏时校验和列表都明确显示无效备份', async () => {
  const fixture = createFixture();
  try {
    const result = await createBackup({
      dbPath: fixture.dbPath,
      backupDir: fixture.backupDir,
      minFreeBytes: 0,
    });
    fs.writeFileSync(result.manifestPath, '{invalid json', 'utf8');

    const verification = verifyBackup(result.backupPath);
    const backups = listBackups(fixture.backupDir);
    assert.equal(verification.valid, false);
    assert.equal(verification.errors.includes('manifest_invalid'), true);
    assert.equal(backups.length, 1);
    assert.equal(backups[0].integrity, 'invalid_manifest');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('默认只保留最近六份备份', async () => {
  const fixture = createFixture();
  try {
    for (let index = 0; index < 7; index += 1) {
      await createBackup({
        dbPath: fixture.dbPath,
        backupDir: fixture.backupDir,
        minFreeBytes: 0,
        now: new Date(Date.UTC(2026, 6, 24, 8, 0, index)),
      });
    }

    const backups = listBackups(fixture.backupDir);
    assert.equal(backups.length, 6);
    assert.equal(backups[0].created_at, '2026-07-24T08:00:06.000Z');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('恢复演练只写入新目标并验证原数据', async () => {
  const fixture = createFixture();
  try {
    const result = await createBackup({
      dbPath: fixture.dbPath,
      backupDir: fixture.backupDir,
      minFreeBytes: 0,
    });
    const targetPath = path.join(fixture.root, 'restore-drill.sqlite');
    const restored = restoreDrill({
      backupPath: result.backupPath,
      targetPath,
    });
    const restoredDb = new Database(targetPath, { readonly: true });
    const row = restoredDb.prepare('SELECT value FROM sample').get();
    restoredDb.close();

    assert.equal(restored.valid, true);
    assert.equal(row.value, '茉莉妈妈');
    assert.throws(
      () => restoreDrill({ backupPath: result.backupPath, targetPath }),
      (error) => error.code === 'RESTORE_TARGET_EXISTS',
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('剩余空间低于下限时停止且不生成备份', async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      createBackup({
        dbPath: fixture.dbPath,
        backupDir: fixture.backupDir,
        minFreeBytes: Number.MAX_SAFE_INTEGER,
      }),
      (error) => error.code === 'DATA_BACKUP_LOW_SPACE',
    );
    assert.equal(listBackups(fixture.backupDir).length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('新备份校验失败时不清理已有的六份有效备份', async () => {
  const fixture = createFixture();
  try {
    for (let index = 0; index < 6; index += 1) {
      await createBackup({
        dbPath: fixture.dbPath,
        backupDir: fixture.backupDir,
        minFreeBytes: 0,
        now: new Date(Date.UTC(2026, 6, 24, 8, 0, index)),
      });
    }

    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function writeInvalidManifest(filePath, content, ...args) {
      if (String(filePath).endsWith('.sqlite.json')) {
        const manifest = JSON.parse(String(content));
        manifest.sha256 = '0'.repeat(64);
        return originalWriteFileSync.call(fs, filePath, `${JSON.stringify(manifest)}\n`, ...args);
      }
      return originalWriteFileSync.call(fs, filePath, content, ...args);
    };
    try {
      await assert.rejects(
        createBackup({
          dbPath: fixture.dbPath,
          backupDir: fixture.backupDir,
          minFreeBytes: 0,
          now: new Date('2026-07-24T08:00:06.000Z'),
        }),
        (error) => error.code === 'DATA_BACKUP_VERIFICATION_FAILED',
      );
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(listBackups(fixture.backupDir).length, 6);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
