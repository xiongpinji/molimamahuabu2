# 剧本分析不限字数实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 移除剧本分析固定 60,000 字符限制，以自动分段方式处理超长剧本，并从生产前端完成超长分析与单个短视频成品验收。

**架构：** 短剧本保留现有单次调用；超过 60,000 字符时按自然边界拆成不超过 30,000 字符的片段，每片段走既有模型生成、标准化与 schema 校验，再确定性合并并进行终检。生产发布只从实时 `/opt/moli-drama/current` 克隆窄候选，覆盖本任务文件。

**技术栈：** Node.js 20、Node test runner、Express、SQLite、Vue 3、Vite、Playwright CLI、受保护 release guard。

---

### 任务 1：建立前端不限字数合同

**文件：**
- 创建：`frontweb/test/scriptAnalysisUnlimited.test.js`
- 修改：`frontweb/src/views/ScriptAnalysis.vue`

- [ ] **步骤 1：先写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/views/ScriptAnalysis.vue', import.meta.url), 'utf8')

test('剧本分析输入与文件导入不再包含固定字数上限', () => {
  assert.doesNotMatch(source, /SCRIPT_CHAR_LIMIT/)
  assert.doesNotMatch(source, /:maxlength="SCRIPT_CHAR_LIMIT"/)
  assert.doesNotMatch(source, /剧本内容超过[^\n]+字符限制/)
  assert.match(source, /原剧本（\{\{\s*project\.source_script\.length\.toLocaleString\(\)\s*\}\}\s*字符）/)
})
```

- [ ] **步骤 2：确认红灯**

运行：`node --test test/scriptAnalysisUnlimited.test.js`

预期：因现有 `SCRIPT_CHAR_LIMIT`、`maxlength` 和导入拒绝逻辑而 FAIL。

- [ ] **步骤 3：做最小前端修改**

将标签改为：

```vue
<span>原剧本（{{ project.source_script.length.toLocaleString() }} 字符）</span>
<textarea
  v-model="project.source_script"
  rows="15"
  placeholder="粘贴完整剧本、小说章节或故事大纲。建议保留人物名、场次和对白。"
/>
```

删除 `const SCRIPT_CHAR_LIMIT = 60000`，并删除 `importScriptFile()` 中 `text.length > SCRIPT_CHAR_LIMIT` 的拒绝分支；文件类型和空内容校验保持不变。

- [ ] **步骤 4：确认绿灯并提交**

运行：`node --test test/scriptAnalysisUnlimited.test.js`

预期：1/1 PASS。

提交：`git commit -m "fix: 解除剧本分析前端字数限制"`

### 任务 2：接受超长剧本并实现安全分段

**文件：**
- 修改：`backend-node/test/scriptAnalysisService.test.js`
- 修改：`backend-node/src/services/scriptAnalysisService.js`

- [ ] **步骤 1：先写长文本与分段失败测试**

在测试导入中加入 `runAnalysis` 和 `splitSourceScript`，添加：

```js
test('getProjectInputError accepts source scripts above the former 60000 character limit', () => {
  assert.equal(getProjectInputError({ sourceScript: '字'.repeat(60001), lockedFacts: [] }), '')
})

test('splitSourceScript preserves every character and prefers natural boundaries', () => {
  const source = `${'甲'.repeat(18)}。${'乙'.repeat(18)}。${'丙'.repeat(18)}`
  const chunks = splitSourceScript(source, 25)
  assert.equal(chunks.join(''), source)
  assert.ok(chunks.every((chunk) => chunk.length <= 25))
  assert.ok(chunks[0].endsWith('。'))
})
```

- [ ] **步骤 2：确认红灯**

运行：`node --test test/scriptAnalysisService.test.js`

预期：旧限制断言失败，`splitSourceScript` 尚未导出。

- [ ] **步骤 3：实现最小输入与拆分逻辑**

保留锁定事实限制，删除 `sourceScriptChars` 和对应拒绝分支，新增：

```js
const SCRIPT_ANALYSIS_DIRECT_CHARS = 60000;
const SCRIPT_ANALYSIS_CHUNK_CHARS = 30000;

function splitSourceScript(sourceScript, maxChars = SCRIPT_ANALYSIS_CHUNK_CHARS) {
  const source = String(sourceScript || '');
  if (!source || source.length <= maxChars) return source ? [source] : [];
  const chunks = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(start + maxChars, source.length);
    if (end < source.length) {
      const floor = start + Math.floor(maxChars * 0.6);
      const window = source.slice(floor, end);
      const boundary = Math.max(
        window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('！'),
        window.lastIndexOf('？'), window.lastIndexOf('!'), window.lastIndexOf('?'),
      );
      if (boundary >= 0) end = floor + boundary + 1;
    }
    chunks.push(source.slice(start, end));
    start = end;
  }
  return chunks;
}
```

- [ ] **步骤 4：确认基础绿灯**

运行：`node --test test/scriptAnalysisService.test.js`

预期：输入接受与拆分测试 PASS，原锁定事实测试仍 PASS。

### 任务 3：分段生成、合并与终检

**文件：**
- 修改：`backend-node/test/scriptAnalysisService.test.js`
- 修改：`backend-node/src/services/scriptAnalysisService.js`

- [ ] **步骤 1：先写分段调用与合并失败测试**

使用 60,001 字符剧本 mock `aiClient.generateText` 返回两个以上合法 V1/V2 分段包，并断言：调用次数大于 1；每个提示词不含完整超长文本；每段 idempotency key 唯一；最终 `source.source_script` 与输入逐字相等；人物按名称去重；集、场、镜头顺序稳定且编号连续；合并结果通过 `validateProductionPackage()`。

- [ ] **步骤 2：确认红灯**

运行：`node --test test/scriptAnalysisService.test.js`

预期：当前 `runAnalysis()` 仅调用模型一次，断言 FAIL。

- [ ] **步骤 3：实现确定性合并**

新增 `mergeProductionPackages(packages, project, skill, strategyPreset)`：

```js
function mergeNamedItems(packages, key) {
  const seen = new Set();
  return packages.flatMap((item) => item[key] || []).filter((item) => {
    const identity = String(item?.name || JSON.stringify(item)).trim().toLowerCase();
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
```

合并对象以第一段为全局字段基线，拼接 `story_structure`、`continuity_rules`、`review.issues` 与 `ai_changes`，累加 `target_duration_seconds`，对 episode/scene/shot 重新从 1 编号；V2 合并 `creative_strategy` 的数组字段和 `visual_direction` 的证据/列表字段。最后用完整 `project` 再次 `normalizeProductionPackage()` 与 `validateProductionPackage()`。

- [ ] **步骤 4：让 `runAnalysis()` 按长度选择路径**

抽出单段调用；长剧本对每片段顺序调用，传递唯一键：

```js
const chunkOptions = {
  ...generationOptions,
  ...(generationOptions.idempotency_key
    ? { idempotency_key: `${generationOptions.idempotency_key}:chunk:${index + 1}` }
    : {}),
};
```

每个片段先标准化和校验；日志只记录 `chunk_index`、`chunk_count`、`chunk_chars`。短剧本继续原单次路径。

- [ ] **步骤 5：确认绿灯并提交**

运行：`node --test test/scriptAnalysisService.test.js test/scriptAnalysisRoutes.test.js`

预期：全部 PASS。

提交：`git commit -m "feat: 自动分段分析超长剧本"`

### 任务 4：本地回归与生产候选门禁

**文件：**
- 创建：`docs/superpowers/reports/2026-09-03-script-analysis-unlimited-verification.md`

- [ ] **步骤 1：运行本地验证**

运行：

```powershell
npm --prefix backend-node test
npm --prefix frontweb test
npm --prefix frontweb run build
npm --prefix backend-node run audit:canvas-credit-contract -- --require-build
git diff --check
```

记录精确通过/失败数；任何失败先分类为本次回归或已存在基线，不能隐去。

- [ ] **步骤 2：确认并发窗口与实时生产父版本**

确认同项目活动任务没有部署/模型配置动作；远端核对 `current`、flock、三类活动任务、服务状态、数据库 `quick_check` 和 8787 PID。

- [ ] **步骤 3：构建窄候选**

从实时 current 克隆 `/opt/moli-drama/releases/script-analysis-unlimited-20260903-<sha>-r1`，只叠加：

```text
frontweb/src/views/ScriptAnalysis.vue
frontweb/test/scriptAnalysisUnlimited.test.js
backend-node/src/services/scriptAnalysisService.js
backend-node/test/scriptAnalysisService.test.js
docs/superpowers/specs/2026-09-03-script-analysis-unlimited-design.md
docs/superpowers/plans/2026-09-03-script-analysis-unlimited.md
docs/superpowers/reports/2026-09-03-script-analysis-unlimited-verification.md
```

若线上前端与 worktree 不同，则只应用已审计的函数级补丁并验证其他差异逐字保留。候选中执行专项测试、全量门禁、构建、生产预检、增量 scope 与共享 verify-only；失败即停止并保留候选。

- [ ] **步骤 4：提交验证文档**

提交：`git commit -m "docs: 记录剧本分析不限字数验证"`

### 任务 5：受保护激活与线上用户验收

**文件：**
- 更新：`docs/superpowers/reports/2026-09-03-script-analysis-unlimited-verification.md`

- [ ] **步骤 1：受保护激活**

仅当 current CAS、锁、活动任务、备份和 verify-only 全部通过时运行：

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
```

- [ ] **步骤 2：生产健康复核**

验证 `activation_success`、新 current、`moli-drama.service`、`127.0.0.1:5679/health`、公开页面/静态资源、DB 与备份 `quick_check`、严重日志、活动任务归零和 8787 PID 不变。

- [ ] **步骤 3：Playwright 前端长剧本验收**

从 `https://molimama.vip/script-analysis` 登录测试账号，以正常键鼠输入创建 60,001 字符以上项目，确认页面无固定上限、保存成功、开始分析并到达待审核/成功状态；截图保存到 `output/playwright/`。

- [ ] **步骤 4：Playwright 单视频验收**

新建独立简短剧本，完成分析、审核并导入短剧工厂；只选择一个镜头并触发一次最短视频生成。轮询页面到成功终态，验证 `<video>` 可加载、媒体响应为成功、文件非空且可读取；不得在结果未知时重试。

- [ ] **步骤 5：更新证据并最终复核**

把项目/任务/视频 ID、字符数、时间、状态、媒体大小/时长、截图路径、候选/current、测试统计和生产健康写入报告，不记录凭证或剧本文本。重跑关键只读复核后再交付。
