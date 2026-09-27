const fs = require('fs');
const path = require('path');

const ENV_FILES = ['.env', '.env.local'];

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const text = fs.readFileSync(filePath, 'utf8');
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, parsed.key)) continue;
    process.env[parsed.key] = parsed.value;
    count += 1;
  }
  return count;
}

function loadDotenv({ cwd = process.cwd(), silent = true } = {}) {
  if (process.env.__MOLI_DOTENV_LOADED__) return 0;
  let total = 0;
  for (const name of ENV_FILES) {
    total += loadEnvFile(path.join(cwd, name));
  }
  process.env.__MOLI_DOTENV_LOADED__ = '1';
  if (!silent) {
    console.log(`[dotenv] loaded ${total} variable(s) from ${cwd}`);
  }
  return total;
}

module.exports = { loadDotenv, parseLine, loadEnvFile };
