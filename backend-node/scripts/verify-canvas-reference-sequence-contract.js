'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT = 'canvas-reference-numbered-mentions-v1';
const PROTECTED_FILES = [
  'frontweb/src/utils/freeCanvasGeneration.js',
  'frontweb/src/views/DramaCanvas.vue',
  'frontweb/src/views/HomeCanvas.vue',
  'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
];

function contractError(message) {
  const error = new Error(`[${CONTRACT}] ${message}`);
  error.code = 'PROTECTED_REFERENCE_SEQUENCE_CONTRACT_FAILED';
  return error;
}

function readProtectedFile(releaseRoot, relativePath) {
  const filePath = path.join(releaseRoot, ...relativePath.split('/'));
  if (!fs.existsSync(filePath)) throw contractError(`受保护文件不存在: ${relativePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

function requireMatch(content, pattern, message) {
  if (!pattern.test(content)) throw contractError(message);
}

function functionSection(content, functionName) {
  const start = content.indexOf(`function ${functionName}`);
  if (start < 0) throw contractError(`缺少函数 ${functionName}`);
  const nextFunction = content.indexOf('\nfunction ', start + 1);
  const nextExport = content.indexOf('\nexport function ', start + 1);
  const candidates = [nextFunction, nextExport].filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : content.length;
  return content.slice(start, end);
}

function validateCandidateBuilder(content) {
  const section = functionSection(content, 'buildFreeCanvasReferenceMentionCandidates');
  requireMatch(section, /label:\s*`图片\$\{index \+ 1\}`/, '缺少图片1、图片2…序号构造');
  requireMatch(section, /mentionToken:\s*`@图片\$\{index \+ 1\}`/, '缺少与图片序号一致的 mention token');
  requireMatch(section, /reference\.ready\s*&&\s*reference\.enabled !== false/, '候选必须只包含已就绪且启用的参考图');
  if (section.indexOf('.map(') < 0 || section.indexOf('.filter(') < 0
    || section.indexOf('.map(') > section.indexOf('.filter(')) {
    throw contractError('必须先按卡片顺序编号，再过滤不可引用图片');
  }
}

function validateCanvasEntry(content, relativePath) {
  const section = functionSection(content, 'freeCanvasReferenceCandidates');
  requireMatch(
    section,
    /return buildFreeCanvasReferenceMentionCandidates\([\s\S]*collectDirectUpstreamImageReferences\(/,
    `${relativePath} 必须复用统一序号候选构造器`,
  );
}

function validateNodeEditor(content) {
  requireMatch(content, /canvas-reference-numbered-mentions-v1/, '节点编辑器缺少受保护合同标记');
  requireMatch(content, /<span>\{\{ candidate\.label \}\}<\/span>/, '下拉项必须显示图片序号');
  requireMatch(content, /candidate\?\.mentionToken/, '下拉选择必须读取带序号的 mention token');
  if (/@\$\{candidate\??\.title\}/.test(content)) {
    throw contractError('禁止退回 @原始标题，必须使用 @图片N');
  }
  requireMatch(content, /\$\{mentionToken\}\s/, '提示词必须插入带序号的 mention token');
}

function auditCanvasReferenceSequenceContract({ releaseRoot } = {}) {
  const root = path.resolve(String(releaseRoot || path.resolve(__dirname, '..', '..')));
  const sources = Object.fromEntries(PROTECTED_FILES.map((relativePath) => (
    [relativePath, readProtectedFile(root, relativePath)]
  )));

  validateCandidateBuilder(sources[PROTECTED_FILES[0]]);
  validateCanvasEntry(sources[PROTECTED_FILES[1]], PROTECTED_FILES[1]);
  validateCanvasEntry(sources[PROTECTED_FILES[2]], PROTECTED_FILES[2]);
  validateNodeEditor(sources[PROTECTED_FILES[3]]);

  return {
    ready: true,
    contract: CONTRACT,
    protectedFiles: [...PROTECTED_FILES],
  };
}

function runCli(argv) {
  try {
    if (argv.length > 1) throw contractError('usage: verify-canvas-reference-sequence-contract.js [RELEASE_ROOT]');
    const report = auditCanvasReferenceSequenceContract({ releaseRoot: argv[0] });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ready: false,
      contract: CONTRACT,
      error: error.code || 'PROTECTED_REFERENCE_SEQUENCE_CONTRACT_FAILED',
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli(process.argv.slice(2));

module.exports = {
  CONTRACT,
  PROTECTED_FILES,
  auditCanvasReferenceSequenceContract,
  runCli,
};
