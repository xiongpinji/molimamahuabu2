# 一键转绘海外短剧总执行计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按已确认规格交付独立四步“一键转绘”工作台，把授权的中国短剧转换为目标语言、目标地区、目标视觉风格的海外短剧成片。

**架构：** 新增独立转绘编排层，以不可变源片事实层和版本化本地化层为中心，复用现有任务、资产、图片、视频、音频、合并和积分账本能力。四个阶段按“输入分析 → 本地化资产审核 → 付费分镜生成 → 合成导出验收”串行推进，每个阶段独立测试和提交，未通过真实生成证据的能力不得进入生产目录。

**技术栈：** Node.js 20、Express、better-sqlite3、Vue 3、Vue Router、Element Plus、Vite、Node Test Runner、Playwright、FFmpeg/FFprobe。

---

## 1. 规范与计划文件

- 设计规格：`docs/superpowers/specs/2026-08-06-one-click-short-drama-redraw-design.md`
- 阶段 1：`docs/superpowers/plans/2026-08-06-one-click-short-drama-redraw-phase-1-foundation-analysis.md`
- 阶段 2：`docs/superpowers/plans/2026-08-06-one-click-short-drama-redraw-phase-2-localization-assets.md`
- 阶段 3：`docs/superpowers/plans/2026-08-06-one-click-short-drama-redraw-phase-3-shot-generation-billing.md`
- 阶段 4：`docs/superpowers/plans/2026-08-06-one-click-short-drama-redraw-phase-4-composition-export-e2e.md`

## 2. 固定执行顺序

- [ ] **步骤 1：执行阶段 1**

完成数据库、项目/作品、源片上传、风格目录、能力目录、源片分析、全局入口和第一步页面。运行阶段 1 中列出的全部测试，预期全部 PASS，再提交。

- [ ] **步骤 2：执行阶段 2**

完成忠实本地化、台词改写与时长检查、角色/场景/物品/音色生成、场景去人净景和强制人工审核。运行阶段 2 中列出的全部测试，预期全部 PASS，再提交。

- [ ] **步骤 3：执行阶段 3**

完成分镜编辑、引用解析、单镜/批量生成、报价、冻结、结算、释放、幂等和重启回读。运行阶段 3 中列出的全部测试，预期全部 PASS，再提交。

- [ ] **步骤 4：执行阶段 4**

完成时间线、配音/字幕、合成版本、下载、剪映归档验证、短剧工厂导入和真实同链 E2E。运行阶段 4 中列出的全部测试，预期全部 PASS，再提交。

- [ ] **步骤 5：执行全量回归**

运行：

```powershell
Set-Location backend-node
npm test
Set-Location ..\frontweb
node --test test/*.test.js
npm run build
npx playwright test e2e/redraw-workspace.spec.js
```

预期：后端测试 0 failed，前端合同测试 0 failed，Vite 构建成功，转绘浏览器 E2E 全部通过。

## 3. 跨阶段不可变合同

### 3.1 数据与版本

- `redraw_works.source_asset_id` 和 `source_fingerprint` 在作品创建后不可被普通更新接口覆盖。
- 源片事实层只追加版本，不允许本地化接口回写或删除。
- 风格预设提交时保存 `stable_key + version + prompt snapshot`，目录更新不改变旧版本。
- 改语言、地区、风格或已生成输入时创建新的 `redraw_versions`，不覆盖旧产物。
- 资产、分镜、配音、字幕、合成和导出均引用明确 `version_id`。

### 3.2 生产能力门禁

- 普通用户风格目录只返回 `status='verified'` 且证据产物可读的预设。
- 语言能力分别展示 `full_output`、`subtitle_only`、`voice_pending`。
- 图片、视频、TTS 和视频理解能力必须使用目标 Key 完成真实生成并记录不含密钥的证据。
- 模型列表、连通性测试、模拟接口、静态缩略图和历史产物不能作为可生产证明。

### 3.3 资产审核门禁

- 所有被分镜引用的角色、场景、物品和角色音色必须为 `approved`。
- 场景资产同时保留源场景、本地化场景和可选去人净景版本；引用净景的镜头必须审批对应版本。
- 门禁失败时允许编辑，但单镜和批量视频生成均返回结构化缺失清单，不创建供应商任务，不冻结积分。

### 3.4 计费

- 所有生成按钮显示加粗“本次预计扣除 X 积分”；没有定价时显示“积分待管理员配置”并禁用。
- 提交顺序固定为：服务端报价 → 资源/版本复核 → 冻结 → 创建本地任务 → 创建供应商任务。
- 成功终态且产物可读后结算；失败或供应商拒绝后释放；状态不确定时进入 `needs_attention`，不自动重提或退款。
- 幂等键至少包含 `tenant_id + operation + version_id + resource_id + input_hash + attempt`。

### 3.5 API 成功合同

异步写接口只有在返回下列结构且后端可回读任务时，前端才推进步骤：

```js
{
  success: true,
  data: {
    project_id: 1,
    work_id: 2,
    version: 1,
    task_id: 'uuid',
    status: 'processing',
    current_step: 2,
    billing: { held: 12, charged: 0, released: 0 },
    artifacts: [],
    updated_at: '2026-08-06T00:00:00.000Z',
  },
}
```

HTTP 200 但缺少 `success: true`、任务 ID 或应有产物 ID 时，前端按失败处理。

## 4. 规格覆盖矩阵

| 规格章节 | 实现计划 |
| --- | --- |
| 入口、路由、项目/作品列表 | 阶段 1，任务 5-6 |
| MP4/MOV/ZIP 上传、指纹、校验 | 阶段 1，任务 2 |
| 四类风格、37 个真人预设、自由风格 | 阶段 1，任务 3、6 |
| 能力门禁、语言及地区状态 | 阶段 1，任务 3；阶段 2，任务 2、5 |
| 源片拆镜、事实层、恢复 | 阶段 1，任务 4、7 |
| 忠实本地化、台词时长、事实锁 | 阶段 2，任务 1-2 |
| 角色/场景/物品/音色、去人净景 | 阶段 2，任务 3-5 |
| 强制资产审核 | 阶段 2，任务 6-7 |
| 分镜引用、编辑、批次 | 阶段 3，任务 1-2、6 |
| 单镜/批量视频生成 | 阶段 3，任务 3-5 |
| 报价、冻结、结算、释放、幂等 | 阶段 3，任务 2-5 |
| 原片对比、轻量时间线、重新拼接 | 阶段 4，任务 1-3、6 |
| 配音、字幕、SRT/VTT、RTL | 阶段 4，任务 1-3 |
| 下载、剪映、短剧工厂导入 | 阶段 4，任务 4-5 |
| 租户隔离、权限、安全 | 阶段 1，任务 1-2、5；各阶段路由测试 |
| 可观测性、恢复、失败注入 | 阶段 1，任务 7；阶段 3，任务 5；阶段 4，任务 7 |
| 真实浏览器/模型同链验收 | 阶段 4，任务 7 |
| 受保护生产发布 | 阶段 4，任务 8，仅在用户明确授权部署后执行 |

## 5. 阶段门禁

- [ ] **步骤 1：阶段 1 完成门禁**

确认真实源视频能上传、指纹去重、选择已验证风格和语言、创建分析任务、刷新后恢复状态，并回读结构化事实层。没有已验证视频理解模型时，页面明确阻塞且不模拟成功。

- [ ] **步骤 2：阶段 2 完成门禁**

确认本地化版本不改变锁定事实，角色/场景/物品/音色及去人净景均有版本，全部引用资产审批前视频生成入口被后端阻止。

- [ ] **步骤 3：阶段 3 完成门禁**

确认真实生成一个分镜，重复请求不重复扣费，失败只影响目标镜头，服务重启可回读供应商任务，未知状态不自动重提。

- [ ] **步骤 4：阶段 4 完成门禁**

确认同一作品完成全部镜头、目标语言配音、字幕、合成、下载和真实剪映导入；积分账本与各任务终态一致；浏览器 E2E 无未处理控制台错误。

## 6. Git 与生产边界

- 每个任务只暂存计划列出的文件，先运行 `git diff --check` 再提交。
- 不清理、不覆盖、不回退其他会话或用户已有改动。
- 计划执行期间不修改生产数据库、模型目录、积分余额或 `/opt/moli-drama/current`。
- 用户明确授权生产发布后，必须先通过 SSH 读取实时 `/opt/moli-drama/current`，从该 release 构建候选并保留 `canvas-credit-callout-v1`。
- 生产切换只能调用共享 `activate-protected-release.sh CANDIDATE EXPECTED_CURRENT`，并通过部署锁、CAS、备份、活动任务、健康、日志和 AI 音乐进程隔离检查。
