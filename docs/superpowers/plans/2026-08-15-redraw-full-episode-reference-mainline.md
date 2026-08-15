# 整集短剧参考包主线接通实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将用户指定的 68.733 秒源片从旧的“原视频直接交给生成模型”路径迁移到逐镜参考包主线，确保所有可辨认人物、中文字幕、场景、动作、英文对白和美国化姓名在本地审核通过前无法发起生成。

**架构：** 复用已经完成的 `redraw-reference-bundle-v1`、身份包、clean plate、文字净景和无原音运动参考服务；先修正真实源片九镜事实合同，再增加 owner-scoped 参考包 API 和本地工作台审核面板。最后以真实源片生成九镜仓库外证据清单，只验证“准备是否完整”和“旧原片直投是否被关闭”，本计划不调用 Fumin/ToAPIs、不读取 Key、不产生付费提交。

**技术栈：** Vue 3、Node.js 20、`node:test`、Express、better-sqlite3、FFmpeg/FFprobe、SHA-256、Playwright。

**设计依据：**
- `docs/superpowers/plans/2026-08-13-redraw-full-episode-1to1-test.md`
- `docs/superpowers/reports/2026-08-13-redraw-full-episode-1to1-evidence.md`
- `docs/superpowers/specs/2026-08-14-redraw-reference-bundle-motion-identity-text-design.md`

---

## 文件职责

- 修改：`frontweb/e2e/fixtures/redraw-latin-american-case.js`——修正五个命名角色、逐镜人物范围、中文字幕范围和英文姓名对白。
- 修改：`frontweb/test/redrawLatinAmericanCase.test.js`——锁定真实源片事实合同和 fail-closed 状态。
- 修改：`backend-node/src/routes/redraw.js`、`backend-node/src/routes/index.js`——增加当前 owner 的逐镜参考包读写 API。
- 修改：`backend-node/test/redrawRoutes.test.js`——验证输入白名单、跨 owner、CAS、响应脱敏和路由注册。
- 修改：`frontweb/src/api/redraw.js`——增加参考包读写客户端。
- 修改：`backend-node/src/routes/redraw.js`、`backend-node/test/redrawRoutes.test.js`——把当前版本的服务端 `reference_bundle_required` 只读投影给工作台，不提供客户端开关。
- 创建：`frontweb/src/components/redraw/RedrawReferenceBundlePanel.vue`——显示逐镜人脸、文字、运动参考和对白门禁。
- 修改：`frontweb/src/components/redraw/RedrawShotEditor.vue`、`frontweb/src/components/redraw/RedrawShotStep.vue`——在生成按钮之前保存和刷新参考包。
- 修改：`frontweb/test/redrawShots.test.js`——验证工作台不得绕过参考包。
- 修改：`frontweb/e2e/fixtures/redraw-latin-american-case.js`、`frontweb/test/redrawLatinAmericanCase.test.js`——当前真实源片案例显式启用参考包主线。
- 创建：`backend-node/scripts/run-redraw-full-episode-reference-local.js`——读取真实源片，输出九镜本地准备清单和联系表，不调用供应商。
- 创建：`backend-node/test/redrawFullEpisodeReferenceLocal.test.js`——验证真实源片合同、九镜连续性、阻塞原因和脱敏输出。
- 创建：`docs/superpowers/reports/2026-08-15-redraw-full-episode-reference-local-evidence.md`——记录本地主线准备结果和未完成项。

### 任务 1：修正真实整集人物与中文字幕合同

**文件：**
- 修改：`frontweb/e2e/fixtures/redraw-latin-american-case.js`
- 修改：`frontweb/test/redrawLatinAmericanCase.test.js`

- [ ] **步骤 1：先写人物分离红灯测试**

要求 `cast` 包含五个不同命名角色：

```js
assert.deepEqual(redrawLatinAmericanCase.cast.map((actor) => actor.id), [
  'mateo', 'diego', 'lucas', 'elena', 'rafael',
])
assert.deepEqual(
  redrawLatinAmericanCase.sourceFacts.shots.find((shot) => shot.id === 'shot-1').speaking_character_ids,
  ['mateo', 'diego', 'lucas'],
)
assert.deepEqual(
  redrawLatinAmericanCase.sourceFacts.shots.find((shot) => shot.id === 'shot-2').speaking_character_ids,
  ['lucas', 'mateo'],
)
```

同时断言第 1 镜的后两句和第 2 镜的前两句由 `lucas` 说，不再与挑衅者 `diego` 共用身份；英文对白使用 `Mateo`、`Diego`、`Lucas`，不得保留 `Lin` 或 `Lu Feiyu`。

- [ ] **步骤 2：先写中文字幕覆盖红灯测试**

每个有对白的镜头必须包含 `text_regions`，每条源对白时间窗恰好对应一个 `text_subtitle` 区域；第 8 镜还必须包含 `text_screen`：

```js
for (const shot of redrawLatinAmericanCase.sourceFacts.shots) {
  const subtitleRanges = (shot.text_regions || [])
    .filter((region) => region.kind === 'text_subtitle')
    .flatMap((region) => region.time_ranges)
  assert.deepEqual(subtitleRanges, shot.dialogue.map(({ start_ms, end_ms }) => [start_ms, end_ms]))
}
```

每镜同时声明 `face_track_review.status` 和 `text_region_review.status`；未完成完整逐帧人脸轨迹或文字区域审核时只能是 `pending`，不得伪造 `approved`。

- [ ] **步骤 3：运行测试确认红灯**

运行：

```powershell
node --test frontweb/test/redrawLatinAmericanCase.test.js
```

预期：五角色、`lucas` 说话人、字幕区域和 review 字段断言失败。

- [ ] **步骤 4：最小修正源片合同**

新增角色：

```js
{ id: 'lucas', source_name: '男同学朋友', target_name: 'Lucas', role: 'friend', age_min: 18 }
```

第 1 镜说话人固定为 `mateo → diego → lucas → lucas`；第 2 镜固定为 `lucas → lucas → mateo`。为七个对白镜头补 `text_subtitle` 时间范围，为第 8 镜补 `text_screen` 区域。初始逐帧 coverage review 使用 `pending` 和明确的 `unresolved_reason`，不把抽帧观察升级为完整轨迹审核。

- [ ] **步骤 5：运行绿灯并提交**

```powershell
node --test frontweb/test/redrawLatinAmericanCase.test.js
node --test frontweb/test/redrawFoundation.test.js frontweb/test/redrawShots.test.js
git diff --check
git add frontweb/e2e/fixtures/redraw-latin-american-case.js frontweb/test/redrawLatinAmericanCase.test.js
git commit -m "fix(转绘): 修正整集人物与字幕事实合同"
```

### 任务 2：增加逐镜参考包 owner-scoped API

**文件：**
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：写路由红灯测试**

增加：

```text
GET /redraw/shots/:id/reference-bundle
PUT /redraw/shots/:id/reference-bundle
```

PUT 只接受 `shot_id` 之外的内部参考字段：`expected_updated_at`、`motion_reference_asset_id`、`face_tracks`、`text_regions`、`coverage_review`。拒绝客户端自报 hash、path、URL、reviewer、status、tenant 和 user；跨 owner 统一 404；CAS 冲突 409；成功响应只返回 `shot_id`、`reference_bundle_hash`、`reference_bundle_updated_at` 和脱敏 bundle。

- [ ] **步骤 2：运行红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawRoutes.test.js --test-name-pattern="参考包 API"
```

预期：handler 和总路由尚未注册。

- [ ] **步骤 3：复用 reference bundle service 实现最小 handler**

handler 从当前请求 owner、配置 storage root、当前 shot ID 和服务端时间构建 context，调用 `saveReferenceBundle` 或 `loadCurrentReferenceBundle`；不得在路由复制哈希、路径或身份校验逻辑。

- [ ] **步骤 4：运行联合绿灯并提交**

```powershell
node --test --test-concurrency=1 test/redrawRoutes.test.js test/redrawReferenceBundle.test.js test/redrawGeneration.test.js
node --check src/routes/redraw.js src/routes/index.js
Set-Location ..
git diff --check
git add backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawRoutes.test.js
git commit -m "feat(转绘): 接通逐镜参考包接口"
```

### 任务 3：把参考包门禁接入本地工作台

**文件：**
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/test/redrawRoutes.test.js`
- 修改：`frontweb/src/api/redraw.js`
- 创建：`frontweb/src/components/redraw/RedrawReferenceBundlePanel.vue`
- 修改：`frontweb/src/components/redraw/RedrawShotEditor.vue`
- 修改：`frontweb/src/components/redraw/RedrawShotStep.vue`
- 修改：`frontweb/test/redrawShots.test.js`
- 修改：`frontweb/e2e/fixtures/redraw-latin-american-case.js`
- 修改：`frontweb/test/redrawLatinAmericanCase.test.js`

- [ ] **步骤 1：写服务端状态投影和前端红灯测试**

锁定：`getWork` 只读返回当前版本的 `reference_bundle_required`，客户端不能修改该值；当前真实源片案例显式为 `true`。工作台显示 `人物轨迹 → 身份包 → 文字净景 → 无原音运动参考 → 英文对白` 五段状态；强制参考包的版本中，参考包未 ready 时生成按钮禁用；保存参考包使用 `expected_updated_at`；响应 409 后刷新当前 work，不自动重放 PUT；批量生成只包含经 GET 参考包复核成功的镜头。旧版本 `reference_bundle_required=0` 不增加新阻塞。

- [ ] **步骤 2：运行红灯**

```powershell
node --test frontweb/test/redrawShots.test.js
```

- [ ] **步骤 3：实现最小面板与 API 接线**

面板只编辑 asset/track/region 绑定，不允许输入 hash、path、URL、reviewer 或 ready。后端只读投影当前版本的 `reference_bundle_required`；前端不可切换。已有 `reference_bundle_required=0` 的旧项目保持旧路径；当前整集本地案例必须显式设置为 1。

- [ ] **步骤 4：运行绿灯并提交**

```powershell
node --test frontweb/test/redrawShots.test.js frontweb/test/redrawAssets.test.js frontweb/test/redrawFoundation.test.js
Set-Location backend-node
node --test --test-concurrency=1 test/redrawRoutes.test.js
Set-Location ..
npm --prefix frontweb run build
git diff --check
git add backend-node/src/routes/redraw.js backend-node/test/redrawRoutes.test.js frontweb/src/api/redraw.js frontweb/src/components/redraw/RedrawReferenceBundlePanel.vue frontweb/src/components/redraw/RedrawShotEditor.vue frontweb/src/components/redraw/RedrawShotStep.vue frontweb/test/redrawShots.test.js frontweb/e2e/fixtures/redraw-latin-american-case.js frontweb/test/redrawLatinAmericanCase.test.js
git commit -m "feat(转绘): 在工作台显示逐镜参考包门禁"
```

### 任务 4：建立真实源片九镜本地准备运行器

**文件：**
- 创建：`backend-node/scripts/run-redraw-full-episode-reference-local.js`
- 创建：`backend-node/test/redrawFullEpisodeReferenceLocal.test.js`
- 修改：`backend-node/package.json`

- [ ] **步骤 1：写 CLI 红灯测试**

CLI 固定参数：`--source <mp4> --case-manifest <json> --output-dir <dir>`。输出九镜相对路径清单、源片/分镜 SHA-256、代表帧、人物/文字 review 状态、参考包 ready 状态和阻塞原因；禁止输出绝对路径、Key、Authorization 或公网 URL。

- [ ] **步骤 2：运行红灯确认脚本缺失**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawFullEpisodeReferenceLocal.test.js
```

- [ ] **步骤 3：实现真实源片只读预处理**

先重算源片 SHA-256 和 FFprobe；再按固定九镜时间轴用 FFmpeg 生成仓库外的无音轨片段与代表帧。任何人物轨迹、文字区域、身份包、clean plate 或 motion review 未批准时，镜头状态必须是 `blocked`，不得构造供应商请求。

- [ ] **步骤 4：运行绿灯并提交**

```powershell
node --test --test-concurrency=1 test/redrawFullEpisodeReferenceLocal.test.js test/redrawReferenceBundle.test.js test/redrawMotionReference.test.js
node --check scripts/run-redraw-full-episode-reference-local.js
git diff --check
git add -f backend-node/scripts/run-redraw-full-episode-reference-local.js
git add backend-node/test/redrawFullEpisodeReferenceLocal.test.js backend-node/package.json
git commit -m "feat(转绘): 增加真实整集参考包本地运行器"
```

### 任务 5：执行本地整集主线验收并记录报告

**文件：**
- 创建：`docs/superpowers/reports/2026-08-15-redraw-full-episode-reference-local-evidence.md`

- [ ] **步骤 1：执行真实源片运行器**

输出目录必须位于仓库外；记录九镜逐项状态。pending/blocked 是合法结果，但不能写成通过。

- [ ] **步骤 2：运行联合测试与前端构建**

```powershell
node --test frontweb/test/redrawLatinAmericanCase.test.js frontweb/test/redrawShots.test.js frontweb/test/redrawAssets.test.js
Set-Location backend-node
node --test --test-concurrency=1 test/redrawRoutes.test.js test/redrawReferenceBundle.test.js test/redrawGeneration.test.js test/redrawFullEpisodeReferenceLocal.test.js
Set-Location ..
npm --prefix frontweb run build
git diff --check
```

- [ ] **步骤 3：编写脱敏报告并提交**

报告必须逐镜列出人物轨迹、身份包、中文字幕净化、运动参考、英文对白、reference gate 和阻塞原因；明确“未调用供应商、未完成视觉复刻、未部署”。

```powershell
git add docs/superpowers/reports/2026-08-15-redraw-full-episode-reference-local-evidence.md
git commit -m "test(转绘): 记录真实整集参考包本地证据"
```

## 完成边界

- 本计划完成时只证明真实整集已经进入正确的参考包主线，且所有未审核项会 fail closed。
- 本计划不证明外国人物视觉替换成功，不证明口型同步，不证明整集供应商生成完成。
- 只有九镜 `reference_bundle_ready=true`、本地 UI/API 同链通过、账户实时报价和用户重新确认总预算后，才允许创建新的付费计划。
- 全程不部署、不 SSH、不写生产数据库、不开放线上入口、不 push。
