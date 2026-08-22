# 通用短剧生成与整集交付实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `reference_ready` 镜头安全地提交给当前已验证视频能力，完成目标语声画、逐镜 QA、失败恢复、整集合并和可下载交付。

**架构：** 复用现有逐镜生成、计费、原生对白、字幕、合并和导出服务；新增项目级预算/尝试策略、追加式候选审核和正式 release 哈希。供应商返回只形成候选，只有当前依赖、媒体、身份、文字、对白、声音和口型证据全部通过后才可自动批准并进入整集。

**技术栈：** Node.js 20、Express、better-sqlite3、Vue 3、Node test runner、Playwright、FFmpeg/ffprobe、现有视频能力注册表与 locale verifier。

---

## 前置条件

- 已完成计划 1 和计划 2。
- 当前版本所有待生成镜头均为 `reference_ready`。
- 项目已保存 A/B、预算和自动尝试上限。
- 真实付费验收必须在本计划所有本地门禁通过后单独授权。

## 供应商边界

产品生成入口不得接收客户端 `model`、`provider`、价格、配置 ID、Key 或供应商 URL。

首个计划验收的供应商是 Fumin Seedance 2.0 Mini 480p，但代码不新增猜测出来的 Fumin 私有协议。服务端必须从当前能力注册表解析到一个已启用、已定价、具有真实生成证据且证据文件可读的精确配置。若当前 Fumin 配置不能映射到已实现协议，系统返回 `no_verified_video_model`，不冻结积分、不提交任务；该协议接入必须另有供应商正式接口证据和独立设计。

## 文件结构

### 新建

- `backend-node/migrations/57_redraw_candidate_release.sql`：追加式候选审核、镜头批准指针和 release 哈希。
- `backend-node/src/services/redrawGenerationPolicyService.js`：项目预算、尝试上限和自动重试决策。
- `backend-node/src/services/redrawCandidateQualityService.js`：媒体、身份、文字、对白、声音、口型和依赖质量汇总。
- `backend-node/src/services/redrawCandidateReviewService.js`：追加候选审核、自动/人工决定和 CAS。
- `backend-node/src/services/redrawEpisodeReleaseService.js`：整集 release 哈希和交付清单。
- `backend-node/test/redrawGenerationPolicy.test.js`：预算和尝试策略测试。
- `backend-node/test/redrawCandidateQuality.test.js`：候选质量矩阵测试。
- `backend-node/test/redrawCandidateReview.test.js`：追加审核和失效测试。
- `backend-node/test/redrawEpisodeRelease.test.js`：整集 release 测试。
- `frontweb/src/components/redraw/RedrawGenerationQueuePanel.vue`：生成队列、费用和异常状态。
- `frontweb/src/components/redraw/RedrawQualityReviewPanel.vue`：逐镜质量和人工接管。
- `frontweb/src/components/redraw/RedrawEpisodeReleasePanel.vue`：整集候选、下载和审计报告。
- `frontweb/test/redrawDeliveryWorkspace.test.js`：生成、QA 和导出 UI 测试。
- `frontweb/e2e/redraw-full-product.spec.js`：无付费的同次完整产品链路。
- `frontweb/e2e/redraw-full-product-live.spec.js`：显式开关保护的真实供应商验收。
- `docs/superpowers/reports/redraw-full-product-acceptance-template.md`：不含密钥的验收报告模板。

### 修改

- `backend-node/src/db/migrate.js`：候选审核和 release 旧库兜底。
- `backend-node/src/services/redrawGenerationService.js`：项目预算、尝试上限、准备 gate 和候选 QA。
- `backend-node/src/services/redrawProviderAdapters.js`：规范化视频候选终态，不增加客户端控制。
- `backend-node/src/services/redrawNativeAudioService.js`：输出候选质量所需的目标语、音轨和对白证据。
- `backend-node/src/services/redrawDialogueOrchestrator.js`：只为当前已批准候选生成/验证目标语音频。
- `backend-node/src/services/redrawSubtitleService.js`：按当前本地化镜头生成字幕。
- `backend-node/src/services/redrawCompositionService.js`：只合并当前批准候选并写 release 输入哈希。
- `backend-node/src/services/redrawExportService.js`：验证 release 哈希后下载。
- `backend-node/src/routes/redraw.js`：生成队列、候选审核和 release API。
- `backend-node/src/routes/index.js`：注册新路由。
- `backend-node/test/redrawMigration.test.js`：候选审核迁移测试。
- `backend-node/test/redrawGeneration.test.js`：预算、尝试、准备 gate 和候选 QA 测试。
- `backend-node/test/redrawNativeAudio.test.js`：目标语音轨与静默合同测试。
- `backend-node/test/redrawComposition.test.js`：只合并批准候选测试。
- `backend-node/test/redrawExport.test.js`：release 下载哈希测试。
- `backend-node/test/redrawRoutes.test.js`：严格 API 和 owner 测试。
- `frontweb/src/api/redraw.js`：生成状态、候选审核和 release API。
- `frontweb/src/views/RedrawWorkspace.vue`：接入生成、QA 和导出工作区。
- `frontweb/src/components/redraw/RedrawShotStep.vue`：生成队列入口。
- `frontweb/src/components/redraw/RedrawEditStep.vue`：改为当前批准候选的合并入口。
- `frontweb/src/utils/redrawShotState.js`：候选和 QA 状态。
- `frontweb/src/utils/redrawTimelineState.js`：release 时间轴状态。

## 任务 1：建立追加式候选审核与 release 数据合同

**文件：**

- 创建：`backend-node/migrations/57_redraw_candidate_release.sql`
- 修改：`backend-node/src/db/migrate.js`
- 修改：`backend-node/test/redrawMigration.test.js`

- [ ] **步骤 1：编写迁移红灯测试**

```js
test('候选审核追加保存并由镜头和导出绑定当前批准哈希', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='redraw_candidate_reviews'").get().name,
    'redraw_candidate_reviews',
  );
  assert.ok(db.prepare('PRAGMA table_info(redraw_shots)').all().some((row) => row.name === 'approved_candidate_review_id'));
  assert.ok(db.prepare('PRAGMA table_info(redraw_exports)').all().some((row) => row.name === 'release_hash'));
});
```

- [ ] **步骤 2：运行红灯**

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawMigration.test.js
```

预期：FAIL，候选审核表和列不存在。

- [ ] **步骤 3：实现迁移和不可变触发器**

```sql
CREATE TABLE redraw_candidate_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version_id INTEGER NOT NULL,
  shot_id INTEGER NOT NULL,
  video_generation_id INTEGER NOT NULL,
  candidate_sha256 TEXT NOT NULL,
  dependency_hash TEXT NOT NULL,
  review_version INTEGER NOT NULL CHECK (review_version > 0),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'needs_review')),
  decision_source TEXT NOT NULL CHECK (decision_source IN ('automatic', 'human')),
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  reviewer_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(version_id) REFERENCES redraw_versions(id),
  FOREIGN KEY(shot_id) REFERENCES redraw_shots(id)
);

CREATE UNIQUE INDEX uq_redraw_candidate_review_version
  ON redraw_candidate_reviews(tenant_id, user_id, shot_id, video_generation_id, review_version);

ALTER TABLE redraw_shots ADD COLUMN approved_candidate_review_id INTEGER;
ALTER TABLE redraw_exports ADD COLUMN release_hash TEXT;
ALTER TABLE redraw_exports ADD COLUMN quality_summary_json TEXT NOT NULL DEFAULT '{}';
```

对 `redraw_candidate_reviews` 建立 UPDATE/DELETE 拒绝触发器。人工重新审核插入新 `review_version`，不更新旧记录。

- [ ] **步骤 4：运行迁移测试**

```bash
node --test --test-concurrency=1 test/redrawMigration.test.js
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add backend-node/migrations/57_redraw_candidate_release.sql backend-node/src/db/migrate.js backend-node/test/redrawMigration.test.js
git commit -m "feat(转绘): 增加候选审核与整集发布合同"
```

## 任务 2：将项目预算和自动尝试上限接入逐镜生成

**文件：**

- 创建：`backend-node/src/services/redrawGenerationPolicyService.js`
- 创建：`backend-node/test/redrawGenerationPolicy.test.js`
- 修改：`backend-node/src/services/redrawGenerationService.js`
- 修改：`backend-node/test/redrawGeneration.test.js`

- [ ] **步骤 1：编写预算和尝试红灯测试**

```js
test('auto 项目不超过预算和每镜尝试上限', () => {
  assert.deepEqual(evaluateGenerationPolicy({
    execution_mode: 'auto',
    budget_limit_credits: 100,
    spent_credits: 70,
    held_credits: 20,
    quote_credits: 10,
    max_auto_attempts_per_shot: 2,
    completed_attempts: 1,
    prior_state: 'failed',
  }), { action: 'submit', attempt: 2 });
});
```

覆盖：预算刚好、超预算转 A、缺预算阻断、达到尝试上限转 A、`submission_unknown`/`needs_attention` 永久禁止自动重提、旧 held reservation 优先阻断、新幂等键不能绕过。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawGenerationPolicy.test.js test/redrawGeneration.test.js
```

预期：FAIL，项目策略尚未参与生成。

- [ ] **步骤 3：实现纯生成策略**

服务只导出：

```js
module.exports = {
  evaluateGenerationPolicy,
  projectBudgetSnapshot,
};
```

预算计算只读取服务端已结算和 held reservation。客户端提供的 spent、held、price、attempt 全部拒绝。

- [ ] **步骤 4：在任何冻结和任务创建前执行策略**

`generateShot()` 和 `generateBatch()` 顺序固定为：

1. owner/version；
2. 当前 preparation gate；
3. 当前 verified capability 和服务端报价；
4. 项目预算/尝试策略；
5. 请求幂等/CAS；
6. reservation；
7. task/video row；
8. 供应商调度。

任何前置失败均不得产生 reservation、task 或 video row。

- [ ] **步骤 5：运行联合测试**

```bash
node --test --test-concurrency=1 test/redrawGenerationPolicy.test.js test/redrawGeneration.test.js test/redrawShotBilling.test.js
```

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add backend-node/src/services/redrawGenerationPolicyService.js backend-node/src/services/redrawGenerationService.js backend-node/test/redrawGenerationPolicy.test.js backend-node/test/redrawGeneration.test.js
git commit -m "feat(转绘): 接入项目预算与自动尝试上限"
```

## 任务 3：固化供应商中立候选终态

**文件：**

- 修改：`backend-node/src/services/redrawProviderAdapters.js`
- 修改：`backend-node/src/services/redrawGenerationService.js`
- 修改：`backend-node/test/redrawProviderAdapters.test.js`
- 修改：`backend-node/test/redrawGeneration.test.js`

- [ ] **步骤 1：编写终态映射红灯测试**

```js
test('供应商 completed 只映射为 completed_candidate', () => {
  assert.deepEqual(normalizeVideoProviderResult({ status: 'completed', task_id: 'p1', url: 'https://result' }), {
    status: 'completed_candidate',
    provider_task_id: 'p1',
    result_url: 'https://result',
  });
});
```

覆盖 `accepted`、`running`、`failed_terminal`、`submission_unknown`、`result_unavailable`；未知状态不能映射为 failed 或 completed。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawProviderAdapters.test.js test/redrawGeneration.test.js
```

预期：FAIL，视频候选没有统一规范终态。

- [ ] **步骤 3：实现规范结果映射**

新增导出：

```js
module.exports.normalizeVideoProviderResult = normalizeVideoProviderResult;
```

映射结果只保留 `provider_task_id`、规范状态、结果引用和安全阶段。原始供应商正文不写入任务、错误或审计。

- [ ] **步骤 4：强制服务端能力选择**

生成继续使用现有 `resolveVerifiedGenerationCapability()`：

- 配置启用；
- 精确 provider/protocol/model/config 绑定；
- 480p 和参考输入能力经过真实证据验证；
- 模型价格存在；
- 验证产物可读。

客户端传入 `model`、`provider` 或 `config_id` 时在副作用前返回 400。

- [ ] **步骤 5：验证 Fumin 缺能力时安全阻断**

测试数据库不插入精确验证能力，调用生成必须返回 `no_verified_video_model`，reservation/task/video/provider calls 均为 0。

- [ ] **步骤 6：运行测试并提交**

```bash
node --test --test-concurrency=1 test/redrawProviderAdapters.test.js test/redrawGeneration.test.js test/redrawCapabilities.test.js
git add backend-node/src/services/redrawProviderAdapters.js backend-node/src/services/redrawGenerationService.js backend-node/test/redrawProviderAdapters.test.js backend-node/test/redrawGeneration.test.js
git commit -m "feat(转绘): 规范逐镜供应商候选终态"
```

## 任务 4：实现逐镜候选质量聚合

**文件：**

- 创建：`backend-node/src/services/redrawCandidateQualityService.js`
- 创建：`backend-node/test/redrawCandidateQuality.test.js`
- 修改：`backend-node/src/services/redrawNativeAudioService.js`
- 修改：`backend-node/test/redrawNativeAudio.test.js`

- [ ] **步骤 1：编写质量矩阵红灯测试**

```js
test('候选只有全部当前证据通过时可自动批准', async () => {
  const result = await verifyCandidateQuality(ctx, candidateInput, verifiedDeps);
  assert.deepEqual(result.decision, 'approved');
  assert.equal(result.metrics.media.readable, true);
  assert.equal(result.metrics.identity.all_bound, true);
  assert.equal(result.metrics.dialogue.exact_target_text, true);
  assert.equal(result.metrics.lip_sync.passed, true);
});
```

失败矩阵必须逐项覆盖：

- 文件不可读、时长/尺寸错误、哈希漂移；
- 当前角色或服装依赖哈希变化；
- 原人物或原文字残留；
- 角色身份漂移、人物数量或关系错误；
- 有声镜头无音轨、静默镜头出现对白；
- 目标语言错误、台词不完全匹配、声音属于错误角色；
- 字幕缺失或超出镜头；
- 口型证据缺失或不通过。

口型证据缺失的结果固定为 `needs_review`，不得自动批准。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawCandidateQuality.test.js test/redrawNativeAudio.test.js
```

预期：FAIL，质量聚合服务不存在。

- [ ] **步骤 3：实现严格质量输入**

`verifyCandidateQuality()` 只接受服务端解析后的 ID 和哈希：

```js
{
  version_id,
  shot_id,
  video_generation_id,
  candidate_sha256,
  dependency_hash,
}
```

它通过注入依赖调用：媒体探针、候选全帧覆盖、locale verifier、原生音频验证、字幕验证和口型验证。客户端不能提交 metrics 或 approval。

- [ ] **步骤 4：扩展原生音频证据投影**

`redrawNativeAudioService` 输出给质量服务的白名单：

```js
{
  has_audio,
  dialogue_mode,
  language,
  exact_target_text,
  speaker_voice_matches,
  ambient_audio_safe,
  evidence_hash,
}
```

静默镜头允许环境声，但 `exact_target_text` 必须为空且不能检测到对白。

- [ ] **步骤 5：运行测试和提交**

```bash
node --test --test-concurrency=1 test/redrawCandidateQuality.test.js test/redrawNativeAudio.test.js test/redrawLocaleVerifierClient.test.js test/redrawSubtitle.test.js
node --check src/services/redrawCandidateQualityService.js src/services/redrawNativeAudioService.js
git add backend-node/src/services/redrawCandidateQualityService.js backend-node/src/services/redrawNativeAudioService.js backend-node/test/redrawCandidateQuality.test.js backend-node/test/redrawNativeAudio.test.js
git commit -m "feat(转绘): 增加逐镜候选质量聚合"
```

## 任务 5：追加自动和人工候选审核

**文件：**

- 创建：`backend-node/src/services/redrawCandidateReviewService.js`
- 创建：`backend-node/test/redrawCandidateReview.test.js`
- 修改：`backend-node/src/services/redrawGenerationService.js`
- 修改：`backend-node/test/redrawGeneration.test.js`

- [ ] **步骤 1：编写审核红灯测试**

```js
test('auto 质量全过时追加审核并以 CAS 绑定当前候选', async () => {
  const review = await reviewCandidate(ctx, {
    shot_id: shotId,
    video_generation_id: videoId,
    decision_source: 'automatic',
  });
  assert.equal(review.decision, 'approved');
  assert.equal(readShot(shotId).approved_candidate_review_id, review.id);
});
```

覆盖：A 模式自动结果仍 `needs_review`、B 边界结果降级、人工批准需 `expected_updated_at` + `candidate_sha256`、人工驳回、重复同决定幂等、冲突决定 409、审核期间文件/依赖漂移、旧审核不可更新或删除。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawCandidateReview.test.js test/redrawGeneration.test.js
```

预期：FAIL，审核服务不存在。

- [ ] **步骤 3：实现追加式审核**

服务导出：

```js
module.exports = {
  reviewCandidate,
  getCurrentCandidateReview,
  assertCurrentApprovedCandidate,
};
```

每次审核重新计算候选 SHA 和依赖哈希。批准时使用 shot `updated_at` 做 CAS，并把新审核 ID 写入 `approved_candidate_review_id`。

- [ ] **步骤 4：接入供应商候选收口**

`runShotGeneration()` 下载并验证候选后：

1. 写候选资产；
2. 运行质量聚合；
3. B 全通过时自动审核；
4. A 或边界结果写 `needs_review`；
5. 质量验证异常保持 candidate、reservation `held`、shot `needs_attention`；
6. 只有自动/人工批准后才确认结算并进入 `approved`。

- [ ] **步骤 5：运行联合测试并提交**

```bash
node --test --test-concurrency=1 test/redrawCandidateReview.test.js test/redrawCandidateQuality.test.js test/redrawGeneration.test.js test/redrawShotBilling.test.js
git add backend-node/src/services/redrawCandidateReviewService.js backend-node/src/services/redrawGenerationService.js backend-node/test/redrawCandidateReview.test.js backend-node/test/redrawGeneration.test.js
git commit -m "feat(转绘): 接通逐镜候选自动与人工审核"
```

## 任务 6：只用当前批准候选生成整集 release

**文件：**

- 创建：`backend-node/src/services/redrawEpisodeReleaseService.js`
- 创建：`backend-node/test/redrawEpisodeRelease.test.js`
- 修改：`backend-node/src/services/redrawDialogueOrchestrator.js`
- 修改：`backend-node/src/services/redrawSubtitleService.js`
- 修改：`backend-node/src/services/redrawCompositionService.js`
- 修改：`backend-node/src/services/redrawExportService.js`
- 修改：`backend-node/test/redrawComposition.test.js`
- 修改：`backend-node/test/redrawExport.test.js`

- [ ] **步骤 1：编写 release 红灯测试**

```js
test('release 只锁定当前版本全部批准候选的哈希', async () => {
  const release = await buildEpisodeRelease(ctx, { version_id: versionId });
  assert.deepEqual(release.shots.map((item) => item.shot_id), [shot1.id, shot2.id, shot3.id]);
  assert.match(release.release_hash, /^[a-f0-9]{64}$/);
  assert.equal(release.shots.every((item) => item.candidate_review_id), true);
});
```

失败矩阵：缺镜头、顺序 gap、旧审核、依赖漂移、候选文件替换、字幕越界、有声/静默合同错误、跨 owner、旧 export 干扰。

- [ ] **步骤 2：运行红灯**

```bash
node --test --test-concurrency=1 test/redrawEpisodeRelease.test.js test/redrawComposition.test.js test/redrawExport.test.js
```

预期：FAIL，release 服务不存在，composition 尚未要求当前审核。

- [ ] **步骤 3：实现 release 清单和哈希**

规范清单：

```js
{
  schema_version: 'redraw-episode-release-v1',
  project_id,
  work_id,
  version_id,
  locale,
  market,
  shots: [{
    shot_id,
    shot_index,
    start_ms,
    end_ms,
    candidate_review_id,
    candidate_sha256,
    audio_sha256,
    subtitle_sha256,
    dependency_hash,
  }],
  quality_summary,
  release_hash,
}
```

所有哈希由服务端重算，稳定排序后生成 `release_hash`。

- [ ] **步骤 4：收紧 dialogue、subtitle 和 composition**

- `redrawDialogueOrchestrator` 只处理当前审核引用的镜头；
- `redrawSubtitleService` 从当前本地化对白生成字幕；
- `redrawCompositionService` 在 FFmpeg 前重新校验所有候选、音频、字幕和依赖哈希；
- `redrawExportService` 下载前重算文件 SHA 并核对 `release_hash`；
- 合并失败保留旧 completed export，不删除旧 release。

- [ ] **步骤 5：真实 FFmpeg 联合测试**

```powershell
$env:REQUIRE_LOCAL_FFMPEG = '1'
node --test --test-concurrency=1 test/redrawEpisodeRelease.test.js test/redrawComposition.test.js test/redrawExport.test.js test/redrawSubtitle.test.js
Remove-Item Env:REQUIRE_LOCAL_FFMPEG
```

预期：PASS，生成可 probe 的 MP4、SRT、VTT 和脱敏 manifest。

- [ ] **步骤 6：提交**

```bash
git add backend-node/src/services/redrawEpisodeReleaseService.js backend-node/src/services/redrawDialogueOrchestrator.js backend-node/src/services/redrawSubtitleService.js backend-node/src/services/redrawCompositionService.js backend-node/src/services/redrawExportService.js backend-node/test/redrawEpisodeRelease.test.js backend-node/test/redrawComposition.test.js backend-node/test/redrawExport.test.js
git commit -m "feat(转绘): 生成可追溯整集发布版本"
```

## 任务 7：接通生成队列、质量审核和整集导出工作台

**文件：**

- 创建：`frontweb/src/components/redraw/RedrawGenerationQueuePanel.vue`
- 创建：`frontweb/src/components/redraw/RedrawQualityReviewPanel.vue`
- 创建：`frontweb/src/components/redraw/RedrawEpisodeReleasePanel.vue`
- 创建：`frontweb/test/redrawDeliveryWorkspace.test.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawRoutes.test.js`
- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/src/views/RedrawWorkspace.vue`
- 修改：`frontweb/src/components/redraw/RedrawShotStep.vue`
- 修改：`frontweb/src/components/redraw/RedrawEditStep.vue`
- 修改：`frontweb/src/utils/redrawShotState.js`
- 修改：`frontweb/src/utils/redrawTimelineState.js`

- [ ] **步骤 1：编写路由和 UI 红灯测试**

新增 API：

```text
GET  /redraw/versions/:id/generation-summary
GET  /redraw/shots/:id/candidate-reviews
POST /redraw/shots/:id/candidate-reviews
GET  /redraw/versions/:id/release-readiness
POST /redraw/versions/:id/releases
```

前端测试断言显示：已用/held/剩余预算、每镜 attempt、provider 状态、候选 QA、B→A 原因、人工批准/驳回、整集 readiness、MP4/SRT/VTT/报告下载。

- [ ] **步骤 2：运行红灯**

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawRoutes.test.js
cd ..
node --test frontweb/test/redrawDeliveryWorkspace.test.js frontweb/test/redrawShots.test.js frontweb/test/redrawEdit.test.js
```

预期：FAIL，新 API 和组件不存在。

- [ ] **步骤 3：实现严格路由输入**

候选人工审核只允许：

```js
['decision', 'reason_code', 'candidate_sha256', 'expected_updated_at']
```

`decision` 只允许 `approved`/`rejected`。release 创建只允许 `idempotency_key` 和服务端返回的 readiness hash。所有 model/provider/price/path/url/review metrics 注入均返回 400。

- [ ] **步骤 4：实现工作台状态**

- `submission_unknown` 显示“需要核对”，不显示自动重试；
- `failed_terminal` 且预算/尝试允许时显示下一次尝试；
- A 模式显示候选人工审核；
- B 全过显示自动批准证据；
- release 不 ready 时列出精确镜头和原因；
- 下载按钮只来自服务端受控相对 URL。

- [ ] **步骤 5：运行测试和构建**

```bash
cd backend-node
node --test --test-concurrency=1 test/redrawRoutes.test.js test/redrawCandidateReview.test.js test/redrawEpisodeRelease.test.js
cd ..
node --test frontweb/test/redrawDeliveryWorkspace.test.js frontweb/test/redrawShots.test.js frontweb/test/redrawEdit.test.js
npm --prefix frontweb run build
```

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawRoutes.test.js frontweb/src/api/redraw.js frontweb/src/views/RedrawWorkspace.vue frontweb/src/components/redraw/RedrawGenerationQueuePanel.vue frontweb/src/components/redraw/RedrawQualityReviewPanel.vue frontweb/src/components/redraw/RedrawEpisodeReleasePanel.vue frontweb/src/components/redraw/RedrawShotStep.vue frontweb/src/components/redraw/RedrawEditStep.vue frontweb/src/utils/redrawShotState.js frontweb/src/utils/redrawTimelineState.js frontweb/test/redrawDeliveryWorkspace.test.js
git commit -m "feat(转绘): 接通生成审核与整集交付工作台"
```

## 任务 8：完成无付费的同次完整产品验收

**文件：**

- 创建：`frontweb/e2e/redraw-full-product.spec.js`
- 修改：`frontweb/e2e/fixtures/redraw-generic-project.js`
- 修改：`frontweb/e2e/redraw-backend-integration.spec.js`

- [ ] **步骤 1：建立本地假供应商**

假供应商必须通过与真实供应商相同的 adapter、task、download、candidate QA 和 billing 接口。它生成 3 个真实可解码 MP4：2 个目标语有声镜头和 1 个无对白但有环境声镜头。

- [ ] **步骤 2：编写同次端到端浏览器测试**

测试从空数据库开始：

1. 创建 `es-ES / ES` auto 项目和预算；
2. 上传 12 秒源视频；
3. 完成分析和本地化；
4. 创建 2 个角色身份、声音和服装；
5. 完成 3 镜净景和参考包；
6. 提交 3 镜生成；
7. 验证 2 个有声镜头和 1 个静默镜头；
8. 自动批准全部候选；
9. 合并整集；
10. 下载 MP4、SRT、VTT 和审计报告；
11. 使用 ffprobe 验证整集可读、时长和音轨；
12. 刷新页面后仍能从后端恢复所有状态。

- [ ] **步骤 3：运行完整本地验收**

```powershell
Set-Location backend-node
npm test
Set-Location ..
node --test frontweb/test/*.test.js
npm --prefix frontweb run build
$env:REDRAW_E2E_FAKE_PROVIDER = '1'
npm --prefix frontweb run test:e2e -- redraw-full-product.spec.js
Remove-Item Env:REDRAW_E2E_FAKE_PROVIDER
git diff --check
```

预期：全部 PASS；同一次运行产生可读整集和下载证据；没有公网请求或真实扣费。

- [ ] **步骤 4：提交完整本地验收**

```bash
git add frontweb/e2e/redraw-full-product.spec.js frontweb/e2e/fixtures/redraw-generic-project.js frontweb/e2e/redraw-backend-integration.spec.js
git commit -m "test(转绘): 验收通用短剧完整本地链路"
```

## 任务 9：执行一次受控真实供应商验收

**文件：**

- 创建：`frontweb/e2e/redraw-full-product-live.spec.js`
- 创建：`docs/superpowers/reports/redraw-full-product-acceptance-template.md`

- [ ] **步骤 1：编写默认禁用的真实验收测试**

测试入口必须同时要求：

```js
if (process.env.REDRAW_LIVE_ACCEPTANCE !== '1') test.skip();
if (process.env.REDRAW_LIVE_MAX_SUBMITS !== '1') throw new Error('live submit budget not authorized');
```

测试不读取 Key，不打印配置，不直接调用供应商；只通过本地产品 API 创建一个 5 秒镜头生成任务。

- [ ] **步骤 2：完成零提交前门禁**

在不设置 `REDRAW_LIVE_ACCEPTANCE` 的情况下运行测试，确认 skip；再只读检查：

- Fumin Seedance 2.0 Mini 480p 当前能力可见；
- 配置、模型、价格和真实证据精确绑定；
- 证据产物可读；
- 项目预算只允许 1 次提交；
- 目标镜头参考包当前有效；
- 当前没有旧 `needs_attention` 或 held reservation。

任一项失败即停止，实际提交次数保持 0。

- [ ] **步骤 3：停止并获取当次明确授权**

向用户报告只读前门禁结果，并明确请求：“授权 Fumin Seedance 2.0 Mini 480p 有声 5 秒样片，仅 1 次真实付费提交；失败不自动重试，不部署。”

没有该授权时不得执行步骤 4。

- [ ] **步骤 4：执行唯一一次真实提交**

授权后运行：

```powershell
$env:REDRAW_LIVE_ACCEPTANCE = '1'
$env:REDRAW_LIVE_MAX_SUBMITS = '1'
npm --prefix frontweb run test:e2e -- redraw-full-product-live.spec.js
Remove-Item Env:REDRAW_LIVE_ACCEPTANCE
Remove-Item Env:REDRAW_LIVE_MAX_SUBMITS
```

测试等待自然终态，不自动重试。未知结果写 `needs_attention` 并保持 held。

- [ ] **步骤 5：验证真实候选并记录报告**

成功时必须验证：文件下载可读、5 秒容差、480p、音轨存在、目标语台词、角色身份、无原人物/原文字、口型证据和候选哈希。失败时记录稳定错误码和安全阶段，不记录 Key、Authorization、供应商 URL 或本地绝对路径。

使用 `redraw-full-product-acceptance-template.md` 生成带日期报告并单独提交：

```powershell
$report = "docs/superpowers/reports/$((Get-Date).ToString('yyyy-MM-dd'))-redraw-full-product-live-acceptance.md"
git add -- $report frontweb/e2e/redraw-full-product-live.spec.js docs/superpowers/reports/redraw-full-product-acceptance-template.md
git commit -m "test(转绘): 记录真实单镜产品验收"
```

- [ ] **步骤 6：整集真实验收另行授权**

单镜成功只证明单镜产品路径。整集真实验收必须重新只读核算镜头数、最大提交次数和预算，并取得包含该上限的独立授权。整集验收仍从产品入口上传当前样片，不使用样片专用业务代码。

## 计划 3 完成标准

- 项目预算、held 金额和尝试上限在任何副作用前生效。
- 供应商 `completed` 只形成候选，不直接批准。
- 每镜媒体、身份、文字、对白、声音、字幕、口型和依赖证据均可追溯。
- A 模式人工批准，B 模式仅在全部证据通过时自动批准。
- 供应商结果不明进入 `needs_attention`，不自动重提。
- 整集只合并当前批准候选，并输出可验证 release 哈希。
- 通用 3 镜项目完成同次本地端到端验收并生成可读下载物。
- 真实 Fumin 单镜和整集验收分别受独立授权约束；未通过真实验收时不声称供应商能力或产品正式交付完成。
