# 转绘全员换人与文字净化参考包实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在供应商调用和积分冻结之前，构建并验证一份只包含虚构美国成年角色身份图、无原脸/无中文字/无原音运动参考和 en-US 对白绑定的 `redraw-reference-bundle-v1`。

**架构：** 在现有转绘数据表上增加服务端专属参考包字段，不新建业务表；`redrawReferenceBundleService` 负责从当前数据库资产生成规范快照、CAS 保存、失效复核和白名单投影，`redrawMotionReferenceService` 独立负责视频路径、哈希、媒体元数据和无音轨门禁。`redrawGenerationService` 仅对显式 `reference_bundle_required=1` 的版本启用新路径，旧流程保持兼容；本阶段用捕获型假适配器和本地 5 秒 fixture 验证，不接入 Fumin、不读取 Key、不产生付费调用。

**技术栈：** Node.js 20、`node:test`、`better-sqlite3`、FFmpeg/FFprobe、`sharp`、SHA-256、现有 redraw identity/text-clean/generation 服务。

**设计依据：** `docs/superpowers/specs/2026-08-14-redraw-reference-bundle-motion-identity-text-design.md`

---

## 文件清单

- 创建：`backend-node/migrations/54_redraw_reference_bundle.sql`——为版本启用开关和镜头参考包快照增加列。
- 修改：`backend-node/src/db/migrate.js:806-862`——为旧库补齐新增列。
- 修改：`backend-node/test/redrawMigration.test.js`——验证迁移幂等、默认关闭和旧库兼容。
- 修改：`backend-node/src/services/redrawCharacterIdentityService.js:1-355`——保存并投影虚构 AI 来源与目标国家字段，同时保持旧身份包兼容。
- 修改：`backend-node/src/routes/redraw.js:409-510,2711-2758`——身份包 API 接受严格枚举的新增政策字段。
- 修改：`backend-node/test/redrawCharacterIdentity.test.js`——身份包政策字段、哈希和旧包兼容测试。
- 修改：`backend-node/test/redrawRoutes.test.js:4285-4536`——身份包新增字段白名单与响应脱敏测试。
- 创建：`backend-node/src/services/redrawMotionReferenceService.js`——净化运动视频的文件、哈希、时长、尺寸、MIME、音轨和覆盖绑定验证。
- 创建：`backend-node/test/redrawMotionReference.test.js`——运动参考成功与 fail-closed 测试。
- 创建：`backend-node/src/services/redrawReferenceBundleService.js`——参考包规范化、数据库解析、CAS、失效复核和请求投影。
- 创建：`backend-node/test/redrawReferenceBundle.test.js`——人脸、身份、文字、对白、排序、哈希、租户和 CAS 测试。
- 修改：`backend-node/src/services/redrawGenerationService.js:249-990`——接入参考包生成前门禁和请求快照。
- 修改：`backend-node/test/redrawGeneration.test.js`——证明原片不进入新请求、失败不冻结积分/不调用供应商、旧流程不回归。
- 创建：`backend-node/scripts/run-redraw-reference-bundle-local-case.js`——生成本地 5 秒 fixture、无音轨运动视频、manifest 和 contact sheet。
- 创建：`backend-node/test/redrawReferenceBundleLocalCase.test.js`——CLI、重复运行、产物可读性与脱敏测试。
- 修改：`backend-node/package.json:scripts`——增加 `verify:redraw-reference-bundle-local`。
- 创建：`docs/superpowers/reports/2026-08-14-redraw-reference-bundle-local-evidence.md`——本地证据报告。

明确不修改前端入口、供应商模型目录、Fumin 客户端、线上配置、生产数据库和 `/opt/moli-drama`。本计划不把旧 Fumin 分支整体合并进当前工作树。

### 任务 1：增加服务端参考包持久化列

**文件：** 创建 `backend-node/migrations/54_redraw_reference_bundle.sql`；修改 `backend-node/src/db/migrate.js:806-862`、`backend-node/test/redrawMigration.test.js`。

- [ ] **步骤 1：先写迁移红灯测试**

在 `redrawMigration.test.js` 增加测试，要求重复迁移后列存在且默认关闭：

```js
test('参考包列迁移幂等且旧生成默认关闭', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  runMigrationsAndEnsure(db);

  const versionColumns = columnNames(db, 'redraw_versions');
  const shotColumns = columnNames(db, 'redraw_shots');
  assert.ok(versionColumns.includes('reference_bundle_required'));
  for (const name of ['reference_bundle_json', 'reference_bundle_hash', 'reference_bundle_updated_at']) {
    assert.ok(shotColumns.includes(name), name);
  }

  const projectId = insertProject(db);
  const workId = insertWork(db, projectId);
  const versionId = insertVersion(db, workId);
  assert.equal(db.prepare('SELECT reference_bundle_required FROM redraw_versions WHERE id = ?').get(versionId).reference_bundle_required, 0);
});
```

- [ ] **步骤 2：运行测试确认红灯**

```powershell
Set-Location C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809\backend-node
node --test --test-concurrency=1 test/redrawMigration.test.js
```

预期：新增列断言失败。

- [ ] **步骤 3：实现最小迁移和旧库兜底**

`54_redraw_reference_bundle.sql` 内容固定为：

```sql
ALTER TABLE redraw_versions ADD COLUMN reference_bundle_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE redraw_shots ADD COLUMN reference_bundle_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE redraw_shots ADD COLUMN reference_bundle_hash TEXT;
ALTER TABLE redraw_shots ADD COLUMN reference_bundle_updated_at TEXT;
```

在 `ensureAllColumns` 的 `redraw_versions` 与 `redraw_shots` 列清单加入相同定义。不得修改既有列、索引或默认状态。

- [ ] **步骤 4：运行绿灯并提交**

```powershell
node --test --test-concurrency=1 test/redrawMigration.test.js
node --check src/db/migrate.js
Set-Location ..
git diff --check
git add backend-node/migrations/54_redraw_reference_bundle.sql backend-node/src/db/migrate.js backend-node/test/redrawMigration.test.js
git commit -m "feat(转绘): 增加参考包持久化字段"
```

预期：迁移测试通过，重复执行无异常，旧版本 `reference_bundle_required=0`。

### 任务 2：扩展虚构美国成年角色身份政策

**文件：** 修改 `backend-node/src/services/redrawCharacterIdentityService.js`、`backend-node/src/routes/redraw.js`、`backend-node/test/redrawCharacterIdentity.test.js`、`backend-node/test/redrawRoutes.test.js`。

- [ ] **步骤 1：先写身份政策红灯测试**

在 service 测试保存完整新身份包并断言：

```js
const saved = saveIdentityPack(ctx, characterAssetId, {
  target_actor_label: 'Ethan',
  confirmed_views: ['front', 'profile', 'full_body'],
  live_action_human_confirmed: true,
  adult_status: 'verified_18_plus',
  identity_consistency_confirmed: true,
  persona_origin: 'fictional_ai_generated',
  target_country: 'US',
  expected_updated_at: original.updated_at,
});
assert.equal(saved.identity_pack.persona_origin, 'fictional_ai_generated');
assert.equal(saved.identity_pack.target_country, 'US');
assert.match(saved.identity_pack.pack_sha256, /^[a-f0-9]{64}$/);
```

补充旧包兼容断言：没有新增字段的历史 `target-actor-identity-v1` 仍按原规则计算 `identity_pack_status.ready`，但后续参考包策略会拒绝它。路由测试分别覆盖 snake/camel 成功，以及 `persona_origin='real_person'`、`target_country='CN'`、重复别名和未知字段返回 `REDRAW_CHARACTER_IDENTITY_INPUT_INVALID`。

- [ ] **步骤 2：运行红灯**

```powershell
node --test --test-concurrency=1 test/redrawCharacterIdentity.test.js test/redrawRoutes.test.js
```

预期：新增字段当前被路由拒绝或未进入身份包。

- [ ] **步骤 3：实现向后兼容的字段保存与投影**

在 identity service 中只在字段存在时纳入规范哈希：

```js
const PERSONA_ORIGIN = 'fictional_ai_generated';
const TARGET_COUNTRY = 'US';

function identityPolicyFields(pack) {
  return {
    ...(pack?.persona_origin ? { persona_origin: String(pack.persona_origin) } : {}),
    ...(pack?.target_country ? { target_country: String(pack.target_country).toUpperCase() } : {}),
  };
}
```

`canonicalPackFields`、`readIdentityPack`、`saveIdentityPack` 和 `identityBindingForAsset` 使用同一字段名；历史包缺字段时不注入 `null`，避免改变旧哈希。路由 `identityPackInput` 允许 snake/camel 别名，但只接受固定值 `fictional_ai_generated` 和 `US`；这两个字段对旧请求可缺省，对新参考包则由任务 5 强制要求。

- [ ] **步骤 4：运行联合绿灯并提交**

```powershell
node --test --test-concurrency=1 test/redrawCharacterIdentity.test.js test/redrawRoutes.test.js test/redrawReviewGate.test.js test/redrawGeneration.test.js
node --check src/services/redrawCharacterIdentityService.js
node --check src/routes/redraw.js
Set-Location ..
git diff --check
git add backend-node/src/services/redrawCharacterIdentityService.js backend-node/src/routes/redraw.js backend-node/test/redrawCharacterIdentity.test.js backend-node/test/redrawRoutes.test.js
git commit -m "feat(转绘): 增加虚构美国成年角色身份政策"
```

预期：新身份包字段参与新哈希，旧身份包和既有生成测试不回归，响应不泄露路径。

### 任务 3：实现无原音运动参考文件门禁

**文件：** 创建 `backend-node/src/services/redrawMotionReferenceService.js`、`backend-node/test/redrawMotionReference.test.js`。

- [ ] **步骤 1：写成功和失败红灯测试**

fixture 在临时 storage root 的 `redraw-conditioning` 下写入一段 5 秒 H.264 MP4。测试注入 `probeRunner`，成功返回：

```js
const verified = await verifyMotionReference({
  db,
  storageRoot,
  assetId: motionAssetId,
  expected: {
    source_asset_id: sourceAssetId,
    source_fingerprint: 'a'.repeat(64),
    clip_start_ms: 0,
    clip_end_ms: 5000,
    face_coverage_sha256: 'b'.repeat(64),
    text_coverage_sha256: 'c'.repeat(64),
  },
  probeRunner: async () => ({ duration_ms: 5000, width: 864, height: 496, mime_type: 'video/mp4', video_codec: 'h264', audio_stream_count: 0 }),
});
assert.equal(verified.audio_stream_count, 0);
assert.equal(verified.path, undefined);
assert.match(verified.sha256, /^[a-f0-9]{64}$/);
```

运动资产的 `assets.metadata.redraw_motion_reference` 必须由本地预处理器写入以下服务端证据，测试不能用顶层客户端字段代替：

```json
{
  "schema_version": "redraw-motion-reference-v1",
  "tenant_id": "tenant-a",
  "user_id": "user-a",
  "version_id": 1,
  "shot_id": 1,
  "source_asset_id": 101,
  "source_fingerprint": "64位小写hex",
  "clip_start_ms": 0,
  "clip_end_ms": 5000,
  "face_coverage_sha256": "64位小写hex",
  "text_coverage_sha256": "64位小写hex"
}
```

逐项加入稳定错误断言：绝对路径、`..`、realpath/符号链接逃逸、资产不存在/跨 owner、实际哈希漂移、source fingerprint 或片段边界不符、覆盖哈希不符、时长/尺寸/MIME 不符、非 H.264、`audio_stream_count=1`。每个变体只改变一个条件。

- [ ] **步骤 2：运行测试确认模块缺失红灯**

```powershell
node --test --test-concurrency=1 test/redrawMotionReference.test.js
```

预期：`MODULE_NOT_FOUND: ../src/services/redrawMotionReferenceService`。

- [ ] **步骤 3：实现文件与媒体证据验证**

固定接口：

```js
async function verifyMotionReference({ db, storageRoot, tenantId, userId, assetId, expected, probeRunner }) {
  const asset = selectOwnedVideoAsset(db, tenantId, userId, assetId);
  const resolved = resolveInsideConditioningRoot(storageRoot, asset.local_path);
  const before = await readFileEvidence(resolved);
  const probe = await probeRunner(resolved.absolute_path);
  assertMotionContract(probe, expected);
  const after = await readFileEvidence(resolved);
  if (before.sha256 !== after.sha256 || before.file_identity !== after.file_identity) {
    throw codedError('REDRAW_REFERENCE_BUNDLE_MOTION_REFERENCE_STALE', '运动参考在校验期间发生变化');
  }
  return sanitizeMotionEvidence(asset, expected, after, probe);
}
```

`selectOwnedVideoAsset` 要求 `assets.type='video'`、`mime_type='video/mp4'`，并从 `assets.metadata.redraw_motion_reference` 读取上述完整绑定；tenant、user、version、shot、source 和时间边界必须同时匹配当前上下文。`resolveInsideConditioningRoot` 只允许 `redraw-conditioning/<64hex>.mp4`。验证前后复核 realpath、stat 身份和 SHA-256；底层异常不挂 `cause`。输出只含 asset ID、SHA-256、时长、尺寸、MIME、codec、音轨数和覆盖哈希，不含绝对路径。

- [ ] **步骤 4：运行绿灯并提交**

```powershell
node --test --test-concurrency=1 test/redrawMotionReference.test.js
node --check src/services/redrawMotionReferenceService.js
Set-Location ..
git diff --check
git add backend-node/src/services/redrawMotionReferenceService.js backend-node/test/redrawMotionReference.test.js
git commit -m "feat(转绘): 增加无原音运动参考门禁"
```

预期：所有路径、哈希、媒体和音轨变体 fail closed；错误 JSON 不含 storage root。

### 任务 4：先固定参考包服务的完整红灯合同

**文件：** 创建 `backend-node/test/redrawReferenceBundle.test.js`；被测文件为尚不存在的 `backend-node/src/services/redrawReferenceBundleService.js`。

- [ ] **步骤 1：建立最小成功数据库 fixture**

fixture 建立 en-US/US 版本、一个 5 秒 shot、两个已批准虚构美国成年角色身份包、两个已批准 `text_clean_plate` 场景资产、已批准覆盖清单和运动参考资产。调用固定接口：

```js
const saved = await saveReferenceBundle(ctx, {
  shot_id: shotId,
  expected_updated_at: shot.updated_at,
  motion_reference_asset_id: motionAssetId,
  face_tracks: [
    { track_key: 'face-002', source_character_key: 'character-002', time_ranges: [[2500, 5000]], identity_redraw_asset_id: actorBId },
    { track_key: 'face-001', source_character_key: 'character-001', time_ranges: [[0, 5000]], identity_redraw_asset_id: actorAId },
  ],
  text_regions: [
    { region_key: 'text-002', kind: 'text_screen', time_ranges: [[2500, 5000]], text_clean_redraw_asset_id: screenCleanId },
    { region_key: 'text-001', kind: 'text_subtitle', time_ranges: [[0, 2500]], text_clean_redraw_asset_id: subtitleCleanId },
  ],
  coverage_review: {
    recognizable_face_count: 2,
    mapped_face_count: 2,
    unresolved_face_count: 0,
    recognizable_text_region_count: 2,
    mapped_text_region_count: 2,
    unresolved_text_region_count: 0,
    status: 'approved',
  },
});
assert.equal(saved.schema_version, 'redraw-reference-bundle-v1');
assert.deepEqual(saved.face_tracks.map((item) => item.track_key), ['face-001', 'face-002']);
assert.deepEqual(saved.text_regions.map((item) => item.region_key), ['text-001', 'text-002']);
assert.equal(saved.dialogue.target_locale, 'en-US');
assert.match(saved.coverage_sha256, /^[a-f0-9]{64}$/);
```

`localized_dialogue_json` 只放英文台词，`name_map_json` 固定为 `{"character-001":"Ethan","character-002":"Maya"}`；断言输出不含源中文台词、绝对路径、Key、Authorization 或 URL。

- [ ] **步骤 2：覆盖人脸与身份 fail-closed 矩阵**

加入：缺/重复 track、非法或越界时间段、审核未批准、数量不一致、未映射人脸、同角色绑定两个身份、不同角色复用同一身份、身份包缺三视图/未批准/未成年/非虚构 AI/非 US/哈希漂移，以及 10 个不同身份返回：

```js
await assert.rejects(() => saveReferenceBundle(ctx, tenActorsInput), {
  code: 'REDRAW_REFERENCE_BUNDLE_REFERENCE_LIMIT_EXCEEDED',
});
```

每个失败用例记录 shot 的 `reference_bundle_json/hash/updated_at` 前值并断言完全不变。

- [ ] **步骤 3：覆盖文字、对白、CAS 与脱敏矩阵**

加入：text region 缺失/重复、识别数量与映射数量不一致、未解析文字区域不为 0、kind 与资产快照错配、时间覆盖空洞、text-clean 未批准、输出文件哈希漂移；版本不是 en-US/US、角色名映射缺失、说话人没有身份绑定、脚本或名字映射漂移；跨租户/跨用户统一 not found；缺 `expected_updated_at` 和并发冲突；未知字段或自报 hash/path/url/reviewer/status。错误码分别锁定为 `REDRAW_REFERENCE_BUNDLE_FACE_COVERAGE_REQUIRED`、`REDRAW_REFERENCE_BUNDLE_IDENTITY_PACK_REQUIRED`、`REDRAW_REFERENCE_BUNDLE_TEXT_COVERAGE_REQUIRED`、`REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED`、`REDRAW_REFERENCE_BUNDLE_INPUT_INVALID` 和 `REDRAW_REFERENCE_BUNDLE_CONFLICT`。

- [ ] **步骤 4：运行红灯并提交测试**

```powershell
node --test --test-concurrency=1 test/redrawReferenceBundle.test.js
node --check test/redrawReferenceBundle.test.js
Set-Location ..
git diff --check
git add backend-node/test/redrawReferenceBundle.test.js
git commit -m "test(转绘): 增加参考包完整门禁红灯"
```

预期：因 service 不存在而 `MODULE_NOT_FOUND`；测试文件语法和 diff 检查通过。

### 任务 5：实现参考包规范化、CAS 与白名单投影

**文件：** 创建 `backend-node/src/services/redrawReferenceBundleService.js`；继续修改 `backend-node/test/redrawReferenceBundle.test.js`。

- [ ] **步骤 1：实现输入白名单、时间段和稳定哈希**

只接受内部业务字段：

```js
const INPUT_FIELDS = new Set([
  'shot_id', 'expected_updated_at', 'motion_reference_asset_id',
  'face_tracks', 'text_regions', 'coverage_review',
]);
const MAX_IDENTITY_REFERENCES = 9;
const SCHEMA_VERSION = 'redraw-reference-bundle-v1';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
```

`normalizeTimeRanges` 要求整数毫秒、`0 <= start < end <= shot.duration_ms`，按 start/end 排序并拒绝同一条目的重叠区间。规范人脸和文字清单后分别计算 `face_coverage_sha256`、`text_coverage_sha256`；`coverage_sha256` 不含审核时间、绝对路径、URL 或生成时间。

- [ ] **步骤 2：从数据库解析当前身份、文字和对白**

先通过当前 shot → version → work 的服务端关联读取源资产；要求 work 的 `source_fingerprint` 是 64 位小写 SHA-256，源资产路径位于 storage root 内且 owner 关联有效，重新读取文件并计算出的哈希必须一致。bundle 的 `source.asset_id/sha256/clip_start_ms/clip_end_ms` 只能来自这条链，不能来自 input。

`resolveIdentityTrack` 必须查询当前 owner/version 的 `redraw_assets.kind='character'`，要求资产 `approval_status='approved'`、`identityPackStatus.ready=true`、pack hash 当前有效，并额外要求：

```js
if (pack.persona_origin !== 'fictional_ai_generated'
  || pack.target_country !== 'US'
  || pack.adult_status !== 'verified_18_plus') {
  throw codedError('REDRAW_REFERENCE_BUNDLE_IDENTITY_PACK_REQUIRED', '目标身份政策未通过');
}
```

目标角色名只能从当前版本 `name_map_json[source_character_key]` 派生，并必须等于 pack 的 `target_actor_label`。`resolveTextRegion` 查询当前 owner/version 的已批准 scene 资产，要求 `source_ref_json.snapshot.mode='text_clean_plate'`、`text_kind` 一致、`clean_plate_asset_id` 与 `mask_asset_id` 可读，并在 storage root 内重新读取 text-clean 文件计算 SHA-256。`coverage_review` 同时要求人脸和文字的识别数等于映射数、未解析数为 0、`status='approved'`；`reviewed_by` 和 `reviewed_at` 由 `ctx.userId` 与 `ctx.now` 生成，不接受 input 自报。`resolveDialogue` 从 shot 的 `localized_dialogue_json` 和版本 `name_map_json` 生成 `localized_script_version_id=version.id`、`script_sha256`、`character_name_map_sha256`；拒绝非 en-US/US、中文台词字符和未绑定说话人。

- [ ] **步骤 3：校验运动参考并原子 CAS 保存**

先完成所有身份、文字、对白和覆盖哈希，再调用任务 3 的服务：

```js
const motionReference = await verifyMotionReference({
  ...ctx,
  assetId: input.motion_reference_asset_id,
  expected: {
    source_asset_id: shot.source_asset_id,
    source_fingerprint: shot.source_fingerprint,
    clip_start_ms: shot.start_ms,
    clip_end_ms: shot.end_ms,
    face_coverage_sha256: faceCoverageSha256,
    text_coverage_sha256: textCoverageSha256,
  },
  probeRunner: ctx.probeRunner,
});
```

构造规范 bundle 后用 `UPDATE redraw_shots ... WHERE updated_at=? AND owner/version` 一次写入 `reference_bundle_json`、`reference_bundle_hash`、`reference_bundle_updated_at` 和新的 `updated_at`。任何前置失败不执行 UPDATE；CAS 变化返回 `REDRAW_REFERENCE_BUNDLE_CONFLICT`。

- [ ] **步骤 4：实现失效复核和安全投影**

固定导出接口：

```js
module.exports = {
  saveReferenceBundle,
  loadCurrentReferenceBundle,
  projectReferenceBundleForGeneration,
  canonicalBundleHash,
};
```

`loadCurrentReferenceBundle` 重新读取关联资产、身份包、text-clean、对白和 motion 文件，重算 bundle hash；任一漂移返回对应稳定错误。`projectReferenceBundleForGeneration` 只通过 `ctx.createReferenceUrl({ asset_id, sha256, kind })` 为身份图和运动视频生成 URL，并返回：

```js
{
  referenceImageUrls,
  referenceVideoUrl,
  identityBindings,
  referenceBundleSnapshot: {
    schema_version: bundle.schema_version,
    coverage_sha256: bundle.coverage_sha256,
    source_sha256: bundle.source.sha256,
    motion_sha256: bundle.motion_reference.sha256,
    dialogue_script_sha256: bundle.dialogue.script_sha256,
    character_name_map_sha256: bundle.dialogue.character_name_map_sha256,
  },
}
```

投影必须恰好一个 motion URL、0 至 9 个按 track 首次出现去重的身份 URL；回调结果必须是 `/static/` 或 HTTPS，且不能等于源资产 URL。投影失败只抛 `REDRAW_REFERENCE_BUNDLE_PROJECTION_FAILED`，不返回 raw bundle。

- [ ] **步骤 5：运行绿灯并提交**

```powershell
Set-Location C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809\backend-node
node --test --test-concurrency=1 test/redrawReferenceBundle.test.js test/redrawMotionReference.test.js test/redrawCharacterIdentity.test.js
node --check src/services/redrawReferenceBundleService.js
Set-Location ..
git diff --check
git add backend-node/src/services/redrawReferenceBundleService.js backend-node/test/redrawReferenceBundle.test.js
git commit -m "feat(转绘): 实现全员换人参考包门禁"
```

预期：反序输入产生相同哈希；失败不改 shot；输出与错误不泄露路径或凭证。

### 任务 6：在单镜生成前接入参考包

**文件：** 修改 `backend-node/src/services/redrawGenerationService.js:249-990`、`backend-node/test/redrawGeneration.test.js`。

- [ ] **步骤 1：先写生成集成红灯**

在 setup 中仅对目标用例执行：

```js
state.db.prepare('UPDATE redraw_versions SET locale = ?, market = ?, reference_bundle_required = 1 WHERE id = ?')
  .run('en-US', 'US', state.versionId);
```

成功用例保存参考包后调用 `generateShot`，注入 `createReferenceUrl` 和一个若被调用就失败的 raw conditioning：

```js
const result = await generateShot(ctx(state.db, {
  prepareSourceConditioning: async () => assert.fail('raw source conditioning must not run'),
  createReferenceUrl: ({ kind, sha256 }) => `https://fixture.invalid/${kind}/${sha256}`,
  schedule() {},
}), { shotId });
const video = state.db.prepare('SELECT * FROM video_generations WHERE id = ?').get(result.video_generation_id);
const snapshot = JSON.parse(video.request_snapshot);
assert.equal(snapshot.reference_bundle.schema_version, 'redraw-reference-bundle-v1');
assert.deepEqual(JSON.parse(video.reference_video_urls), [`https://fixture.invalid/motion/${motionSha}`]);
assert.equal(JSON.stringify(snapshot).includes(SIGNED_SOURCE_VIDEO_URL), false);
```

失败矩阵至少覆盖：bundle 缺失、hash 漂移、motion 含音轨、身份包过期、text-clean 过期、对白/name map 过期、超过 9 个身份、客户端提交 `reference_bundle`/face tracks/path/url。每个失败断言 `video_generations=0`、`tenant_credit_accounts.held=0`、`tenant_usage_reservations=0`、`providerCalls=0`。

- [ ] **步骤 2：运行目标测试确认红灯**

```powershell
node --test --test-concurrency=1 test/redrawGeneration.test.js
```

预期：新 flag 仍走原片 conditioning，或请求快照缺少参考包。

- [ ] **步骤 3：增加显式开关和参考包分支**

`selectShot` 增加 `v.reference_bundle_required`。在能力选择后、积分事务前分流：

```js
const useReferenceBundle = Number(shot.reference_bundle_required) === 1;
const projection = useReferenceBundle
  ? await redrawReferenceBundleService.projectReferenceBundleForGeneration({ ...ctx, shot })
  : null;
const sourceConditioning = useReferenceBundle
  ? projection.sourceConditioning
  : await prepareServerSourceConditioning(ctx, shot, generation);
const referenceImageUrls = useReferenceBundle
  ? projection.referenceImageUrls
  : collectReferenceImageUrls(db, shot, parsed);
const identityBindings = useReferenceBundle
  ? projection.identityBindings
  : collectIdentityBindings(parsed);
```

`projection.sourceConditioning` 保持现有结构但固定 `mode='redraw_reference_bundle'`、`audio_mode='strip'`、`segment_sha256=motion_sha256` 和 `coverage_sha256`，不含原片 URL。`buildRequestSnapshot` 接收可选 `referenceBundleSnapshot`，`sameRequestSnapshot` 比较 `coverage_sha256`、motion/dialogue/name-map 哈希，防止复用旧生成。

- [ ] **步骤 4：拒绝客户端绕过并保持旧路径兼容**

在 service 入口拒绝 `reference_bundle`、`referenceBundle`、`face_tracks`、`text_regions`、`motion_reference`、`reference_urls` 和 URL/path/hash/reviewer/status 控制字段。`reference_bundle_required=0` 时保持原有 `prepareServerSourceConditioning`、计费、请求快照和全部旧测试行为；不能按 locale 自动启用。

- [ ] **步骤 5：运行联合绿灯并提交**

```powershell
node --test --test-concurrency=1 test/redrawGeneration.test.js test/redrawReferenceBundle.test.js test/redrawMotionReference.test.js test/redrawReviewGate.test.js
node --check src/services/redrawGenerationService.js
Set-Location ..
git diff --check
git add backend-node/src/services/redrawGenerationService.js backend-node/test/redrawGeneration.test.js
git commit -m "feat(转绘): 接通参考包生成前置门禁"
```

预期：新路径完全不读取/签发原片 conditioning URL，所有参考包失败均早于 reserve；旧路径测试保持通过。

### 任务 7：实现本地 5 秒 fixture、CLI 和 contact sheet

**文件：** 创建 `backend-node/scripts/run-redraw-reference-bundle-local-case.js`、`backend-node/test/redrawReferenceBundleLocalCase.test.js`；修改 `backend-node/package.json:scripts`。

- [ ] **步骤 1：先写 CLI 红灯测试**

通过导出的 `main(argv, streams)` 验证：`--fixture --output-dir` 返回 0 和 `REDRAW_REFERENCE_BUNDLE_LOCAL_OK`；manifest、motion MP4、contact sheet 均存在；FFprobe 结果为 5000ms 容差 100ms、H.264、864×496、音频流 0；manifest 有两个 face track、两种 text kind、en-US/US、coverage hash，且不含 output root、Key、Authorization、原中文对白或 URL。

失败测试分别覆盖未知参数、`--fixture` 与 `--manifest` 同时出现、manifest 不可读、输出路径为普通文件、FFmpeg 失败；失败不留下最终 manifest。

- [ ] **步骤 2：运行红灯确认脚本缺失**

```powershell
node --test --test-concurrency=1 test/redrawReferenceBundleLocalCase.test.js
```

预期：`MODULE_NOT_FOUND: ../scripts/run-redraw-reference-bundle-local-case`。

- [ ] **步骤 3：实现完全本地的合成 fixture**

CLI 只支持 `--fixture`、`--manifest <path>`、`--output-dir <path>`、`--help`。fixture 使用 `sharp` 生成两个 3 视图合成角色图、字幕/屏幕文字 mask 与 text-clean 图片；使用本地 FFmpeg 生成 source 和 motion：

```js
await execFileAsync(getFfmpegPath(), [
  '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=864x496:rate=25',
  '-t', '5', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', motionPath,
], { timeout: 120000, windowsHide: true });
```

motion 输出移动测试图案但不含真人、人脸、中文文字或音轨；source fixture 只用于本地指纹绑定，不写入最终 manifest 路径。临时 SQLite 运行迁移，插入两个角色、两个 text-clean 资产和一个启用参考包的 shot，调用真实 identity、reference bundle 与 motion 服务生成结果。

- [ ] **步骤 4：实现原子输出和 contact sheet**

最终文件名固定：

```js
const MANIFEST_FILENAME = 'redraw-reference-bundle-local-manifest.json';
const MOTION_FILENAME = 'redraw-reference-bundle-motion.mp4';
const CONTACT_SHEET_FILENAME = 'redraw-reference-bundle-contact-sheet.jpg';
```

先把所有产物写到 outputDir 内随机临时文件，验证成功后依次 rename；任何失败删除本次临时文件。contact sheet 为 960×360 JPEG，两行三列，每格 320×180：motion 抽帧、face coverage、text coverage、Ethan 三视图、Maya 三视图、净化结果。不写绝对路径或原中文台词。临时 fixture root 和数据库在 finally 删除，用户 outputDir 保留。

- [ ] **步骤 5：注册 npm 命令并运行绿灯**

在 `backend-node/package.json` 增加：

```json
"verify:redraw-reference-bundle-local": "node scripts/run-redraw-reference-bundle-local-case.js --fixture"
```

```powershell
node --test --test-concurrency=1 test/redrawReferenceBundleLocalCase.test.js test/redrawReferenceBundle.test.js test/redrawMotionReference.test.js
npm run verify:redraw-reference-bundle-local
node --check scripts/run-redraw-reference-bundle-local-case.js
Set-Location ..
git diff --check
git add -f backend-node/scripts/run-redraw-reference-bundle-local-case.js
git add backend-node/test/redrawReferenceBundleLocalCase.test.js backend-node/package.json
git commit -m "feat(转绘): 增加五秒参考包本地运行器"
```

预期：目标测试全通过；CLI 无网络、无环境 Key 读取，重复运行得到相同规范字段和 coverage hash。

### 任务 8：执行联合验收并记录脱敏报告

**文件：** 创建 `docs/superpowers/reports/2026-08-14-redraw-reference-bundle-local-evidence.md`；不提交临时输出目录。

- [ ] **步骤 1：运行本地 fixture 和联合测试**

```powershell
Set-Location C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809\backend-node
$caseOutput = Join-Path $env:TEMP 'redraw-reference-bundle-local-case'
node scripts/run-redraw-reference-bundle-local-case.js --fixture --output-dir $caseOutput
node --test --test-concurrency=1 test/redrawMigration.test.js test/redrawCharacterIdentity.test.js test/redrawRoutes.test.js test/redrawMotionReference.test.js test/redrawReferenceBundle.test.js test/redrawReferenceBundleLocalCase.test.js test/redrawGeneration.test.js test/redrawReviewGate.test.js test/redrawAssets.test.js test/redrawTextCleanPlateLocalCase.test.js
```

记录命令的实际 exit code、tests/pass/fail/skipped 数量，不用计划中的预期数字替代实际结果。

- [ ] **步骤 2：核验产物与源码无外部调用**

```powershell
node -e "const fs=require('fs');const p=require('path').join(process.env.TEMP,'redraw-reference-bundle-local-case','redraw-reference-bundle-local-manifest.json');const v=JSON.parse(fs.readFileSync(p));if(v.schema_version!=='redraw-reference-bundle-v1'||v.motion_reference.audio_stream_count!==0||v.coverage.unresolved_face_count!==0)process.exit(1);console.log('REFERENCE_BUNDLE_MANIFEST_OK')"
rg -n "https?://|fetch\(|axios|process\.env\..*(KEY|TOKEN)|Authorization" scripts/run-redraw-reference-bundle-local-case.js src/services/redrawReferenceBundleService.js src/services/redrawMotionReferenceService.js
node --check src/services/redrawReferenceBundleService.js
node --check src/services/redrawMotionReferenceService.js
node --check src/services/redrawGenerationService.js
Set-Location ..
git diff --check
```

`rg` 允许测试用的 URL 格式校验代码，但不得出现网络调用、Key 读取或 Authorization 值；若命中，逐项解释并消除真实外部调用。

- [ ] **步骤 3：编写证据报告**

报告记录实际工作树、证据提交短 SHA、`backend-node` cwd、命令、测试统计和三个产物文件名。逐项列出：

```text
source fingerprint → face coverage → identity packs → text coverage
→ audio-free motion reference → en-US dialogue/name map
→ reference bundle hash → provider projection gate
```

同时明确：两个虚构 AI 美国成年角色已完整绑定、不同角色没有共享身份、中文字时间区域已进入证据、motion 音频流为 0、投影不含原片；`reference_gate=ready` 只表示本地合同可进入后续集成。报告不得包含绝对路径、Key、Authorization、临时公网 URL、源中文对白或真实付费金额，并明确“不代表 Fumin 全员换人成功、不代表整集完成、不代表已部署”。

- [ ] **步骤 4：最终审计并提交报告**

```powershell
git diff --check
git status --short --branch
git add docs/superpowers/reports/2026-08-14-redraw-reference-bundle-local-evidence.md
git commit -m "test(转绘): 记录五秒参考包本地验收证据"
git status --short --branch
```

预期：工作树只保留任务前已有 `.superpowers/`、`frontweb/output/` 和三个 `__pycache__` 未跟踪项；无 Fumin/ToAPIs 调用、Key 读取、SSH、部署、生产 DB 写入或 activate。

## 规格覆盖自检

- 原片隔离：任务 6 新路径禁止调用 raw source conditioning，任务 7–8 检查投影不含原片。
- 所有可辨认人脸：任务 4–5 覆盖数量一致、未映射为 0、跨段同角色一致和不同角色不共享身份。
- 虚构美国成年人：任务 2 保存政策字段，任务 5 在参考包门禁中强制 `fictional_ai_generated`、`US`、`verified_18_plus`。
- 9 图限制与拆镜信号：任务 4–5 锁定第 10 个身份的稳定错误，不静默删人。
- 中文字完整时间覆盖：任务 4–5 验证 subtitle/screen 类型、时间段、审核与哈希，任务 7 提供两类 fixture。
- 无原音运动参考：任务 3 验证 `audio_stream_count=0`、H.264、时长、尺寸、路径和哈希，任务 7 生成真实可解码 MP4。
- en-US 对白和美国化角色名：任务 5 从服务端版本/shot 数据派生并哈希，任务 6 写入安全 request snapshot。
- CAS 与资产漂移：任务 1 提供字段，任务 4–5 覆盖保存冲突和每类依赖变化，任务 6 防止旧生成复用。
- 失败无副作用：任务 4–6 断言数据库/积分/供应商调用为 0。
- 本地 CLI、manifest、contact sheet 和报告：任务 7–8 覆盖。
- Fumin、付费提交、生产和整集验收明确不在本计划：文件清单边界和任务 8 报告声明覆盖。

## 交付方式

计划文件保存后，执行阶段有两种方式：

1. **子代理驱动（推荐）**：每个任务使用新的子代理，任务间进行规格与代码质量审查。
2. **内联执行**：在当前会话使用 `executing-plans` 逐任务实现，并在每个提交后设置检查点。
