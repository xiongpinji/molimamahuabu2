const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const verification = require('../src/services/authVerificationService');

function makeDb() {
  return new Database(':memory:');
}

test('验证码只保存摘要且成功校验后立即失效', () => {
  const db = makeDb();
  const now = new Date('2026-07-26T10:00:00.000Z');
  const issued = verification.issue(db, {
    email: ' USER@example.com ',
    purpose: 'register',
    secret: 'v'.repeat(32),
    now,
    generateCode: () => '123456',
  });

  assert.equal(issued.code, '123456');
  const stored = db.prepare('SELECT email, code_hash, consumed_at FROM auth_verification_codes').get();
  assert.equal(stored.email, 'user@example.com');
  assert.notEqual(stored.code_hash, '123456');
  assert.equal(stored.consumed_at, null);

  verification.consume(db, {
    email: 'user@example.com',
    purpose: 'register',
    code: '123456',
    secret: 'v'.repeat(32),
    now,
  });
  assert.throws(
    () => verification.consume(db, {
      email: 'user@example.com',
      purpose: 'register',
      code: '123456',
      secret: 'v'.repeat(32),
      now,
    }),
    (error) => error.code === 'VERIFICATION_INVALID',
  );
});

test('验证码错误、过期和用途不匹配统一返回无效错误', () => {
  const db = makeDb();
  const secret = 'v'.repeat(32);
  const now = new Date('2026-07-26T10:00:00.000Z');
  verification.issue(db, {
    email: 'user@example.com',
    purpose: 'password_reset',
    secret,
    now,
    generateCode: () => '654321',
  });

  for (const input of [
    { purpose: 'password_reset', code: '000000', now },
    { purpose: 'register', code: '654321', now },
    { purpose: 'password_reset', code: '654321', now: new Date('2026-07-26T10:11:00.000Z') },
  ]) {
    assert.throws(
      () => verification.consume(db, {
        email: 'user@example.com',
        secret,
        ...input,
      }),
      (error) => error.code === 'VERIFICATION_INVALID',
    );
  }
});
