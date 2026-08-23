# 转绘 V2 目标侧对白绑定实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用当前服务端 V2 本地化数据生成可复核的目标侧对白绑定，淘汰依赖不可变源事实中伪造哈希的参考包合同，并恢复通用三镜本地端到端验收。

**架构：** `redrawReferenceBundleService` 负责规范化当前 version/shot 的姓名、源对白和目标对白，并生成 `redraw-localization-binding-v1` 与 `redraw-reference-bundle-v2`。`redrawGenerationService` 只消费安全投影并在请求复用、事务前和事务内核对完整绑定。现有 SQLite 列继续保存 bundle JSON 和请求快照，不增加迁移；旧 V1 参考包和旧 generation 快照均 fail-closed。

**技术栈：** Node.js 20+、CommonJS、`node:test`、`better-sqlite3`、Express、Playwright、Sharp、FFmpeg/FFprobe、Vite。

---

## 规格基线与工作树约束

- 规格：`docs/superpowers/specs/2026-08-23-redraw-v2-localization-dialogue-binding-design.md`
- 工作树：`worktrees/pr171-live-full-semantic-merge-20260822`
- 当前分支：`codex/redraw-complete-delivery-20260822`
- 当前本地规格提交：`bf45322c`
- PR：`#184`，保持 Draft；本计划不授权 push、Ready、merge 或 deploy。
- 以下三个 Task8 文件是用户已知的暂停现场，开始任务 4 前不得回退、格式化、暂存或提交：
  - `backend-node/test/redrawReferenceBundleLocalCase.test.js`
  - `frontweb/e2e/fixtures/redraw-generic-project.js`
  - `frontweb/e2e/redraw-backend-integration.spec.js`
- 以下三个 `__pycache__` 目录为预存未跟踪项，所有任务均不得触碰。
- 全过程供应商调用、付费、SSH、生产数据库写入、部署和 activate 必须保持 0。

## 文件职责

### 任务 1：参考包 V2 目标绑定

- 修改：`backend-node/src/services/redrawReferenceBundleService.js`
  - 规范姓名、源对白和目标对白；
  - 生成四个组成哈希和总绑定；
  - 升级 bundle schema；
  - 保存和重读时重算当前绑定。
- 修改：`backend-node/test/redrawReferenceBundle.test.js`
  - 删除人工源事实哈希夹具；
  - 锁定 V2、漂移、旧包、静默、多 locale 和脱敏合同。
- 修改：`backend-node/scripts/run-redraw-reference-bundle-local-case.js`
  - 删除本地 runner 中伪造的源事实目标哈希；
  - 继续使用正式参考包服务构造本地证据。

### 任务 2：生成快照与付费前复核

- 修改：`backend-node/src/services/redrawGenerationService.js`
  - 把 V2 目标绑定加入 request snapshot 精确复用比较。
- 修改：`backend-node/test/redrawGeneration.test.js`
  - 锁定缺字段旧快照不复用；
  - 锁定事务间对白漂移零 reservation/attempt/schedule。

### 任务 3：真实三镜 Task8 验收

- 修改并提交暂停现场：`backend-node/test/redrawReferenceBundleLocalCase.test.js`
  - 固化通用三镜 fixture 与 V2 bundle 字段。
- 修改并提交暂停现场：`frontweb/e2e/fixtures/redraw-generic-project.js`
  - 只提供真实 V2 source facts、es-ES 本地化和本地媒体定义，不提供目标哈希。
- 修改并提交暂停现场：`frontweb/e2e/redraw-backend-integration.spec.js`
  - 完成真实 SQLite、角色包、净景、运动参考和三镜 V2 bundle 链；
  - 验证漂移恢复和零外部调用。

### 任务 4：证据报告与完整回归

- 创建：`docs/verification/redraw/v2-localization-dialogue-binding-20260823.md`
  - 记录同次命令、测试统计、三镜链路、零调用边界和未完成的真实供应商/整集交付边界。
- 只读验证：`docs/verification/platform-stability/feature-lock-manifest.json`
  - 只运行审计；若返回 `FEATURE_LOCKED`，停止并请求新的特性锁授权，不得修改或弱化审计器。

---

### 任务 1：实现参考包 V2 目标侧绑定

**文件：**
- 修改：`backend-node/test/redrawReferenceBundle.test.js:40-205,580-1030,1360-1390`
- 修改：`backend-node/src/services/redrawReferenceBundleService.js:8-100,550-570,786-835,875-1015,1120-1140`
- 修改：`backend-node/scripts/run-redraw-reference-bundle-local-case.js:25-40,360-410,500-610`

- [ ] **步骤 1：把测试夹具改为真实 V2 源事实并先建立红灯**

在 `redrawReferenceBundle.test.js` 中把 `sourceFacts()` 改为不含目标侧哈希的真实最小事实：

```js
function sourceFacts(_nameMap, overrides = {}) {
  return {
    schema_version: '2.0',
    duration_ms: 5000,
    characters: [
      { id: 'character-001', source_name: '角色一', display_name: '角色一', relationship: '主角' },
      { id: 'character-002', source_name: '角色二', display_name: '角色二', relationship: '证人' },
    ],
    shots: [{
      id: 'shot-001',
      index: 1,
      start_ms: 0,
      end_ms: 5000,
      dialogue: [{
        id: 'turn-001',
        speaker_id: 'character-001',
        source_text: '跟我走。',
        start_ms: 0,
        end_ms: 2400,
      }],
    }],
    ...overrides,
  };
}
```

把成功断言改为 V2，并按当前规范数据在测试侧独立计算期望值：

```js
const canonicalSource = [{
  id: '',
  speaker_id: 'character-001',
  source_text: '跟我走。',
  start_ms: 0,
  end_ms: 2400,
}];
const canonicalLocalized = [
  { speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 0, end_ms: 2400 },
  { speaker_id: 'character-002', localized_text: 'Not without proof.', start_ms: 2500, end_ms: 5000 },
];
assert.equal(bundle.schema_version, 'redraw-reference-bundle-v2');
assert.equal(bundle.dialogue.source_dialogue_sha256, sha256(stableJson(canonicalSource)));
assert.equal(bundle.dialogue.script_sha256, sha256(stableJson(canonicalLocalized)));
assert.match(bundle.dialogue.localization_binding_sha256, /^[a-f0-9]{64}$/);
assert.equal(bundle.dialogue.target_market, 'US');
const persistedFacts = JSON.parse(state.db.prepare(
  'SELECT source_facts_json FROM redraw_versions WHERE id = ?',
).get(state.versionId).source_facts_json);
assert.equal(Object.hasOwn(persistedFacts, 'script_sha256'), false);
assert.equal(Object.hasOwn(persistedFacts, 'name_map_source_sha256'), false);
```

规范函数对缺失的源 turn `id` 固定写入空字符串；测试夹具保持无 `id`，因此上面的期望值固定为 `id: ''`。

- [ ] **步骤 2：运行目标测试确认旧实现失败**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 test/redrawReferenceBundle.test.js
```

预期：FAIL。至少出现 `REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED` 或 schema 实际为 `redraw-reference-bundle-v1`；不得是测试语法错误、fixture 路径错误或数据库迁移错误。

- [ ] **步骤 3：增加漂移、旧 V1 和多 locale 红灯**

在同一测试文件加入表驱动测试：

```js
test('V2 目标绑定任一当前组成漂移都拒绝旧参考包', async () => {
  const cases = [
    ['name map', (state) => state.db.prepare('UPDATE redraw_versions SET name_map_json = ? WHERE id = ?')
      .run(JSON.stringify({ 'character-001': 'Ethan II', 'character-002': 'Maya' }), state.versionId)],
    ['localized dialogue', (state) => state.db.prepare('UPDATE redraw_shots SET localized_dialogue_json = ? WHERE id = ?')
      .run(JSON.stringify([{ speaker_id: 'character-001', localized_text: 'Wait.', start_ms: 0, end_ms: 2400 }]), state.shotId)],
    ['source dialogue', (state) => state.db.prepare('UPDATE redraw_shots SET source_dialogue_json = ? WHERE id = ?')
      .run(JSON.stringify([{ speaker_id: 'character-001', text: '等一下。', start_ms: 0, end_ms: 2400 }]), state.shotId)],
    ['locale', (state) => state.db.prepare("UPDATE redraw_versions SET locale = 'es-MX' WHERE id = ?").run(state.versionId)],
    ['market', (state) => state.db.prepare("UPDATE redraw_versions SET market = 'MX' WHERE id = ?").run(state.versionId)],
    ['facts hash', (state) => state.db.prepare('UPDATE redraw_versions SET facts_hash = ? WHERE id = ?')
      .run('f'.repeat(64), state.versionId)],
    ['timeline', (state) => state.db.prepare('UPDATE redraw_shots SET end_ms = 4900, duration_ms = 4900 WHERE id = ?')
      .run(state.shotId)],
  ];
  for (const [name, mutate] of cases) {
    const state = setup();
    try {
      await saveReferenceBundle(ctx(state), validInput(state));
      mutate(state);
      await assert.rejects(
        () => loadCurrentReferenceBundle(ctx(state), state.shotId),
        (error) => error.code === 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED',
        name,
      );
    } finally {
      state.cleanup();
    }
  }
});

test('旧 V1 包即使重算 bundle hash 也要求重建', async () => {
  const state = setup();
  try {
    await saveReferenceBundle(ctx(state), validInput(state));
    const row = state.db.prepare('SELECT reference_bundle_json FROM redraw_shots WHERE id = ?').get(state.shotId);
    const legacy = JSON.parse(row.reference_bundle_json);
    legacy.schema_version = 'redraw-reference-bundle-v1';
    delete legacy.dialogue.source_dialogue_sha256;
    delete legacy.dialogue.localization_binding_sha256;
    state.db.prepare('UPDATE redraw_shots SET reference_bundle_json = ?, reference_bundle_hash = ? WHERE id = ?')
      .run(JSON.stringify(legacy), canonicalBundleHash(legacy), state.shotId);
    await assert.rejects(
      () => loadCurrentReferenceBundle(ctx(state), state.shotId),
      (error) => error.code === 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND',
    );
  } finally {
    state.cleanup();
  }
});
```

把既有 `es-ES/ES` 与静默测试扩展为精确断言 `target_market`、四个哈希和总绑定。保留中文、路径、URL、Key、Authorization 脱敏断言。

- [ ] **步骤 4：运行新增用例确认红灯原因正确**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 --test-name-pattern="V2|旧 V1|es-ES|静默" test/redrawReferenceBundle.test.js
```

预期：新增用例 FAIL，失败只来自缺少 V2 绑定或旧实现仍读取源事实目标哈希。

- [ ] **步骤 5：在参考包服务实现最小规范化与绑定**

在 `redrawReferenceBundleService.js` 中把 schema 改为 V2，并增加内部函数。不要导出客户端可调用的 hash override：

```js
const SCHEMA_VERSION = 'redraw-reference-bundle-v2';
const LOCALIZATION_BINDING_CONTRACT = 'redraw-localization-binding-v1';

function normalizeNameMap(value) {
  assertPlainObject(value, DIALOGUE_CODE);
  const out = {};
  for (const rawKey of Object.keys(value).sort()) {
    const key = String(rawKey).trim();
    const name = String(value[rawKey] || '').trim();
    if (!key || !name || Object.hasOwn(out, key) || containsChinese(name)) fail(DIALOGUE_CODE);
    out[key] = name;
  }
  return out;
}

function canonicalSourceDialogue(value, durationMs) {
  return parseDialogueArray(value).map((entry) => {
    assertPlainObject(entry, DIALOGUE_CODE);
    const normalized = {
      id: String(entry.id || '').trim(),
      speaker_id: String(entry.speaker_id || '').trim(),
      source_text: String(entry.source_text ?? entry.text ?? '').trim(),
      start_ms: Number(entry.start_ms),
      end_ms: Number(entry.end_ms),
    };
    if (!normalized.speaker_id || !normalized.source_text
      || !Number.isInteger(normalized.start_ms) || !Number.isInteger(normalized.end_ms)
      || normalized.start_ms < 0 || normalized.start_ms >= normalized.end_ms
      || normalized.end_ms > durationMs) fail(DIALOGUE_CODE);
    return normalized;
  }).sort((a, b) => a.start_ms - b.start_ms
    || a.end_ms - b.end_ms
    || a.speaker_id.localeCompare(b.speaker_id)
    || a.id.localeCompare(b.id));
}

function localizationBinding(shot, canonicalNameMap, sourceDialogue, localizedDialogue) {
  const sourceDialogueSha256 = sha256(stableJson(sourceDialogue));
  const scriptSha256 = sha256(stableJson(localizedDialogue));
  const characterNameMapSha256 = sha256(stableJson(canonicalNameMap));
  const binding = {
    contract: LOCALIZATION_BINDING_CONTRACT,
    version_id: Number(shot.version_id),
    facts_hash: String(shot.facts_hash || ''),
    target: { locale: normalizeLocale(shot.locale), market: normalizeMarket(shot.market) },
    shot: {
      id: Number(shot.id),
      shot_id: String(shot.shot_id || '').trim(),
      start_ms: Number(shot.start_ms),
      end_ms: Number(shot.end_ms),
      duration_ms: Number(shot.duration_ms),
    },
    source_dialogue_sha256: sourceDialogueSha256,
    script_sha256: scriptSha256,
    character_name_map_sha256: characterNameMapSha256,
  };
  if (!HEX_64.test(binding.facts_hash) || !binding.shot.shot_id) fail(DIALOGUE_CODE);
  return {
    ...binding,
    localization_binding_sha256: sha256(stableJson(binding)),
  };
}
```

重写 `verifyDialogue()`：

1. 先规范 name map、源对白和目标对白；
2. 保持源/目标同为静默或同为有声；
3. 有声目标对白继续执行说话人、文字、时间和身份绑定检查；
4. 用最终排序后的目标 turns 计算绑定；
5. 返回 `target_market`、`source_dialogue_sha256`、`script_sha256`、`character_name_map_sha256` 和 `localization_binding_sha256`。

构建 bundle 时使用规范 name map，而不是原始 parse 结果。`classifyBundleMismatch()` 继续把 dialogue/name map 漂移映射为 `REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED`。旧 schema 在 `loadCurrentReferenceBundle()` 入口继续映射为 `REDRAW_REFERENCE_BUNDLE_NOT_FOUND`。

- [ ] **步骤 6：删除本地 runner 的伪造目标哈希**

把 runner 的常量改成真正的 V2 源事实：

```js
const SOURCE_FACTS = Object.freeze({
  schema_version: '2.0',
  duration_ms: 5000,
  characters: [
    { id: 'character-001', source_name: '角色一', display_name: '角色一', relationship: '主角' },
    { id: 'character-002', source_name: '角色二', display_name: '角色二', relationship: '证人' },
  ],
});
```

不要在 runner 中计算或写入 `script_sha256`、`name_map_source_sha256` 或 `localization_binding_sha256`；后者只能由正式服务生成。

- [ ] **步骤 7：运行参考包与本地 runner 联合绿灯**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 test/redrawReferenceBundle.test.js test/redrawReferenceBundleLocalCase.test.js test/redrawMotionReference.test.js
```

预期：全部 PASS；本地 runner 不联网、不读取 Key，manifest 内 bundle schema 为 V2。若暂停中的 `redrawReferenceBundleLocalCase.test.js` 因 Task8 新断言失败，只修生产 V2 合同相关原因，不回退其 34 行暂停现场。

- [ ] **步骤 8：静态检查并提交任务 1**

运行：

```powershell
node --check backend-node/src/services/redrawReferenceBundleService.js
node --check backend-node/scripts/run-redraw-reference-bundle-local-case.js
node --check backend-node/test/redrawReferenceBundle.test.js
git diff --check -- backend-node/src/services/redrawReferenceBundleService.js backend-node/test/redrawReferenceBundle.test.js backend-node/scripts/run-redraw-reference-bundle-local-case.js
```

只暂存三个任务 1 文件，确认 `git diff --cached --name-only` 精确后提交：

```powershell
git add -- backend-node/src/services/redrawReferenceBundleService.js backend-node/test/redrawReferenceBundle.test.js backend-node/scripts/run-redraw-reference-bundle-local-case.js
git commit -m "feat(转绘): 绑定当前目标对白证据"
```

---

### 任务 2：固化生成请求快照与付费前双检

**文件：**
- 修改：`backend-node/test/redrawGeneration.test.js:620-780,5180-5480`
- 修改：`backend-node/src/services/redrawGenerationService.js:507-575,730-780,830-990`

- [ ] **步骤 1：先把现有成功快照断言升级为 V2 红灯**

在 `redrawGeneration.test.js` 的 reference bundle 成功测试中断言：

```js
assert.equal(snapshot.reference_bundle.schema_version, 'redraw-reference-bundle-v2');
assert.equal(snapshot.reference_bundle.dialogue_kind, 'spoken');
assert.equal(snapshot.reference_bundle.speech_required, true);
assert.match(snapshot.reference_bundle.source_dialogue_sha256, /^[a-f0-9]{64}$/);
assert.match(snapshot.reference_bundle.dialogue_script_sha256, /^[a-f0-9]{64}$/);
assert.match(snapshot.reference_bundle.character_name_map_sha256, /^[a-f0-9]{64}$/);
assert.match(snapshot.reference_bundle.localization_binding_sha256, /^[a-f0-9]{64}$/);
```

并把 `setupReferenceBundleGenerationFixture()` 的 `sourceFacts` 改为不含两个旧目标哈希的 V2 事实。不能用测试 UPDATE 把目标哈希塞回源事实。

- [ ] **步骤 2：运行成功链确认请求快照红灯**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 --test-name-pattern="reference bundle required 的单镜生成" test/redrawGeneration.test.js
```

预期：FAIL，原因是旧快照 schema 或缺少 V2 绑定字段。

- [ ] **步骤 3：增加旧快照不复用和事务间漂移红灯**

先在测试文件内提取固定依赖 helper，再增加两个行为测试：

```js
function referenceBundleGenerationDeps(state, overrides = {}) {
  return {
    storageRoot: state.storageRoot,
    versionId: state.versionId,
    probeRunner: async () => ({
      duration_ms: 12000,
      width: 864,
      height: 496,
      mime_type: 'video/mp4',
      video_codec: 'h264',
      audio_stream_count: 0,
    }),
    resolveVideoConditioningCapability: () => referenceBundleAudioCapability(state),
    createReferenceUrl: ({ asset_id: assetId, kind }) => (
      `https://cdn.example.test/reference/${kind}/${assetId}`
    ),
    prepareSourceConditioning: async () => assert.fail('raw source conditioning must not run'),
    videoProcessor: async () => {},
    schedule() {},
    ...overrides,
  };
}

test('reference bundle V2 的旧 generation 快照缺总绑定时不复用', async (t) => {
  const state = await setupReferenceBundleGenerationFixture(t);
  const first = await generateShot(ctx(state.db, referenceBundleGenerationDeps(state)), { shotId: state.shotId });
  const row = state.db.prepare('SELECT request_snapshot FROM video_generations WHERE id = ?')
    .get(first.video_generation_id);
  const legacy = JSON.parse(row.request_snapshot);
  delete legacy.reference_bundle.localization_binding_sha256;
  state.db.prepare('UPDATE video_generations SET request_snapshot = ? WHERE id = ?')
    .run(JSON.stringify(legacy), first.video_generation_id);

  await assert.rejects(
    () => generateShot(ctx(state.db, referenceBundleGenerationDeps(state)), { shotId: state.shotId }),
    (error) => error.code === 'REDRAW_SHOT_CONFLICT',
  );
  assert.equal(count(state.db, 'video_generations'), 1);
  assert.equal(count(state.db, 'tenant_usage_reservations'), 1);
});

test('reference bundle V2 在事务前后目标对白漂移时零付费副作用', async (t) => {
  const state = await setupReferenceBundleGenerationFixture(t);
  let providerCalls = 0;
  let scheduleCalls = 0;
  await assert.rejects(
    () => generateShot(ctx(state.db, {
      ...referenceBundleGenerationDeps(state),
      beforeCreateTransaction: async () => {
        state.db.prepare('UPDATE redraw_shots SET localized_dialogue_json = ? WHERE id = ?')
          .run(JSON.stringify([{ speaker_id: 'character-001', localized_text: 'Changed.', start_ms: 0, end_ms: 1000 }]), state.shotId);
      },
      videoProcessor: async () => { providerCalls += 1; },
      schedule() { scheduleCalls += 1; },
    }), { shotId: state.shotId }),
    (error) => error.code === 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED',
  );
  assert.equal(providerCalls, 0);
  assert.equal(scheduleCalls, 0);
  assert.equal(count(state.db, 'video_generations'), 0);
  assert.equal(count(state.db, 'tenant_usage_reservations'), 0);
  assert.equal(count(state.db, 'async_tasks', "type = 'redraw_shot'"), 0);
  assert.equal(credits.getTenantAccount(state.db, 'tenant-a').held, 0);
});
```

helper 不接受客户端 bundle/hash 参数；所有参考包数据仍由正式服务投影。

- [ ] **步骤 4：运行新增测试确认旧实现失败**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 --test-name-pattern="reference bundle V2" test/redrawGeneration.test.js
```

预期：至少一项 FAIL，证明旧 `sameRequestSnapshot()` 没有核对 V2 总绑定；不得通过删除冲突断言来迎合旧行为。

- [ ] **步骤 5：最小更新生成快照比较**

在 `sameRequestSnapshot()` 的嵌套 `reference_bundle` 比较键中精确加入：

```js
for (const key of [
  'schema_version',
  'coverage_sha256',
  'source_sha256',
  'motion_sha256',
  'dialogue_kind',
  'speech_required',
  'source_dialogue_sha256',
  'dialogue_script_sha256',
  'character_name_map_sha256',
  'localization_binding_sha256',
]) {
  if (storedBundle[key] !== expectedBundle[key]) return false;
}
```

不要为缺字段提供 V1 fallback。保持 `prepareReferenceBundleGeneration()` 在首次预检和事务内复检都调用 `loadCurrentReferenceBundle()`；不要缓存第一次的 bundle 代替第二次重读。

- [ ] **步骤 6：运行生成、计费与参考包联合绿灯**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 test/redrawGeneration.test.js test/redrawReferenceBundle.test.js test/redrawReviewGate.test.js test/creditLedger.test.js
```

预期：全部 PASS；漂移测试的 held credits、generation、attempt 和 schedule 全为 0。

- [ ] **步骤 7：静态检查并提交任务 2**

```powershell
node --check backend-node/src/services/redrawGenerationService.js
node --check backend-node/test/redrawGeneration.test.js
git diff --check -- backend-node/src/services/redrawGenerationService.js backend-node/test/redrawGeneration.test.js
git add -- backend-node/src/services/redrawGenerationService.js backend-node/test/redrawGeneration.test.js
git commit -m "fix(转绘): 固化目标对白生成快照"
```

---

### 任务 3：恢复并完成通用三镜真实本地验收

**文件：**
- 修改：`backend-node/test/redrawReferenceBundleLocalCase.test.js:394-430` 及任务 4 新断言
- 修改：`frontweb/e2e/fixtures/redraw-generic-project.js:1-220`
- 修改：`frontweb/e2e/redraw-backend-integration.spec.js:1-1030,1450-1920`

- [ ] **步骤 1：先核对暂停现场边界**

运行：

```powershell
git status --short
git diff --numstat -- backend-node/test/redrawReferenceBundleLocalCase.test.js frontweb/e2e/fixtures/redraw-generic-project.js frontweb/e2e/redraw-backend-integration.spec.js
```

预期：三个文件仍是已知暂停现场，`git diff --numstat` 分别为 `34 0`、`48 15`、`822 6`。若出现冲突 marker、文件缺失或额外 tracked 文件，停止并报告，不得用 `git restore` 或 stash 覆盖现场。

- [ ] **步骤 2：给真实三镜链补 V2 精确断言并确认红灯**

在 Playwright 成功用例读取每镜 bundle 后加入：

```js
const bundle = JSON.parse(shot.reference_bundle_json);
expect(bundle.schema_version).toBe('redraw-reference-bundle-v2');
expect(bundle.locale).toBe('es-ES');
expect(bundle.market).toBe('ES');
expect(bundle.dialogue.target_locale).toBe('es-ES');
expect(bundle.dialogue.target_market).toBe('ES');
expect(bundle.dialogue.source_dialogue_sha256).toMatch(/^[a-f0-9]{64}$/);
expect(bundle.dialogue.script_sha256).toMatch(/^[a-f0-9]{64}$/);
expect(bundle.dialogue.character_name_map_sha256).toMatch(/^[a-f0-9]{64}$/);
expect(bundle.dialogue.localization_binding_sha256).toMatch(/^[a-f0-9]{64}$/);
expect(JSON.stringify(bundle)).not.toContain('name_map_source_sha256');
```

对目标版本源事实加入不可伪造断言：

```js
const targetFacts = JSON.parse(database.prepare(
  'SELECT source_facts_json FROM redraw_versions WHERE id = ?',
).get(Number(localized.version_id)).source_facts_json);
expect(targetFacts.script_sha256).toBeUndefined();
expect(targetFacts.name_map_source_sha256).toBeUndefined();
```

三镜 dialogue 状态必须精确为：

```js
expect(preparedRows.map(({ reference_bundle_json: value }) => {
  const dialogue = JSON.parse(value).dialogue;
  return [dialogue.kind, dialogue.speech_required, dialogue.turns.length];
})).toEqual([
  ['spoken', true, 1],
  ['spoken', true, 1],
  ['silent', false, 0],
]);
```

- [ ] **步骤 3：运行精准 Playwright 红灯**

运行：

```powershell
npm --prefix frontweb run test:e2e -- redraw-backend-integration.spec.js --grep "通用三镜项目高置信度分析后完成"
```

预期：在任务 1、2 未正确完成时 FAIL 于 `REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED` 或 V2 字段缺失；若任务 1、2 已正确完成，应直接转绿。浏览器、后端、FFmpeg、SQLite 或 fixture 自身失败必须单独诊断，不能伪造数据库字段绕过。

- [ ] **步骤 4：只修真实链暴露的最小问题**

允许的修复边界：

- generic fixture 的稳定角色、镜头、本地媒体定义；
- E2E 本地 provider、审核、轮询和断言；
- V2 bundle 服务和生成服务中已经由任务 1、2 定义的合同缺陷。

禁止：

- UPDATE V2 `source_facts_json`；
- drop/disable 不可变触发器；
- 手工写 `script_sha256`、`name_map_source_sha256` 或 `localization_binding_sha256`；
- 降低 owner/version/CAS、身份、净景、运动或付费门禁；
- 调用公网供应商。

- [ ] **步骤 5：验证漂移恢复与零调用合同**

保留现有身份文件替换流程，并断言受影响镜头变为 stale、重新批准后只恢复受影响镜头且本地净景 provider 不重复调用。最终精确断言：

```js
expect(referencePreparationProviderCalls).toBe(7);
expect(providerCallCounts).toEqual({ asset: 0, video: 0, dialogue: 0 });
expect(database.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count).toBe(0);
expect(database.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE status = 'held'").get().count).toBe(0);
expect(browserErrors).toEqual([]);
expect(runtimeErrors).toEqual([]);
```

- [ ] **步骤 6：运行 Task8 与相关本地案例联合绿灯**

```powershell
node --test --test-concurrency=1 backend-node/test/redrawReferenceBundleLocalCase.test.js
npm --prefix frontweb run test:e2e -- redraw-backend-integration.spec.js --grep "通用三镜项目"
```

预期：本地参考包测试全部 PASS；通用三镜低置信度 safe 与高置信度完整链均 PASS。

- [ ] **步骤 7：检查暂停现场最终差异并提交任务 3**

```powershell
node --check backend-node/test/redrawReferenceBundleLocalCase.test.js
node --check frontweb/e2e/fixtures/redraw-generic-project.js
node --check frontweb/e2e/redraw-backend-integration.spec.js
git diff --check -- backend-node/test/redrawReferenceBundleLocalCase.test.js frontweb/e2e/fixtures/redraw-generic-project.js frontweb/e2e/redraw-backend-integration.spec.js
git add -- backend-node/test/redrawReferenceBundleLocalCase.test.js frontweb/e2e/fixtures/redraw-generic-project.js frontweb/e2e/redraw-backend-integration.spec.js
git commit -m "test(转绘): 闭环通用三镜参考准备"
```

提交前必须确认三个文件的全部暂停现场都是 Task8 真实验收的一部分；不允许顺带纳入其他 tracked 文件。

---

### 任务 4：完成同次全量验证与证据报告

**文件：**
- 创建：`docs/verification/redraw/v2-localization-dialogue-binding-20260823.md`

- [ ] **步骤 1：运行后端目标联合组**

```powershell
cd backend-node
node --test --test-concurrency=1 test/redrawReferenceBundle.test.js test/redrawReferenceBundleLocalCase.test.js test/redrawGeneration.test.js test/redrawLocalization.test.js test/redrawLocalizationOrchestration.test.js test/redrawPreparationGate.test.js test/redrawReferencePreparationOrchestration.test.js test/redrawRoutes.test.js test/redrawReviewGate.test.js test/creditLedger.test.js
```

预期：0 fail；只接受有明确 Windows 权限原因且原测试已标注的 skip。

- [ ] **步骤 2：运行前端受影响测试与生产构建**

```powershell
node --test frontweb/test/redrawFoundation.test.js frontweb/test/redrawShots.test.js frontweb/test/redrawPreparationWorkspace.test.js
npm --prefix frontweb run build
```

预期：测试 0 fail；Vite build exit 0。已有 chunk size warning 可以记录，不能当作失败忽略其他 warning。

- [ ] **步骤 3：重新运行精准 Task8，保存同次统计**

```powershell
npm --prefix frontweb run test:e2e -- redraw-backend-integration.spec.js --grep "通用三镜项目"
```

预期：低置信度 safe 用例与高置信度完整三镜用例全部 PASS；provider/付费计数继续为 0。

- [ ] **步骤 4：运行后端全量**

```powershell
cd backend-node
npm test
```

预期：exit 0、`fail 0`。记录 tests/pass/skipped/duration 的实际值，不复制历史 3047 项统计。

- [ ] **步骤 5：运行静态、差异和特性锁检查**

```powershell
node --check backend-node/src/services/redrawReferenceBundleService.js
node --check backend-node/src/services/redrawGenerationService.js
node --check backend-node/scripts/run-redraw-reference-bundle-local-case.js
node --check backend-node/test/redrawReferenceBundle.test.js
node --check backend-node/test/redrawGeneration.test.js
node --check backend-node/test/redrawReferenceBundleLocalCase.test.js
node --check frontweb/e2e/fixtures/redraw-generic-project.js
node --check frontweb/e2e/redraw-backend-integration.spec.js
git diff --check
node backend-node/scripts/verify-feature-lock-manifest.js --base HEAD^
node backend-node/scripts/verify-feature-lock-manifest.js --base origin/main
```

预期：全部 exit 0，两个审计均 `ready=true`。若出现 `FEATURE_LOCKED`，停止并请求授权；不得编辑审计脚本、删除 protected path 或伪造 base。

- [ ] **步骤 6：编写脱敏验证报告**

报告必须包含实际提交 SHA、上述命令和实际统计，并明确写出：

```markdown
- V2 source facts 未写入 script_sha256 或 name_map_source_sha256。
- 三镜目标绑定全部由当前 SQLite version/shot 数据派生。
- shot-1/2 为 spoken，shot-3 为 silent。
- 本轮供应商调用 0、付费 0、部署 0、生产数据库写入 0。
- 本地三镜参考准备通过不等于真实供应商整集生成或客户交付。
```

禁止记录绝对临时路径、Key、Authorization、供应商 URL、数据库内容或用户源片路径。

- [ ] **步骤 7：检查并提交验证报告**

```powershell
git diff --check -- docs/verification/redraw/v2-localization-dialogue-binding-20260823.md
git add -- docs/verification/redraw/v2-localization-dialogue-binding-20260823.md
git commit -m "docs(转绘): 记录 V2 对白绑定验收"
```

- [ ] **步骤 8：最终边界审计**

```powershell
git status --short --branch
git log --oneline -6
git diff origin/main...HEAD --name-only
gh pr view 184 --repo xiongpinji/molimamahuabu2 --json isDraft,state,headRefName,baseRefName,url
```

预期：PR #184 仍为 Draft；除三个预存 `__pycache__` 外无未提交 tracked 改动。不要在本计划内 push、转 Ready、merge 或 deploy。

---

## 计划自检映射

| 规格要求 | 实现任务 |
| --- | --- |
| 不修改不可变源事实 | 任务 1 步骤 1、5、6；任务 3 步骤 2、4 |
| 服务端派生姓名、源对白、目标对白与总绑定 | 任务 1 步骤 3、5 |
| V2 schema 与旧 V1 fail-closed | 任务 1 步骤 3、5 |
| locale/market 非 US 硬编码 | 任务 1 的 es-ES 测试；任务 3 三镜 E2E |
| 静默/有声状态机 | 任务 1 静默测试；任务 3 三镜精确状态 |
| 生成快照与旧 generation 不复用 | 任务 2 步骤 1、3、5 |
| 事务前后漂移零付费副作用 | 任务 2 步骤 3、6 |
| Task8 真实 V2 本地化链 | 任务 3 全部步骤 |
| 脱敏与零外部调用 | 任务 1、2 的断言；任务 3 步骤 5；任务 4 报告 |
| 全量与特性锁门禁 | 任务 4 步骤 1-5 |

类型和字段名称在所有任务中固定为：

- bundle schema：`redraw-reference-bundle-v2`
- binding contract：`redraw-localization-binding-v1`
- `source_dialogue_sha256`
- `script_sha256` / request snapshot 中的 `dialogue_script_sha256`
- `character_name_map_sha256`
- `localization_binding_sha256`
- `target_locale`
- `target_market`

不得在后续任务中引入第二套同义字段或兼容别名。
