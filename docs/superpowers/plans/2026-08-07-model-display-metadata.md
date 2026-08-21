# 模型展示名称与用户备注统一目录实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让管理员维护的模型展示名称和用户备注统一出现在首页、自由创作、画布与短剧工厂，同时保持原始模型 ID 路由、停用边界和发布安全门禁。

**架构：** `model_credit_prices` 是展示元数据与计费状态的唯一管理来源，新增纯文本 `public_note`。普通首页读取 `/billing/catalog`，画布与短剧工厂读取 `/canvas/model-catalog`；所有选择器显示展示名和备注，但生成请求仍提交原始 `model`。生产预检按公开目录的核心类别可用性判断，不再强制启用历史固定模型。

**技术栈：** Node.js 20、Express、better-sqlite3、Vue 3、Element Plus、Node Test Runner、Playwright、Vite

---

## 文件结构

- 修改 `backend-node/src/services/modelPriceService.js`：迁移、校验、保存并公开 `public_note`。
- 修改 `backend-node/src/services/canvasModelCatalogService.js`：输出统一 `label`/`note`，排除停用或未定价模型。
- 修改 `backend-node/src/services/productionPreflightService.js`：按公开目录核心类别检查发布就绪状态。
- 修改 `backend-node/test/modelPrice.test.js`、`billingPublicCatalog.test.js`、`canvasModelCatalogService.test.js`、`productionPreflight.test.js`：覆盖字段、过滤和预检语义。
- 修改 `frontweb/src/utils/canvasModelCapabilities.js`：标准化并查询模型备注。
- 修改 `frontweb/src/views/BillingAdmin.vue`：管理员备注编辑、保存、搜索和回读。
- 修改 `frontweb/src/views/FilmList.vue`、`FreeCreate.vue`：首页和自由创作展示当前模型备注。
- 修改 `frontweb/src/views/DramaCanvas.vue`、`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`、`CanvasGenerationOptions.vue`：画布模型条目和当前备注。
- 修改 `frontweb/src/views/FilmCreate.vue`：短剧工厂三处选择器使用统一目录对象，同时保留 AI 配置能力和声音策略。
- 修改 `frontweb/e2e/admin-workspace.spec.js`、`home-quick-generation.spec.js`，新增 `frontweb/test/modelDisplayMetadataContract.test.js`：覆盖管理员和三端展示合同。
- 修改 `backend-node/scripts/verify-model-ui-contract.js`、`backend-node/test/modelUiProtectionGate.test.js`：增加展示元数据防回归门禁。
- 更新 `docs/superpowers/specs/2026-08-07-model-display-metadata-design.md` 和本计划：记录完成证据与线上验收结果。

### 任务 1：持久化管理员用户备注

**文件：**
- 修改：`backend-node/test/modelPrice.test.js`
- 修改：`backend-node/src/services/modelPriceService.js`

- [ ] **步骤 1：编写失败的保存与长度校验测试**

在 `backend-node/test/modelPrice.test.js` 增加：

```js
test('管理员展示名称和用户备注会被规范化保存并回读', () => {
  const db = makeDb();
  const saved = prices.set(db, 'video-model', 7, {
    category: 'video',
    display_name: '  极速视频  ',
    public_note: '  支持 480P，适合快速预览。  ',
  });
  assert.equal(saved.display_name, '极速视频');
  assert.equal(saved.public_note, '支持 480P，适合快速预览。');
  assert.equal(prices.list(db).find((row) => row.model === 'video-model').public_note,
    '支持 480P，适合快速预览。');
});

test('用户备注超过 500 字时拒绝保存', () => {
  const db = makeDb();
  assert.throws(
    () => prices.set(db, 'video-model', 7, { category: 'video', public_note: '字'.repeat(501) }),
    (error) => error.code === 'INVALID_MODEL_PRICE',
  );
});
```

- [ ] **步骤 2：运行测试并确认因缺少 `public_note` 失败**

运行：

```powershell
node --test backend-node/test/modelPrice.test.js
```

预期：新增回读断言得到 `undefined`，长度测试未抛错。

- [ ] **步骤 3：实现最小数据库和服务变更**

在 `ensureSchema()` 增加：

```js
ensureColumn(db, 'public_note', "ALTER TABLE model_credit_prices ADD COLUMN public_note TEXT NOT NULL DEFAULT ''");
```

所有价格行查询加入 `public_note`。`set()` 使用：

```js
const publicNote = String(options.public_note ?? options.publicNote ?? existing?.public_note ?? '').trim();
if (publicNote.length > 500) {
  throw priceError('INVALID_MODEL_PRICE', '用户备注不能超过 500 个字符');
}
```

把 `public_note` 加入 `INSERT ... ON CONFLICT DO UPDATE`，同时对 `displayName` 保存前执行 `trim()`。

- [ ] **步骤 4：运行模型价格测试确认通过**

运行：`node --test backend-node/test/modelPrice.test.js`

预期：全部通过，新增字段保留纯文本且长度边界生效。

- [ ] **步骤 5：提交**

```powershell
git add backend-node/src/services/modelPriceService.js backend-node/test/modelPrice.test.js
git commit -m "feat(models): persist public model notes"
```

### 任务 2：统一公开目录并修正生产预检

**文件：**
- 修改：`backend-node/test/billingPublicCatalog.test.js`
- 修改：`backend-node/test/canvasModelCatalogService.test.js`
- 修改：`backend-node/test/productionPreflight.test.js`
- 修改：`backend-node/src/services/canvasModelCatalogService.js`
- 修改：`backend-node/src/services/productionPreflightService.js`

- [ ] **步骤 1：编写失败的公开目录测试**

扩展公开计费目录断言：

```js
modelPrice.set(db, 'gpt-image-2', 12, {
  category: 'image',
  display_name: '图片模型',
  public_note: '适合角色和场景出图。',
});
assert.equal(result.body.data[0].public_note, '适合角色和场景出图。');
```

扩展画布目录测试：

```js
prices.set(db, 'catalog-video', 2, {
  category: 'video',
  display_name: '管理员设置的视频名称',
  public_note: '支持多图参考。',
});
const item = catalog.list(db).find((row) => row.model === 'catalog-video');
assert.equal(item.label, '管理员设置的视频名称');
assert.equal(item.note, '支持多图参考。');
```

再建立一个已验证但价格状态为 `disabled` 的配置，断言 `catalog.list(db)` 不返回它。

- [ ] **步骤 2：编写失败的动态生产预检测试**

把预检测试数据库补齐三个已验证、启用、正价的文本/图片/视频配置。新增：

```js
test('管理员停用历史视频模型但仍有其他公开视频模型时预检通过', () => {
  const db = createDb();
  modelPrices.set(db, 'seedance 2.0', 25, { category: 'video', status: 'disabled' });
  modelPrices.set(db, 'replacement-video', 8, { category: 'video', status: 'enabled' });
  insertVerifiedConfig(db, 'video', 'replacement-video');
  const report = runProductionPreflight({ config: productionConfig(), env: productionEnv(), db });
  assert.equal(report.checks.find((check) => check.id === 'model_prices').status, 'pass');
});

test('最后一个公开视频模型停用时预检阻止发布并列出视频类别', () => {
  const db = createDb();
  disableCategory(db, 'video');
  const report = runProductionPreflight({ config: productionConfig(), env: productionEnv(), db });
  assert.match(report.checks.find((check) => check.id === 'model_prices').detail, /视频/);
});
```

- [ ] **步骤 3：运行三组测试确认正确失败**

运行：

```powershell
node --test backend-node/test/billingPublicCatalog.test.js backend-node/test/canvasModelCatalogService.test.js backend-node/test/productionPreflight.test.js
```

预期：备注映射、停用过滤和动态类别预检断言失败。

- [ ] **步骤 4：实现目录和预检最小变更**

画布目录只为存在启用价格行的模型创建条目，并输出：

```js
const price = prices.get(model.toLowerCase());
if (!price) return null;
return {
  kind: KIND_BY_SERVICE[config.service_type],
  model,
  label: price.display_name || model,
  note: price.public_note || '',
  credits: price.credits,
  // 原有 billing_unit、resolution_prices、capabilities 保持不变
};
```

生产预检改为调用 `modelPriceService.listPublic(db)`，检查 `text`、`image`、`video` 三类均至少一条；错误详情使用中文类别名，不再导入或遍历 `SUPPORTED_MODELS`。

- [ ] **步骤 5：运行三组测试确认通过**

运行同上，预期全部通过。

- [ ] **步骤 6：提交**

```powershell
git add backend-node/src/services/canvasModelCatalogService.js backend-node/src/services/productionPreflightService.js backend-node/test/billingPublicCatalog.test.js backend-node/test/canvasModelCatalogService.test.js backend-node/test/productionPreflight.test.js
git commit -m "feat(models): publish unified model metadata"
```

### 任务 3：管理员后台编辑和回读备注

**文件：**
- 修改：`frontweb/e2e/admin-workspace.spec.js`
- 修改：`frontweb/src/views/BillingAdmin.vue`

- [ ] **步骤 1：编写失败的管理员浏览器测试**

在模型 GET 模拟数据加入 `public_note`，PUT 模拟响应原样返回。测试填写“用户备注”后保存：

```js
await page.getByLabel('用户备注').first().fill('适合高速预览，最高 720P。');
await page.getByRole('button', { name: '保存' }).first().click();
expect(calls.modelUpdates[0].body.public_note).toBe('适合高速预览，最高 720P。');
```

清空搜索并输入备注关键词，断言对应模型仍可见。

- [ ] **步骤 2：运行 E2E 并确认因缺少备注控件失败**

运行：

```powershell
cd frontweb
npx playwright test e2e/admin-workspace.spec.js
```

预期：找不到“用户备注”输入框。

- [ ] **步骤 3：实现管理员 UI 最小变更**

现有模型和新增模型表单都加入：

```vue
<label class="model-field model-note-field">
  <span>用户备注</span>
  <el-input v-model="item.public_note" type="textarea" :rows="2" maxlength="500" show-word-limit />
</label>
```

`saveModel()` 与 `addModel()` 的请求体加入 `public_note`；`normalizePrice()` 和新增模型重置对象保留该字段；搜索匹配 `item.public_note`。

- [ ] **步骤 4：运行管理员 E2E 确认通过**

运行同上，预期测试通过且请求体包含备注。

- [ ] **步骤 5：提交**

```powershell
git add frontweb/src/views/BillingAdmin.vue frontweb/e2e/admin-workspace.spec.js
git commit -m "feat(admin): edit public model notes"
```

### 任务 4：首页与自由创作同步名称和备注

**文件：**
- 修改：`frontweb/e2e/home-quick-generation.spec.js`
- 修改：`frontweb/src/views/FilmList.vue`
- 修改：`frontweb/src/views/FreeCreate.vue`

- [ ] **步骤 1：编写失败的首页展示测试**

给 E2E 目录模型加入：

```js
{ category: 'video', model: 'video-model', display_name: '极速视频', public_note: '支持 480P 与 720P。', credits: 12, billing_unit: 'second' }
```

首页断言：

```js
await expect(page.getByLabel('生成模型')).toHaveValue('video-model');
await expect(page.getByText('支持 480P 与 720P。')).toBeVisible();
```

进入 `/free-create?mode=video` 后再次断言名称和备注可见，提交请求仍为 `video-model`。

- [ ] **步骤 2：运行测试确认备注断言失败**

运行：

```powershell
cd frontweb
npx playwright test e2e/home-quick-generation.spec.js
```

预期：名称已有，备注文本不可见。

- [ ] **步骤 3：实现当前模型备注显示**

`FilmList.vue` 使用已有 `homeSelectedModel`：

```vue
<p v-if="homeSelectedModel?.public_note" class="model-public-note">
  {{ homeSelectedModel.public_note }}
</p>
```

`FreeCreate.vue` 增加 `selectedModel` 计算属性，并在模型选择器下方显示相同纯文本字段。请求逻辑继续使用 `model`。

- [ ] **步骤 4：运行首页 E2E 确认通过**

运行同上，预期通过。

- [ ] **步骤 5：提交**

```powershell
git add frontweb/src/views/FilmList.vue frontweb/src/views/FreeCreate.vue frontweb/e2e/home-quick-generation.spec.js
git commit -m "feat(home): show public model notes"
```

### 任务 5：画布节点同步统一备注

**文件：**
- 修改：`frontweb/test/canvasFiveGapCore.test.js`
- 修改：`frontweb/src/utils/canvasModelCapabilities.js`
- 修改：`frontweb/src/views/DramaCanvas.vue`
- 修改：`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`
- 修改：`frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue`

- [ ] **步骤 1：编写失败的目录标准化测试**

```js
test('canvas model catalog preserves display labels and public notes', () => {
  const catalog = normalizeCanvasModelCatalog([{
    kind: 'video', model: 'raw-video-id', label: '管理员名称', note: '适合多图参考。', credits: 7,
  }]);
  assert.equal(catalog[0].label, '管理员名称');
  assert.equal(catalog[0].note, '适合多图参考。');
  assert.equal(canvasModelEntry(catalog, 'video', 'raw-video-id').model, 'raw-video-id');
});
```

- [ ] **步骤 2：运行测试确认 `note` 丢失**

运行：`node --test frontweb/test/canvasFiveGapCore.test.js`

预期：`catalog[0].note` 为 `undefined`。

- [ ] **步骤 3：实现标准化和选项备注**

`normalizeCanvasModelCatalog()` 加入：

```js
note: String(item.note || item.public_note || '').trim(),
```

`canvasModelOptions()` 返回 `{ value, label, note, disabled? }`。`DramaCanvas.getFreeNodeModelOptionEntries()` 直接复用这些字段。

`HomeCanvasNode.vue` 根据 `draft.model` 找到当前条目并在选择器下方显示 `note`。`CanvasGenerationOptions.vue` 对图片、视频、音频选中项使用同一映射并显示备注。

- [ ] **步骤 4：运行画布单元和源码合同测试**

运行：

```powershell
node --test frontweb/test/canvasFiveGapCore.test.js frontweb/test/standaloneCanvasNodeEditorParity.test.js frontweb/test/standaloneCanvasFreeNodeRuntime.test.js
```

预期：全部通过。

- [ ] **步骤 5：提交**

```powershell
git add frontweb/src/utils/canvasModelCapabilities.js frontweb/src/views/DramaCanvas.vue frontweb/src/components/dramaCanvas/HomeCanvasNode.vue frontweb/src/components/dramaCanvas/CanvasGenerationOptions.vue frontweb/test/canvasFiveGapCore.test.js
git commit -m "feat(canvas): display unified model metadata"
```

### 任务 6：短剧工厂三处模型选择器统一目录

**文件：**
- 创建：`frontweb/test/modelDisplayMetadataContract.test.js`
- 修改：`frontweb/src/views/FilmCreate.vue`

- [ ] **步骤 1：编写失败的短剧工厂源码合同测试**

```js
test('FilmCreate uses canvas catalog labels and notes while submitting raw model IDs', () => {
  assert.match(source, /request\.get\('\/canvas\/model-catalog'\)/);
  assert.match(source, /videoModelOptions\.value = .*value.*label.*note/s);
  assert.match(source, /selectedVideoModelNote/);
  assert.equal((source.match(/class="sb-video-model-note"/g) || []).length, 3);
  assert.match(source, /model:\s*getStoryboardVideoModel\(sb\)/);
});
```

同一测试文件还检查 `FilmList.vue`、`FreeCreate.vue`、`HomeCanvasNode.vue` 均含对应备注绑定。

- [ ] **步骤 2：运行测试确认短剧工厂仍使用字符串列表**

运行：`node --test frontweb/test/modelDisplayMetadataContract.test.js`

预期：缺少 `/canvas/model-catalog` 和 `selectedVideoModelNote`。

- [ ] **步骤 3：实现短剧工厂目录合并**

保留 `aiAPI.listVideoModels()` 获取供应商配置；并行读取画布目录：

```js
const [rows, catalog] = await Promise.all([
  aiAPI.listVideoModels(),
  request.get('/canvas/model-catalog'),
]);
const byModel = new Map(normalizeCanvasModelCatalog(catalog)
  .filter((item) => item.kind === 'video')
  .map((item) => [item.model, item]));
videoModelOptions.value = models
  .map((value) => ({ value, label: byModel.get(value)?.label || value, note: byModel.get(value)?.note || '' }))
  .filter((item) => byModel.has(item.value));
```

所有模型包含判断改为读取 `item.value`；三个 `<el-option>` 使用 `:label="model.label" :value="model.value"`。增加 `selectedVideoModelNote` 和按分镜模型取得备注的辅助函数，在三处选择器下方渲染纯文本备注。供应商匹配、声音策略、项目设置和生成请求继续使用原始 `value`。

- [ ] **步骤 4：运行短剧工厂相关测试**

运行：

```powershell
node --test frontweb/test/modelDisplayMetadataContract.test.js frontweb/test/filmCreateUsmercariShortDrama.test.js frontweb/test/filmCreateTailFrameLink.test.js frontweb/test/storyboardVoiceExtractionUi.test.js
```

预期：全部通过，四条 USMercari 生成路径未被改写。

- [ ] **步骤 5：提交**

```powershell
git add frontweb/src/views/FilmCreate.vue frontweb/test/modelDisplayMetadataContract.test.js
git commit -m "feat(factory): sync public model metadata"
```

### 任务 7：增加不可绕过的展示元数据门禁

**文件：**
- 修改：`backend-node/scripts/verify-model-ui-contract.js`
- 修改：`backend-node/test/modelUiProtectionGate.test.js`

- [ ] **步骤 1：先写门禁变异测试**

把 `FilmList.vue`、`FreeCreate.vue`、`FilmCreate.vue` 加入 `protectedFiles`。新增三个测试：删除 `public_note` 服务字段、删除画布 `note` 映射、把短剧工厂 `/canvas/model-catalog` 调用替换掉，均应使 `auditModelUiContract()` 抛错。

```js
assert.throws(() => auditModelUiContract(target), /public_note/);
assert.throws(() => auditModelUiContract(target), /note:/);
assert.throws(() => auditModelUiContract(target), /canvas\/model-catalog/);
```

- [ ] **步骤 2：运行测试确认新门禁尚未实现**

运行：`node --test backend-node/test/modelUiProtectionGate.test.js`

预期：新增变异测试无法触发门禁而失败。

- [ ] **步骤 3：扩展门禁令牌**

要求以下合同：

- `modelPriceService.js` 包含 `public_note`、500 字校验和公开目录过滤；
- `canvasModelCatalogService.js` 包含 `note: price.public_note`；
- `FilmList.vue`、`FreeCreate.vue` 使用 `public_note`；
- `DramaCanvas.vue` 和 `FilmCreate.vue` 调用 `/canvas/model-catalog`；
- `FilmCreate.vue` 仍包含原始模型 ID 的请求构造标记；
- `productionPreflightService.js` 使用 `listPublic` 且不引用 `SUPPORTED_MODELS`。

- [ ] **步骤 4：运行门禁与变异测试确认通过**

运行：

```powershell
node --test backend-node/test/modelUiProtectionGate.test.js
node backend-node/scripts/verify-model-ui-contract.js
```

预期：测试全部通过，CLI 输出 `{"ready":true,"contract":"model-ui-protection-v1"}`。

- [ ] **步骤 5：提交**

```powershell
git add backend-node/scripts/verify-model-ui-contract.js backend-node/test/modelUiProtectionGate.test.js
git commit -m "test(models): guard public display metadata"
```

### 任务 8：全量验证、受保护部署与线上验收

**文件：**
- 更新：`docs/superpowers/specs/2026-08-07-model-display-metadata-design.md`
- 更新：`docs/superpowers/plans/2026-08-07-model-display-metadata.md`

- [ ] **步骤 1：运行完整本地验证**

```powershell
node --test backend-node/test/*.test.js
node --test frontweb/test/*.test.js
node backend-node/scripts/verify-model-ui-contract.js
npm --prefix frontweb run build
git diff --check
git status --short
```

预期：所有命令退出码 0；只保留用户已有的 `.playwright-cli/` 未跟踪目录。

- [ ] **步骤 2：运行受影响浏览器测试**

```powershell
cd frontweb
npx playwright test e2e/admin-workspace.spec.js e2e/home-quick-generation.spec.js
```

预期：管理员保存备注、首页/自由创作显示备注且提交原始模型 ID。

- [ ] **步骤 3：读取实时生产状态并制作候选**

通过 SSH 读取 `/opt/moli-drama/current`、服务 PID、活动任务、磁盘、备份和 AI 音乐 PID。候选必须从实时 current 克隆，仅覆盖本计划修改清单和已提交的 USMercari 502 上传重试文件；不得整体上传本地 worktree。

- [ ] **步骤 4：候选构建与共享门禁**

在候选中安装依赖、运行后端全量测试、前端构建、`model-ui-protection-v1`、`canvas-credit-callout-v1` 和动态生产预检。失败时删除候选并从最新 current 重建，不修改共享门禁。

- [ ] **步骤 5：备份并受保护切换**

确认 CAS 的 `EXPECTED_CURRENT` 未变化、无活动生成任务、备份可验证、磁盘余量满足要求后，只执行：

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
```

- [ ] **步骤 6：线上只读与浏览器验收**

验证：

1. `/api/v1/billing/catalog` 返回管理员展示名和 `public_note`，且不返回已停用 `seedance 2.0`；
2. `/api/v1/canvas/model-catalog` 返回相同 `label`/`note`；
3. 管理后台、首页、自由创作、画布和短剧工厂逐页显示相同名称与备注；
4. 只选择模型和检查前端请求构造，不触发付费生成；
5. 502 HTML 不再直接暴露，媒体上传重试代码存在于线上 release；
6. 服务健康、错误日志、Nginx 5xx、积分数据和 AI 音乐 PID 均无异常。

- [ ] **步骤 7：记录证据并提交文档**

把 release 路径、测试计数、接口回读、页面截图、PID 和日志窗口写入规格与计划；不得记录 API key、令牌或完整供应商响应。

```powershell
git add docs/superpowers/specs/2026-08-07-model-display-metadata-design.md docs/superpowers/plans/2026-08-07-model-display-metadata.md
git commit -m "docs: record model metadata deployment"
```
