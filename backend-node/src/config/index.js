const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const configPaths = [
  path.join(process.cwd(), 'configs', 'config.yaml'),
  path.join(process.cwd(), 'config.yaml'),
  path.join(__dirname, '..', '..', 'configs', 'config.yaml'),
];

function hasEnv(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key);
}

function parseBooleanEnv(env, key) {
  const value = String(env[key] ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  throw new Error(`Invalid ${key}: expected true or false`);
}

function applyEnvironmentOverrides(config, env = process.env) {
  const result = structuredClone(config);
  result.app ||= {};
  result.server ||= {};
  result.database ||= {};
  result.storage ||= {};

  if (hasEnv(env, 'APP_NAME')) result.app.name = String(env.APP_NAME).trim();
  if (hasEnv(env, 'APP_VERSION')) result.app.version = String(env.APP_VERSION).trim();
  if (hasEnv(env, 'APP_DEBUG')) result.app.debug = parseBooleanEnv(env, 'APP_DEBUG');
  if (hasEnv(env, 'SERVER_INSECURE_TLS')) {
    result.server.insecure_tls = parseBooleanEnv(env, 'SERVER_INSECURE_TLS');
  }
  if (hasEnv(env, 'SERVER_CORS_ORIGINS')) {
    const origins = String(env.SERVER_CORS_ORIGINS)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    if (!origins.length) throw new Error('Invalid SERVER_CORS_ORIGINS: expected at least one origin');
    result.server.cors_origins = origins;
  }
  if (hasEnv(env, 'DATABASE_PATH')) result.database.path = String(env.DATABASE_PATH).trim();
  if (hasEnv(env, 'STORAGE_LOCAL_PATH')) {
    result.storage.local_path = String(env.STORAGE_LOCAL_PATH).trim();
  }
  if (hasEnv(env, 'STORAGE_BASE_URL')) {
    result.storage.base_url = String(env.STORAGE_BASE_URL).trim();
  }
  return result;
}

function loadConfig() {
  let raw = null;
  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      raw = fs.readFileSync(p, 'utf8');
      break;
    }
  }
  if (!raw) {
    throw new Error('Config file not found: configs/config.yaml');
  }
  const parsed = yaml.load(raw);
  if (!parsed?.app?.name) {
    throw new Error('Invalid config: missing app section');
  }
  return applyEnvironmentOverrides(parsed);
}

module.exports = { applyEnvironmentOverrides, loadConfig };
