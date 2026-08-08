#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalPayload(manifest) {
  return Buffer.from(JSON.stringify(canonicalize(manifest)), 'utf8');
}

function main(argv = process.argv.slice(2), streams = process) {
  try {
    const args = parseArgs(argv);
    const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
    const privateKey = fs.readFileSync(args.privateKey);
    const signature = crypto.sign(null, canonicalPayload(manifest), privateKey);
    writeSignatureFile(args.signature, `${signature.toString('base64')}\n`);
    if (streams.stdout && typeof streams.stdout.write === 'function') {
      streams.stdout.write('SIGN_REDRAW_LOCALE_MANIFEST_OK\n');
    }
    return 0;
  } catch (error) {
    if (streams.stderr && typeof streams.stderr.write === 'function') {
      streams.stderr.write(`${error.code || 'SIGN_REDRAW_LOCALE_MANIFEST_FAILED'}\n`);
    }
    if (streams === process) {
      process.exitCode = 1;
    }
    return 1;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !flag.startsWith('--')) {
      throw codedError('SIGN_REDRAW_LOCALE_MANIFEST_ARGS_INVALID');
    }
    parsed[flag.slice(2)] = value;
  }
  const manifest = parsed.manifest;
  const privateKey = parsed['private-key'];
  const signature = parsed.signature;
  if (!manifest || !privateKey || !signature) {
    throw codedError('SIGN_REDRAW_LOCALE_MANIFEST_ARGS_INVALID');
  }
  return { manifest, privateKey, signature };
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function writeSignatureFile(signaturePath, value) {
  const directory = path.dirname(signaturePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(signaturePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, value, { mode: 0o600 });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, signaturePath);
    fs.chmodSync(signaturePath, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Best effort cleanup; the stable error code is emitted by main().
    }
    throw error;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  canonicalize,
  canonicalPayload,
  main,
  writeSignatureFile,
};
