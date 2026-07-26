const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('普通创作入口不暴露模型配置，配置路由只允许管理员', () => {
  const router = read('frontweb/src/router/index.js');
  const filmList = read('frontweb/src/views/FilmList.vue');
  const filmCreate = read('frontweb/src/views/FilmCreate.vue');
  const canvasSwitcher = read('frontweb/src/components/CanvasWorkspaceSwitcher.vue');

  assert.match(
    router,
    /name:\s*'ai-config'[\s\S]*?meta:\s*\{[^}]*roles:\s*\['admin'\]/,
  );
  assert.doesNotMatch(filmList, /goAiConfig|AI配置/);
  assert.doesNotMatch(filmCreate, /showAiConfigDialog|AIConfigContent/);
  assert.doesNotMatch(canvasSwitcher, /command="\/ai-config"|AI 配置/);
});

test('画布模型下拉只读取脱敏公开模型目录', () => {
  const component = read('frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue');
  assert.match(component, /listImageModels\(\)/);
  assert.match(component, /listVideoModels\(\)/);
  assert.match(component, /listAudioModels\(\)/);
  assert.doesNotMatch(component, /aiAPI\.list\(/);
});
