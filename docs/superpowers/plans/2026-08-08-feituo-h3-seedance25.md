# 飞拓 MiniMax H3-2K 与 Seedance 2.5 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将飞拓的 `xuan-video-v1-6e7b4763634e6206` 和 `xuan-seedance-2.5` 经真实生成验证后同步到首页、画布、短剧工厂和管理员后台，并一并发布画布图片预览缩放修复。

**架构：** 扩展现有 `feituo_open` 专用客户端的精确模型能力表，在创建任务前和供应商提交前各执行一次验证。公开页面仅消费统一 `/canvas/model-catalog`；真实验证脚本生成脱敏证据，然后由单事务配置脚本启用精确模型和价格。

**技术栈：** Node.js CommonJS，`node:test`，SQLite/`better-sqlite3`，Vue 3，Element Plus，Vite，`ffprobe`，systemd/nginx，受保护 release guard。

---

## 文件结构

- 修改 `backend-node/src/services/feituoVideoClient.js`：两个新上游 ID 的分辨率、时长和引用能力，请求体与提交前门禁。
- 修改 `backend-node/src/services/videoService.js`：创建任务前验证飞拓精确配置、能力和定价。
- 修改 `backend-node/src/services/videoClient.js`：将 `resolution` 传入飞拓客户端，保持创建与恢复路径同一配置。
- 修改 `backend-node/src/services/canvasModelCatalogService.js`：飞拓只公开已真实验证且已定价的精确模型能力。
- 修改 `backend-node/src/services/modelPriceService.js`：飞拓公开计价目录同样验证 `real_generation_verified_models`。
- 修改 `frontweb/src/components/AIConfigContent.vue`：增加飞拓预设 ID、协议、Base URL 和动态时长。
- 修改 `frontweb/src/utils/videoGenerationRequest.js`：短剧工厂依统一能力保留完整引用，禁止按模型名静默截断新飞拓请求。
- 新建 `backend-node/test/feituoVideoModels.test.js`：客户端请求、两层门禁、公开目录与计费合同。
- 修改 `frontweb/test/videoGenerationRequest.test.js`、`frontweb/test/aiConfigProviderPresets.test.js`：短剧请求和管理员预设合同。
- 新建 `backend-node/scripts/verify-feituo-video-models.js`：可恢复、不自动重试的真实生成、成品下载、`ffprobe`、哈希和速度证据脚本。
- 新建 `backend-node/test/verifyFeituoVideoModels.test.js`：验证脚本状态恢复、不确定提交和证据结构。
- 新建 `deploy/apply-feituo-video-model-config.js`：计划/应用/验证/回滚单事务，复用现有飞拓凭证而不输出密钥。
- 新建 `backend-node/test/feituoVideoModelConfigTransaction.test.js`：配置、价格、重入和回滚合同。
- 修改 `docs/tasks/2026-08-08-h3-catalog-image-preview-zoom.md`：记录飞拓实测任务、速度、成品和发布证据。

### 任务 1：飞拓客户端能力与请求体

**文件：**
- 修改：`backend-node/src/services/feituoVideoClient.js`
- 测试：`backend-node/test/feituoVideoModels.test.js`

- [ ] **步骤 1：编写失败的模型参数测试**

```js
test('Seedance 2.5 仅接受 xuan 渠道的 480P/720P', () => {
  assert.equal(buildFeituoVideoBody({
    model: 'xuan-seedance-2.5', prompt: 'test', resolution: '720p', duration: 5,
  }).resolution, '720p')
  assert.throws(() => buildFeituoVideoBody({
    model: 'seedance-2.5', prompt: 'test', resolution: '720p', duration: 5,
  }), /未经真实生成验证/)
  assert.throws(() => buildFeituoVideoBody({
    model: 'xuan-seedance-2.5', prompt: 'test', resolution: '1080p', duration: 5,
  }), /不支持分辨率/)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd backend-node && node --test test/feituoVideoModels.test.js`

预期：FAIL，`xuan-seedance-2.5` 尚未在 `FEITUO_MODELS`。

- [ ] **步骤 3：最小实现新模型能力表**

```js
const FEITUO_MODELS = Object.freeze({
  'xuan-video-v1-6e7b4763634e6206': Object.freeze({
    resolutions: Object.freeze(['2k']),
    durations: Object.freeze(Array.from({ length: 11 }, (_, index) => index + 5)),
    ratios: Object.freeze(['1:1', '16:9', '9:16', '3:4', '4:3', '21:9']),
    maxImages: 9, maxVideos: 0, maxAudio: 3,
  }),
  'xuan-seedance-2.5': Object.freeze({
    resolutions: Object.freeze(['480p', '720p']),
    durations: Object.freeze(Array.from({ length: 12 }, (_, index) => index + 4)),
    ratios: Object.freeze(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
    maxImages: 4, maxVideos: 3, maxAudio: 1,
  }),
})
```

`buildFeituoVideoBody()` 必须校验 `spec.durations` 与 `spec.resolutions`，并把 `resolution` 放入 JSON 请求体。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd backend-node && node --test test/feituoVideoModels.test.js`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/src/services/feituoVideoClient.js backend-node/test/feituoVideoModels.test.js
git commit -m "feat: 扩展飞拓 H3 与 Seedance 2.5 请求"
```

### 任务 2：创建任务前门禁与统一目录

**文件：**
- 修改：`backend-node/src/services/videoService.js`
- 修改：`backend-node/src/services/videoClient.js`
- 修改：`backend-node/src/services/canvasModelCatalogService.js`
- 修改：`backend-node/src/services/modelPriceService.js`
- 测试：`backend-node/test/feituoVideoModels.test.js`

- [ ] **步骤 1：编写未验证/未定价无副作用的失败测试**

```js
assert.throws(() => videoService.create(db, log, request, {
  billingEnabled: true, userId: 'user-1', schedule() { scheduled += 1 },
}), (error) => error.code === 'MODEL_NOT_VERIFIED')
assert.equal(db.prepare('SELECT COUNT(*) count FROM video_generations').get().count, 0)
assert.equal(db.prepare('SELECT COUNT(*) count FROM usage_reservations').get().count, 0)
assert.equal(scheduled, 0)
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd backend-node && node --test test/feituoVideoModels.test.js`

预期：FAIL，当前通用飞拓路径只校验静态模型表。

- [ ] **步骤 3：实现双层门禁**

```js
function verifiedFeituoCapabilities(config, model) {
  const settings = parseSettings(config?.settings)
  const verified = Array.isArray(settings.real_generation_verified_models)
    ? settings.real_generation_verified_models.map((value) => String(value).toLowerCase())
    : []
  const capability = config?.verified_capabilities?.[model]
  return config?.verification_status === 'verified'
    && verified.includes(String(model).toLowerCase())
    && capability && typeof capability === 'object'
    ? capability : null
}
```

`videoService.create()` 在任务/预扣前检查配置、分辨率、时长、引用数和价格；`videoClient` 在 `callFeituoVideoApi()` 前重复同样的终端检查。

- [ ] **步骤 4：验证公开目录只出现已验证模型**

```js
assert.deepEqual(canvasModelCatalogService.list(db)
  .filter((item) => item.provider === 'feituo')
  .map((item) => item.model), ['xuan-video-v1-6e7b4763634e6206', 'xuan-seedance-2.5'])
assert.deepEqual(Object.keys(seedance.resolution_prices), ['480p', '720p'])
assert.deepEqual(h3.capabilities.resolutions, ['2k'])
```

- [ ] **步骤 5：运行后端相关回归**

运行：

```bash
cd backend-node
node --test test/feituoVideoModels.test.js test/videoBilling.test.js test/videoGenerationRequestSnapshot.test.js test/canvasModelCatalogService.test.js test/modelPrice.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add backend-node/src/services/videoService.js backend-node/src/services/videoClient.js backend-node/src/services/canvasModelCatalogService.js backend-node/src/services/modelPriceService.js backend-node/test/feituoVideoModels.test.js
git commit -m "feat: 为飞拓新视频模型增加生成门禁"
```

### 任务 3：管理员预设与短剧请求

**文件：**
- 修改：`frontweb/src/components/AIConfigContent.vue`
- 修改：`frontweb/src/utils/videoGenerationRequest.js`
- 测试：`frontweb/test/aiConfigProviderPresets.test.js`
- 测试：`frontweb/test/videoGenerationRequest.test.js`

- [ ] **步骤 1：编写管理员预设和完整引用失败测试**

```js
assert.match(source, /id:\s*'feituo'[\s\S]*xuan-video-v1-6e7b4763634e6206[\s\S]*xuan-seedance-2\.5/)
assert.match(source, /feituo:\s*'feituo_open'/)
assert.match(source, /p === 'feituo'[\s\S]*https:\/\/feituokuajing\.com/)
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd frontweb && node --test test/aiConfigProviderPresets.test.js test/videoGenerationRequest.test.js`

预期：FAIL，飞拓预设和新模型引用能力尚不存在。

- [ ] **步骤 3：实现最小前端改动**

```js
{ id: 'feituo', name: '飞拓 H3-2K / Seedance 2.5', models: [
  'xuan-video-v1-6e7b4763634e6206', 'xuan-seedance-2.5',
] }
```

增加 `providerProtocolMap.feituo = 'feituo_open'`、默认 Base URL 和分模型时长。短剧构造器仅依 `capability` 限制引用，不为新模型静默截断。

- [ ] **步骤 4：运行前端相关回归**

运行：

```bash
cd frontweb
node --test test/aiConfigProviderPresets.test.js test/videoGenerationRequest.test.js test/homeQuickGeneration.test.js test/toapisVideoCanvasContract.test.js test/toapisShortDramaVideoContract.test.js
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add frontweb/src/components/AIConfigContent.vue frontweb/src/utils/videoGenerationRequest.js frontweb/test/aiConfigProviderPresets.test.js frontweb/test/videoGenerationRequest.test.js
git commit -m "feat: 同步飞拓模型管理预设"
```

### 任务 4：真实验证脚本与配置事务

**文件：**
- 创建：`backend-node/scripts/verify-feituo-video-models.js`
- 创建：`backend-node/test/verifyFeituoVideoModels.test.js`
- 创建：`deploy/apply-feituo-video-model-config.js`
- 创建：`backend-node/test/feituoVideoModelConfigTransaction.test.js`

- [ ] **步骤 1：编写恢复与证据失败测试**

```js
assert.equal(decideResumeAction({ status: 'indeterminate' }), 'stop')
assert.equal(decideResumeAction({ status: 'completed', artifact: null }), 'verify_artifact')
assert.equal(validateEvidence(validEvidence), true)
assert.equal(validateEvidence({ ...validEvidence, results: [] }), false)
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd backend-node && node --test test/verifyFeituoVideoModels.test.js test/feituoVideoModelConfigTransaction.test.js`

预期：FAIL，脚本和导出尚不存在。

- [ ] **步骤 3：实现三条实测矩阵**

```js
const CASES = Object.freeze([
  { id: 'h3-2k', model: 'xuan-video-v1-6e7b4763634e6206', resolution: '2k', duration: 5 },
  { id: 'seedance25-480', model: 'xuan-seedance-2.5', resolution: '480p', duration: 5 },
  { id: 'seedance25-720', model: 'xuan-seedance-2.5', resolution: '720p', duration: 5 },
])
```

每条状态以原子写入保存。新提交连接中断标记 `indeterminate`，再次运行必须停止而不是重发。完成后下载 MP4，计算 SHA-256 并用 `ffprobe` 读尺寸/时长/编码。

- [ ] **步骤 4：实现配置事务并红绿测试**

```js
const TARGETS = Object.freeze({
  'xuan-video-v1-6e7b4763634e6206': { billing_unit: 'request', credits: 1313, cost_micros_per_unit: 1500000 },
  'xuan-seedance-2.5': { billing_unit: 'second', credits: 350, resolution_prices: {
    '480p': { credits: 350, cost_micros_per_second: 400000 },
    '720p': { credits: 350, cost_micros_per_second: 400000 },
  } },
})
```

`--plan` 只读，`--apply` 先备份数据库再单事务写入，`--verify` 精确对比，`--rollback` 只恢复该 receipt 记录的行。

- [ ] **步骤 5：运行定向测试与语法检查**

运行：

```bash
cd backend-node
node --check scripts/verify-feituo-video-models.js
node --check ../deploy/apply-feituo-video-model-config.js
node --test test/verifyFeituoVideoModels.test.js test/feituoVideoModelConfigTransaction.test.js
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add backend-node/scripts/verify-feituo-video-models.js backend-node/test/verifyFeituoVideoModels.test.js deploy/apply-feituo-video-model-config.js backend-node/test/feituoVideoModelConfigTransaction.test.js
git commit -m "feat: 添加飞拓视频真实验证与配置事务"
```

### 任务 5：本地总回归与构建

**文件：**
- 修改：`docs/tasks/2026-08-08-h3-catalog-image-preview-zoom.md`

- [ ] **步骤 1：运行后端定向总集**

```bash
cd backend-node
node --test test/feituoVideoModels.test.js test/verifyFeituoVideoModels.test.js test/feituoVideoModelConfigTransaction.test.js test/videoBilling.test.js test/videoGenerationRequestSnapshot.test.js test/canvasModelCatalogService.test.js test/modelPrice.test.js test/videoProviderVerification.test.js
```

预期：0 失败。

- [ ] **步骤 2：运行前端定向总集和生产构建**

```bash
cd frontweb
node --test test/canvasStabilityStage3.test.js test/aiConfigProviderPresets.test.js test/videoGenerationRequest.test.js test/homeQuickGeneration.test.js test/canvasGenerationOptions.test.js test/toapisVideoCanvasContract.test.js test/toapisShortDramaVideoContract.test.js
npm run build
```

预期：0 失败，Vite 构建成功。

- [ ] **步骤 3：执行静态审计**

运行：`git diff --check && git status --short && rg -n "api[_-]?key|Bearer [A-Za-z0-9]" docs backend-node/test frontweb/test`

预期：无密钥、无冲突标记、无格式错误。

### 任务 6：付费实测与速度证据

**文件：**
- 修改：`docs/tasks/2026-08-08-h3-catalog-image-preview-zoom.md`

- [ ] **步骤 1：准备专用状态目录和不含密钥的参考素材 URL**

使用受保护的 `/verification-assets/bootstrap/` 图片、视频和音频；密钥从线上飞拓配置读取，不写入命令行和证据。

- [ ] **步骤 2：依次执行 H3-2K、Seedance 480P、Seedance 720P**

```bash
node scripts/verify-feituo-video-models.js --config-id 13 --cases h3-2k,seedance25-480,seedance25-720 --output-dir /opt/moli-drama/shared/verification-state/feituo-video-v1
```

预期：三条均达到成功终态并生成可解析 MP4。任何 `indeterminate` 立即停止，不自动重试。

- [ ] **步骤 3：复核速度、成品和费用**

检查证据的 `create_latency_ms`、`terminal_latency_ms`、`download_latency_ms`、尺寸、时长、编码、SHA-256 和供应商任务 ID。如实际费用高于设计成本，停止配置事务并更新设计/价格，不以低成本上线。

- [ ] **步骤 4：将脱敏实测摘要写入任务文档并 Commit**

```bash
git add docs/tasks/2026-08-08-h3-catalog-image-preview-zoom.md
git commit -m "docs: 记录飞拓视频真实生成证据"
```

### 任务 7：受保护发布与产品验收

**文件：**
- 候选 release 中的审计差异
- 线上数据库备份和配置 receipt

- [ ] **步骤 1：通过 SSH 重新读取实时 `current` 并从其创建新候选**

不复用旧候选，不从本地工作树整体覆盖线上。只安装精确差异，保留 `canvas-credit-callout-v1`。

- [ ] **步骤 2：在候选中运行测试、构建、数据库快速检查和共享审计器**

预期：所有门禁通过，活动生成任务为 0，候选文件根所有权/权限合格。

- [ ] **步骤 3：使用已安装共享门禁原子切换**

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
```

预期：健康 200，无新致命日志，数据库备份与回滚路径存在。

- [ ] **步骤 4：应用模型配置事务并精确验证**

运行 `--plan`，对照真实证据 SHA，再执行 `--apply` 与 `--verify`。如验证失败立即 `--rollback`。

- [ ] **步骤 5：在真实浏览器中验收五个表面**

1. 首页选择两个模型，分辨率/时长/预计积分正确。
2. 画布图片节点和视频节点的模型、备注、参考素材、请求快照和成品回写正确。
3. 短剧工厂单条/批量/流水线/修复四条路径使用同一构造器。
4. 管理员展示名、备注、成本、扣分和验证状态正确。
5. 图片节点双击全屏后 `Ctrl` + 滚轮可改变 25%~500% 缩放，关闭重开恢复 100%。

最后一次浏览器动作执行会话结束操作，不在其后继续调用浏览器工具。

