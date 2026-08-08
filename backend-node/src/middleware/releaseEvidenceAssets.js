const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const SHARED_EVIDENCE_PARENT = '/opt/moli-drama/shared/release-evidence';
const SHARED_EVIDENCE_PUBLIC = '/opt/moli-drama/shared/release-evidence/external-models-v1/public';
const SAFE_MEDIA_PATH = /^\/(?:toapis\/[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4|usmercari\/[A-Za-z0-9][A-Za-z0-9._~-]*\.(?:jpg|jpeg|png|webp)|bootstrap\/[A-Za-z0-9][A-Za-z0-9._~-]*\.(?:jpg|jpeg|png|webp|mp4|mp3|m4a|wav))$/;

function assertProtectedProductionTree(allowedRoot, publicRoot) {
  let current = publicRoot;
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error('共享验证资产目录必须全程为 root:root 且不可被组或其他用户写入');
    }
    if (current === allowedRoot) return;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('共享验证资产目录不在受保护根内');
    current = parent;
  }
}

function resolveReleaseEvidenceRoot(roots) {
  const configured = String(roots?.publicRoot || SHARED_EVIDENCE_PUBLIC).trim();
  const allowedConfigured = String(roots?.allowedRoot || SHARED_EVIDENCE_PARENT).trim();
  if (!path.isAbsolute(configured) || !path.isAbsolute(allowedConfigured)) {
    throw new Error('共享验证资产目录必须使用绝对路径');
  }
  if (!fs.existsSync(configured) || !fs.existsSync(allowedConfigured)) {
    if (!roots) return null;
    throw new Error('共享验证资产路径必须存在');
  }
  if (!roots && process.platform !== 'win32') {
    assertProtectedProductionTree(allowedConfigured, configured);
  }
  const allowed = fs.realpathSync(allowedConfigured);
  const target = fs.realpathSync(configured);
  if (!fs.statSync(allowed).isDirectory() || !fs.statSync(target).isDirectory()) {
    throw new Error('共享验证资产路径必须是目录');
  }
  if (fs.lstatSync(configured).isSymbolicLink()) {
    throw new Error('共享验证资产目录不能是符号链接');
  }
  const relative = path.relative(allowed, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('验证资产必须位于受保护共享证据目录的 public 子目录');
  }
  return target;
}

function mountReleaseEvidenceAssets(app, roots) {
  const root = resolveReleaseEvidenceRoot(roots);
  if (!root) return false;
  app.use('/verification-assets', (request, response, next) => {
    let pathname;
    try { pathname = decodeURIComponent(String(request.path || '')); } catch (_) { return response.status(404).end(); }
    if (pathname.split('/').some((part) => part.startsWith('.')) || !SAFE_MEDIA_PATH.test(pathname)) {
      return response.status(404).end();
    }
    return next();
  }, express.static(root, {
    dotfiles: 'ignore',
    fallthrough: false,
    immutable: true,
    maxAge: '1y',
    setHeaders(response) {
      response.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }));
  return true;
}

module.exports = {
  SHARED_EVIDENCE_PARENT,
  SHARED_EVIDENCE_PUBLIC,
  mountReleaseEvidenceAssets,
  resolveReleaseEvidenceRoot,
};
