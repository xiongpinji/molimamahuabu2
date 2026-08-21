'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT = 'canvas-credit-callout-v1';
const componentRelativePath = path.join(
  'frontweb',
  'src',
  'components',
  'dramaCanvas',
  'HomeCanvasNode.vue',
);
const bundleExtensions = new Set(['.css', '.html', '.js']);

function contractError(message) {
  const error = new Error(`[${CONTRACT}] ${message}`);
  error.code = 'PROTECTED_UI_CONTRACT_FAILED';
  return error;
}

function requireMatch(content, pattern, message) {
  if (!pattern.test(content)) throw contractError(message);
}

function validateSource(content) {
  requireMatch(
    content,
    /class="billing-cost"\s+aria-live="polite"/,
    '缺少醒目积分卡片 billing-cost 或无障碍状态声明',
  );
  requireMatch(
    content,
    /本次预计扣除\s*<strong>\{\{\s*estimatedCredits\s*\}\}<\/strong>\s*积分/,
    '积分数字必须在“本次预计扣除”文案中单独加粗',
  );
  requireMatch(content, /积分待管理员配置/, '缺少未定价状态提示');
  const card = content.match(/\.billing-cost\s*\{([^}]*)\}/)?.[1] || '';
  if (!card.includes('border:')
    || !card.includes('background:')
    || !/font-weight\s*:\s*(?:800|900)/.test(card)) {
    throw contractError('醒目积分卡片必须保留背景、边框和至少 800 字重');
  }
  const amount = content.match(/\.billing-cost strong\s*\{([^}]*)\}/)?.[1] || '';
  if (!/font-weight\s*:\s*900/.test(amount)) {
    throw contractError('积分数字必须保留 900 字重');
  }
  if (/class="billing-note">\{\{\s*estimatedCredits/.test(content)) {
    throw contractError('检测到旧 billing-note 灰字积分模板');
  }
}

function collectBundleFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectBundleFiles(target);
    if (!entry.isFile() || !bundleExtensions.has(path.extname(entry.name))) return [];
    return [target];
  });
}

function fileContainsAll(file, tokens) {
  const content = fs.readFileSync(file, 'utf8');
  return tokens.every((token) => content.includes(token));
}

function buildStyleSatisfiesContract(file) {
  const content = fs.readFileSync(file, 'utf8');
  const card = content.match(/\.billing-cost(?:\[[^\]]+\])?\{([^}]*)\}/)?.[1] || '';
  const amount = content.match(/\.billing-cost strong(?:\[[^\]]+\])?\{([^}]*)\}/)?.[1] || '';
  return card.includes('background:')
    && card.includes('border:')
    && card.includes('font-weight:800')
    && amount.includes('font-weight:900');
}

function validateBuild(releaseRoot) {
  const distPath = path.join(releaseRoot, 'frontweb', 'dist');
  const files = collectBundleFiles(distPath);
  if (files.length === 0) throw contractError('生产构建目录为空或不存在');

  const scriptReady = files.some((file) => (
    fileContainsAll(file, ['本次预计扣除', 'billing-cost', '积分待管理员配置'])
  ));
  if (!scriptReady) throw contractError('生产构建缺少预计积分文案或 billing-cost 类名');

  const styleReady = files.some(buildStyleSatisfiesContract);
  if (!styleReady) throw contractError('生产构建缺少醒目积分样式或关键字重');
}

function auditCanvasCreditReleaseContract({ releaseRoot, requireBuild = false }) {
  const root = path.resolve(String(releaseRoot || ''));
  const componentPath = path.join(root, componentRelativePath);
  const sourceValidated = fs.existsSync(componentPath);

  if (sourceValidated) {
    validateSource(fs.readFileSync(componentPath, 'utf8'));
  } else if (!requireBuild) {
    throw contractError(`源码文件不存在: ${componentRelativePath}`);
  }

  if (requireBuild) validateBuild(root);

  return {
    contract: CONTRACT,
    sourceValidated,
    buildValidated: Boolean(requireBuild),
  };
}

function parseCliArguments(argv) {
  const args = [...argv];
  let releaseRoot;
  let requireBuild = false;
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--require-build') {
      requireBuild = true;
    } else if (argument === '--root') {
      if (args.length === 0) throw contractError('--root 缺少目录参数');
      releaseRoot = args.shift();
    } else if (!releaseRoot) {
      releaseRoot = argument;
    } else {
      throw contractError(`未知参数: ${argument}`);
    }
  }
  return { releaseRoot, requireBuild };
}

function runCli(argv, defaultRoot) {
  try {
    const options = parseCliArguments(argv);
    const report = auditCanvasCreditReleaseContract({
      releaseRoot: options.releaseRoot || defaultRoot,
      requireBuild: options.requireBuild,
    });
    process.stdout.write(`${JSON.stringify({ ready: true, ...report })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ready: false,
      contract: CONTRACT,
      error: error.code || 'PROTECTED_UI_CONTRACT_FAILED',
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2), path.resolve(__dirname, '..', '..', '..'));
}

module.exports = {
  CONTRACT,
  auditCanvasCreditReleaseContract,
  runCli,
};
