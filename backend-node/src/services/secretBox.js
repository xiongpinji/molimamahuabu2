'use strict';

const crypto = require('node:crypto');

const PREFIX = 'enc:v1:';

function getMasterKey(env = process.env) {
  const raw = String(env.AI_CONFIG_MASTER_KEY || env.API_KEY_MASTER_KEY || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function isEncrypted(value) {
  return String(value || '').startsWith(PREFIX);
}

/**
 * 将明文 api_key 加密后入库。无主密钥时保持明文（本地开发兼容）。
 * 生产应通过 productionPreflight 要求配置 AI_CONFIG_MASTER_KEY。
 */
function encryptSecret(plaintext, env = process.env) {
  const text = String(plaintext || '');
  if (!text || isEncrypted(text)) return text;
  const key = getMasterKey(env);
  if (!key) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(stored, env = process.env) {
  const text = String(stored || '');
  if (!text || !isEncrypted(text)) return text;
  const key = getMasterKey(env);
  if (!key) {
    throw new Error('AI_CONFIG_MASTER_KEY required to decrypt stored API keys');
  }
  const payload = text.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('corrupt encrypted API key');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = {
  PREFIX,
  isEncrypted,
  encryptSecret,
  decryptSecret,
  getMasterKey,
};
