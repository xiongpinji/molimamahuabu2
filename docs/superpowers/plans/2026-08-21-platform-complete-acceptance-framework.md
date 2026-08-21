# 平台完整验收阶段 0：清单、证据账本与锁框架实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不修改业务行为的前提下，为现有 140 项功能建立与来源清单一一对应、证据不足绝不伪绿、能够被 CI 和功能锁验证的验收决策账本。

**架构：** 保留 `platform-feature-inventory.json` 作为不可伪造的来源清单，新建稀疏的 acceptance ledger：未出现的功能自动为 `unverified`，已知缺口显式为 `blocked`，只有携带完整同候选证据的条目才能是 `locked_pass` 或 `locked_fixed`。独立校验器负责 schema、来源 SHA、ID 一致性、证据覆盖和最终完成门禁；现有 feature-lock 与增量发布门禁只锁住框架，不提前把业务功能标记为通过。

**技术栈：** Node.js 22、`node:test`、AJV 2020、JSON Schema、Git 功能锁、增量发布 scope。

---

## 文件结构与职责

### 创建

- `backend-node/scripts/verify-platform-feature-acceptance.js`：加载来源清单与验收账本，验证结构、来源绑定、状态和证据完整性，提供 CLI。
- `backend-node/test/platformFeatureAcceptance.test.js`：阶段 0 的 TDD 合同。
- `docs/verification/platform-stability/platform-feature-acceptance.schema.json`：验收账本 schema。
- `docs/verification/platform-stability/platform-feature-acceptance.json`：初始决策账本，仅登记 16 个当前阻断项；其余 124 项隐式为 `unverified`。
- `deploy/release-scopes/platform-complete-acceptance-framework.json`：本阶段精确 12 文件 allowlist。
- `docs/verification/platform-stability/platform-complete-acceptance-framework-verification.md`：本阶段同批验证证据。
- `docs/superpowers/plans/2026-08-21-platform-complete-acceptance-framework.md`：本计划。

### 修改

- `backend-node/package.json`：增加结构校验和最终完成校验命令。
- `backend-node/test/featureLockManifest.test.js`：允许新增框架以 `locked_pass` 锁定，并固定新锁内容。
- `backend-node/test/incrementalReleaseScope.test.js`：固定阶段 0 精确 allowlist，拒绝同数量偷换。
- `docs/verification/platform-stability/feature-lock-manifest.json`：新增 `stability.platform-complete-acceptance-framework`，不改写既有证据历史。

### 明确不修改

- `docs/verification/platform-stability/platform-feature-inventory.json`
- `docs/verification/platform-stability/platform-feature-inventory.schema.json`
- `backend-node/scripts/verify-platform-feature-inventory.js`
- 任何前端页面、业务 API、供应商客户端、数据库迁移或生产配置。

---

### 任务 1：用测试固定账本的来源绑定和稀疏状态语义

**文件：**

- 创建：`backend-node/test/platformFeatureAcceptance.test.js`

- [ ] **步骤 1：编写来源绑定与初始计数红灯测试**

创建测试文件并写入以下核心断言：

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  loadDefaultAcceptance,
  validateAcceptance,
} = require('../scripts/verify-platform-feature-acceptance');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function codes(result) {
  return new Set(result.errors.map((error) => error.code));
}

test('checked-in acceptance ledger is structurally valid and incomplete', () => {
  const loaded = loadDefaultAcceptance();
  const result = validateAcceptance(loaded);

  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.summary, {
    total: 140,
    unverified: 124,
    blocked: 16,
    locked_pass: 0,
    locked_fixed: 0,
    not_applicable: 0,
  });
});

test('source inventory digest mismatch is rejected', () => {
  const loaded = loadDefaultAcceptance();
  const drifted = clone(loaded.acceptance);
  drifted.source_inventory.sha256 = '0'.repeat(64);

  const result = validateAcceptance({ ...loaded, acceptance: drifted });
  assert.equal(result.valid, false);
  assert.ok(codes(result).has('source_inventory_mismatch'));
});

test('unknown and duplicate feature decisions are rejected', () => {
  const loaded = loadDefaultAcceptance();
  const unknown = clone(loaded.acceptance);
  unknown.decisions.push({
    feature_id: 'canvas.not-real',
    status: 'blocked',
    reason: '不存在于来源清单',
    evidence: [],
  });
  assert.ok(codes(validateAcceptance({ ...loaded, acceptance: unknown })).has('unknown_feature'));

  const duplicate = clone(loaded.acceptance);
  duplicate.decisions.push(clone(duplicate.decisions[0]));
  assert.ok(codes(validateAcceptance({ ...loaded, acceptance: duplicate })).has('duplicate_feature'));
});
```

- [ ] **步骤 2：运行测试确认功能缺失红灯**

运行：

```powershell
cd backend-node
node --test --test-concurrency=1 test/platformFeatureAcceptance.test.js
```

预期：FAIL，错误包含 `Cannot find module '../scripts/verify-platform-feature-acceptance'`。

- [ ] **步骤 3：保留红灯证据，不提交失败状态**

记录本次失败命令、退出码和缺失模块错误；保持测试文件未提交，待任务 2 的最小实现使其转绿后，与实现一并提交。禁止把红灯状态单独提交到分支。

---

### 任务 2：建立 schema 和初始阻断账本

**文件：**

- 创建：`docs/verification/platform-stability/platform-feature-acceptance.schema.json`
- 创建：`docs/verification/platform-stability/platform-feature-acceptance.json`
- 创建：`backend-node/scripts/verify-platform-feature-acceptance.js`

- [ ] **步骤 1：增加 schema，禁止任意字段和伪造状态**

schema 顶层固定为：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://moli.local/schemas/platform-feature-acceptance.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "source_inventory", "decisions"],
  "properties": {
    "schema_version": { "const": "1.0.0" },
    "source_inventory": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "sha256", "feature_count"],
      "properties": {
        "path": { "const": "docs/verification/platform-stability/platform-feature-inventory.json" },
        "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "feature_count": { "const": 140 }
      }
    },
    "decisions": {
      "type": "array",
      "uniqueItems": true,
      "items": { "$ref": "#/$defs/decision" }
    }
  },
  "$defs": {
    "decision": {
      "type": "object",
      "additionalProperties": false,
      "required": ["feature_id", "status", "evidence"],
      "properties": {
        "feature_id": { "type": "string", "pattern": "^[a-z0-9]+(?:[._-][a-z0-9]+)*$" },
        "status": { "enum": ["blocked", "locked_pass", "locked_fixed", "not_applicable"] },
        "reason": { "type": "string", "minLength": 1 },
        "approved_by": { "type": "string", "minLength": 1 },
        "defect_id": { "type": "string", "minLength": 1 },
        "fix_commit": { "type": "string", "pattern": "^[a-f0-9]{40}$" },
        "candidate_commit": { "type": "string", "pattern": "^[a-f0-9]{40}$" },
        "evidence": {
          "type": "array",
          "uniqueItems": true,
          "items": { "$ref": "#/$defs/evidence" }
        }
      }
    },
    "evidence": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "path", "result", "recorded_at", "candidate_commit"],
      "properties": {
        "kind": {
          "enum": ["contract", "auth", "api", "task", "provider", "artifact", "writeback", "billing", "download", "browser", "ci", "production", "lock"]
        },
        "path": { "type": "string", "minLength": 1 },
        "result": { "enum": ["pass", "fail", "blocked"] },
        "recorded_at": { "type": "string", "format": "date-time" },
        "candidate_commit": { "type": "string", "pattern": "^[a-f0-9]{40}$" },
        "note": { "type": "string", "minLength": 1 }
      }
    }
  }
}
```

- [ ] **步骤 2：创建初始账本，只复制 16 个真实阻断项**

账本规则：

```json
{
  "schema_version": "1.0.0",
  "source_inventory": {
    "path": "docs/verification/platform-stability/platform-feature-inventory.json",
    "sha256": "62f60e01bb46ac850bc044fdc4a674af0f5d729bb13cf8d9523524942b5a10f3",
    "feature_count": 140
  },
  "decisions": [
    {
      "feature_id": "canvas.billing.project_node_callout",
      "status": "blocked",
      "reason": "当前项目画布业务节点未发现独立的预计积分提示验收；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "canvas.share.link",
      "status": "blocked",
      "reason": "仅找到相邻画布交互结构测试；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.script.tabs",
      "status": "blocked",
      "reason": "现有测试仅覆盖制作页或来源边界，未独立验证两个剧本页签切换；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.character.reference",
      "status": "blocked",
      "reason": "现有测试覆盖素材复用或角色生图，未独立验证角色参考图上传与主图绑定；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.scene.reference",
      "status": "blocked",
      "reason": "现有测试覆盖素材复用或场景生图，未独立验证场景参考图上传与主图绑定；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.prop.reference",
      "status": "blocked",
      "reason": "现有测试覆盖素材复用或道具生图，未独立验证道具参考图上传与主图绑定；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.storyboard.batch_video_generation",
      "status": "blocked",
      "reason": "现有测试覆盖任务轮询或单分镜视频生成，未独立验证批量端点的逐镜结果、失败与计费；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.result.preview",
      "status": "blocked",
      "reason": "现有制作页测试未独立打开并核验图片、视频、音频或合成结果；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.project.download",
      "status": "blocked",
      "reason": "现有测试未独立验证项目 ZIP 可打开及内容；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.storyboard.download",
      "status": "blocked",
      "reason": "现有工作区测试未独立验证下载文件内容；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.billing.generation_callout",
      "status": "blocked",
      "reason": "当前短剧工厂只显示生成前检查，未发现每个生成按钮的独立预计积分提示；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.api.import",
      "status": "blocked",
      "reason": "现有测试仅覆盖相邻项目工作区或生成路由结构，未独立验证归档、小说及示例导入结果；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "short_drama_factory.api.export",
      "status": "blocked",
      "reason": "现有测试未独立验证导出归档可打开及内容；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "script_analysis.script.upload",
      "status": "blocked",
      "reason": "现有测试仅覆盖相邻页面结构，未独立验证文件选择、读取与内容写入；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "script_analysis.results.download",
      "status": "blocked",
      "reason": "当前页面与剧本分析公开 API 未发现结果下载入口；缺少该功能的独立验收覆盖。",
      "evidence": []
    },
    {
      "feature_id": "script_analysis.billing.visibility",
      "status": "blocked",
      "reason": "后端存在分析运行与修订计费，但前端缺少预计扣费展示及该提示的独立验收；缺少该功能的独立验收覆盖。",
      "evidence": []
    }
  ]
}
```

以上 16 项必须与来源清单中的 `baseline_state=blocked` 条目逐字一致。不得加入未在来源清单出现的功能，不得把 `unverified` 写成锁定状态。下面的只读命令必须输出同一个 SHA；若不同，说明来源清单已经漂移，应停止并从新基线重新生成计划：

```powershell
node -e "const fs=require('node:fs'),c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('../docs/verification/platform-stability/platform-feature-inventory.json')).digest('hex'))"
```

- [ ] **步骤 3：实现最小加载器和来源一致性校验**

`verify-platform-feature-acceptance.js` 必须包含并导出：

```js
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ACCEPTANCE_PATH = path.join(REPO_ROOT, 'docs', 'verification', 'platform-stability', 'platform-feature-acceptance.json');
const ACCEPTANCE_SCHEMA_PATH = path.join(REPO_ROOT, 'docs', 'verification', 'platform-stability', 'platform-feature-acceptance.schema.json');
const INVENTORY_PATH = path.join(REPO_ROOT, 'docs', 'verification', 'platform-stability', 'platform-feature-inventory.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadDefaultAcceptance() {
  return {
    acceptance: readJson(ACCEPTANCE_PATH),
    schema: readJson(ACCEPTANCE_SCHEMA_PATH),
    inventory: readJson(INVENTORY_PATH),
    inventorySha256: sha256(INVENTORY_PATH),
    repoRoot: REPO_ROOT,
  };
}
```

`validateAcceptance()` 首先执行 AJV，然后建立来源 ID Map 和决策 ID Set，返回固定对象：

```js
{
  valid: errors.length === 0,
  complete: errors.length === 0 && summary.unverified === 0 && summary.blocked === 0,
  errors,
  summary,
}
```

来源 SHA 或条目数量不一致时加入 `source_inventory_mismatch`；未知 ID 加入 `unknown_feature`；重复 ID 加入 `duplicate_feature`。未出现在 `decisions` 的来源条目计入 `unverified`。

- [ ] **步骤 4：运行聚焦测试并确认第一组转绿**

```powershell
cd backend-node
node --test --test-concurrency=1 test/platformFeatureAcceptance.test.js
```

预期：本任务已写的 3 项全部 PASS。

- [ ] **步骤 5：提交 schema、账本和最小校验器**

```powershell
git add backend-node/scripts/verify-platform-feature-acceptance.js backend-node/test/platformFeatureAcceptance.test.js docs/verification/platform-stability/platform-feature-acceptance.schema.json docs/verification/platform-stability/platform-feature-acceptance.json
git commit -m "feat(稳定性): 建立平台功能验收账本"
```

---

### 任务 3：锁定证据覆盖、修复元数据与完成语义

**文件：**

- 修改：`backend-node/test/platformFeatureAcceptance.test.js`
- 修改：`backend-node/scripts/verify-platform-feature-acceptance.js`

- [ ] **步骤 1：为四种决策状态编写红灯**

追加以下测试族：

```js
test('locked decision requires every source acceptance kind plus ci production and lock', () => {
  const loaded = loadDefaultAcceptance();
  const feature = loaded.inventory.features.find((item) => item.feature_id === 'canvas.api.image_generation');
  const acceptance = clone(loaded.acceptance);
  acceptance.decisions.push({
    feature_id: feature.feature_id,
    status: 'locked_pass',
    candidate_commit: 'a'.repeat(40),
    evidence: [],
  });

  const result = validateAcceptance({ ...loaded, acceptance });
  assert.equal(result.valid, false);
  assert.ok(codes(result).has('missing_evidence'));
});

test('locked_fixed requires defect id and full fix commit', () => {
  const loaded = loadDefaultAcceptance();
  const acceptance = clone(loaded.acceptance);
  acceptance.decisions.push({
    feature_id: 'canvas.api.image_generation',
    status: 'locked_fixed',
    candidate_commit: 'a'.repeat(40),
    evidence: [],
  });
  const result = validateAcceptance({ ...loaded, acceptance });
  assert.ok(codes(result).has('missing_fix_metadata'));
});

test('not_applicable requires product approval and decision evidence', () => {
  const loaded = loadDefaultAcceptance();
  const acceptance = clone(loaded.acceptance);
  acceptance.decisions.push({
    feature_id: 'canvas.share.link',
    status: 'not_applicable',
    evidence: [],
  });
  const result = validateAcceptance({ ...loaded, acceptance });
  assert.ok(codes(result).has('missing_approval'));
});
```

再增加：证据文件不存在返回 `missing_evidence_path`；锁定证据包含 `fail`/`blocked` 返回 `non_passing_evidence`；两个证据使用不同 `candidate_commit` 返回 `candidate_mismatch`；`blocked` 缺 reason 返回 schema 错误。

- [ ] **步骤 2：运行测试确认规则红灯**

```powershell
cd backend-node
node --test --test-concurrency=1 test/platformFeatureAcceptance.test.js
```

预期：新增测试失败，错误表明校验器尚未实现证据覆盖和元数据规则。

- [ ] **步骤 3：实现完整决策验证**

证据要求采用以下精确集合：

```js
function requiredEvidenceKinds(feature) {
  return new Set([
    'contract',
    ...feature.acceptance_chain,
    'ci',
    'production',
    'lock',
  ]);
}
```

对 `locked_pass` 和 `locked_fixed`：

1. 所有证据必须为 `result=pass`。
2. `evidence.kind` 必须覆盖 `requiredEvidenceKinds(feature)`。
3. 所有证据路径必须是仓库内存在的普通文件。
4. 决策和每条证据的 `candidate_commit` 必须为同一个 40 位 SHA；验证器以账本中的 SHA 为机器门禁，验收报告再核对各证据文件确实来自该候选，不能把历史文件冒充同批证据。
5. `locked_fixed` 必须有 `defect_id` 和 40 位 `fix_commit`。
6. `locked_pass` 不得携带 `defect_id` 或 `fix_commit`。

对 `not_applicable`：要求 `reason`、`approved_by`，并至少有一个 `kind=lock,result=pass` 的产品决定证据。对 `blocked`：要求 `reason`；证据允许为空，但存在时路径必须可读。

路径校验使用 `path.resolve(repoRoot, relativePath)` 并拒绝绝对路径、`..` 逃逸、目录和不存在文件。错误摘要不能包含文件内容、URL 查询参数或凭据。

- [ ] **步骤 4：运行来源清单与验收账本联合测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/platformFeatureInventory.test.js test/platformFeatureAcceptance.test.js
```

预期：全部 PASS，且初始汇总仍为 124 `unverified`、16 `blocked`。

- [ ] **步骤 5：提交证据门禁**

```powershell
git add backend-node/scripts/verify-platform-feature-acceptance.js backend-node/test/platformFeatureAcceptance.test.js
git commit -m "test(稳定性): 阻止平台功能无证据锁定"
```

---

### 任务 4：增加 CLI 与 package 门禁

**文件：**

- 修改：`backend-node/package.json`
- 修改：`backend-node/test/platformFeatureAcceptance.test.js`
- 修改：`backend-node/scripts/verify-platform-feature-acceptance.js`

- [ ] **步骤 1：编写 CLI 红灯**

追加两个 `spawnSync` 测试：

```js
test('CLI accepts structurally valid incomplete ledger', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-platform-feature-acceptance.js'], {
    cwd: path.join(repoRoot, 'backend-node'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, true);
  assert.equal(report.complete, false);
  assert.equal(report.summary.unverified, 124);
  assert.equal(report.summary.blocked, 16);
});

test('--require-complete rejects current incomplete ledger without printing ready', () => {
  const result = spawnSync(process.execPath, [
    'scripts/verify-platform-feature-acceptance.js',
    '--require-complete',
  ], {
    cwd: path.join(repoRoot, 'backend-node'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /"complete":true/);
  assert.match(result.stderr, /ACCEPTANCE_INCOMPLETE/);
});
```

导入 `spawnSync`、`path` 并定义 `repoRoot`。再增加未知参数退出 1、错误为 `INVALID_ARGUMENTS` 的测试。

- [ ] **步骤 2：运行 CLI 测试确认红灯**

```powershell
cd backend-node
node --test --test-concurrency=1 test/platformFeatureAcceptance.test.js
```

预期：CLI 测试失败，因为脚本没有入口和参数解析。

- [ ] **步骤 3：实现 CLI 并增加 package scripts**

CLI 只允许零参数或单个 `--require-complete`：

```js
function runCli(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--require-complete')) {
    process.stderr.write(`${JSON.stringify({ valid: false, error: 'INVALID_ARGUMENTS' })}\n`);
    process.exitCode = 1;
    return;
  }
  const result = validateAcceptance(loadDefaultAcceptance());
  if (!result.valid) {
    process.stderr.write(`${JSON.stringify({ valid: false, errors: result.errors })}\n`);
    process.exitCode = 1;
    return;
  }
  if (argv[0] === '--require-complete' && !result.complete) {
    process.stderr.write(`${JSON.stringify({ valid: true, complete: false, error: 'ACCEPTANCE_INCOMPLETE', summary: result.summary })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ valid: true, complete: result.complete, summary: result.summary })}\n`);
}
```

`package.json` 增加：

```json
"audit:platform-feature-acceptance": "node scripts/verify-platform-feature-acceptance.js",
"audit:platform-feature-acceptance:complete": "node scripts/verify-platform-feature-acceptance.js --require-complete"
```

- [ ] **步骤 4：运行两个 CLI 并记录预期差异**

```powershell
cd backend-node
npm run audit:platform-feature-acceptance
node scripts/verify-platform-feature-acceptance.js --require-complete
```

预期：第一条 exit 0 且 `complete=false`；第二条 exit 1 且错误为 `ACCEPTANCE_INCOMPLETE`。第二条是阶段 0 的预期阻断证据，不得改成绿色；只有全部业务阶段完成后才允许通过。

- [ ] **步骤 5：提交 CLI**

```powershell
git add backend-node/package.json backend-node/scripts/verify-platform-feature-acceptance.js backend-node/test/platformFeatureAcceptance.test.js
git commit -m "feat(稳定性): 增加平台完整验收门禁"
```

---

### 任务 5：锁定验收框架但不提前锁业务功能

**文件：**

- 修改：`backend-node/test/featureLockManifest.test.js`
- 修改：`docs/verification/platform-stability/feature-lock-manifest.json`
- 创建：`docs/verification/platform-stability/platform-complete-acceptance-framework-verification.md`

- [ ] **步骤 1：先写新锁红灯**

在测试中增加常量：

```js
const COMPLETE_ACCEPTANCE_FRAMEWORK_ID = 'stability.platform-complete-acceptance-framework';
const COMPLETE_ACCEPTANCE_PROTECTED_PATHS = [
  'backend-node/scripts/verify-platform-feature-acceptance.js',
  'docs/verification/platform-stability/platform-feature-inventory.json',
  'docs/verification/platform-stability/platform-feature-inventory.schema.json',
  'docs/verification/platform-stability/platform-feature-acceptance.json',
  'docs/verification/platform-stability/platform-feature-acceptance.schema.json',
];
const COMPLETE_ACCEPTANCE_REQUIRED_TESTS = [
  'backend-node/test/platformFeatureInventory.test.js',
  'backend-node/test/platformFeatureAcceptance.test.js',
  'backend-node/test/featureLockManifest.test.js',
];
```

追加测试断言新 feature 存在、`module=shared`、`status=locked_pass`、`fixCommit=null`、保护路径和测试完全相等、evidence 包含已确认设计、本计划和阶段验证报告、`unlock=null`。

把旧的：

```js
assert.equal(manifest.features.every((feature) => feature.status === 'locked_fixed'), true);
```

改为：

```js
assert.equal(
  manifest.features.every((feature) => ['locked_pass', 'locked_fixed'].includes(feature.status)),
  true,
);
```

同时把“其余稳定性锁保留既有批准原因”的分支条件收紧为：

```js
if (![PROACTIVE_CANARY_FEATURE_ID, COMPLETE_ACCEPTANCE_FRAMEWORK_ID].includes(feature.featureId)) {
  assert.equal(feature.unlock?.reason, '2026-08-20 线路成本分离与多模型配置拆分本地 TDD 授权');
  assert.match(feature.unlock?.approvedBy || '', /product-owner/);
}
```

新框架锁在自己的测试中单独断言 `unlock === null`。这只排除新增锁，不删除或放宽既有四个锁的批准原因断言。

- [ ] **步骤 2：运行测试确认缺锁红灯**

```powershell
cd backend-node
node --test --test-concurrency=1 test/featureLockManifest.test.js
```

预期：FAIL，报告找不到 `stability.platform-complete-acceptance-framework`。

- [ ] **步骤 3：创建阶段 0 基线证据文件**

先写入已经在任务 1 至任务 4 实际取得的命令、时间、exit code、来源清单 SHA、140/124/16 汇总和 `--require-complete` 预期阻断。文件必须明确写出：当前只证明验收框架能够阻止伪绿，不证明 140 项业务功能已经通过；尚未执行的后端全量、前端全量、浏览器、Hosted CI、真实供应商和生产回读不得写成通过。

- [ ] **步骤 4：在 manifest 追加框架锁**

新增条目：

```json
{
  "featureId": "stability.platform-complete-acceptance-framework",
  "module": "shared",
  "status": "locked_pass",
  "acceptance": [
    "来源功能清单与验收决策账本通过 SHA 和 feature_id 一致性绑定",
    "未登记功能保持 unverified，阻断功能不能伪装为通过",
    "锁定功能必须覆盖适用证据链、Hosted CI、生产回读和功能锁证据"
  ],
  "protectedPaths": [
    "backend-node/scripts/verify-platform-feature-acceptance.js",
    "docs/verification/platform-stability/platform-feature-inventory.json",
    "docs/verification/platform-stability/platform-feature-inventory.schema.json",
    "docs/verification/platform-stability/platform-feature-acceptance.json",
    "docs/verification/platform-stability/platform-feature-acceptance.schema.json"
  ],
  "requiredTests": [
    "backend-node/test/platformFeatureInventory.test.js",
    "backend-node/test/platformFeatureAcceptance.test.js",
    "backend-node/test/featureLockManifest.test.js"
  ],
  "evidence": [
    "docs/superpowers/specs/2026-08-21-platform-complete-acceptance-lock-design.md",
    "docs/superpowers/plans/2026-08-21-platform-complete-acceptance-framework.md",
    "docs/verification/platform-stability/platform-complete-acceptance-framework-verification.md"
  ],
  "fixCommit": null,
  "unlock": null
}
```

不修改已有五个锁的 `acceptance`、`protectedPaths`、`requiredTests`、`evidence`、`fixCommit` 或 `unlock`。

- [ ] **步骤 5：运行功能锁测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/featureLockManifest.test.js test/platformFeatureAcceptance.test.js
node scripts/verify-feature-lock-manifest.js --base origin/main
```

预期：测试全部 PASS；CLI 输出 `ready=true`。若 CLI 报任何既有保护路径被触碰且缺少新解锁，立即停止，不通过修改历史 evidence 或弱化校验器绕过。

- [ ] **步骤 6：提交框架锁与基线证据**

```powershell
git add backend-node/test/featureLockManifest.test.js docs/verification/platform-stability/feature-lock-manifest.json docs/verification/platform-stability/platform-complete-acceptance-framework-verification.md
git commit -m "test(稳定性): 锁定平台完整验收框架"
```

---

### 任务 6：固定本阶段精确增量范围

**文件：**

- 创建：`deploy/release-scopes/platform-complete-acceptance-framework.json`
- 修改：`backend-node/test/incrementalReleaseScope.test.js`

- [ ] **步骤 1：编写精确 allowlist 红灯**

在测试中定义新 manifest 路径和精确数组：

```js
const completeAcceptanceManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'platform-complete-acceptance-framework.json',
);

const COMPLETE_ACCEPTANCE_ALLOWED_PATHS = [
  'backend-node/package.json',
  'backend-node/scripts/verify-platform-feature-acceptance.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/incrementalReleaseScope.test.js',
  'backend-node/test/platformFeatureAcceptance.test.js',
  'deploy/release-scopes/platform-complete-acceptance-framework.json',
  'docs/superpowers/plans/2026-08-21-platform-complete-acceptance-framework.md',
  'docs/superpowers/specs/2026-08-21-platform-complete-acceptance-lock-design.md',
  'docs/verification/platform-stability/feature-lock-manifest.json',
  'docs/verification/platform-stability/platform-complete-acceptance-framework-verification.md',
  'docs/verification/platform-stability/platform-feature-acceptance.json',
  'docs/verification/platform-stability/platform-feature-acceptance.schema.json',
];
```

断言 manifest 的 `release` 为 `platform-complete-acceptance-framework`，`allowedPaths` 与数组深比较相等，且不含通配符、目录、数据库、上传、素材、AI 音乐、共享 release guard 或业务源文件。复制数组并把一个路径换成 `backend-node/data/drama_generator.db`，断言同数量偷换仍失败。

- [ ] **步骤 2：运行测试确认 manifest 缺失红灯**

```powershell
cd backend-node
node --test --test-concurrency=1 test/incrementalReleaseScope.test.js
```

预期：FAIL，错误指向新 scope 文件不存在。

- [ ] **步骤 3：创建精确 scope**

```json
{
  "schemaVersion": 1,
  "release": "platform-complete-acceptance-framework",
  "allowedPaths": [
    "backend-node/package.json",
    "backend-node/scripts/verify-platform-feature-acceptance.js",
    "backend-node/test/featureLockManifest.test.js",
    "backend-node/test/incrementalReleaseScope.test.js",
    "backend-node/test/platformFeatureAcceptance.test.js",
    "deploy/release-scopes/platform-complete-acceptance-framework.json",
    "docs/superpowers/plans/2026-08-21-platform-complete-acceptance-framework.md",
    "docs/superpowers/specs/2026-08-21-platform-complete-acceptance-lock-design.md",
    "docs/verification/platform-stability/feature-lock-manifest.json",
    "docs/verification/platform-stability/platform-complete-acceptance-framework-verification.md",
    "docs/verification/platform-stability/platform-feature-acceptance.json",
    "docs/verification/platform-stability/platform-feature-acceptance.schema.json"
  ]
}
```

- [ ] **步骤 4：运行 scope 与锁联合测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/incrementalReleaseScope.test.js test/featureLockManifest.test.js test/platformFeatureAcceptance.test.js test/platformFeatureInventory.test.js
```

预期：全部 PASS。

- [ ] **步骤 5：提交增量范围**

```powershell
git add deploy/release-scopes/platform-complete-acceptance-framework.json backend-node/test/incrementalReleaseScope.test.js
git commit -m "test(部署): 固定完整验收框架增量范围"
```

---

### 任务 7：执行完整验证并记录同批证据

**文件：**

- 修改：`docs/verification/platform-stability/platform-complete-acceptance-framework-verification.md`

- [ ] **步骤 1：确认改动精确等于 12 文件 allowlist**

```powershell
git diff --name-only origin/main...HEAD | Sort-Object
```

将输出与 `COMPLETE_ACCEPTANCE_ALLOWED_PATHS` 深比较。预期：12 个文件完全一致，0 缺失、0 多余。

- [ ] **步骤 2：运行后端聚焦和全量测试**

```powershell
cd backend-node
node --test --test-concurrency=1 test/platformFeatureInventory.test.js test/platformFeatureAcceptance.test.js test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
npm test
npm run audit:platform-feature-acceptance
node scripts/verify-feature-lock-manifest.js --base origin/main
```

预期：测试与结构门禁 exit 0；验收报告为 `complete=false`、124 `unverified`、16 `blocked`；功能锁 `ready=true`。

- [ ] **步骤 3：运行预期阻断门禁**

```powershell
cd backend-node
node scripts/verify-platform-feature-acceptance.js --require-complete
```

预期：exit 1、`ACCEPTANCE_INCOMPLETE`。验证文档必须把它记录为阶段 0 的正确阻断，不得宣称全平台完成。

- [ ] **步骤 4：运行前端全量、构建和零成本浏览器回归**

仅使用与 `frontweb/package-lock.json` SHA256 完全一致的现有依赖树；若没有匹配树，停止并报告，不联网安装、不借用不同 lock 的 `node_modules`。

```powershell
cd frontweb
node --test test/*.test.js
npm run build
npx --no-install playwright test e2e/platform-zero-cost-smoke.spec.js e2e/provider-stability-admin.spec.js --workers=1
```

预期：全部 exit 0；零成本冒烟的生成写请求数为 0。

- [ ] **步骤 5：执行静态和敏感信息审计**

```powershell
git diff --check origin/main...HEAD
git status --short
rg -n --hidden --glob '!node_modules' --glob '!dist' "sk-[A-Za-z0-9_-]{16,}|Authorization:\s*Bearer\s+[A-Za-z0-9._-]{12,}" backend-node frontweb docs deploy
```

预期：diff check exit 0；状态只包含待提交验证报告；敏感扫描每个命中均为测试占位或规则自身，并在报告逐项解释，不能只写“无风险”。

- [ ] **步骤 6：写入真实验证报告**

报告必须包含：候选 SHA、命令、开始/结束时间、exit code、测试通过/失败/跳过数量、12 文件 allowlist 对比、预期 `ACCEPTANCE_INCOMPLETE`、依赖 lock SHA、Playwright 零生成写计数、敏感扫描解释，以及明确的未执行项：真实供应商、付费、生产写入、部署、`enforce`、AI 音乐。

- [ ] **步骤 7：提交验证报告**

```powershell
git add docs/verification/platform-stability/platform-complete-acceptance-framework-verification.md
git commit -m "docs(稳定性): 记录完整验收框架同批证据"
```

- [ ] **步骤 8：提交后重跑轻量门禁**

```powershell
cd backend-node
node --test --test-concurrency=1 test/platformFeatureInventory.test.js test/platformFeatureAcceptance.test.js test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
node scripts/verify-feature-lock-manifest.js --base origin/main
cd ..
git diff --check origin/main...HEAD
git status --short
```

预期：测试和门禁 exit 0，工作树干净。

---

## 阶段 0 退出条件

阶段 0 只有满足以下条件才可进入 PR：

1. 来源清单仍为 140 项且没有被改写成通过。
2. 验收账本结构有效，汇总精确为 124 `unverified`、16 `blocked`。
3. `--require-complete` 保持失败，证明门禁没有伪绿。
4. 新框架锁为 `locked_pass`，业务功能没有被提前锁定。
5. 后端全量、前端全量、构建、零成本浏览器、功能锁和增量 scope 全绿。
6. 改动精确为 12 文件，0 个业务源文件、数据库、运行资产、AI 音乐或共享门禁文件。
7. 计划提交本身不授权 push、PR、合入、生产部署、付费生成或启用 `enforce`；这些动作分别等待用户授权。

阶段 0 合入后，从届时最新 `main` 依次编写并执行：公共底座、图片节点、视频/文本/音频节点、画布、短剧工厂、剧本分析的独立计划。每一阶段只能把本阶段实际完成证据的条目从 `unverified/blocked` 转为 `locked_pass/locked_fixed/not_applicable`。
