# 图片模型精准路由、结果解析与管理员中转关联实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让画布图片节点把用户选择的模型精确绑定到已验证配置，补齐 Token6688 的同步图片响应解析，并仅在管理员 AI 配置表展示“模型 → 中转站”关联，同时安全下架失效的 `gpt-image-2-2k`。

**架构：** 公共画布目录只增加不透明的 `config_id`，前端内部保留并提交该字段；后端把它校验后写入 `image_generations.config_id`，计费、异步执行和供应商调用都读取同一配置。OpenAI 兼容图片响应由一个纯解析函数统一处理 URL/Base64，管理员中转展示由独立前端纯函数从现有配置数据派生，不向普通用户 API 增加域名或密钥。

**技术栈：** Node.js 20、Express、better-sqlite3、Node test runner、Vue 3、Element Plus、Vite、Playwright、现有受保护增量发布门禁。

---

## 文件结构

### 新建

- `backend-node/migrations/58_image_generation_config_route.sql`：为图片生成记录增加精确配置身份字段。
- `backend-node/test/imageConfigRouting.test.js`：覆盖配置 ID 校验、持久化、异步执行和禁止同名串路由。
- `backend-node/scripts/deactivate-aihubcc-gpt-image-2-2k.js`：带旧值断言、默认 dry-run 的一次性受控下架脚本。
- `backend-node/test/aihubccImage2kDeactivation.test.js`：验证脚本只修改配置 `#2` 和目标价格行，旧值不符时整笔回滚。
- `frontweb/src/utils/aiConfigRelayAssociation.js`：安全解析管理员“模型 → 中转站”关联文字。
- `frontweb/test/aiConfigRelayAssociation.test.js`：覆盖多模型、非法 URL、query/fragment 与敏感字段边界。
- `deploy/release-scopes/image-model-relay-repair.json`：生产候选允许变更文件白名单。

### 修改

- `backend-node/src/db/migrate.js`：启动兜底确保 `image_generations.config_id` 存在。
- `backend-node/src/services/canvasModelCatalogService.js`：目录条目携带所选配置的 `config_id`，仍不返回中转域名或密钥。
- `backend-node/test/canvasModelCatalogService.test.js`：验证目录内部路由身份和公开字段边界。
- `backend-node/src/services/imageClient.js`：增加精确配置解析；显式配置禁止故障切换；补齐同步结果解析和安全日志摘要。
- `backend-node/test/openAIImageOutput.test.js`：覆盖全部 URL/Base64 格式和无资产未知结果。
- `backend-node/src/services/imageService.js`：创建、预扣、记录和异步运行共用同一 `config_id`。
- `backend-node/src/routes/images.js`：把明确的配置路由错误映射为可读的 4xx/503 响应。
- `backend-node/test/imageBilling.test.js`：确认 HTTP 成功但资产未知时预扣保持 `held`。
- `frontweb/src/utils/canvasModelCapabilities.js`：目录标准化保留 `configId`，提供内部路由条目查找。
- `frontweb/test/canvasFiveGapCore.test.js`：验证目录配置身份被保留且不成为用户标签。
- `frontweb/src/utils/freeCanvasGeneration.js`：图片请求内部携带 `config_id`。
- `frontweb/test/standaloneCanvasFreeNodeGeneration.test.js`：验证配置 ID 只进入图片 payload。
- `frontweb/src/views/DramaCanvas.vue`：按当前图片模型从目录查找配置 ID 并交给请求构建器。
- `frontweb/test/standaloneCanvasFreeNodeRuntime.test.js`：验证目录到请求的配置身份绑定。
- `frontweb/src/components/AIConfigContent.vue`：管理员表格增加“模型 → 中转站”列。
- `frontweb/test/redeem-admin-console.test.js`：确认关联列只位于管理员组件。

### 不修改

- 普通用户 `/image-models` 接口仍只返回模型名称。
- 普通用户画布的模型标签仍只显示模型名/公开显示名。
- `image_generations` 历史记录 `536`、`540`、`541` 及其 180 冻结积分不自动变更。
- `/opt/moli-mama`、AI 音乐进程、Fumin/转绘/视频会话文件不进入发布范围。

---

### 任务 1：建立精确图片配置解析合同

**文件：**
- 创建：`backend-node/migrations/58_image_generation_config_route.sql`
- 修改：`backend-node/src/db/migrate.js:329-360`
- 修改：`backend-node/src/services/imageClient.js:178-230,1739-1805,2437-2465`
- 创建：`backend-node/test/imageConfigRouting.test.js`

- [ ] **步骤 1：编写失败的配置解析测试**

在 `backend-node/test/imageConfigRouting.test.js` 创建内存数据库，显式补充生产已有的验证列，并插入两个包含同名模型的配置：`#4` 为 `storyboard_image + verified + active`，另一个为 `image + verified + active`。测试精确 ID 始终返回 `#4`，且停用、未验证、模型不匹配时抛出不同错误码。

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');

function addVerificationColumn(db) {
  const columns = db.prepare('PRAGMA table_info(ai_service_configs)').all();
  if (!columns.some((column) => column.name === 'verification_status')) {
    db.exec('ALTER TABLE ai_service_configs ADD COLUMN verification_status TEXT');
  }
}

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function addImageConfig(db, overrides = {}) {
  const model = overrides.model || 'gpt-image-2';
  const config = aiConfigService.createConfig(db, log, {
    service_type: overrides.serviceType || 'image',
    provider: 'openai',
    api_protocol: 'openai',
    name: overrides.name || model,
    base_url: overrides.baseUrl || 'https://provider.invalid/v1',
    api_key: 'test-key',
    model: [model],
    default_model: model,
    is_default: Boolean(overrides.isDefault),
  });
  db.prepare('UPDATE ai_service_configs SET is_active = ?, verification_status = ? WHERE id = ?')
    .run(overrides.active === false ? 0 : 1, overrides.verified === false ? 'failed' : 'verified', config.id);
  return config;
}

test('显式 config_id 精确解析 storyboard_image 配置且不按 image 类型改选同名配置', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  addVerificationColumn(db);
  const exact = addImageConfig(db, { serviceType: 'storyboard_image', name: '目标配置' });
  addImageConfig(db, { serviceType: 'image', name: '禁止串入的同名配置', isDefault: true });
  const resolved = imageClient.getImageConfigById(db, exact.id, 'gpt-image-2');
  assert.equal(resolved.id, exact.id);
  assert.equal(resolved.service_type, 'storyboard_image');
  db.close();
});

test('显式 config_id 不存在、停用、未验证或不含请求模型时拒绝且不回退', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  addVerificationColumn(db);
  const inactive = addImageConfig(db, { name: '停用配置', active: false });
  const unverified = addImageConfig(db, { name: '未验证配置', verified: false });
  const mismatch = addImageConfig(db, { name: '模型不匹配配置', model: 'another-image-model' });
  assert.throws(() => imageClient.getImageConfigById(db, 9999, 'gpt-image-2'),
    (error) => error.code === 'IMAGE_CONFIG_NOT_FOUND');
  assert.throws(() => imageClient.getImageConfigById(db, inactive.id, 'gpt-image-2'),
    (error) => error.code === 'IMAGE_CONFIG_INACTIVE');
  assert.throws(() => imageClient.getImageConfigById(db, unverified.id, 'gpt-image-2'),
    (error) => error.code === 'IMAGE_CONFIG_UNVERIFIED');
  assert.throws(() => imageClient.getImageConfigById(db, mismatch.id, 'gpt-image-2'),
    (error) => error.code === 'IMAGE_CONFIG_MODEL_MISMATCH');
  db.close();
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 test/imageConfigRouting.test.js
```

预期：FAIL，`imageClient.getImageConfigById is not a function`。

- [ ] **步骤 3：增加配置 ID 数据列**

`backend-node/migrations/58_image_generation_config_route.sql`：

```sql
ALTER TABLE image_generations ADD COLUMN config_id INTEGER;
```

在 `backend-node/src/db/migrate.js` 的 `image_generations` 兜底列中加入：

```js
{ name: 'config_id', type: 'INTEGER' },
```

- [ ] **步骤 4：实现最小精确解析函数**

在 `backend-node/src/services/imageClient.js` 增加并导出：

```js
function imageConfigError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getImageConfigById(db, configId, preferredModel) {
  const id = Number(configId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw imageConfigError('IMAGE_CONFIG_NOT_FOUND', '指定的图片模型配置不存在');
  }
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row || !['image', 'storyboard_image'].includes(row.service_type)) {
    throw imageConfigError('IMAGE_CONFIG_NOT_FOUND', '指定的图片模型配置不存在');
  }
  if (row.is_active === 0) {
    throw imageConfigError('IMAGE_CONFIG_INACTIVE', '指定的图片模型配置已停用');
  }
  const columns = db.prepare('PRAGMA table_info(ai_service_configs)').all();
  if (columns.some((column) => column.name === 'verification_status')
      && row.verification_status !== 'verified') {
    throw imageConfigError('IMAGE_CONFIG_UNVERIFIED', '指定的图片模型尚未通过真实生成验证');
  }
  const config = aiConfigService.getConfig(db, id);
  const wanted = String(preferredModel || '').trim().toLowerCase();
  const models = Array.isArray(config.model) ? config.model : [];
  if (wanted && !models.some((model) => String(model).trim().toLowerCase() === wanted)) {
    throw imageConfigError('IMAGE_CONFIG_MODEL_MISMATCH', '所选模型不属于指定的图片配置');
  }
  return config;
}
```

在 `callImageApi` 中：显式 `opts.config_id` 时仅使用 `getImageConfigById` 返回的配置，`candidates` 只含该配置，`nextConfig` 必须为 `null`；旧请求没有 `config_id` 时保留现有候选/故障切换逻辑。

- [ ] **步骤 5：运行配置解析测试确认通过**

运行同步骤 2。

预期：PASS，全部精确解析用例通过。

- [ ] **步骤 6：提交独立合同变更**

```powershell
git add backend-node/migrations/58_image_generation_config_route.sql backend-node/src/db/migrate.js backend-node/src/services/imageClient.js backend-node/test/imageConfigRouting.test.js
git commit -m "fix(图片): 建立精确模型配置路由"
```

---

### 任务 2：让计费、记录和异步执行共用配置 ID

**文件：**
- 修改：`backend-node/src/services/imageService.js:700-816,836-976,1658-1673`
- 修改：`backend-node/src/routes/images.js:22-44`
- 修改：`backend-node/test/imageConfigRouting.test.js`

- [ ] **步骤 1：编写失败的图片任务持久化测试**

新增测试：以 `config_id=4` 创建不带 `storyboard_id` 的图片任务，确认 `image_generations.config_id=4`、`image_generations.model='gpt-image-2'`、`async_tasks.model='gpt-image-2'`；捕获 `schedule` 回调并执行后，模拟供应商必须只收到配置 `#4` 的请求。

```js
test('图片任务从预扣到异步执行始终使用请求 config_id', async () => {
  let scheduled;
  const created = imageService.create(db, log, {
    drama_id: 7,
    prompt: '测试精确路由',
    model: 'gpt-image-2',
    config_id: 4,
  }, {
    billingEnabled: true,
    userId: 'user-1',
    schedule(callback) { scheduled = callback; },
  });
  const row = db.prepare('SELECT config_id, model FROM image_generations WHERE id = ?').get(created.id);
  assert.deepEqual(row, { config_id: 4, model: 'gpt-image-2' });
  assert.equal(typeof scheduled, 'function');
});
```

再加三条拒绝用例：`config_id` 不存在、已停用、未验证/模型不匹配时，图片记录、异步任务、积分预扣数均为 0。

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd backend-node
node --test --test-concurrency=1 test/imageConfigRouting.test.js
```

预期：FAIL，创建记录没有 `config_id` 或任务仍走同名 `image` 配置。

- [ ] **步骤 3：在创建事务前解析一次明确配置**

在 `imageService.create` 中生成以下稳定变量；显式 ID 不得进入默认解析：

```js
const imageServiceType = req.storyboard_id ? 'storyboard_image' : 'image';
const selectedConfig = req.config_id != null
  ? imageClient.getImageConfigById(db, req.config_id, req.model)
  : imageClient.getDefaultImageConfig(db, req.model, req.provider, imageServiceType);
const selectedConfigId = selectedConfig?.id ?? null;
generationModel = req.model
  || selectedConfig?.default_model
  || (Array.isArray(selectedConfig?.model) ? selectedConfig.model[0] : selectedConfig?.model);
```

计费价格只根据 `generationModel` 计算；`provider` 写入所选配置的 provider；INSERT 增加 `config_id` 参数。

- [ ] **步骤 4：异步处理按记录中的配置 ID 再校验**

在 `processImageGeneration` 中：

```js
const config = row.config_id != null
  ? imageClient.getImageConfigById(db, row.config_id, row.model)
  : imageClient.getDefaultImageConfig(db, row.model, null, imageServiceType);
```

调用供应商时同时传递：

```js
config_id: row.config_id || undefined,
```

这样配置在排队期间被停用/撤销验证时会明确失败，不会串到同名供应商。

- [ ] **步骤 5：为路由错误返回明确 HTTP 状态**

在 `backend-node/src/routes/images.js` 的 create catch 中加入：

```js
if (['IMAGE_CONFIG_NOT_FOUND', 'IMAGE_CONFIG_MODEL_MISMATCH'].includes(err.code)) {
  return response.badRequest(res, err.message);
}
if (['IMAGE_CONFIG_INACTIVE', 'IMAGE_CONFIG_UNVERIFIED'].includes(err.code)) {
  return response.error(res, 503, err.code, err.message);
}
```

- [ ] **步骤 6：运行针对性后端测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/imageConfigRouting.test.js test/imageBilling.test.js
```

预期：PASS；显式配置用例无备用供应商请求。

- [ ] **步骤 7：提交任务链变更**

```powershell
git add backend-node/src/services/imageService.js backend-node/src/routes/images.js backend-node/test/imageConfigRouting.test.js
git commit -m "fix(图片): 贯通任务配置身份"
```

---

### 任务 3：从公共目录把不透明配置身份传到图片请求

**文件：**
- 修改：`backend-node/src/services/canvasModelCatalogService.js:55-95`
- 修改：`backend-node/test/canvasModelCatalogService.test.js`
- 修改：`frontweb/src/utils/canvasModelCapabilities.js:8-27`
- 修改：`frontweb/test/canvasFiveGapCore.test.js`
- 修改：`frontweb/src/utils/freeCanvasGeneration.js:502-545`
- 修改：`frontweb/test/standaloneCanvasFreeNodeGeneration.test.js:253-283`
- 修改：`frontweb/src/views/DramaCanvas.vue:975-995,3023-3032`
- 修改：`frontweb/test/standaloneCanvasFreeNodeRuntime.test.js:140-153`

- [ ] **步骤 1：先写后端目录失败测试**

在目录测试中插入一个 `storyboard_image` 配置，价格启用，并断言条目只增加不透明 ID，不暴露供应商信息：

```js
const item = catalog.list(db).find((row) => row.model === 'gpt-image-2');
assert.equal(item.config_id, config.id);
assert.equal(item.provider, undefined);
assert.equal(item.base_url, undefined);
assert.equal(item.api_key, undefined);
```

如果表存在 `verification_status`，测试配置必须显式标记为 `verified`。

- [ ] **步骤 2：运行后端目录测试确认失败**

```powershell
cd backend-node
node --test --test-concurrency=1 test/canvasModelCatalogService.test.js
```

预期：FAIL，`item.config_id` 为 `undefined`。

- [ ] **步骤 3：目录条目绑定实际入选配置**

在 `canvasModelCatalogService.list` 生成条目时加入：

```js
config_id: config.id,
```

若生产表存在 `verification_status`，目录只接受 `verified`；没有该列的旧环境保持兼容。仍不得返回 `provider`、`base_url`、`api_key`、配置名称。

- [ ] **步骤 4：写前端目录与 payload 失败测试**

在 `frontweb/test/canvasFiveGapCore.test.js`：

```js
const normalized = normalizeCanvasModelCatalog([
  { kind: 'image', model: 'gpt-image-2', label: 'GPT Image 2', config_id: 4 },
]);
assert.equal(normalized[0].configId, 4);
assert.equal(normalized[0].label, 'GPT Image 2');
```

在 `frontweb/test/standaloneCanvasFreeNodeGeneration.test.js` 的图片 payload 期望中加入 `config_id: 4`，调用 options 传 `{ configId: 4 }`；文本、视频、音频 payload 断言不含 `config_id`。

- [ ] **步骤 5：运行前端测试确认失败**

```powershell
cd frontweb
node --test test/canvasFiveGapCore.test.js test/standaloneCanvasFreeNodeGeneration.test.js
```

预期：FAIL，标准化丢失 `config_id`，图片 payload 不携带配置 ID。

- [ ] **步骤 6：实现内部目录路由查找**

在 `canvasModelCapabilities.js` 标准化字段并导出查找函数：

```js
configId: Number.isSafeInteger(Number(item.config_id ?? item.configId))
  ? Number(item.config_id ?? item.configId)
  : null,
```

```js
export function canvasModelRoute(catalog, kind, model) {
  return normalizeCanvasModelCatalog(catalog)
    .find((item) => item.kind === kind && item.model === model) || null;
}
```

在 `buildFreeCanvasGenerationRequest` 的图片分支加入：

```js
config_id: positiveInteger(options.configId),
```

- [ ] **步骤 7：让 DramaCanvas 只在内部使用 configId**

运行图片节点前查找目录路由：

```js
const modelRoute = canvasModelRoute(freeCanvasModelCatalog.value, kind, node.data?.model);
requestPayload = buildFreeCanvasGenerationRequest(node.data, {
  dramaId: dramaId.value,
  configId: kind === 'image' ? modelRoute?.configId : undefined,
  upstreamUrls,
  upstreamReferences,
  upstreamTexts,
  maxReferences: capability.maxReferences,
});
```

用户可见的 `getFreeNodeModelOptions` 仍返回模型名数组，不显示 `configId`。

- [ ] **步骤 8：运行目录到请求的针对性测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/canvasModelCatalogService.test.js
cd ../frontweb
node --test test/canvasFiveGapCore.test.js test/standaloneCanvasFreeNodeGeneration.test.js test/standaloneCanvasFreeNodeRuntime.test.js
```

预期：PASS；普通标签断言仍只有公开模型名。

- [ ] **步骤 9：提交公共目录内部路由变更**

```powershell
git add backend-node/src/services/canvasModelCatalogService.js backend-node/test/canvasModelCatalogService.test.js frontweb/src/utils/canvasModelCapabilities.js frontweb/test/canvasFiveGapCore.test.js frontweb/src/utils/freeCanvasGeneration.js frontweb/test/standaloneCanvasFreeNodeGeneration.test.js frontweb/src/views/DramaCanvas.vue frontweb/test/standaloneCanvasFreeNodeRuntime.test.js
git commit -m "fix(画布): 传递图片目录配置身份"
```

---

### 任务 4：补齐 Token6688/OpenAI 兼容图片结果与未知语义

**文件：**
- 修改：`backend-node/src/services/imageClient.js:418-450,2000-2035,2437-2465`
- 修改：`backend-node/test/openAIImageOutput.test.js`
- 修改：`backend-node/test/imageBilling.test.js`

- [ ] **步骤 1：编写失败的纯解析测试**

把响应提取做成纯函数 `extractOpenAIImageResult(data, outputFormat)`，覆盖以下输入：

```js
assert.equal(extractOpenAIImageResult({ data: [{ url: 'https://cdn/a.png' }] }).image_url, 'https://cdn/a.png');
assert.equal(extractOpenAIImageResult({ data: [{ image_url: 'https://cdn/b.png' }] }).image_url, 'https://cdn/b.png');
assert.match(extractOpenAIImageResult({ data: [{ b64_json: 'QUJD' }] }, 'jpeg').image_url, /^data:image\/jpeg;base64,QUJD$/);
assert.equal(extractOpenAIImageResult({ image_url: 'https://cdn/c.png' }).image_url, 'https://cdn/c.png');
assert.equal(extractOpenAIImageResult({ result: { url: 'https://cdn/d.png' } }).image_url, 'https://cdn/d.png');
assert.equal(extractOpenAIImageResult({ images: ['QUJD'] }).image_url, 'data:image/png;base64,QUJD');
assert.equal(extractOpenAIImageResult({ images: ['data:image/webp;base64,QUJD'] }).image_url, 'data:image/webp;base64,QUJD');
```

另测 `summarizeImageResponse` 只返回 `response_bytes`、`response_keys`、`first_item_keys`、上游 ID，不包含 `b64_json` 值、API Key、签名 URL。

- [ ] **步骤 2：运行结果解析测试确认失败**

```powershell
cd backend-node
node --test --test-concurrency=1 test/openAIImageOutput.test.js
```

预期：FAIL，两个新函数尚未导出。

- [ ] **步骤 3：实现有序结果提取**

在 `imageClient.js` 增加：

```js
function extractOpenAIImageResult(data, outputFormat) {
  const item = Array.isArray(data?.data) ? data.data[0] : null;
  let imageUrl = item?.url || item?.image_url || '';
  if (!imageUrl && item?.b64_json) {
    imageUrl = `data:${imageMimeFromOutputFormat(outputFormat)};base64,${String(item.b64_json).replace(/\s/g, '')}`;
  }
  if (!imageUrl) imageUrl = data?.image_url || data?.result?.url || '';
  if (!imageUrl && typeof data?.images?.[0] === 'string') {
    const first = data.images[0];
    imageUrl = first.startsWith('data:') ? first : `data:image/png;base64,${first.replace(/\s/g, '')}`;
  }
  return imageUrl ? { image_url: imageUrl } : null;
}
```

解析顺序必须与规格一致；已有 URL、`data[0].b64_json` 和顶层 `images[0]` 行为不能回归。

- [ ] **步骤 4：实现安全摘要与未知结果**

`summarizeImageResponse(data, raw, httpStatus, imageGenId, model)` 只构造允许字段。HTTP 2xx 但 `extractOpenAIImageResult` 返回空时：

```js
log.warn('Image API no readable asset in successful response', summary);
return {
  indeterminate: true,
  error: '图片供应商已返回成功响应，但未提供可读取资产（结果未知）。请核对供应商记录，不要连续重试。',
};
```

不得记录 `raw`、Base64、完整 URL、Authorization 或 API Key。

- [ ] **步骤 5：增加冻结计费回归测试**

在 `backend-node/test/imageBilling.test.js` 用上述错误调用 `settleImageCredit`，断言 reservation 保持 `held`；明确 4xx/5xx 错误仍走现有退款规则。

- [ ] **步骤 6：运行解析与计费测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/openAIImageOutput.test.js test/imageBilling.test.js test/imageTools.test.js
```

预期：PASS；`imageTools` 既有 URL/Base64 兼容测试不回归。

- [ ] **步骤 7：提交适配器修复**

```powershell
git add backend-node/src/services/imageClient.js backend-node/test/openAIImageOutput.test.js backend-node/test/imageBilling.test.js
git commit -m "fix(图片): 补齐同步结果解析"
```

---

### 任务 5：仅在管理员端展示模型中转关联

**文件：**
- 创建：`frontweb/src/utils/aiConfigRelayAssociation.js`
- 创建：`frontweb/test/aiConfigRelayAssociation.test.js`
- 修改：`frontweb/src/components/AIConfigContent.vue:67-127`
- 修改：`frontweb/test/redeem-admin-console.test.js`

- [ ] **步骤 1：编写失败的安全展示测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiConfigRelayAssociations } from '../src/utils/aiConfigRelayAssociation.js';

test('管理员逐模型显示配置名、中转域名和配置 ID', () => {
  assert.deepEqual(buildAiConfigRelayAssociations({
    id: 11,
    name: 'Token6688 图片',
    base_url: 'https://qd.token6688.com/v1?token=hidden#frag',
    model: ['token6688-gpt-image-2', 'token6688-gpt-image-2-4k'],
    api_key: 'never-render',
  }), [
    { model: 'token6688-gpt-image-2', detail: 'Token6688 图片 · qd.token6688.com · #11' },
    { model: 'token6688-gpt-image-2-4k', detail: 'Token6688 图片 · qd.token6688.com · #11' },
  ]);
});

test('非法 Base URL 显示未识别域名且不抛异常', () => {
  assert.equal(buildAiConfigRelayAssociations({ id: 4, name: '图片', base_url: 'not a url', model: ['gpt-image-2'] })[0].detail,
    '图片 · 未识别域名 · #4');
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd frontweb
node --test test/aiConfigRelayAssociation.test.js
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现无副作用派生函数**

```js
function relayHostname(baseUrl) {
  try {
    const url = new URL(String(baseUrl || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && url.hostname
      ? url.hostname
      : '未识别域名';
  } catch {
    return '未识别域名';
  }
}

export function buildAiConfigRelayAssociations(row = {}) {
  const models = Array.isArray(row.model) ? row.model : [];
  const detail = `${String(row.name || '未命名配置')} · ${relayHostname(row.base_url)} · #${row.id}`;
  return models.map((model) => ({ model: String(model), detail }));
}
```

函数不接受或输出 `api_key`，URL 只取 `hostname`。

- [ ] **步骤 4：在管理员表格添加 A 方案列**

在 `AIConfigContent.vue` import 该函数，并在 Base URL/默认模型附近增加：

```vue
<el-table-column label="模型 → 中转站" min-width="320">
  <template #default="{ row }">
    <div class="relay-association-list">
      <div
        v-for="item in buildAiConfigRelayAssociations(row)"
        :key="`${row.id}:${item.model}`"
        class="relay-association-item"
      >
        <code>{{ item.model }}</code>
        <span>→ {{ item.detail }}</span>
      </div>
      <span v-if="!buildAiConfigRelayAssociations(row).length" class="no-default">—</span>
    </div>
  </template>
</el-table-column>
```

只修改管理员组件；`DramaCanvas.vue`、`HomeCanvasNode.vue` 的模板不得渲染 `provider`、域名或 `#configId`。

- [ ] **步骤 5：增加管理员权限边界静态测试**

在 `redeem-admin-console.test.js` 读取组件/路由源码，断言：

```js
assert.match(aiConfigSource, /模型 → 中转站/);
assert.match(routerSource, /path: '\/ai-config'[\s\S]*roles: \['admin'\]/);
assert.doesNotMatch(dramaCanvasSource, /模型 → 中转站/);
```

- [ ] **步骤 6：运行管理员展示测试**

```powershell
cd frontweb
node --test test/aiConfigRelayAssociation.test.js test/redeem-admin-console.test.js
```

预期：PASS；query、fragment、Key 不出现在输出中。

- [ ] **步骤 7：提交管理员展示变更**

```powershell
git add frontweb/src/utils/aiConfigRelayAssociation.js frontweb/test/aiConfigRelayAssociation.test.js frontweb/src/components/AIConfigContent.vue frontweb/test/redeem-admin-console.test.js
git commit -m "feat(管理): 展示模型中转关联"
```

---

### 任务 6：受控下架失效的 AIHubCC 2K 配置

**文件：**
- 创建：`backend-node/scripts/deactivate-aihubcc-gpt-image-2-2k.js`
- 创建：`backend-node/test/aihubccImage2kDeactivation.test.js`

- [ ] **步骤 1：编写失败的事务范围测试**

测试数据库必须包含：目标配置 `#2`、同中转站其他配置 `#4`、Token6688 `#11`、目标价格和其他价格。执行后断言只有两行变化：

```js
assert.deepEqual(db.prepare('SELECT is_active, is_default, verification_status FROM ai_service_configs WHERE id = 2').get(), {
  is_active: 0,
  is_default: 0,
  verification_status: 'failed',
});
assert.equal(db.prepare('SELECT is_active FROM ai_service_configs WHERE id = 4').get().is_active, 1);
assert.equal(db.prepare('SELECT status FROM model_credit_prices WHERE model = ?').get('gpt-image-2-2k').status, 'disabled');
assert.equal(db.prepare('SELECT status FROM model_credit_prices WHERE model = ?').get('gpt-image-2').status, 'enabled');
```

再修改任一旧值后执行，断言抛出 `DEACTIVATION_PRECONDITION_FAILED` 且两张表均未改变。

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd backend-node
node --test --test-concurrency=1 test/aihubccImage2kDeactivation.test.js
```

预期：FAIL，脚本模块不存在。

- [ ] **步骤 3：实现默认 dry-run 的精确脚本**

脚本导出 `deactivateAihubccGptImage2k(db, now)`，在一个 better-sqlite3 transaction 内：

1. 读取 `id=2`，断言类型、模型、域名、active/default/verified 均与已核对旧值一致。
2. 读取 `gpt-image-2-2k` 价格，断言 `status='enabled'`。
3. 条件 UPDATE 配置和价格；两次 `changes` 必须都是 1。
4. 任一断言/行数失败抛出，事务自动回滚。

核心实现保持为一次原子事务：

```js
function deactivationError(message, details = {}) {
  const error = new Error(message);
  error.code = 'DEACTIVATION_PRECONDITION_FAILED';
  error.details = details;
  return error;
}

function parseModels(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String);
  } catch {
    return [String(value || '')];
  }
}

function inspectAihubccGptImage2k(db) {
  const config = db.prepare('SELECT * FROM ai_service_configs WHERE id = 2 AND deleted_at IS NULL').get();
  const price = db.prepare('SELECT model, status FROM model_credit_prices WHERE model = ? COLLATE NOCASE')
    .get('gpt-image-2-2k');
  let hostname = '';
  try { hostname = new URL(config?.base_url || '').hostname; } catch {}
  const ready = Boolean(config)
    && config.service_type === 'image'
    && hostname === 'aihubcc.cc'
    && parseModels(config.model).includes('gpt-image-2-2k')
    && config.is_active === 1
    && config.is_default === 1
    && config.verification_status === 'verified'
    && price?.status === 'enabled';
  if (!ready) throw deactivationError('目标配置或价格旧值不符合下架前置条件', {
    config_id: config?.id || null,
    price_model: price?.model || null,
  });
  return { config_id: config.id, model: price.model, hostname };
}

function deactivateAihubccGptImage2k(db, now = new Date().toISOString()) {
  return db.transaction(() => {
    const target = inspectAihubccGptImage2k(db);
    const configUpdate = db.prepare(`UPDATE ai_service_configs
      SET is_active = 0, is_default = 0, verification_status = 'failed', updated_at = ?
      WHERE id = 2 AND is_active = 1 AND is_default = 1 AND verification_status = 'verified'`)
      .run(now);
    const priceUpdate = db.prepare(`UPDATE model_credit_prices
      SET status = 'disabled', updated_at = ?
      WHERE model = ? COLLATE NOCASE AND status = 'enabled'`)
      .run(now, 'gpt-image-2-2k');
    if (configUpdate.changes !== 1 || priceUpdate.changes !== 1) {
      throw deactivationError('目标行数发生漂移，已回滚', {
        config_changes: configUpdate.changes,
        price_changes: priceUpdate.changes,
      });
    }
    return { ...target, config_changes: 1, price_changes: 1 };
  })();
}
```

CLI 规则：

```powershell
node scripts/deactivate-aihubcc-gpt-image-2-2k.js --database /opt/moli-drama/shared/data/drama_generator.db
```

只输出 JSON dry-run 检查结果；只有追加 `--apply` 才写入。脚本不得处理历史 `536/540/541`、积分台账或其他配置。

- [ ] **步骤 4：运行脚本范围测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/aihubccImage2kDeactivation.test.js
```

预期：PASS；旧值漂移用例证明整笔回滚。

- [ ] **步骤 5：提交受控数据变更工具**

```powershell
git add backend-node/scripts/deactivate-aihubcc-gpt-image-2-2k.js backend-node/test/aihubccImage2kDeactivation.test.js
git commit -m "fix(图片): 安全下架失效2K模型"
```

---

### 任务 7：建立增量发布白名单并完成全量回归

**文件：**
- 创建：`deploy/release-scopes/image-model-relay-repair.json`
- 修改：仅当审计器测试要求时修改对应测试，不扩大生产文件范围。

- [ ] **步骤 1：创建精确生产白名单**

`deploy/release-scopes/image-model-relay-repair.json`：

```json
{
  "schemaVersion": 1,
  "release": "image-model-relay-repair",
  "allowedPaths": [
    "backend-node/migrations/58_image_generation_config_route.sql",
    "backend-node/scripts/deactivate-aihubcc-gpt-image-2-2k.js",
    "backend-node/src/db/migrate.js",
    "backend-node/src/routes/images.js",
    "backend-node/src/services/canvasModelCatalogService.js",
    "backend-node/src/services/imageClient.js",
    "backend-node/src/services/imageService.js",
    "deploy/release-scopes/image-model-relay-repair.json",
    "frontweb/src/components/AIConfigContent.vue",
    "frontweb/src/utils/aiConfigRelayAssociation.js",
    "frontweb/src/utils/canvasModelCapabilities.js",
    "frontweb/src/utils/freeCanvasGeneration.js",
    "frontweb/src/views/DramaCanvas.vue"
  ]
}
```

候选中任何白名单外差异必须中止发布；测试和文档不复制进生产候选。

- [ ] **步骤 2：运行所有针对性测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/imageConfigRouting.test.js test/canvasModelCatalogService.test.js test/openAIImageOutput.test.js test/imageBilling.test.js test/imageTools.test.js test/aihubccImage2kDeactivation.test.js
cd ../frontweb
node --test test/canvasFiveGapCore.test.js test/standaloneCanvasFreeNodeGeneration.test.js test/standaloneCanvasFreeNodeRuntime.test.js test/aiConfigRelayAssociation.test.js test/redeem-admin-console.test.js
```

预期：全部 PASS。

- [ ] **步骤 3：运行后端全量测试与发布审计**

```powershell
cd backend-node
npm test
npm run audit:image-node-release
npm run audit:canvas-reference-sequence
```

预期：全量 PASS；输出包含 `image_node_release_audit=passed` 和参考图合同通过。

- [ ] **步骤 4：运行前端全量 Node 测试和生产构建**

```powershell
cd frontweb
node --test test/*.test.js
npm run build
```

预期：全部测试 PASS；Vite 生产构建成功。

- [ ] **步骤 5：运行浏览器集成回归**

使用测试数据库启动后端和前端，再运行：

```powershell
cd frontweb
npx playwright test e2e/project-canvas-backend-integration.spec.js e2e/image-node-toolbar-backend-integration.spec.js
```

验收点：目录选择 `gpt-image-2` 后请求含正确 `config_id`；普通用户页面不显示域名/配置 ID；管理员页面展示关联列；参考图缩略图和积分卡片合同不回归。

- [ ] **步骤 6：检查敏感信息与改动范围**

```powershell
git diff origin/main...HEAD --check
git diff origin/main...HEAD --name-only
rg -n "sk-[A-Za-z0-9_-]{20,}|Authorization: Bearer [A-Za-z0-9]" backend-node/src backend-node/scripts frontweb/src deploy
```

预期：diff check 无输出；生产文件均在白名单；源码没有硬编码密钥。

- [ ] **步骤 7：提交发布白名单**

```powershell
git add deploy/release-scopes/image-model-relay-repair.json
git commit -m "chore(发布): 限定图片模型修复范围"
```

---

### 任务 8：PR、CI、合入与受保护线上发布

**文件：**
- 不再修改业务代码；只产生 Git/PR/CI 与服务器审计证据。

- [ ] **步骤 1：最终审查分支**

```powershell
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

预期：工作树干净；提交只属于本任务；不含其他工作树的 Fumin/转绘/视频改动。

- [ ] **步骤 2：推送分支并创建 PR**

```powershell
git push -u origin codex/image-model-relay-repair-20260814
gh pr create --base main --head codex/image-model-relay-repair-20260814 --title "fix: 修复图片模型精准路由与中转关联" --body-file docs/superpowers/specs/2026-08-14-image-model-relay-repair-design.md
```

预期：PR 创建成功；不得把任何 Key、线上数据库内容或签名 URL 写入 PR。

- [ ] **步骤 3：等待 CI 与审查并合入 main**

```powershell
gh pr checks --watch
gh pr view --json mergeStateStatus,statusCheckRollup,reviewDecision
```

只有检查全绿且可合入时才合并。若 main 已变化，先更新分支并重新跑针对性/全量门禁。

- [ ] **步骤 4：重新读取生产实时状态**

通过 SSH 只读检查：

- `/opt/moli-drama/current` 实际路径与 HEAD。
- 共享 `deploy.lock` 是否空闲。
- Moli 服务、活动图片/视频任务、队列和健康接口。
- `/opt/moli-mama` AI 音乐 PID/端口基线。
- 共享数据库配置 `#2/#4/#11`、目标价格和冻结记录 `536/540/541` 当前值。

任一状态与计划证据漂移时停止，不制作旧基线候选。

- [ ] **步骤 5：从届时实时 current 制作候选**

候选必须克隆实时 release，只从合入后的 main 提取 `image-model-relay-repair.json` 白名单中的生产文件。先后运行增量范围审计：

```bash
node backend-node/scripts/verify-incremental-release-scope.js \
  --parent "$EXPECTED_CURRENT" \
  --candidate "$CANDIDATE" \
  --manifest "$CANDIDATE/deploy/release-scopes/image-model-relay-repair.json" \
  --expected-current "$EXPECTED_CURRENT" \
  --current-link /opt/moli-drama/current
```

预期：`ready=true`，`changedPaths` 全在白名单。

- [ ] **步骤 6：备份并 dry-run 数据变更**

在共享部署锁内：

1. 使用现有备份脚本备份 SQLite。
2. 执行 `PRAGMA integrity_check` 并验证备份可读。
3. 不带 `--apply` 运行下架脚本，确认只命中配置 `#2` 与价格 `gpt-image-2-2k`。
4. 再带 `--apply` 执行；脚本必须报告两行各修改 1 条。

不修改冻结积分记录 `536/540/541`。

- [ ] **步骤 7：只用共享受保护激活器切换**

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh "$CANDIDATE" "$EXPECTED_CURRENT"
```

禁止直接替换 `current`、禁止覆盖共享门禁、禁止触碰 `/opt/moli-mama`。

- [ ] **步骤 8：线上同一轮验收**

按顺序验证：

1. 健康接口、登录、画布与管理员页面正常。
2. 普通目录不再出现 `gpt-image-2-2k`。
3. 普通用户画布不显示中转站、域名或配置 ID。
4. 管理员 AI 配置表逐模型显示配置名、hostname、配置 ID。
5. `gpt-image-2` 请求记录写入 `config_id=4`，不再报“未配置图片模型”。
6. Token6688 使用已授权的一次真实生成时，URL/Base64 结果能落盘并可打开；若仍无资产，状态为结果未知且积分保持 held，不自动重试。
7. `canvas-credit-callout-v1`、参考图缩略图、下载/资产打开链路正常。
8. Moli 日志无新异常，AI 音乐 PID/端口与发布前一致。

没有单次付费生成授权时，第 6 项只执行非付费浏览器/接口合同验证，并把真实供应商验收明确标为待授权，不声称完成。

- [ ] **步骤 9：记录发布证据**

记录 PR、合入 SHA、候选路径、旧/新 current、manifest SHA256、备份路径、门禁输出、线上健康与 AI 音乐 PID；不记录 Key、完整供应商响应或签名 URL。

---

## 规格覆盖自检

- 精确 `config_id`：任务 1、2、3。
- 计费与异步同路由：任务 2。
- Token6688 URL/Base64 与安全日志：任务 4。
- 成功响应但无资产保持 held：任务 4。
- `gpt-image-2-2k` 精确下架且不波及其他配置：任务 6。
- 管理员专属“模型 → 中转站”：任务 5。
- 普通用户不暴露域名/配置 ID：任务 3、5、7、8。
- 历史 180 冻结积分不自动处理：任务 6、8。
- PR/CI/main、实时 current、增量部署与 AI 音乐隔离：任务 7、8。

## 类型与命名自检

- API/数据库字段统一使用 `config_id`。
- 前端标准化对象统一使用 `configId`。
- 精确解析函数统一命名 `getImageConfigById`。
- 目录内部查找统一命名 `canvasModelRoute`。
- 管理员展示统一使用 `buildAiConfigRelayAssociations`。
- 未引入新的供应商表、公开域名字段或自动重试策略。
