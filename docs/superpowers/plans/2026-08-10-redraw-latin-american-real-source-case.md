# 拉美演员真实源片本地案例实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用用户指定的 68.733333 秒竖屏短剧作为真实上传输入，固定 C 拉美演员和美式英语合同，完成不调用付费供应商的本地前后端模拟同链并产出诚实的验证清单。

**架构：** 新增一个纯数据案例夹具和一个本地运行器；现有 `redraw-backend-integration.spec.js` 根据环境变量选择默认 16 秒夹具或 C 方案真实源片夹具。所有应用 API、数据库、计费、合成和下载仍走真实本地代码，只有分析、图片、视频和 TTS 供应商使用明确标注的离线模拟器。

**技术栈：** Node.js ESM、Node `node:test`、Playwright 1.61、Express、SQLite、FFmpeg/FFprobe、Vue 3/Vite 6。

---

## 文件结构

- 创建：`frontweb/e2e/fixtures/redraw-latin-american-case.js`——C 方案的媒体指纹、演员、时间轴、本地化和镜头提示词唯一来源。
- 创建：`frontweb/e2e/fixtures/redraw-latin-american-case/actor-cast-reference.png`——用户选定的 C 方案照片级虚构演员概念图。
- 创建：`frontweb/test/redrawLatinAmericanCase.test.js`——验证媒体合同、时间轴连续性、演员合同、概念图指纹和证据边界。
- 创建：`frontweb/scripts/run-redraw-latin-american-case.mjs`——探测用户传入源片并启动专用 Playwright 同链。
- 修改：`frontweb/e2e/redraw-backend-integration.spec.js`——参数化源片、分析事实、模拟镜头数量/时长、提示词和输出清单。
- 修改：`frontweb/package.json`——增加本地案例运行命令。

### 任务 1：用失败测试锁定 C 方案合同

**文件：**
- 创建：`frontweb/test/redrawLatinAmericanCase.test.js`
- 创建：`frontweb/e2e/fixtures/redraw-latin-american-case.js`
- 创建：`frontweb/e2e/fixtures/redraw-latin-american-case/actor-cast-reference.png`

- [x] **步骤 1：编写失败的案例合同测试**

测试必须导入 `redrawLatinAmericanCase` 和 `buildLocalCaseManifest`，并逐项断言：

```js
assert.equal(redrawLatinAmericanCase.source.sha256, '24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae')
assert.equal(redrawLatinAmericanCase.source.duration_ms, 68_733)
assert.deepEqual(redrawLatinAmericanCase.source.video, { width: 720, height: 1280, codec: 'hevc', frame_rate: 30 })
assert.deepEqual(redrawLatinAmericanCase.source.audio, { codec: 'aac', channels: 1, sample_rate: 44_100 })
assert.equal(redrawLatinAmericanCase.sourceFacts.shots[0].start_ms, 0)
assert.equal(redrawLatinAmericanCase.sourceFacts.shots.at(-1).end_ms, 68_733)
assert.equal(redrawLatinAmericanCase.sourceFacts.shots.every((shot, index, shots) => index === 0 || shots[index - 1].end_ms === shot.start_ms), true)
assert.equal(redrawLatinAmericanCase.cast.every((actor) => actor.age_min >= 18), true)
assert.equal(redrawLatinAmericanCase.target.locale, 'en-US')
assert.equal(redrawLatinAmericanCase.generationDurations.reduce((sum, value) => sum + value, 0), 69)
assert.deepEqual(buildLocalCaseManifest().verification, {
  source_upload_verified: false,
  workflow_contract_verified: false,
  visual_actor_replacement_verified: false,
  provider_mode: 'local_fixture',
})
```

测试还读取 PNG 的 IHDR 和 SHA-256，要求尺寸 `941x1672`、哈希 `35b1f9f65d819b12b11f61e17720f202a6ebb4292660a7fe93ec55fedddc319e`。

- [x] **步骤 2：运行测试确认正确失败**

运行：

```powershell
cd frontweb
node --test test/redrawLatinAmericanCase.test.js
```

预期：FAIL，原因是 `e2e/fixtures/redraw-latin-american-case.js` 尚不存在。

- [x] **步骤 3：复制已批准演员概念图并实现最小案例夹具**

把选定的 C 图复制为 `actor-cast-reference.png`，然后导出：

```js
export const redrawLatinAmericanCase = Object.freeze({
  id: 'ac087bcd-latam-en-us',
  target: { language: 'en', locale: 'en-US', market: 'US', cast_direction: 'latin-american' },
  source: {
    sha256: '24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae',
    duration_ms: 68_733,
    duration_tolerance_ms: 50,
    video: { width: 720, height: 1280, codec: 'hevc', frame_rate: 30 },
    audio: { codec: 'aac', channels: 1, sample_rate: 44_100 },
  },
  cast: [
    { id: 'mateo', target_name: 'Mateo', role: 'protagonist', age_min: 18 },
    { id: 'diego', target_name: 'Diego', role: 'classmate', age_min: 18 },
    { id: 'elena', target_name: 'Elena', role: 'mother', age_min: 35 },
    { id: 'rafael', target_name: 'Rafael', role: 'father', age_min: 35 },
  ],
  sourceFacts: {
    duration_ms: 68_733,
    shots: [
      { id: 'shot-1', start_ms: 0, end_ms: 8_000 },
      { id: 'shot-2', start_ms: 8_000, end_ms: 16_000 },
      { id: 'shot-3', start_ms: 16_000, end_ms: 24_000 },
      { id: 'shot-4', start_ms: 24_000, end_ms: 32_000 },
      { id: 'shot-5', start_ms: 32_000, end_ms: 40_000 },
      { id: 'shot-6', start_ms: 40_000, end_ms: 48_000 },
      { id: 'shot-7', start_ms: 48_000, end_ms: 56_000 },
      { id: 'shot-8', start_ms: 56_000, end_ms: 64_000 },
      { id: 'shot-9', start_ms: 64_000, end_ms: 68_733 },
    ],
  },
  localization: {
    name_map: { 男主: 'Mateo', 男同学: 'Diego', 母亲: 'Elena', 父亲: 'Rafael' },
    culture_map: { 校园门口: 'school entrance', 家中餐厅: 'family dining room' },
    glossary: { 第一桶金: 'first seed money' },
    dialogue: [{
      shot_id: 'shot-1',
      turns: [{ speaker_id: 'mateo', localized_text: 'Dude, who are you?' }],
    }],
  },
  shotPrompts: {
    'shot-1': 'Same fixed Latino actor Mateo at the school entrance as classmates confront him.',
    'shot-2': 'Same fixed Latino actors Mateo and Diego as Diego intervenes and Mateo leaves by bicycle.',
    'shot-3': 'Same fixed Latino actor Mateo rides away from school on the same bicycle.',
    'shot-4': 'Same fixed Latino actor Mateo reflects on having no capital while traveling through the neighborhood.',
    'shot-5': 'Same fixed Latino actor Mateo sees sports news and realizes how to earn his first seed money.',
    'shot-6': 'Same fixed Latino actors Mateo, Elena, and Rafael reunite at the family dinner table.',
    'shot-7': 'Same fixed Latino actor Mateo enters his dark bedroom and turns on the computer.',
    'shot-8': 'Same fixed Latino actor Mateo researches the opportunity on the computer and makes a decision.',
    'shot-9': 'Same fixed Latino actor Mateo writes down the plan at his desk as the episode ends.',
  },
  generationDurations: [8, 8, 8, 8, 8, 8, 8, 8, 5],
})

export function buildLocalCaseManifest(overrides = {}) {
  return {
    case_id: redrawLatinAmericanCase.id,
    source: redrawLatinAmericanCase.source,
    target: redrawLatinAmericanCase.target,
    verification: {
      source_upload_verified: false,
      workflow_contract_verified: false,
      visual_actor_replacement_verified: false,
      provider_mode: 'local_fixture',
      ...overrides,
    },
  }
}
```

- [x] **步骤 4：运行合同测试确认通过**

运行：`node --test test/redrawLatinAmericanCase.test.js`

预期：全部 PASS，0 FAIL。

### 任务 2：实现拒绝错误源片的本地运行器

**文件：**
- 修改：`frontweb/test/redrawLatinAmericanCase.test.js`
- 创建：`frontweb/scripts/run-redraw-latin-american-case.mjs`
- 修改：`frontweb/package.json`

- [x] **步骤 1：先为媒体探测和命令接线补失败测试**

测试导入 `validateSourceProbe`，使用正确探测对象时返回规范结果，并分别对错误哈希、尺寸、时长、视频编码、缺失音频断言抛错。静态读取 `package.json`，要求存在：

```json
"test:e2e:redraw-latam-case": "node scripts/run-redraw-latin-american-case.mjs"
```

- [x] **步骤 2：运行测试确认失败原因是函数/脚本缺失**

运行：`node --test test/redrawLatinAmericanCase.test.js`

预期：FAIL，错误指向缺少 `validateSourceProbe` 或运行器接线。

- [x] **步骤 3：实现最小运行器**

运行器只接受 `--source <absolute-or-relative-path>`，读取文件 SHA-256，并用仓库现有 FFprobe 输出 JSON。调用 `validateSourceProbe` 后，以以下环境启动同一个 Playwright 规格：

```js
const env = {
  ...process.env,
  REDRAW_E2E_CASE: 'latam-real-source',
  REDRAW_E2E_SOURCE_VIDEO: sourcePath,
  REDRAW_E2E_CASE_OUTPUT_DIR: outputDir,
  PLAYWRIGHT_REUSE_SERVER: '0',
}
spawnSync(npxCommand, ['playwright', 'test', 'e2e/redraw-backend-integration.spec.js'], {
  cwd: frontwebRoot,
  env,
  stdio: 'inherit',
})
```

缺少文件或媒体不匹配时退出非零，不启动浏览器测试。

- [x] **步骤 4：运行合同测试确认通过**

运行：`node --test test/redrawLatinAmericanCase.test.js`

预期：媒体错误用例和 package 接线全部 PASS。

### 任务 3：把现有真实前后端同链参数化为案例模式

**文件：**
- 修改：`frontweb/e2e/redraw-backend-integration.spec.js`

- [x] **步骤 1：在未改集成规格前运行案例命令确认红灯**

运行：

```powershell
npm run test:e2e:redraw-latam-case -- --source "C:\Users\canqu\Desktop\ac087bcd4cf5f856f85182834794853a.mp4"
```

预期：FAIL；错误显示现有规格仍按 16 秒、2 镜头合同执行，证明案例接线尚未实现。

- [x] **步骤 2：最小参数化测试夹具**

当 `REDRAW_E2E_CASE === 'latam-real-source'` 时：

```js
const activeCase = redrawLatinAmericanCase
sourceVideoPath = path.resolve(process.env.REDRAW_E2E_SOURCE_VIDEO)
const sourceFacts = activeCase.sourceFacts
```

默认无环境变量时继续生成原有 16 秒视频并保持原测试合同。案例模式按 `sourceFacts.shots` 动态生成 9 个模拟镜头文件，单段时长取 `activeCase.generationDurations[index]`；角色资产复制 `actor-cast-reference.png`，并在元数据中标记 `casting_reference: true`、`production_identity_pack: false`。

- [x] **步骤 3：让本地化、镜头更新和断言使用案例数据**

案例模式必须使用：

```js
result: {
  ...input.input.source_facts,
  ...activeCase.localization,
  facts_hash: buildLocalizationInput(input.input.source_facts, { locale: input.locale }).source_facts_hash,
}
```

镜头提示词、生成时长、镜头数量和最终时长断言全部来自 `activeCase`，不得再硬编码 `2` 和 `16`。默认模式仍保持原值。

- [x] **步骤 4：写出证据边界清单**

案例模式完成下载和 FFprobe 后，在 `REDRAW_E2E_CASE_OUTPUT_DIR/run-manifest.json` 写入源片哈希、输入/输出媒体信息、9 个镜头状态、下载哈希和任务/积分清场结果。验证字段固定为：

```js
verification: {
  source_upload_verified: true,
  workflow_contract_verified: true,
  visual_actor_replacement_verified: false,
  provider_mode: 'local_fixture',
}
```

- [x] **步骤 5：运行 C 方案真实源片同链确认绿灯**

运行任务 3 步骤 1 的相同命令。

预期：1/1 PASS；实际上传源片哈希正确、9/9 镜头完成、末镜从 5 秒供应商请求裁到 4.733 秒、MP4 下载哈希一致、输出约 68.733 秒、0 个 held 预留、0 个活动任务；输出清单不宣称外国演员成片已验证。

### 任务 4：回归、自检和本地提交

**文件：**
- 验证本计划列出的全部文件

- [x] **步骤 1：运行默认同链，证明参数化没有破坏原路径**

运行：

```powershell
npx playwright test e2e/redraw-backend-integration.spec.js
```

预期：1/1 PASS，默认仍为 16 秒、2 镜头本地模拟同链。

- [x] **步骤 2：运行全部转绘 Node 回归**

运行：`node --test test/redraw*.test.js`

预期：0 FAIL。

- [x] **步骤 3：运行转绘浏览器 fixture 回归和前端构建**

运行：

```powershell
npx playwright test e2e/redraw-workspace.spec.js
npm run build
```

预期：Playwright 0 FAIL，构建 exit 0。

- [x] **步骤 4：检查输出清单和改动边界**

运行：

```powershell
Get-Content output\playwright\ac087bcd-case\run-manifest.json -Raw
git diff --check
git status --short
```

预期：清单中的 `visual_actor_replacement_verified` 为 `false`；Git 改动只包含本计划文件、规格/计划和演员参考图；保留既有 `frontweb/output/` 与 Python `__pycache__` 未跟踪目录，不删除、不提交。

- [x] **步骤 5：提交本地实现，不推送**

```powershell
git add -- docs/superpowers/specs/2026-08-10-redraw-latin-american-real-source-case-design.md docs/superpowers/plans/2026-08-10-redraw-latin-american-real-source-case.md frontweb/e2e/fixtures/redraw-latin-american-case.js frontweb/e2e/fixtures/redraw-latin-american-case/actor-cast-reference.png frontweb/test/redrawLatinAmericanCase.test.js frontweb/scripts/run-redraw-latin-american-case.mjs frontweb/e2e/redraw-backend-integration.spec.js frontweb/package.json
git commit -m "test: 增加拉美演员真实源片本地案例"
```

## 交付边界

本计划不推送、不部署、不制作生产候选、不访问 SSH、不调用真实模型。即使全部本地测试通过，也只能声明真实源片上传和应用同链已验证；外国演员替换、英文口型、审美质量和生产计费仍未验证。

## 执行证据（2026-08-10）

- C 方案专用同链：Playwright `1/1` 通过；9 个镜头完成，输出 `68.75` 秒，含 H.264 视频和 AAC 音频。
- 转绘 Node 合同：`76/76` 通过。
- 默认真实本地前后端同链：Playwright `1/1` 通过。
- 工作台浏览器回归：Playwright `13/13` 通过。
- 前端构建：Vite 构建 exit `0`。
- 后端全量：`1692` 个测试，`1688` 通过、`4` 跳过、`0` 失败。
- 输出清单：`visual_actor_replacement_verified=false`、`held_reservations=0`、`active_tasks=0`。
