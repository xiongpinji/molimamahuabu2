const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadEnvFile, parseLine } = require('../src/config/dotenv');

test('parseLine strips matching quotes and ignores comments', () => {
  assert.deepEqual(parseLine('A="x y"'), { key: 'A', value: 'x y' });
  assert.equal(parseLine('# comment'), null);
  assert.equal(parseLine('noequals'), null);
});

test('loadEnvFile never overrides variables already present in the process env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'DOTENV_TEST_KEEP=from-file\r\nDOTENV_TEST_NEW=from-file\r\n');
  process.env.DOTENV_TEST_KEEP = 'from-env';
  delete process.env.DOTENV_TEST_NEW;
  try {
    assert.equal(loadEnvFile(file), 1);
    assert.equal(process.env.DOTENV_TEST_KEEP, 'from-env');
    assert.equal(process.env.DOTENV_TEST_NEW, 'from-file');
  } finally {
    delete process.env.DOTENV_TEST_KEEP;
    delete process.env.DOTENV_TEST_NEW;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
