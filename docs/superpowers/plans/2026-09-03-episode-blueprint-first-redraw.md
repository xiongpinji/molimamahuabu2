# 母本蓝图优先的一键转绘实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让任意短剧母本先生成完整、可审核、带音视频证据的 `episode-blueprint-v1`，再统一完成角色姓名和对白本地化，并由蓝图自动编译逐镜生产包接入现有生成与整集交付链。

**架构：** 在现有 `source_facts v2` 和转绘工作流之上增加不可变的母本蓝图层；音轨 ASR、说话人聚类、视觉/OCR/镜头证据先分别产出，再由纯函数融合并经人工锁定。现有本地化、角色资产、参考包、生成、QA、合成和导出继续复用，但只接受绑定蓝图哈希和本地化哈希的生产包。

**技术栈：** Node.js 20、Express、better-sqlite3、Vue 3、Element Plus、Playwright、Python 3、faster-whisper、torch/torchaudio、ffmpeg/ffprobe、Node `node:test`、Python `unittest`。

---

## 范围与执行约束

- 本计划只处理本地开发、测试和文档，不部署、不写生产数据库、不修改线上模型目录、不调用视频供应商、不付费。
- 固定 `redrawLatinAmericanCase` 只保留为测试 fixture；真实运行入口不得导入它。
- 每项任务按“失败测试 → 最小实现 → 通过测试 → 精确提交”执行。
- 当前工作树存在其他未提交修改。每次提交必须使用精确文件清单，禁止 `git add .`。
- 任何需要联网下载新模型的动作不属于本计划；说话人聚类使用现有 `torch/torchaudio` 的本地声学特征并保留人工审核门禁。

## 文件结构

### 新建文件

- `backend-node/src/services/redrawEpisodeBlueprintService.js`：蓝图规范化、规范哈希、锁定检查和 `source_facts v2` 兼容投影。
- `backend-node/src/services/redrawSourceAudioEvidenceService.js`：安全提取源音轨、调用本地 Worker、持久化证据资产。
- `backend-node/src/services/redrawEvidenceFusionService.js`：融合音频、视觉、OCR 和时间轴证据。
- `backend-node/src/services/redrawBlueprintWorkflowService.js`：蓝图修订、并发控制、锁定和所有者范围校验。
- `backend-node/src/services/redrawShotProductionPackService.js`：从锁定蓝图与本地化版本编译逐镜生产包。
- `backend-node/migrations/72_redraw_episode_blueprints.sql`：蓝图修订表及版本哈希绑定列。
- `backend-node/test/redrawEpisodeBlueprint.test.js`：蓝图合同测试。
- `backend-node/test/redrawSourceAudioEvidence.test.js`：Node 音轨提取与 Worker 合同测试。
- `backend-node/test/redrawEvidenceFusion.test.js`：多模态融合测试。
- `backend-node/test/redrawBlueprintWorkflow.test.js`：持久化、锁定与并发测试。
- `backend-node/test/redrawShotProductionPack.test.js`：生产包编译和哈希失效测试。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/source_evidence.py`：源音频 ASR 和声学说话人聚类。
- `workers/redraw-locale-verifier/tests/test_source_evidence.py`：Worker 源音频测试。
- `frontweb/src/components/redraw/RedrawBlueprintReviewPanel.vue`：母本反推审核界面。
- `frontweb/src/components/redraw/RedrawLocalizationReviewPanel.vue`：人物姓名与对白本地化审核界面。
- `frontweb/src/utils/redrawBlueprintReviewState.js`：前端审核状态和提交载荷纯函数。
- `frontweb/src/utils/redrawBlueprintReviewState.test.mjs`：前端纯函数测试。
- `frontweb/scripts/run-redraw-episode-blueprint-live.mjs`：读取生产包的通用整集验收启动器。
- `frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs`：启动器输入和防硬编码测试。
- `docs/verification/redraw/episode-blueprint-local-acceptance.md`：本地整集验收记录模板和结果说明。

### 修改文件

- `backend-node/src/services/redrawEpisodeFactsService.js`：允许画外音和未解决声音聚类的兼容表达。
- `backend-node/src/services/redrawNativeSourceAnalysisService.js`：接收音频证据并返回视觉事实，不再声明“没有转写”。
- `backend-node/src/services/redrawOrchestrator.js`：串联音频、视觉、融合、蓝图审核状态。
- `backend-node/src/services/localizationService.js`：绑定蓝图哈希、生成本地化哈希和锁定结果。
- `backend-node/src/services/redrawLocalizationOrchestrator.js`：只允许锁定蓝图进入本地化。
- `backend-node/src/services/redrawGenerationService.js`：只接受有效生产包且验证上游哈希。
- `backend-node/src/routes/redraw.js`：增加蓝图读取、修订、锁定和本地化锁定处理器。
- `backend-node/src/routes/index.js`：注册新增 API。
- `backend-node/src/db/migrate.js`：加入新表/列兼容检查与蓝图状态约束。
- `backend-node/test/redrawEpisodeFacts.test.js`：画外音和声音聚类回归。
- `backend-node/test/redrawNativeSourceAnalysis.test.js`：带音频证据的视觉分析测试。
- `backend-node/test/redrawAnalysis.test.js`：完整分析编排回归。
- `backend-node/test/redrawLocalization.test.js`：蓝图哈希、本地化哈希和姓名映射回归。
- `backend-node/test/redrawLocalizationOrchestration.test.js`：蓝图锁门禁回归。
- `backend-node/test/redrawGeneration.test.js`：生产包门禁和上游失效回归。
- `backend-node/test/redrawRoutes.test.js`：新增 API、所有者范围和状态返回测试。
- `backend-node/test/redrawMigration.test.js`：迁移幂等与旧数据兼容测试。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/engines.py`：增加本地 MFCC 声学特征引擎。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/server.py`：增加 `analyze_source_audio` 动作。
- `workers/redraw-locale-verifier/tests/test_server.py`：Worker 协议、安全路径和字段收敛测试。
- `backend-node/src/services/redrawLocaleVerifierClient.js`：增加源音频分析客户端方法。
- `backend-node/test/redrawLocaleVerifierClient.test.js`：新动作请求和响应校验。
- `frontweb/src/api/redraw.js`：增加蓝图和本地化审核 API。
- `frontweb/src/components/redraw/RedrawSourceStep.vue`：先审核并锁定蓝图，再进入本地化。
- `frontweb/src/views/RedrawWorkspace.vue`：展示新的审核阶段。
- `frontweb/src/utils/redrawWorkspaceState.js`：派生 `blueprint_review` 与 `localization_review`。
- `frontweb/e2e/redraw-workspace.spec.js`：审核工作台交互测试。
- `frontweb/e2e/redraw-backend-integration.spec.js`：真实后端蓝图流程测试。
- `frontweb/scripts/run-redraw-fumin-full-episode-live.mjs`：降级为兼容包装器，必须显式接收生产包。
- `frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs`：确认运行时不再隐式导入固定案例。
- `backend-node/test/featureLockManifest.test.js`：登记新增生产文件闭包。
- `backend-node/test/incrementalReleaseScope.test.js`：登记精确发布范围。
- `frontweb/package.json`：增加蓝图启动器测试脚本。

## 任务 1：建立 `episode-blueprint-v1` 纯数据合同

**文件：**

- 创建：`backend-node/src/services/redrawEpisodeBlueprintService.js`
- 创建：`backend-node/test/redrawEpisodeBlueprint.test.js`
- 修改：`backend-node/src/services/redrawEpisodeFactsService.js`
- 修改：`backend-node/test/redrawEpisodeFacts.test.js`

- [ ] **步骤 1：编写失败的蓝图规范化测试**

```js
test('normalizes a gap-free episode blueprint with off-screen and unresolved speakers', () => {
  const value = normalizeEpisodeBlueprint(fixtureBlueprint());
  assert.equal(value.schema_version, 'episode-blueprint-v1');
  assert.equal(value.shots.at(-1).end_ms, value.source.duration_ms);
  assert.equal(value.shots[0].dialogue[0].speaker_kind, 'voice_cluster');
  assert.match(value.blueprint_hash, /^[a-f0-9]{64}$/);
});

test('rejects invented dialogue without audio or subtitle evidence', () => {
  const input = fixtureBlueprint();
  input.shots[0].dialogue[0].evidence_refs = [];
  assert.throws(() => normalizeEpisodeBlueprint(input), /DIALOGUE_EVIDENCE_REQUIRED/);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
cd backend-node
node --test test/redrawEpisodeBlueprint.test.js
```

预期：FAIL，模块 `redrawEpisodeBlueprintService` 尚不存在。

- [ ] **步骤 3：实现最小蓝图规范化和哈希**

```js
function normalizeEpisodeBlueprint(raw) {
  assertExactKeys(raw, BLUEPRINT_FIELDS, 'episode_blueprint');
  const source = normalizeSource(raw.source);
  const evidence = normalizeEvidenceManifest(raw.evidence_manifest, source);
  const characters = normalizeCharacters(raw.characters, evidence);
  const shots = normalizeShots(raw.shots, source.duration_ms, characters, evidence);
  const normalized = {
    schema_version: 'episode-blueprint-v1',
    source,
    evidence_manifest: evidence,
    story: normalizeStory(raw.story),
    characters,
    scenes: normalizeScenes(raw.scenes, source.duration_ms),
    props: normalizeProps(raw.props, source.duration_ms),
    shots,
    causal_chain: normalizeStrings(raw.causal_chain),
    locked_facts: normalizeStrings(raw.locked_facts),
    reversals: normalizeStrings(raw.reversals),
    episode_hook: normalizeHook(raw.episode_hook),
    review: normalizeReview(raw.review),
  };
  normalized.blueprint_hash = sha256Canonical(normalized);
  return normalized;
}
```

实现 `assertBlueprintLockable(blueprint)`：时间轴完整、证据 SHA 合法、对白有证据、所有 `voice_cluster` 已由审核映射到角色或明确画外角色时才返回。

- [ ] **步骤 4：扩展 `source_facts v2` 兼容投影测试**

```js
test('projects locked blueprint speakers into source facts without requiring visible faces', () => {
  const facts = projectSourceFactsV2(lockedBlueprint());
  assert.equal(facts.shots[0].dialogue[0].speaker_id, 'narrator');
  assert.equal(facts.shots[0].dialogue[0].off_screen, true);
});
```

- [ ] **步骤 5：最小修改 `redrawEpisodeFactsService.js`**

允许对白字段 `speaker_kind`、`off_screen` 和 `evidence_refs`；只有 `off_screen !== true` 且 `speaker_kind === 'character'` 时才要求人物出现在 `visible_character_ids`。保持旧 `2.0` 输入兼容。

- [ ] **步骤 6：运行合同测试**

```powershell
cd backend-node
node --test test/redrawEpisodeBlueprint.test.js test/redrawEpisodeFacts.test.js
```

预期：全部 PASS。

- [ ] **步骤 7：提交**

```powershell
git add -- backend-node/src/services/redrawEpisodeBlueprintService.js backend-node/src/services/redrawEpisodeFactsService.js backend-node/test/redrawEpisodeBlueprint.test.js backend-node/test/redrawEpisodeFacts.test.js
git commit -m "feat(转绘): 建立母本蓝图数据合同"
```

## 任务 2：在本地 Worker 中提取源对白并聚类说话人

**文件：**

- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/source_evidence.py`
- 创建：`workers/redraw-locale-verifier/tests/test_source_evidence.py`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/engines.py`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/server.py`
- 修改：`workers/redraw-locale-verifier/tests/test_server.py`

- [ ] **步骤 1：编写失败的源音频证据测试**

```python
def test_analyze_source_audio_returns_timed_transcript_and_stable_clusters(self):
    result = analyze_source_audio(
        self.wav_path,
        asr=FakeAsr([
            {"start": 0.1, "end": 1.2, "text": "你回来了"},
            {"start": 1.5, "end": 2.4, "text": "我回来了"},
        ], language="zh", probability=0.99),
        clusterer=FakeClusterer([1, 0]),
    )
    self.assertEqual([row["speaker_cluster_id"] for row in result["segments"]], ["speaker-cluster-2", "speaker-cluster-1"])
    self.assertEqual(result["source_language"], "zh")
    self.assertRegex(result["transcript_sha256"], r"^[0-9a-f]{64}$")
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
Push-Location workers/redraw-locale-verifier
$env:PYTHONPATH='src'
python -m unittest discover -s tests -p 'test_source_evidence.py' -v
Pop-Location
```

预期：FAIL，`source_evidence` 尚不存在。

- [ ] **步骤 3：实现本地 MFCC 声学特征与确定性聚类**

```python
class MfccSpeakerClusterer:
    def embed(self, waveform, sample_rate):
        mono = waveform.mean(dim=0, keepdim=True)
        mfcc = torchaudio.transforms.MFCC(sample_rate=sample_rate, n_mfcc=20)(mono)
        return torch.cat((mfcc.mean(dim=-1), mfcc.std(dim=-1)), dim=-1).squeeze(0)

    def cluster(self, embeddings, threshold=0.82):
        centroids = []
        labels = []
        for embedding in embeddings:
            similarities = [cosine_similarity(embedding, center) for center in centroids]
            if not similarities or max(similarities) < threshold:
                centroids.append(embedding)
                labels.append(len(centroids) - 1)
            else:
                labels.append(max(range(len(similarities)), key=similarities.__getitem__))
        return canonicalize_cluster_labels(labels)
```

聚类只用于提出 `speaker-cluster-N`，不自动声称具体人物身份。

- [ ] **步骤 4：实现 `analyze_source_audio` 纯函数**

```python
def analyze_source_audio(audio_path, *, asr, clusterer):
    asr_result = asr.infer(audio_path)
    segments = normalize_segments(asr_result["segments"])
    waveform, sample_rate = torchaudio.load(audio_path)
    labels = clusterer.cluster(segment_embeddings(waveform, sample_rate, segments, clusterer))
    return build_source_audio_evidence(asr_result, segments, labels)
```

输出仅包含语言、置信度、分段时间码、原文、声音聚类、音频 SHA 和转写 SHA，不返回本地绝对路径。

- [ ] **步骤 5：为 Worker 协议增加新动作并测试路径约束**

```python
def test_source_audio_action_rejects_path_outside_allowed_roots(self):
    response = dispatch({"action": "analyze_source_audio", "audio_path": "/etc/passwd"})
    self.assertEqual(response["error_code"], "AUDIO_PATH_NOT_ALLOWED")
```

在 `server.py` 的动作白名单中加入 `analyze_source_audio`，复用既有私有音频根目录和大小限制。

- [ ] **步骤 6：运行 Worker 测试**

```powershell
Push-Location workers/redraw-locale-verifier
$env:PYTHONPATH='src'
python -m unittest discover -s tests -p 'test_source_evidence.py' -v
python -m unittest discover -s tests -p 'test_server.py' -v
Pop-Location
```

预期：全部 PASS，且不发生网络访问。

- [ ] **步骤 7：提交**

```powershell
git add -- workers/redraw-locale-verifier/src/redraw_locale_worker/source_evidence.py workers/redraw-locale-verifier/src/redraw_locale_worker/engines.py workers/redraw-locale-verifier/src/redraw_locale_worker/server.py workers/redraw-locale-verifier/tests/test_source_evidence.py workers/redraw-locale-verifier/tests/test_server.py
git commit -m "feat(转绘): 提取母本对白与说话人聚类"
```

## 任务 3：建立 Node 侧源音频证据服务

**文件：**

- 创建：`backend-node/src/services/redrawSourceAudioEvidenceService.js`
- 创建：`backend-node/test/redrawSourceAudioEvidence.test.js`
- 修改：`backend-node/src/services/redrawLocaleVerifierClient.js`
- 修改：`backend-node/test/redrawLocaleVerifierClient.test.js`

- [ ] **步骤 1：编写失败的音轨提取测试**

```js
test('extracts a private 16k mono wav and persists hash-bound source evidence', async (t) => {
  const result = await analyzeSourceAudio(ctx(t), {
    workId: 7,
    sourceAssetId: 11,
    tenantId: 'tenant-a',
    userId: 'user-a',
  });
  assert.equal(result.schema_version, 'redraw-source-audio-evidence-v1');
  assert.equal(result.segments[0].speaker_cluster_id, 'speaker-cluster-1');
  assert.match(result.audio_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.local_path, undefined);
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd backend-node
node --test test/redrawSourceAudioEvidence.test.js test/redrawLocaleVerifierClient.test.js
```

预期：FAIL，新服务和客户端方法不存在。

- [ ] **步骤 3：实现 Worker 客户端方法**

```js
async function analyzeSourceAudio(input) {
  return invoke({
    action: 'analyze_source_audio',
    audio_path: requiredPrivatePath(input.audioPath),
    audio_sha256: requiredSha(input.audioSha256),
  }, validateSourceAudioEvidence);
}
```

- [ ] **步骤 4：实现安全音轨提取和证据资产写入**

使用参数数组调用：

```js
await execFileChecked('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', sourcePath,
  '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath,
]);
```

要求：源路径必须位于 storage root；临时 WAV 位于专用私有根；Worker 返回后写入 `redraw-source-audio-evidence/<task-id>/audio-evidence.json`；注册为 `redraw_source_audio_evidence` 资产；无论成功失败都清理临时 WAV。

- [ ] **步骤 5：补充无音轨和结果未知测试**

```js
test('marks a source without audio as explicit silent evidence', async () => {
  const result = await analyzeSourceAudio(ctxWithoutAudio(), input);
  assert.deepEqual(result.segments, []);
  assert.equal(result.dialogue_mode, 'silent');
});

test('does not retry when worker result is unknown', async () => {
  await assert.rejects(() => analyzeSourceAudio(ctxWithUnknownWorker(), input), /SOURCE_AUDIO_RESULT_UNKNOWN/);
  assert.equal(workerCalls, 1);
});
```

- [ ] **步骤 6：运行 Node 测试**

```powershell
cd backend-node
node --test test/redrawSourceAudioEvidence.test.js test/redrawLocaleVerifierClient.test.js
```

预期：全部 PASS。

- [ ] **步骤 7：提交**

```powershell
git add -- backend-node/src/services/redrawSourceAudioEvidenceService.js backend-node/src/services/redrawLocaleVerifierClient.js backend-node/test/redrawSourceAudioEvidence.test.js backend-node/test/redrawLocaleVerifierClient.test.js
git commit -m "feat(转绘): 接入母本音频证据"
```

## 任务 4：融合音视频证据并生成母本蓝图

**文件：**

- 创建：`backend-node/src/services/redrawEvidenceFusionService.js`
- 创建：`backend-node/test/redrawEvidenceFusion.test.js`
- 修改：`backend-node/src/services/redrawNativeSourceAnalysisService.js`
- 修改：`backend-node/test/redrawNativeSourceAnalysis.test.js`
- 修改：`backend-node/src/services/redrawOrchestrator.js`
- 修改：`backend-node/test/redrawAnalysis.test.js`

- [ ] **步骤 1：编写失败的时间对齐测试**

```js
test('aligns transcript turns to shots and preserves unresolved speaker clusters', () => {
  const blueprint = fuseEpisodeEvidence({
    source: sourceProbe,
    visualFacts,
    audioEvidence,
    evidenceAssets,
  });
  assert.equal(blueprint.shots[1].dialogue[0].source_text, '我回来了');
  assert.equal(blueprint.shots[1].dialogue[0].speaker_id, 'speaker-cluster-1');
  assert.equal(blueprint.review.status, 'needs_review');
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd backend-node
node --test test/redrawEvidenceFusion.test.js
```

预期：FAIL，融合服务不存在。

- [ ] **步骤 3：实现确定性时间融合**

```js
function assignTurnToShot(turn, shots) {
  const midpoint = (turn.start_ms + turn.end_ms) / 2;
  return shots.find((shot) => midpoint >= shot.start_ms && midpoint < shot.end_ms)
    || shots.find((shot) => overlapMs(turn, shot) > 0)
    || null;
}

function fuseEpisodeEvidence(input) {
  const shots = enforceGapFreeTimeline(input.visualFacts.shots, input.source.duration_ms);
  attachTranscriptTurns(shots, input.audioEvidence.segments, input.evidenceAssets.audio);
  attachVisibleFacts(shots, input.visualFacts, input.evidenceAssets.visual);
  return normalizeEpisodeBlueprint(buildBlueprint(input, shots));
}
```

跨镜对白按最大重叠拆成引用同一源转写段的子片段；不得丢弃或复制文本。

- [ ] **步骤 4：修改视觉分析提示词并测试**

`buildPrompt(probe, audioEvidence)` 必须传入只含时间码、声音聚类和原文的证据摘要，并明确：视觉只判断镜头、动作、人物与声音聚类的可能对应，不得改写转写文本。

```js
assert.doesNotMatch(prompt, /No transcript evidence is provided here/);
assert.match(prompt, /speaker-cluster-1/);
assert.match(prompt, /Do not rewrite transcript text/);
```

- [ ] **步骤 5：调整分析编排顺序**

```js
const audioEvidence = await sourceAudioEvidenceService.analyzeSourceAudio(context, request);
const visualEvidence = await nativeSourceAnalysisService.analyzeNativeSource(context, {
  ...request,
  audioEvidence,
});
const blueprint = fuseEpisodeEvidence({ source, audioEvidence, visualFacts: visualEvidence.facts, evidenceAssets });
```

分析任务完成时返回 `blueprint_hash` 和 `review_status`，不直接启动本地化。

- [ ] **步骤 6：运行融合和分析回归**

```powershell
cd backend-node
node --test test/redrawEvidenceFusion.test.js test/redrawNativeSourceAnalysis.test.js test/redrawAnalysis.test.js
```

预期：全部 PASS；测试断言母本对白来自音频证据，不来自视觉猜测。

- [ ] **步骤 7：提交**

```powershell
git add -- backend-node/src/services/redrawEvidenceFusionService.js backend-node/src/services/redrawNativeSourceAnalysisService.js backend-node/src/services/redrawOrchestrator.js backend-node/test/redrawEvidenceFusion.test.js backend-node/test/redrawNativeSourceAnalysis.test.js backend-node/test/redrawAnalysis.test.js
git commit -m "feat(转绘): 融合母本音视频证据"
```

## 任务 5：持久化蓝图修订并增加审核 API

**文件：**

- 创建：`backend-node/migrations/72_redraw_episode_blueprints.sql`
- 创建：`backend-node/src/services/redrawBlueprintWorkflowService.js`
- 创建：`backend-node/test/redrawBlueprintWorkflow.test.js`
- 修改：`backend-node/src/db/migrate.js`
- 修改：`backend-node/test/redrawMigration.test.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：编写失败的迁移测试**

```js
test('creates immutable owner-scoped episode blueprint revisions', () => {
  migrate(db);
  const columns = columnNames(db, 'redraw_episode_blueprints');
  assert.deepEqual(columns, [
    'id', 'work_id', 'tenant_id', 'user_id', 'revision', 'status',
    'blueprint_json', 'blueprint_hash', 'evidence_manifest_json',
    'reviewed_by', 'reviewed_at', 'created_at', 'updated_at',
  ]);
  assert.ok(columnNames(db, 'redraw_versions').includes('blueprint_hash'));
  assert.ok(columnNames(db, 'redraw_versions').includes('localization_hash'));
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd backend-node
node --test test/redrawMigration.test.js
```

预期：FAIL，新表不存在。

- [ ] **步骤 3：创建迁移与兼容检查**

`72_redraw_episode_blueprints.sql` 创建修订表、`UNIQUE(work_id, revision)`、`UNIQUE(work_id, blueprint_hash)`、所有者索引，并向 `redraw_versions` 增加 `blueprint_hash`、`localization_hash` 和 `localization_review_json`。`migrate.js` 的兼容路径确保旧数据库幂等补列，不重写既有 `source_facts_json`。

- [ ] **步骤 4：编写失败的审核服务测试**

```js
test('updates a draft with CAS and locks a new immutable revision', () => {
  const draft = saveDraft(ctx, { workId, blueprint, expectedUpdatedAt });
  const locked = lockBlueprint(ctx, {
    workId,
    expectedBlueprintHash: draft.blueprint_hash,
    expectedUpdatedAt: draft.updated_at,
  });
  assert.equal(locked.status, 'locked');
  assert.throws(() => saveDraft(ctx, { workId, blueprint, expectedUpdatedAt: locked.updated_at }), /BLUEPRINT_LOCKED/);
});
```

- [ ] **步骤 5：实现所有者范围、CAS 与不可变锁定**

```js
function lockBlueprint(ctx, input) {
  const current = findOwnedDraft(ctx, input.workId);
  assertCas(current, input.expectedUpdatedAt);
  const blueprint = normalizeEpisodeBlueprint(JSON.parse(current.blueprint_json));
  assertBlueprintLockable(blueprint);
  assert.equal(blueprint.blueprint_hash, input.expectedBlueprintHash);
  return transaction(() => markLockedAndProjectFacts(ctx, current, blueprint));
}
```

- [ ] **步骤 6：增加蓝图 API 并测试**

注册：

```text
GET  /redraw/works/:id/blueprint
PUT  /redraw/works/:id/blueprint
POST /redraw/works/:id/blueprint/lock
```

PUT 只允许审核字段和事实修订，不接受 URL、路径、密钥、供应商请求或模型参数。所有接口必须校验 `tenant_id + user_id + work_id`。

- [ ] **步骤 7：运行迁移、服务和路由测试**

```powershell
cd backend-node
node --test test/redrawMigration.test.js test/redrawBlueprintWorkflow.test.js test/redrawRoutes.test.js
```

预期：全部 PASS。

- [ ] **步骤 8：提交**

```powershell
git add -- backend-node/migrations/72_redraw_episode_blueprints.sql backend-node/src/db/migrate.js backend-node/src/services/redrawBlueprintWorkflowService.js backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawMigration.test.js backend-node/test/redrawBlueprintWorkflow.test.js backend-node/test/redrawRoutes.test.js
git commit -m "feat(转绘): 增加母本蓝图审核门禁"
```

## 任务 6：实现母本蓝图审核界面

**文件：**

- 创建：`frontweb/src/components/redraw/RedrawBlueprintReviewPanel.vue`
- 创建：`frontweb/src/utils/redrawBlueprintReviewState.js`
- 创建：`frontweb/src/utils/redrawBlueprintReviewState.test.mjs`
- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/src/components/redraw/RedrawSourceStep.vue`
- 修改：`frontweb/src/views/RedrawWorkspace.vue`
- 修改：`frontweb/src/utils/redrawWorkspaceState.js`
- 修改：`frontweb/e2e/redraw-workspace.spec.js`

- [ ] **步骤 1：编写失败的前端状态测试**

```js
test('blocks localization until the blueprint is locked', () => {
  assert.equal(canStartLocalization({ blueprint: { status: 'review' } }), false);
  assert.equal(canStartLocalization({ blueprint: { status: 'locked' } }), true);
});

test('builds a CAS-safe blueprint review payload', () => {
  assert.deepEqual(buildBlueprintSavePayload(review), {
    expected_updated_at: review.updated_at,
    blueprint: review.blueprint,
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
node --test frontweb/src/utils/redrawBlueprintReviewState.test.mjs
```

预期：FAIL，新工具模块不存在。

- [ ] **步骤 3：实现纯状态函数和 API**

```js
getBlueprint(workId) {
  return request.get(`/redraw/works/${workId}/blueprint`)
},
saveBlueprint(workId, body) {
  return request.put(`/redraw/works/${workId}/blueprint`, body)
},
lockBlueprint(workId, body) {
  return request.post(`/redraw/works/${workId}/blueprint/lock`, body)
},
```

- [ ] **步骤 4：实现审核组件**

组件展示：源片播放器；剧情、因果链、角色与关系；按时间排列的镜头；原对白、说话人/声音聚类、画内外标记；OCR；各字段证据和置信度。未解决声音聚类必须显示醒目阻断项，并提供映射到角色或创建画外角色的编辑操作。

- [ ] **步骤 5：调整源片步骤状态**

`analysis_review` 显示蓝图审核组件；锁定成功后才显示本地化报价和提交按钮。`redrawWorkspaceState` 将后端蓝图状态派生为 `blueprint_review` 或 `blueprint_locked`。

- [ ] **步骤 6：编写 Playwright 审核流程**

```js
await expect(page.getByText('母本反推审核')).toBeVisible();
await expect(page.getByText('speaker-cluster-1')).toBeVisible();
await expect(page.getByRole('button', { name: '开始本地化' })).toBeDisabled();
await page.getByLabel('speaker-cluster-1 映射角色').click();
await page.getByRole('option', { name: '男主' }).click();
await page.getByRole('button', { name: '锁定母本蓝图' }).click();
await expect(page.getByRole('button', { name: '开始本地化' })).toBeEnabled();
```

- [ ] **步骤 7：运行前端测试和构建**

```powershell
node --test frontweb/src/utils/redrawBlueprintReviewState.test.mjs
cd frontweb
npx playwright test e2e/redraw-workspace.spec.js --workers=1
npm run build
```

预期：测试全部 PASS，构建成功。

- [ ] **步骤 8：提交**

```powershell
git add -- frontweb/src/components/redraw/RedrawBlueprintReviewPanel.vue frontweb/src/utils/redrawBlueprintReviewState.js frontweb/src/utils/redrawBlueprintReviewState.test.mjs frontweb/src/api/redraw.js frontweb/src/components/redraw/RedrawSourceStep.vue frontweb/src/views/RedrawWorkspace.vue frontweb/src/utils/redrawWorkspaceState.js frontweb/e2e/redraw-workspace.spec.js
git commit -m "feat(转绘): 增加母本蓝图审核界面"
```

## 任务 7：锁定人物姓名和目标对白本地化版本

**文件：**

- 创建：`frontweb/src/components/redraw/RedrawLocalizationReviewPanel.vue`
- 修改：`backend-node/src/services/localizationService.js`
- 修改：`backend-node/src/services/redrawLocalizationOrchestrator.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawLocalization.test.js`
- 修改：`backend-node/test/redrawLocalizationOrchestration.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`
- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/src/components/redraw/RedrawSourceStep.vue`
- 修改：`frontweb/e2e/redraw-workspace.spec.js`

- [ ] **步骤 1：编写失败的蓝图绑定测试**

```js
test('localization is bound to the locked blueprint and hashes all target mappings', () => {
  const localized = normalizeLocalizationResultV2(result, blueprintFacts, {
    locale: 'en-US',
    market: 'US',
    blueprintHash: BLUEPRINT_HASH,
  });
  assert.equal(localized.blueprint_hash, BLUEPRINT_HASH);
  assert.match(localized.localization_hash, /^[a-f0-9]{64}$/);
  assert.equal(localized.character_name_map.c1, 'Mateo');
});

test('rejects localization against an unlocked or changed blueprint', async () => {
  await assert.rejects(() => startLocalization(ctx, input), /BLUEPRINT_NOT_LOCKED|BLUEPRINT_HASH_MISMATCH/);
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd backend-node
node --test test/redrawLocalization.test.js test/redrawLocalizationOrchestration.test.js
```

预期：FAIL，结果没有蓝图哈希或本地化哈希。

- [ ] **步骤 3：扩展本地化输入与规范化**

```js
return {
  schema_version: 'episode-localization-v1',
  blueprint_hash: requiredSha(options.blueprintHash),
  locale,
  market,
  character_name_map: normalizeV2NameMap(raw.name_map, sourceFacts),
  dialogue_map: normalizeV2Dialogue(raw.dialogue, sourceFacts, locale),
  text_region_map: normalizeV2TextMap(raw.text_map, sourceFacts),
  cultural_adaptations: normalizeCultureMap(raw.culture_map),
  glossary: normalizeGlossary(raw.glossary),
  locked_terms: normalizeLockedTerms(raw.locked_terms || []),
  review: { status: 'review' },
};
```

计算 `localization_hash` 时排除审核时间等易变字段。姓名映射必须精确覆盖所有角色，目标名称不得重复，源角色名不得残留在目标对白中。

- [ ] **步骤 4：增加本地化审核锁 API**

注册：

```text
GET  /redraw/versions/:id/localization
PUT  /redraw/versions/:id/localization
POST /redraw/versions/:id/localization/lock
```

锁定时验证 `blueprint_hash`、当前 `localization_hash` 和 `expected_updated_at`；成功后将版本推进到 `asset_review`。

- [ ] **步骤 5：实现本地化并排审核组件**

界面按源角色 ID 集中编辑目标姓名；按源对白 ID 并排展示原文、目标文、说话人、时间码、预计语速和情绪；任何未审核项阻止锁定。

- [ ] **步骤 6：运行后端与前端审核测试**

```powershell
cd backend-node
node --test test/redrawLocalization.test.js test/redrawLocalizationOrchestration.test.js test/redrawRoutes.test.js
cd ..\frontweb
npx playwright test e2e/redraw-workspace.spec.js --workers=1
npm run build
```

预期：全部 PASS；本地化未锁定时资产和生成步骤不可进入。

- [ ] **步骤 7：提交**

```powershell
git add -- backend-node/src/services/localizationService.js backend-node/src/services/redrawLocalizationOrchestrator.js backend-node/src/routes/redraw.js backend-node/src/routes/index.js backend-node/test/redrawLocalization.test.js backend-node/test/redrawLocalizationOrchestration.test.js backend-node/test/redrawRoutes.test.js frontweb/src/components/redraw/RedrawLocalizationReviewPanel.vue frontweb/src/api/redraw.js frontweb/src/components/redraw/RedrawSourceStep.vue frontweb/e2e/redraw-workspace.spec.js
git commit -m "feat(转绘): 锁定全剧人物与对白本地化"
```

## 任务 8：从蓝图编译逐镜生产包并接入生成门禁

**文件：**

- 创建：`backend-node/src/services/redrawShotProductionPackService.js`
- 创建：`backend-node/test/redrawShotProductionPack.test.js`
- 修改：`backend-node/src/services/localizationService.js`
- 修改：`backend-node/src/services/redrawGenerationService.js`
- 修改：`backend-node/test/redrawGeneration.test.js`

- [ ] **步骤 1：编写失败的生产包测试**

```js
test('compiles every shot from locked blueprint and localization hashes', () => {
  const packs = compileEpisodeProductionPacks({ blueprint, localization, assets, references });
  assert.equal(packs.length, blueprint.shots.length);
  assert.equal(packs[0].blueprint_hash, blueprint.blueprint_hash);
  assert.equal(packs[0].localization_hash, localization.localization_hash);
  assert.equal(packs[0].dialogue[0].text, 'I came back.');
  assert.doesNotMatch(packs[0].prompt, /男主|我回来了/);
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd backend-node
node --test test/redrawShotProductionPack.test.js test/redrawGeneration.test.js
```

预期：FAIL，生产包服务不存在。

- [ ] **步骤 3：实现逐镜编译器**

```js
function compileShotProductionPack({ shot, blueprint, localization, assets, referenceBundle }) {
  return hashPack({
    schema_version: 'redraw-shot-production-pack-v1',
    shot_id: shot.id,
    start_ms: shot.start_ms,
    end_ms: shot.end_ms,
    duration_ms: shot.end_ms - shot.start_ms,
    blueprint_hash: blueprint.blueprint_hash,
    localization_hash: localization.localization_hash,
    characters: resolveShotCharacters(shot, localization.character_name_map, assets),
    dialogue: resolveShotDialogue(shot, localization.dialogue_map),
    visual_contract: visualContract(shot, assets, referenceBundle),
    audio_contract: audioContract(shot, localization),
    prompt: compilePrompt(shot, localization, assets, referenceBundle),
  });
}
```

提示词必须从结构化字段生成，不读取固定案例或全局名字常量。

- [ ] **步骤 4：把生产包写入现有 shot 快照**

本地化锁定后事务性编译全部镜头，将包写入 `compiled_prompt_json`，并把 `production_pack_hash`、`blueprint_hash` 和 `localization_hash` 放入 `preparation_snapshot_json`。

- [ ] **步骤 5：更新生成门禁**

```js
assert.equal(pack.blueprint_hash, lockedBlueprint.blueprint_hash);
assert.equal(pack.localization_hash, version.localization_hash);
assert.equal(pack.production_pack_hash, sha256Canonical(withoutHash(pack)));
```

任一不一致返回 `REDRAW_PRODUCTION_PACK_STALE`，保持零生成提交、零积分预留。

- [ ] **步骤 6：运行生产包和生成回归**

```powershell
cd backend-node
node --test test/redrawShotProductionPack.test.js test/redrawGeneration.test.js test/redrawPreparationGate.test.js
```

预期：全部 PASS，且门禁失败测试断言 provider 调用次数为 0。

- [ ] **步骤 7：提交**

```powershell
git add -- backend-node/src/services/redrawShotProductionPackService.js backend-node/src/services/localizationService.js backend-node/src/services/redrawGenerationService.js backend-node/test/redrawShotProductionPack.test.js backend-node/test/redrawGeneration.test.js
git commit -m "feat(转绘): 从母本蓝图编译逐镜生产包"
```

## 任务 9：移除真实运行入口对固定九镜 fixture 的依赖

**文件：**

- 创建：`frontweb/scripts/run-redraw-episode-blueprint-live.mjs`
- 创建：`frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs`
- 修改：`frontweb/scripts/run-redraw-fumin-full-episode-live.mjs`
- 修改：`frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs`
- 修改：`frontweb/package.json`
- 修改：`frontweb/e2e/redraw-backend-integration.spec.js`

- [ ] **步骤 1：编写失败的启动器输入测试**

```js
test('requires a hash-bound episode package and never imports the Latin American fixture', async () => {
  const source = await readFile(new URL('./run-redraw-episode-blueprint-live.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /redrawLatinAmericanCase|redraw-latin-american-case/);
  assert.throws(() => parseArgs([]), /--episode-package/);
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
node --test frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs
```

预期：FAIL，通用启动器不存在。

- [ ] **步骤 3：实现通用启动器**

启动器仅接受：

```text
--episode-package <absolute-json-path>
--state-dir <absolute-isolated-directory>
--stage preflight|shot|assemble|verify
--shot-id <stable-shot-id>
```

加载时验证 `schema_version`、`blueprint_hash`、`localization_hash`、全部 `production_pack_hash`、源素材 SHA 和输出目录隔离。它调用现有上传、生成、轮询、下载和验收函数，但所有人物、对白、镜头和提示词均来自生产包。

- [ ] **步骤 4：把旧 Fumin 脚本改为兼容包装器**

```js
import { main } from './run-redraw-episode-blueprint-live.mjs';

main(process.argv.slice(2), { provider: 'fumin' }).catch(failClosed);
```

旧脚本不得导入 fixture；测试 fixture 由测试命令显式编译为临时 episode package 后传入。

- [ ] **步骤 5：增加真实后端零供应商端到端测试**

Playwright 流程上传本地测试母本，注入确定性音频/视觉假实现，完成蓝图审核、本地化审核和生产包生成；拦截供应商路由并断言请求次数为 0。

- [ ] **步骤 6：运行启动器与后端集成测试**

```powershell
node --test frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs
cd frontweb
npx playwright test e2e/redraw-backend-integration.spec.js --workers=1
```

预期：全部 PASS；源码扫描确认真实启动器不包含 Mateo 等固定人名。

- [ ] **步骤 7：提交**

```powershell
git add -- frontweb/scripts/run-redraw-episode-blueprint-live.mjs frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs frontweb/scripts/run-redraw-fumin-full-episode-live.mjs frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs frontweb/package.json frontweb/e2e/redraw-backend-integration.spec.js
git commit -m "refactor(转绘): 以母本生产包驱动整集运行"
```

## 任务 10：完成全量本地回归和整集蓝图验收

**文件：**

- 创建：`docs/verification/redraw/episode-blueprint-local-acceptance.md`
- 修改：`backend-node/test/featureLockManifest.test.js`
- 修改：`backend-node/test/incrementalReleaseScope.test.js`

- [ ] **步骤 1：登记精确特性闭包并先运行失败测试**

在两个清单测试中列入任务 1–9 的新增生产文件和迁移文件，不纳入测试输出、临时媒体、密钥或本地验收数据库。

```powershell
cd backend-node
node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
```

预期：首次运行因清单尚未更新而 FAIL；更新精确路径后 PASS。

- [ ] **步骤 2：运行 Worker 全量测试**

```powershell
Push-Location workers/redraw-locale-verifier
$env:PYTHONPATH='src'
python -m unittest discover -s tests -p 'test_*.py' -v
Pop-Location
```

预期：全部执行项 PASS；环境条件不具备的模型兼容项只能按既有明确 skip 条件跳过。

- [ ] **步骤 3：运行后端全量测试**

```powershell
cd backend-node
npm test
```

预期：退出码 0，无失败测试。

- [ ] **步骤 4：运行前端纯函数、E2E 与构建**

```powershell
node --test frontweb/src/utils/redrawBlueprintReviewState.test.mjs frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs
cd frontweb
npx playwright test e2e/redraw-workspace.spec.js e2e/redraw-backend-integration.spec.js e2e/redraw-full-product.spec.js --workers=1
npm run build
```

预期：退出码 0，生产构建成功。

- [ ] **步骤 5：使用用户母本完成本地隔离蓝图验收**

输入：`C:\Users\canqu\Desktop\ac087bcd4cf5f856f85182834794853a.mp4`

输出目录使用新的本地隔离路径，不写生产数据库。验收程序必须生成并验证：

```text
source-media.json
audio-evidence.json
visual-evidence.json
episode-blueprint-v1.json
episode-localization-en-US-v1.json
shot-production-packs.json
acceptance-report.json
SHA256SUMS
```

断言：蓝图覆盖 0 到源片完整时长；所有可听对白具有原文、时间码和人物或声音聚类；人物名称映射全剧唯一；目标对白逐句引用源对白；生产包数量等于蓝图镜头数；本阶段供应商提交次数为 0。

- [ ] **步骤 6：记录验收证据**

`episode-blueprint-local-acceptance.md` 记录源 SHA、源码 HEAD、执行命令、产物目录、各产物 SHA、镜头数、对白数、未解决审核项、测试结果和明确边界。不得记录密钥、完整供应商请求或生产数据。

- [ ] **步骤 7：运行差异审计**

```powershell
git diff --check
git status --short
git diff --name-only HEAD~10..HEAD
```

逐项确认每个文件都能追溯到本规格，现有无关工作树修改未被提交。

- [ ] **步骤 8：提交最终本地验收与清单**

```powershell
git add -- backend-node/test/featureLockManifest.test.js backend-node/test/incrementalReleaseScope.test.js docs/verification/redraw/episode-blueprint-local-acceptance.md
git commit -m "test(转绘): 锁定母本蓝图整集验收"
```

## 最终完成门禁

只有同时满足以下条件才能报告“母本反推与一键转绘主链本地开发完成”：

1. 母本蓝图合同、音频证据、视觉融合、审核、锁定、本地化和生产包测试全部通过。
2. 用户母本已实际产出完整蓝图、本地化版本和全部逐镜生产包。
3. 真实产品入口不再导入固定九镜 fixture。
4. 所有未解决人物或说话人均明确列入审核报告，没有被模型猜测填充。
5. 后端全量测试、Worker 全量测试、前端目标 E2E 和生产构建全部通过。
6. 全过程供应商视频生成提交为 0；真实视频生成属于后续独立授权和验收阶段。
