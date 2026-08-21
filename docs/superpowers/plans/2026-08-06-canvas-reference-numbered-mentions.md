# 画布参考图片序号与 @ 引用门禁实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 视频节点的每张已连线参考图片都按稳定顺序显示为“图片1、图片2、图片3……”，并让 `@` 下拉插入相同的 `@图片N` 引用。

**架构：** 在 `freeCanvasGeneration.js` 中集中构造带序号的 mention 候选，序号在过滤未就绪图片之前分配，从而与参考图卡片保持一致。项目画布和本地画布复用同一函数，节点编辑器只消费候选的 `label` 与 `mentionToken`。仓库合同测试、CODEOWNERS 和生产共享只读验证器共同防止未经用户授权的覆盖。

**技术栈：** Vue 3、Node.js 内置测试、Playwright、GitHub CODEOWNERS、`/opt/moli-drama` 共享发布门禁。

---

### 任务 1：建立失败回归测试

**文件：**
- 修改：`frontweb/test/standaloneCanvasFreeNodeGeneration.test.js`
- 修改：`frontweb/test/standaloneCanvasFreeNodeRuntime.test.js`
- 修改：`frontweb/e2e/home-canvas.spec.js`

- [x] **步骤 1：编写纯函数失败测试**

```js
const candidates = buildFreeCanvasReferenceMentionCandidates([
  { nodeId: 'a', title: '角色图', url: '/a.png', ready: true, enabled: true },
  { nodeId: 'b', title: '场景图', url: '/b.png', ready: true, enabled: true },
  { nodeId: 'c', title: '道具图', url: '/c.png', ready: true, enabled: true },
])
assert.deepEqual(candidates.map(({ label, mentionToken }) => ({ label, mentionToken })), [
  { label: '图片1', mentionToken: '@图片1' },
  { label: '图片2', mentionToken: '@图片2' },
  { label: '图片3', mentionToken: '@图片3' },
])
```

- [x] **步骤 2：运行测试验证失败**

运行：`node --test test/standaloneCanvasFreeNodeGeneration.test.js`

预期：FAIL，模块尚未导出 `buildFreeCanvasReferenceMentionCandidates`。

- [x] **步骤 3：编写三图片浏览器失败测试**

```js
await expect(mentionMenu.getByRole('button').nth(0)).toHaveAccessibleName('图片1')
await expect(mentionMenu.getByRole('button').nth(1)).toHaveAccessibleName('图片2')
await expect(mentionMenu.getByRole('button').nth(2)).toHaveAccessibleName('图片3')
await mentionMenu.getByRole('button', { name: '图片3' }).click()
await expect(promptInput).toHaveValue('沿用参考角色 @图片3 ')
```

- [x] **步骤 4：运行浏览器测试验证失败**

运行：`npx playwright test e2e/home-canvas.spec.js -g "三张已连接参考图"`

预期：FAIL，下拉按钮仍使用原始图片标题。

### 任务 2：实现统一序号合同

**文件：**
- 修改：`frontweb/src/utils/freeCanvasGeneration.js`
- 修改：`frontweb/src/views/DramaCanvas.vue`
- 修改：`frontweb/src/views/HomeCanvas.vue`
- 修改：`frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`

- [x] **步骤 1：实现最小候选构造函数**

```js
export function buildFreeCanvasReferenceMentionCandidates(references = []) {
  return (Array.isArray(references) ? references : [])
    .map((reference, index) => ({
      nodeId: String(reference.nodeId || ''),
      title: reference.title || '图片节点',
      label: `图片${index + 1}`,
      mentionToken: `@图片${index + 1}`,
      url: reference.url,
      ready: reference.ready,
      enabled: reference.enabled,
    }))
    .filter((reference) => reference.nodeId && reference.ready && reference.enabled !== false)
}
```

- [x] **步骤 2：两个画布入口复用函数**

将 `DramaCanvas.vue` 与 `HomeCanvas.vue` 的 `freeCanvasReferenceCandidates()` 改为调用 `buildFreeCanvasReferenceMentionCandidates(collectDirectUpstreamImageReferences(...))`。

- [x] **步骤 3：编辑器显示并插入序号**

```vue
<span>{{ candidate.label }}</span>
```

```js
draft.content = `${before}${candidate.mentionToken} ${after}`
```

- [x] **步骤 4：运行定向单测和浏览器测试验证通过**

运行：`node --test test/standaloneCanvasFreeNodeGeneration.test.js test/standaloneCanvasFreeNodeRuntime.test.js test/standaloneCanvasNodeEditorParity.test.js`

运行：`npx playwright test e2e/home-canvas.spec.js -g "三张已连接参考图"`

预期：新增序号合同测试与浏览器测试全部 PASS；记录已有基线失败，不把无关失败混入本任务。

### 任务 3：建立未经授权修改门禁

**文件：**
- 创建：`.github/CODEOWNERS`
- 创建：`backend-node/scripts/verify-canvas-reference-sequence-contract.js`
- 创建：`backend-node/test/canvasReferenceSequenceContract.test.js`
- 修改：`backend-node/package.json`
- 修改：`.github/workflows/dependency-security.yml`

- [x] **步骤 1：先写验证器失败测试**

测试必须证明缺少 `canvas-reference-numbered-mentions-v1`、仍插入 `candidate.title`、或两个画布入口未复用统一函数时返回 `PROTECTED_REFERENCE_SEQUENCE_CONTRACT_FAILED`。

- [x] **步骤 2：实现合同验证器**

验证器同时检查统一构造函数、两个入口复用、组件显示 `candidate.label`、插入 `candidate.mentionToken`，并拒绝旧的 `@${candidate.title}` 实现。

- [x] **步骤 3：接入 CI 和代码所有权**

`dependency-security.yml` 执行 `npm --prefix backend-node run audit:canvas-reference-sequence`；CODEOWNERS 将合同涉及文件归属 `@xiongpinji`。主分支启用必须经 PR 和 CODEOWNER 审查的保护规则。

- [ ] **步骤 4：独立审计生产共享门禁扩展**

从线上共享验证器制作独立安全变更，仅追加 `canvas-reference-numbered-mentions-v1` 验证；不得由候选版本替换 `/opt/moli-drama/shared/release-guard`。安装后共享文件保持 `root:root` 且不可由候选覆盖。

### 任务 4：验证、PR 与受保护增量部署

**文件：**
- 本计划列出的本次合同文件
- 生产候选只覆盖经审计的运行时源文件；不得整体覆盖线上 release

- [x] **步骤 1：运行完整前端单测、定向 E2E、构建和合同审计**

运行：`node --test test/*.test.js`

运行：`npx playwright test e2e/home-canvas.spec.js -g "三张已连接参考图"`

运行：`npm run build`

运行：`npm --prefix backend-node run audit:canvas-reference-sequence`

验证记录：定向纯函数 21/21、门禁篡改 4/4、三图片 Playwright 1/1、生产构建通过。完整前端单测本分支 578 项中 565 通过、13 失败；同一 `origin/main` 基线 576 项中 566 通过、10 失败，共有失败集合一致，额外 3 个任务轮询用例在并行运行时受资源争用影响，随后串行 3/3 通过。

- [ ] **步骤 2：提交、推送并创建 PR**

提交只包含本计划文件；推送 `codex/canvas-reference-numbered-mentions` 并创建面向 `main` 的 PR，等待必需检查通过。

- [ ] **步骤 3：从实时 current 制作候选**

记录实时 `/opt/moli-drama/current`、活动任务、数据库备份和 AI 音乐 PID；克隆该 current，仅覆盖本次运行时文件，使用改动清单哈希和 CAS 防止并行会话覆盖。

- [ ] **步骤 4：受保护切换与真实浏览器验收**

候选通过构建、`preflight:production`、增量范围门禁和共享合同门禁后，只能调用 `activate-protected-release.sh CANDIDATE EXPECTED_CURRENT`。上线后验证三张参考图下拉为图片1/2/3，点击图片3插入 `@图片3`，并确认服务健康、无活动任务、日志无严重错误、AI 音乐 PID 不变。
