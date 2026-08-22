# 转绘整集静默镜头声音合同实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让合法无对白镜头进入整集参考包，允许生成环境音和动作音，同时禁止模型编造对白、旁白或画外音。

**架构：** 后端从同一镜头的源对白和 `en-US` 本地化对白共同派生 `spoken` 或 `silent`，模式与人声需求进入规范参考包、哈希和生成快照。整集本地 runner 使用同一状态合同，合法静默不再形成 blocker，但人物、文字、净景和运动审核继续 fail closed。

**技术栈：** Node.js 20、CommonJS、`node:test`、better-sqlite3、FFmpeg/FFprobe、Vue 3 事实夹具、Git。

---

## 范围与文件职责

- 修改：`backend-node/src/services/redrawReferenceBundleService.js`——严格解析两侧对白、派生模式、构建分模式提示词和生成快照。
- 修改：`backend-node/test/redrawReferenceBundle.test.js`——覆盖静默成功、两侧不一致、伪装静默文本、旧包失效和投影脱敏。
- 修改：`backend-node/scripts/run-redraw-full-episode-reference-local.js`——验证 `speech_required`，移除合法静默 blocker，保留其他审核门禁。
- 修改：`backend-node/test/redrawFullEpisodeReferenceLocal.test.js`——锁定第 3、8 镜静默合同、错误组合和真实 FFmpeg 九镜回归。
- 修改：`frontweb/e2e/fixtures/redraw-latin-american-case.js`——逐镜记录 `kind` 与 `speech_required`，强化第 3、8 镜非人声音频提示。
- 修改：`frontweb/test/redrawLatinAmericanCase.test.js`——锁定源/目标同时为空和静默音频事实。
- 创建：`docs/superpowers/reports/2026-08-15-redraw-silent-shot-audio-contract-local-evidence.md`——记录同一运行的本地测试、构建、边界和剩余 blocker。

不修改数据库迁移、参考包保存接口字段白名单、供应商客户端、计费、生产配置或线上入口。`schema_version` 继续为 `redraw-reference-bundle-v1`；旧包通过规范哈希差异安全失效。

### 任务 1：参考包服务派生静默模式并投影非人声音频提示

**文件：**
- 修改：`backend-node/test/redrawReferenceBundle.test.js`
- 修改：`backend-node/src/services/redrawReferenceBundleService.js`

- [ ] **步骤 1：让测试夹具能分别控制源对白和英文对白**

在 `setup(overrides)` 写入 `redraw_shots` 前增加严格的测试输入选择，避免默认值吞掉显式空数组：

```js
const defaultSourceDialogue = [
  { speaker_id: 'character-001', text: '跟我走。', start_ms: 0, end_ms: 2400 },
];
const defaultLocalizedDialogue = [
  { speaker_id: 'character-001', localized_text: 'Come with me.', start_ms: 0, end_ms: 2400 },
  { speaker_id: 'character-002', localized_text: 'Not without proof.', start_ms: 2500, end_ms: 5000 },
];
const sourceDialogueJson = Object.hasOwn(overrides, 'sourceDialogueJson')
  ? overrides.sourceDialogueJson
  : JSON.stringify(Object.hasOwn(overrides, 'sourceDialogue') ? overrides.sourceDialogue : defaultSourceDialogue);
const localizedDialogueJson = Object.hasOwn(overrides, 'localizedDialogueJson')
  ? overrides.localizedDialogueJson
  : JSON.stringify(Object.hasOwn(overrides, 'dialogue') ? overrides.dialogue : defaultLocalizedDialogue);
```

把 INSERT 的两个参数改为 `sourceDialogueJson` 和 `localizedDialogueJson`。默认测试数据保持原有有声行为。

- [ ] **步骤 2：编写有声合同与合法静默投影红灯**

在现有保存成功测试中增加：

```js
assert.equal(bundle.dialogue.kind, 'spoken');
assert.equal(bundle.dialogue.speech_required, true);
```

在现有生成投影测试中增加：

```js
assert.equal(projected.referenceBundleSnapshot.dialogue_kind, 'spoken');
assert.equal(projected.referenceBundleSnapshot.speech_required, true);
assert.match(projected.prompt, /Dialogue mode: spoken\./);
```

新增合法静默测试：

```js
test('源对白和英文对白同时为空时投影只生成环境与动作音', async () => {
  const state = setup({ sourceDialogue: [], dialogue: [] });
  try {
    const saved = await saveReferenceBundle(ctx(state), validInput(state));
    assert.deepEqual(saved.bundle.dialogue.turns, []);
    assert.equal(saved.bundle.dialogue.kind, 'silent');
    assert.equal(saved.bundle.dialogue.speech_required, false);

    const loaded = await loadCurrentReferenceBundle(ctx(state), state.shotId);
    assert.equal(loaded.reference_bundle_hash, saved.reference_bundle_hash);

    const projected = await projectReferenceBundleForGeneration(ctx(state, {
      createReferenceUrl({ asset_id: assetId, kind }) {
        return `/static/redraw-reference/${kind}/${assetId}`;
      },
    }), state.shotId);
    assert.equal(projected.generateAudio, true);
    assert.equal(projected.referenceBundleSnapshot.dialogue_kind, 'silent');
    assert.equal(projected.referenceBundleSnapshot.speech_required, false);
    assert.match(projected.prompt, /Dialogue mode: silent\./);
    assert.match(projected.prompt, /non-speech ambience and action sound effects/);
    assert.match(projected.prompt, /Do not generate spoken dialogue, voiceover, narration/);
    assert.doesNotMatch(projected.prompt, /English dialogue timing:/);
    assert.doesNotMatch(projected.prompt, /Generate synchronized English speech audio/);
  } finally {
    state.cleanup();
  }
});
```

- [ ] **步骤 3：编写两侧不一致、非法 JSON 和伪装静默文本红灯**

新增表驱动测试，并全部使用现有 `assertRejectsUnchanged` 证明数据库不变：

```js
test('对白两侧不一致、非法结构或伪装静默文本时拒绝且不写库', async () => {
  const cases = [
    { name: 'source empty only', overrides: { sourceDialogue: [], dialogue: [{ speaker_id: 'character-001', localized_text: 'Wait.', start_ms: 0, end_ms: 1000 }] } },
    { name: 'localized empty only', overrides: { sourceDialogue: [{ speaker_id: 'character-001', text: '等等。', start_ms: 0, end_ms: 1000 }], dialogue: [] } },
    { name: 'source malformed', overrides: { sourceDialogueJson: '{', dialogue: [] } },
    { name: 'localized object', overrides: { sourceDialogue: [], localizedDialogueJson: '{}' } },
    { name: 'silence token', overrides: { dialogue: [{ speaker_id: 'character-001', localized_text: '[silence]', start_ms: 0, end_ms: 1000 }] } },
    { name: 'no dialogue token', overrides: { dialogue: [{ speaker_id: 'character-001', localized_text: 'no dialogue', start_ms: 0, end_ms: 1000 }] } },
  ];
  for (const entry of cases) {
    const state = setup(entry.overrides);
    try {
      await assertRejectsUnchanged(state, validInput(state), 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED');
    } finally {
      state.cleanup();
    }
  }
});
```

新增旧包失效测试：

```js
test('旧参考包缺少对白模式字段时安全失效且不自动升级', async () => {
  const state = setup();
  try {
    await saveReferenceBundle(ctx(state), validInput(state));
    const row = currentShot(state.db, state.shotId);
    const bundle = JSON.parse(row.reference_bundle_json);
    delete bundle.dialogue.kind;
    delete bundle.dialogue.speech_required;
    state.db.prepare(`
      UPDATE redraw_shots
      SET reference_bundle_json = ?, reference_bundle_hash = ?
      WHERE id = ?
    `).run(stableJson(bundle), canonicalBundleHash(bundle), state.shotId);
    const before = currentShot(state.db, state.shotId);

    const loadError = await captureAnyError(() => loadCurrentReferenceBundle(ctx(state), state.shotId));
    assert.equal(loadError.code, 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED');
    const projectionError = await captureAnyError(() => projectReferenceBundleForGeneration(ctx(state, {
      createReferenceUrl() {
        return '/static/redraw-reference/unused';
      },
    }), state.shotId));
    assert.equal(projectionError.code, 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED');
    assertShotUnchanged(state.db, state.shotId, before);
  } finally {
    state.cleanup();
  }
});
```

- [ ] **步骤 4：运行目标测试确认红灯**

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawReferenceBundle.test.js
```

预期：新增断言失败；合法静默用例返回 `REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED`；有声快照缺少新字段。不得出现数据库迁移、网络或 FFmpeg 错误。

- [ ] **步骤 5：实现严格对白数组解析和模式派生**

在 `redrawReferenceBundleService.js` 常量区增加：

```js
const SILENCE_TOKENS = new Set([
  'silence',
  '[silence]',
  '(silence)',
  'silent',
  'no dialogue',
  '[no dialogue]',
]);
```

在 `verifyDialogue` 前增加严格数组解析：

```js
function parseDialogueArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') fail(DIALOGUE_CODE);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_) {
    fail(DIALOGUE_CODE);
  }
  if (!Array.isArray(parsed)) fail(DIALOGUE_CODE);
  return parsed;
}

function isSilenceToken(value) {
  return SILENCE_TOKENS.has(String(value || '').trim().toLowerCase().replace(/\s+/g, ' '));
}
```

用以下完整逻辑替换 `verifyDialogue`：

```js
function verifyDialogue(shot, nameMap, boundCharacters) {
  if (shot.locale !== 'en-US' || shot.market !== 'US') fail(DIALOGUE_CODE);
  const facts = parseJson(shot.source_facts_json, {});
  if (!HEX_64.test(String(facts.script_sha256 || ''))
    || facts.name_map_source_sha256 !== sha256(stableJson(nameMap))
    || containsChinese(nameMap)) {
    fail(DIALOGUE_CODE);
  }
  const sourceDialogue = parseDialogueArray(shot.source_dialogue_json);
  const localizedDialogue = parseDialogueArray(shot.localized_dialogue_json);
  const sourceSilent = sourceDialogue.length === 0;
  const localizedSilent = localizedDialogue.length === 0;
  if (sourceSilent !== localizedSilent || containsChinese(localizedDialogue)) fail(DIALOGUE_CODE);

  const kind = sourceSilent ? 'silent' : 'spoken';
  const normalized = localizedDialogue.map((entry) => {
    const speaker = String(entry.speaker_id || '').trim();
    const text = String(entry.localized_text || '').trim();
    const start = Number(entry.start_ms);
    const end = Number(entry.end_ms);
    if (!boundCharacters.has(speaker) || !nameMap[speaker] || !text || isSilenceToken(text)
      || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || start >= end || end > Number(shot.duration_ms)) {
      fail(DIALOGUE_CODE);
    }
    return { speaker_id: speaker, localized_text: text, start_ms: start, end_ms: end };
  }).sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.speaker_id.localeCompare(b.speaker_id));

  return {
    kind,
    speech_required: kind === 'spoken',
    localized_script_version_id: Number(shot.version_id),
    target_locale: shot.locale,
    script_sha256: facts.script_sha256,
    character_name_map_sha256: sha256(stableJson(nameMap)),
    turns: normalized,
  };
}
```

- [ ] **步骤 6：按模式构建提示词与生成快照**

用模式分支替换 `buildGenerationPrompt` 中固定的对白段：

```js
const dialogueSection = bundle.dialogue.kind === 'silent'
  ? [
      'Dialogue mode: silent.',
      'Do not generate spoken dialogue, voiceover, narration, chanting, or intelligible vocalization.',
      'Generate only scene-appropriate non-speech ambience and action sound effects.',
    ]
  : [
      'Dialogue mode: spoken.',
      'English dialogue timing:',
      ...dialogueLines,
      'Generate synchronized US English speech audio for the approved dialogue timing only.',
    ];
```

最终提示词数组在角色映射后展开 `...dialogueSection`，并以统一禁止项结尾：

```js
'Do not include any Chinese subtitles, Chinese dialogue, watermarks, URLs, file paths, keys, or authorization text.'
```

在 `referenceBundleSnapshot` 中增加：

```js
dialogue_kind: bundle.dialogue.kind,
speech_required: bundle.dialogue.speech_required,
```

- [ ] **步骤 7：运行服务与关联回归确认绿灯**

运行：

```powershell
node --test --test-concurrency=1 `
  test/redrawReferenceBundle.test.js `
  test/redrawRoutes.test.js `
  test/redrawGeneration.test.js
node --check src/services/redrawReferenceBundleService.js
node --check test/redrawReferenceBundle.test.js
git diff --check
```

预期：全部测试通过，失败数为 0；允许既有、已注明原因的 Windows 符号链接测试跳过。语法检查和 diff 检查退出码为 0。

- [ ] **步骤 8：提交任务 1**

```powershell
git add backend-node/src/services/redrawReferenceBundleService.js backend-node/test/redrawReferenceBundle.test.js
git commit -m "feat(转绘): 支持静默镜头声音合同"
```

### 任务 2：整集本地 runner 放行合法静默镜头

**文件：**
- 修改：`backend-node/test/redrawFullEpisodeReferenceLocal.test.js`
- 修改：`backend-node/scripts/run-redraw-full-episode-reference-local.js`

- [ ] **步骤 1：先修改测试夹具并锁定静默输出**

在 `validCase()` 的两种 dialogue 分支都增加布尔字段：

```js
dialogue: silent ? {
  kind: 'silent',
  speech_required: false,
  target_locale: 'en-US',
  turns: [],
} : {
  kind: 'spoken',
  speech_required: true,
  target_locale: 'en-US',
  turns: [{
    speaker_id: 'mateo',
    text: `English line for ${id}.`,
    start_ms: TIMELINE[index],
    end_ms: TIMELINE[index + 1],
  }],
},
```

把真实 FFmpeg 成功用例对第 3、8 镜的断言改为：

```js
assert.equal(shot.dialogue.kind, 'silent');
assert.equal(shot.dialogue.speech_required, false);
assert.deepEqual(shot.dialogue.turns, []);
assert.equal(shot.blockers.includes('silent_dialogue_contract_unsupported'), false);
assert.equal(shot.reference_bundle_ready, false);
```

最后一条仍为 false，因为该夹具的人脸、文字和运动审核保持 pending。

- [ ] **步骤 2：编写静默 ready 与组合错误红灯**

新增辅助函数，只批准指定镜头的现有非对白门禁：

```js
function approveNonDialogueGates(shot) {
  shot.face_track_review = { status: 'approved', unresolved_reason: '' };
  for (const pack of shot.identity_packs) {
    pack.status = 'approved';
    pack.sha256 ||= 'b'.repeat(64);
  }
  shot.text_region_review = { status: 'approved', unresolved_reason: '' };
  for (const region of shot.text_regions) {
    region.clean_plate_status = 'approved';
    region.clean_plate_sha256 ||= 'c'.repeat(64);
  }
  shot.motion_reference = { review_status: 'approved', evidence_sha256: 'd'.repeat(64) };
}
```

新增测试：

```js
test('合法静默镜头在其他门禁批准后可以 ready', () => {
  const value = validCase();
  for (const id of ['shot-3', 'shot-8']) {
    approveNonDialogueGates(value.shots.find((shot) => shot.id === id));
  }
  const normalized = validateCaseManifest(value);
  for (const id of ['shot-3', 'shot-8']) {
    const shot = normalized.shots.find((entry) => entry.id === id);
    assert.equal(shot.reference_bundle_ready, true);
    assert.deepEqual(shot.blockers, []);
  }
});

test('dialogue 模式、speech_required 与 turns 不一致时只形成稳定 blocker', () => {
  const cases = [
    { expected: 'dialogue_speech_contract_mismatch', mutate: (shot) => { shot.dialogue.speech_required = true; } },
    { expected: 'silent_dialogue_has_turns', mutate: (shot) => { shot.dialogue.turns.push({ speaker_id: 'mateo', text: 'Wait.', start_ms: shot.start_ms, end_ms: shot.start_ms + 500 }); } },
    { expected: 'spoken_dialogue_missing', mutate: (shot) => { shot.dialogue.kind = 'spoken'; shot.dialogue.speech_required = true; } },
  ];
  for (const entry of cases) {
    const value = validCase();
    const shot = value.shots[2];
    approveNonDialogueGates(shot);
    entry.mutate(shot);
    const normalized = validateCaseManifest(value).shots[2];
    assert.equal(normalized.reference_bundle_ready, false);
    assert.ok(normalized.blockers.includes(entry.expected));
  }
});
```

再增加一个 `spoken` turn 文本为 `[silence]` 的用例，期望 blocker `dialogue_silence_token_forbidden`。

- [ ] **步骤 3：运行 runner 测试确认红灯**

运行：

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawFullEpisodeReferenceLocal.test.js
```

预期：合法静默仍含 `silent_dialogue_contract_unsupported`，输出缺少 `speech_required`，新增 ready 和组合 blocker 断言失败。

- [ ] **步骤 4：实现 runner 的静默状态合同**

在常量区增加与服务端相同的 `SILENCE_TOKENS`。把 dialogue 输入白名单改为：

```js
assertExactKeys(
  value.dialogue,
  new Set(['kind', 'speech_required', 'target_locale', 'turns']),
  `${label}.dialogue`,
);
```

标准化布尔值并在 turns 解析后构造 blockers：

```js
const speechRequired = value.dialogue.speech_required;
if (typeof speechRequired !== 'boolean') fail(CASE_CODE, 'dialogue requires speech_required');

if (speechRequired !== (dialogueKind === 'spoken')) {
  blockers.push('dialogue_speech_contract_mismatch');
}
if (dialogueKind === 'silent' && turns.length !== 0) {
  blockers.push('silent_dialogue_has_turns');
}
if (dialogueKind === 'spoken' && turns.length === 0) {
  blockers.push('spoken_dialogue_missing');
}
if (turns.some((entry) => SILENCE_TOKENS.has(entry.text.toLowerCase().replace(/\s+/g, ' ')))) {
  blockers.push('dialogue_silence_token_forbidden');
}
if (turns.some((entry) => CHINESE.test(entry.text))) {
  blockers.push('dialogue_contains_chinese');
}
```

删除当前“silent 且 turns 非空就抛 `CASE_CODE`”的提前失败分支，再删除 `silent_dialogue_contract_unsupported` 分支。输出改为：

```js
dialogue: {
  kind: dialogueKind,
  speech_required: speechRequired,
  target_locale: 'en-US',
  turns,
},
```

不得改动人物、文字、运动、媒体、路径或原子发布逻辑。

- [ ] **步骤 5：运行真实 FFmpeg runner 回归确认绿灯**

运行：

```powershell
$env:REQUIRE_LOCAL_FFMPEG='1'
node --test --test-concurrency=1 test/redrawFullEpisodeReferenceLocal.test.js
Remove-Item Env:REQUIRE_LOCAL_FFMPEG
node --check scripts/run-redraw-full-episode-reference-local.js
node --check test/redrawFullEpisodeReferenceLocal.test.js
git diff --check
```

预期：目标文件全部测试通过、失败和跳过均为 0；真实 FFmpeg 测试生成九个无音轨 MP4 和九张可读代表帧；失败注入仍不发布部分目录。

- [ ] **步骤 6：提交任务 2**

```powershell
git add -f backend-node/scripts/run-redraw-full-episode-reference-local.js
git add backend-node/test/redrawFullEpisodeReferenceLocal.test.js
git commit -m "fix(转绘): 放行合法静默整集镜头"
```

### 任务 3：真实整集事实夹具显式记录静默语义

**文件：**
- 修改：`frontweb/e2e/fixtures/redraw-latin-american-case.js`
- 修改：`frontweb/test/redrawLatinAmericanCase.test.js`

- [ ] **步骤 1：编写九镜模式与静默事实红灯**

新增测试：

```js
test('整集本地化逐镜声明 spoken 或 silent 及人声需求', () => {
  const sourceByShot = new Map(redrawLatinAmericanCase.sourceFacts.shots.map((shot) => [shot.id, shot]));
  const localizedByShot = new Map(redrawLatinAmericanCase.localization.dialogue.map((row) => [row.shot_id, row]));
  for (const shotId of Array.from(sourceByShot.keys())) {
    const sourceTurns = sourceByShot.get(shotId).dialogue;
    const localized = localizedByShot.get(shotId);
    const silent = sourceTurns.length === 0;
    assert.equal(localized.kind, silent ? 'silent' : 'spoken', `${shotId} 模式错误`);
    assert.equal(localized.speech_required, !silent, `${shotId} 人声需求错误`);
    assert.equal(localized.turns.length === 0, silent, `${shotId} 源目标静默状态不一致`);
  }
  assert.deepEqual(
    redrawLatinAmericanCase.localization.dialogue.filter((row) => row.kind === 'silent').map((row) => row.shot_id),
    ['shot-3', 'shot-8'],
  );
});
```

再增加提示词与伪装静默文本断言：

```js
test('静默镜头提示词只允许对应场景的非人声声音', () => {
  assert.match(redrawLatinAmericanCase.shotPrompts['shot-3'], /no spoken dialogue or voiceover/i);
  assert.match(redrawLatinAmericanCase.shotPrompts['shot-3'], /street ambience and bicycle movement sound effects/i);
  assert.match(redrawLatinAmericanCase.shotPrompts['shot-8'], /no spoken dialogue or voiceover/i);
  assert.match(redrawLatinAmericanCase.shotPrompts['shot-8'], /room ambience, keyboard, mouse, and computer interaction sound effects/i);

  const forbidden = new Set(['silence', '[silence]', '(silence)', 'silent', 'no dialogue', '[no dialogue]']);
  const localizedTexts = redrawLatinAmericanCase.localization.dialogue
    .flatMap((row) => row.turns)
    .map((turn) => turn.localized_text.trim().toLowerCase().replace(/\s+/g, ' '));
  assert.equal(localizedTexts.some((text) => forbidden.has(text)), false);
});
```

- [ ] **步骤 2：运行事实夹具测试确认红灯**

从 worktree 根运行：

```powershell
node --test frontweb/test/redrawLatinAmericanCase.test.js
```

预期：九个本地化 dialogue 行缺少 `kind` 和 `speech_required`，第 3、8 镜提示词缺少明确的非人声音频要求。

- [ ] **步骤 3：最小更新九镜本地化事实**

每个有 turn 的 dialogue 行增加：

```js
kind: 'spoken',
speech_required: true,
```

第 3、8 镜增加：

```js
kind: 'silent',
speech_required: false,
turns: [],
```

第 3 镜提示词明确：

```text
no spoken dialogue or voiceover; use only natural street ambience and bicycle movement sound effects
```

第 8 镜提示词明确：

```text
no spoken dialogue or voiceover; use only quiet room ambience, keyboard, mouse, and computer interaction sound effects
```

不修改对白文本、人物名、镜头时间线、角色表或其他镜头提示词。

- [ ] **步骤 4：运行前端事实合同确认绿灯**

```powershell
node --test `
  frontweb/test/redrawLatinAmericanCase.test.js `
  frontweb/test/redrawShots.test.js `
  frontweb/test/redrawAssets.test.js
node --check frontweb/e2e/fixtures/redraw-latin-american-case.js
node --check frontweb/test/redrawLatinAmericanCase.test.js
git diff --check
```

预期：全部测试通过，失败数为 0；语法与 diff 检查退出码为 0。

- [ ] **步骤 5：提交任务 3**

```powershell
git add frontweb/e2e/fixtures/redraw-latin-american-case.js frontweb/test/redrawLatinAmericanCase.test.js
git commit -m "test(转绘): 固化整集静默镜头事实"
```

### 任务 4：联合验收并记录脱敏本地证据

**文件：**
- 创建：`docs/superpowers/reports/2026-08-15-redraw-silent-shot-audio-contract-local-evidence.md`

- [ ] **步骤 1：记录验收基线并确认工作树范围**

从 worktree 根运行：

```powershell
git status --short --branch
git rev-parse HEAD
git log -4 --oneline
```

预期：已跟踪文件干净；只允许任务开始前已有的 `.superpowers/`、`frontweb/output/` 和三个 `__pycache__` 未跟踪目录。记录当前代码 HEAD，报告提交不能把自身 HEAD 当作执行基线。

- [ ] **步骤 2：运行同一轮后端联合测试和真实 FFmpeg runner 测试**

```powershell
Set-Location backend-node
$env:REQUIRE_LOCAL_FFMPEG='1'
node --test --test-concurrency=1 `
  test/redrawReferenceBundle.test.js `
  test/redrawRoutes.test.js `
  test/redrawGeneration.test.js `
  test/redrawFullEpisodeReferenceLocal.test.js
$backendExit=$LASTEXITCODE
Remove-Item Env:REQUIRE_LOCAL_FFMPEG
if($backendExit -ne 0){exit $backendExit}
Set-Location ..
```

预期：失败数为 0。真实 FFmpeg 用例完整运行九镜切片、代表帧、哈希、探针和原子发布验证，不允许因缺少本地媒体工具而跳过；仅允许现有测试在 Windows 无法创建受控符号链接时按原有原因跳过，并在报告中记录准确数量。

- [ ] **步骤 3：运行前端合同、构建和静态检查**

```powershell
node --test `
  frontweb/test/redrawLatinAmericanCase.test.js `
  frontweb/test/redrawShots.test.js `
  frontweb/test/redrawAssets.test.js `
  frontweb/test/redrawFoundation.test.js
npm --prefix frontweb run build
node --check backend-node/src/services/redrawReferenceBundleService.js
node --check backend-node/scripts/run-redraw-full-episode-reference-local.js
node --check frontweb/e2e/fixtures/redraw-latin-american-case.js
git diff --check
```

预期：测试和构建退出码均为 0，语法和 diff 检查无错误。

- [ ] **步骤 4：执行脱敏与合同机械扫描**

```powershell
$files=@(
  'backend-node/src/services/redrawReferenceBundleService.js',
  'backend-node/scripts/run-redraw-full-episode-reference-local.js',
  'frontweb/e2e/fixtures/redraw-latin-american-case.js'
)
$raw=($files | ForEach-Object { Get-Content -Raw -LiteralPath $_ }) -join "`n"
if($raw -match 'silent_dialogue_contract_unsupported'){throw '旧静默 blocker 仍存在'}
if($raw -notmatch 'Dialogue mode: silent\.'){throw '缺少静默提示词'}
if($raw -notmatch 'non-speech ambience and action sound effects'){throw '缺少非人声音频合同'}
if($raw -match '(?i)sk-[A-Za-z0-9]{8,}|authorization:\s*bearer'){throw '发现凭据模式'}
'SILENT_AUDIO_CONTRACT_SCAN_OK'
```

预期：输出 `SILENT_AUDIO_CONTRACT_SCAN_OK`。

- [ ] **步骤 5：编写本地证据报告**

报告必须记录：

- 实际 worktree、代码基线 commit 和完整测试统计；
- 有声镜头为 `spoken/speech_required=true`；
- 第 3、8 镜为 `silent/speech_required=false/turns=[]`；
- 静默生成投影仍为 `generateAudio=true`，只允许环境音和动作音；
- 两镜不再含 `silent_dialogue_contract_unsupported`，但在其他审核 pending 时仍 blocked；
- 只有将本地测试夹具的其他门禁全部批准后，静默镜头才 ready；
- 真实 FFmpeg 测试生成的是本地合成媒体，不是用户源片的新成片；
- 历史 `run1` 证据保持原样，不覆盖、不改写；
- 未读取 Key、未上传源片、未调用供应商、未计费、未部署；
- 本阶段不证明真实环境音、动作音、英文对白、口型或供应商结果已经通过。

报告不得写入本机绝对路径、源片正文、Key、Authorization、临时公网 URL 或真实金额。

- [ ] **步骤 6：验证并提交报告**

```powershell
$report='docs/superpowers/reports/2026-08-15-redraw-silent-shot-audio-contract-local-evidence.md'
git diff --check
$raw=Get-Content -Raw -LiteralPath $report
if($raw -match '[A-Za-z]:\\|(?i)sk-[A-Za-z0-9]{8,}|authorization:\s*bearer|https?://'){throw '报告脱敏失败'}
git add $report
git commit -m "docs(转绘): 记录静默镜头声音合同证据"
git diff HEAD^ HEAD --check
git status --short --branch
```

预期：报告是该提交唯一文件；提交后只剩任务前已有未跟踪目录。不得推送、部署或开始供应商调用。

## 完成标准

1. 参考包服务能保存、重读和投影合法静默镜头，并在提示词中禁止人声、允许非人声环境与动作音。
2. 两侧对白不一致、非法 JSON、伪装静默文本和旧包缺字段全部 fail closed，且不产生数据库副作用。
3. 第 3、8 镜从 `silent_dialogue_contract_unsupported` 中解除，但其他审核未批准时仍 blocked；全部非对白门禁批准后可 ready。
4. 有声镜头原有英文说话人、时间轴、身份、文字、运动与生成投影不回归。
5. 同一轮后端、前端、真实 FFmpeg 测试、构建、语法、diff 和脱敏检查均有新鲜成功证据；真实 FFmpeg 用例不得跳过。
6. 全程无 Key、无网络、无供应商、无计费、无部署、无生产写入、无 push。

计划执行完成后才进入“全帧可见人物与文字区域审核”阶段，不在本计划内提前修改或批准相关证据。
