# 剧本分析接口与品牌导航清理实现计划

> **面向 AI 代理的工作者：** 使用 `executing-plans` 在当前独立工作树逐项执行。步骤使用复选框跟踪；生产切换必须另行获得确认并走共享发布门禁。

**目标：** 修复线上剧本分析初始化接口 404，并移除左上品牌区域的工作区下拉导航，同时保留顶部主导航。

**架构：** 线上故障属于发布组合漂移：前端已调用 `skills` 与 `production-presets`，正确的 V2 后端实现及集成测试也已存在，但当前 live `routes/index.js` 丢失三条路由注册。代码阶段以正确 V2 合同为基线验证，发布阶段只把三条注册增量应用到最新 live 候选；前端仅把 `CanvasWorkspaceSwitcher` 从交互式下拉框收敛为静态品牌标识。

**技术栈：** Node.js 22、Express、Vue 3、Element Plus、Node test runner、Vite。

---

## 文件结构

- 修改：`frontweb/src/components/CanvasWorkspaceSwitcher.vue` — 删除下拉交互与菜单，仅保留品牌。
- 创建：`frontweb/test/canvasWorkspaceSwitcher.test.js` — 锁定无下拉菜单且顶部主导航不受影响。
- 验证：`backend-node/test/scriptAnalysisEndpoint.integration.test.js` — 真实启动隔离 API，验证 skills、production-presets 与项目接口。
- 发布候选修改：`backend-node/src/routes/index.js` — 仅在最新 live 克隆候选中补回三条已存在处理器的路由注册。

### 任务 1：锁定剧本分析接口根因与正确合同

- [x] **步骤 1：记录生产红灯证据**

运行只读检查：

```bash
curl -i https://molimama.vip/api/v1/script-analysis/skills
curl -i https://molimama.vip/api/v1/script-analysis/production-presets
```

预期（修复前）：登录页面初始化请求在 nginx 访问日志中均为 `404`；前端出现两条 `API endpoint not found`。

- [x] **步骤 2：运行正确 V2 后端集成合同**

```bash
cd backend-node
node --test --test-concurrency=1 test/scriptAnalysisEndpoint.integration.test.js
```

预期：隔离服务上的 `/script-analysis/skills`、`/script-analysis/production-presets` 和项目接口均返回成功，证明处理器实现正确，故障点仅在 live 总路由注册。

- [ ] **步骤 3：准备最新 live 候选中的最小路由补丁**

只在获得生产发布确认后，从实时 `/opt/moli-drama/current` 克隆候选，并在 script analysis 路由组加入：

```js
r.get('/script-analysis/skills', scriptAnalysis.skills);
r.get('/script-analysis/production-presets', scriptAnalysis.presets);
r.post('/script-analysis/projects/:id/import-to-factory', scriptAnalysis.importToFactory);
```

不得替换整个旧版 `index.js`，不得覆盖支付宝充值或其他并行发布路由。

### 任务 2：用 TDD 移除工作区下拉导航

- [x] **步骤 1：编写失败测试**

创建 `frontweb/test/canvasWorkspaceSwitcher.test.js`，断言组件仍包含品牌名称与副标题，但不再包含 `el-dropdown`、`el-dropdown-menu`、`打开工作区菜单`、下拉箭头和原菜单导航项；同时断言 `PlatformPrimaryNav.vue` 仍包含首页、画布、剧本分析和短剧工厂。

- [x] **步骤 2：运行测试确认红灯**

```bash
cd frontweb
node --test test/canvasWorkspaceSwitcher.test.js
```

预期：FAIL，原因是当前组件仍包含 `el-dropdown` 与菜单导航。

- [x] **步骤 3：编写最少实现**

将组件根节点改为静态品牌容器：

```vue
<div class="canvas-workspace-switcher" aria-label="茉莉妈妈短剧制作平台">
  <img class="canvas-workspace-switcher__logo" src="/moli-mama-logo.png" alt="茉莉妈妈" />
  <span class="canvas-workspace-switcher__copy">
    <span class="canvas-workspace-switcher__name">茉莉妈妈</span>
    <span class="canvas-workspace-switcher__subtitle">短剧制作平台</span>
  </span>
</div>
```

保留 `homeTo` prop 用于吞掉现有调用方属性，删除路由、图标、下拉菜单、指针和交互样式。

- [x] **步骤 4：运行测试确认绿灯**

```bash
cd frontweb
node --test test/canvasWorkspaceSwitcher.test.js
```

结果：PASS，2/2。

### 任务 3：回归验证与生产候选门禁

- [x] **步骤 1：运行剧本分析相关后端测试**

```bash
cd backend-node
node --test --test-concurrency=1 test/scriptAnalysisEndpoint.integration.test.js test/scriptAnalysisRoutes.test.js test/scriptAnalysisService.test.js test/scriptAnalysisSkillRegistry.test.js
```

- [x] **步骤 2：运行前端相关测试与构建**

```bash
cd frontweb
node --test test/canvasWorkspaceSwitcher.test.js test/filmListCanvasEntry.test.js test/scriptAnalysisDirectorV2.test.js test/scriptAnalysisFactoryPreview.test.js
npm run build
```

- [x] **步骤 3：检查改动范围**

```bash
git status --short
git diff --check
git diff --stat
```

预期：仅计划、下拉导航组件和其测试发生本地改动；生产候选只允许额外修改 live `routes/index.js` 与新构建的 `frontweb/dist`。

- [ ] **步骤 4：生产发布（需确认）**

获得确认后，按实时 current → 部署锁 → CAS → 数据库备份/quick_check → 活动任务/AI 音乐隔离 → 共享审计器 → `activate-protected-release.sh` → 健康/日志/浏览器复验执行。

验收标准：两个初始化接口返回 200；页面无错误 toast；品牌区不可展开；顶部主导航仍可用；5679/8787 健康，原剧本、分析版本、积分和活动任务均未被修改。

### 任务 4：同步主线画布测试合同且不覆盖并行会话

- [x] **步骤 1：确认失败来源**

当前 V2 分支稳定复现 10 项失败；未修改的 V2 基线同样失败。只读盘点发现 `origin/main` 已包含提交 `0bc376d7`（`test(canvas): align baseline contracts with current behavior`），该提交只更新 3 个测试文件，不修改画布实现。

- [x] **步骤 2：验证既有修复**

在原工作树运行相关测试，结果 54/54 通过；随后仅把该提交的断言变化同步到当前隔离工作树，不修改其他会话工作树。

- [x] **步骤 3：重新执行完整门禁**

- 前端全量：572/572 通过。
- 后端全量：654/654 通过。
- 前端生产构建：成功，1843 个模块完成转换。
- 并行门禁曾出现 `aiConfigPublicView.test.js` 单文件波动；单独复跑 4/4、串行后端全量复跑 654/654，未修改其源码或测试。
