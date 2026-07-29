'use strict';

const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const productionRoots = [
  'backend-node/src',
  'frontweb/src',
  'deploy',
];
const productionFiles = [
  'Dockerfile',
  'compose.production.yml',
  '.env.production.example',
];
const textExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.mjs', '.py',
  '.sh', '.ts', '.vue', '.yaml', '.yml',
]);
const secretPatterns = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAKLT[a-zA-Z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];

function collectFiles(target) {
  const absolute = path.join(repositoryRoot, target);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [absolute];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => (
    collectFiles(path.join(target, entry.name))
  ));
}

const files = [...productionRoots, ...productionFiles]
  .flatMap(collectFiles)
  .filter((file) => textExtensions.has(path.extname(file)) || path.basename(file) === 'Dockerfile');

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      throw new Error(`生产文件疑似包含硬编码密钥: ${path.relative(repositoryRoot, file)}`);
    }
  }
}

const imageNodeFiles = [
  'backend-node/src/routes/imageTools.js',
  'backend-node/src/services/imageToolService.js',
  'frontweb/src/api/imageTools.js',
  'frontweb/src/components/dramaCanvas/ImageNodeToolbar.vue',
];
const forbiddenVerificationTerms = /核验|侵权|版权判断|copyright(?:_check)?|infringement/i;
for (const relativePath of imageNodeFiles) {
  const content = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
  if (forbiddenVerificationTerms.test(content)) {
    throw new Error(`图片节点禁区能力进入生产代码: ${relativePath}`);
  }
}

const routeSource = fs.readFileSync(
  path.join(repositoryRoot, 'backend-node/src/routes/imageTools.js'),
  'utf8',
);
const serviceSource = fs.readFileSync(
  path.join(repositoryRoot, 'backend-node/src/services/imageToolService.js'),
  'utf8',
);
if (!/lip_sync:\s*unavailable\('对口型模型能力尚未配置'\)/.test(routeSource)) {
  throw new Error('对口型必须保持显式不可用');
}
if (/lip_sync/i.test(serviceSource)) {
  throw new Error('对口型不得进入图片处理服务');
}

process.stdout.write(`image_node_release_audit=passed files=${files.length}\n`);
