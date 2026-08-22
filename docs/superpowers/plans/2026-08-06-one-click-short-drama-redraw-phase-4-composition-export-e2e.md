# 一键转绘阶段 4：合成、导出与真实同链验收实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将已生成的分镜、外语配音和字幕编排为版本化成片，提供原片对比、轻量时间线、下载、SRT/VTT、剪映工程和短剧工厂导入，并完成一条真实中国短剧到外语成片的同链验收。

**架构：** 合成层只消费明确版本中已成功且可读的镜头/音频/字幕产物，重新拼接不重新生成视频。导出层生成可验证的媒体和工程归档；短剧工厂导入调用现有 factory import service，创建目标版本并保持源项目隔离。真实浏览器、真实模型、后端回读、账单和剪映打开共同构成最终门禁。

**技术栈：** Node.js、FFmpeg/FFprobe、现有 `videoMergeService.js`、`mergedEpisodePostProcess.js`、`videoService.js`、Vue 3、Element Plus、Playwright、指定版本剪映桌面客户端。

---

## 文件结构

- 创建：`backend-node/src/services/redrawDialogueService.js`：批量 TTS、音频时长对齐和说话人轨道。
- 创建：`backend-node/src/services/redrawSubtitleService.js`：SRT/VTT、RTL、阅读速度和安全区校验。
- 创建：`backend-node/src/services/redrawCompositionService.js`：分镜排序、替换、禁用、FFmpeg 合成和版本产物。
- 创建：`backend-node/src/services/redrawExportService.js`：下载、字幕归档、剪映工程 manifest 和导入验证状态。
- 修改：`backend-node/src/services/redrawOrchestrator.js`：配音、字幕、合成和导出恢复。
- 修改：`backend-node/src/routes/redraw.js`：compose、exports、download 和 factory import API。
- 创建：`backend-node/test/redrawDialogue.test.js`：配音时长和角色固定测试。
- 创建：`backend-node/test/redrawSubtitle.test.js`：SRT/VTT、RTL、重叠和阅读速度测试。
- 创建：`backend-node/test/redrawComposition.test.js`：合成顺序、失败保留和版本测试。
- 创建：`backend-node/test/redrawExport.test.js`：导出 manifest、权限和导入状态测试。
- 修改：`backend-node/test/redrawRoutes.test.js`：阶段 4 API 合同。
- 创建：`frontweb/src/components/redraw/RedrawEditStep.vue`：第四步视频编辑工作台。
- 创建：`frontweb/src/components/redraw/RedrawTimeline.vue`：稳定尺寸轻量时间线。
- 创建：`frontweb/src/components/redraw/RedrawPlayerCompare.vue`：原片/新片播放器和音轨开关。
- 创建：`frontweb/src/components/redraw/RedrawExportPanel.vue`：下载、字幕、剪映和工厂导入。
- 创建：`frontweb/src/utils/redrawTimelineState.js`：时间线纯函数和版本校验。
- 修改：`frontweb/src/api/redraw.js`：合成和导出 API。
- 修改：`frontweb/src/views/RedrawWorkspace.vue`：挂载第四步。
- 创建：`frontweb/src/views/RedrawExport.vue`：导出记录详情。
- 创建：`frontweb/test/redrawEdit.test.js`：第四步 UI 合同测试。
- 修改：`frontweb/e2e/redraw-workspace.spec.js`：完整四步浏览器路径。
- 创建：`frontweb/e2e/redraw-real-chain.spec.js`：授权真实短剧同链验收脚本。
- 创建：`docs/superpowers/evidence/2026-08-06-one-click-short-drama-redraw-real-chain.md`：不含密钥的验收证据。

### 任务 1：实现外语配音和时长对齐

**文件：**
- 创建：`backend-node/src/services/redrawDialogueService.js`
- 创建：`backend-node/test/redrawDialogue.test.js`

- [ ] **步骤 1：编写失败的配音测试**

```js
test('每个角色在版本内固定音色并保留说话顺序', () => {
  const plan = buildDialoguePlan(version, shots, voices);
  assert.deepEqual(plan.tracks.map(x => x.voice_snapshot.voice_id), ['maya-en', 'liam-en']);
  assert.equal(plan.segments[0].speaker_id, 'c1');
});

test('TTS 超出可说时长返回改写，不自动拉伸视频', async () => {
  const result = await synthesizeDialogue(ctx, overlongText);
  assert.equal(result.status, 'needs_rewrite');
  assert.equal(result.video_speed_changed, false);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawDialogue.test.js`

预期：FAIL，提示找不到配音服务。

- [ ] **步骤 3：实现配音计划和 TTS 编排**

按 `speaker_id` 固定 voice snapshot，按时间码分段生成目标语言音频；复用阶段 2 已验证 TTS 能力和现有音频资产写入。成功必须检查音频可读、语言、采样率和时长；过长先返回 `needs_rewrite`，仅在配置阈值内允许轻微语速调整或静音补齐。

- [ ] **步骤 4：运行配音测试并提交**

运行：`cd backend-node; node --test test/redrawDialogue.test.js test/canvas-audio-voice-options.test.js`，预期 PASS。

```powershell
git add backend-node/src/services/redrawDialogueService.js backend-node/test/redrawDialogue.test.js
git diff --cached --check
git commit -m "feat: 增加转绘外语配音编排"
```

### 任务 2：实现字幕校验和 SRT/VTT

**文件：**
- 创建：`backend-node/src/services/redrawSubtitleService.js`
- 创建：`backend-node/test/redrawSubtitle.test.js`

- [ ] **步骤 1：编写失败的字幕测试**

```js
test('字幕输出 SRT/VTT 且不重叠', () => {
  const subtitles = buildSubtitles(dialogueSegments, { locale: 'ar-SA' });
  assert.match(subtitles.srt, /--> /);
  assert.match(subtitles.vtt, /^WEBVTT/);
  assert.equal(validateSubtitles(subtitles.cues).ok, true);
});

test('阅读速度、行长和安全区失败会阻止合成', () => {
  const result = validateSubtitles([{ start_ms: 0, end_ms: 500, text: '一段过长字幕' .repeat(20) }]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(x => x.code === 'reading_speed'));
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawSubtitle.test.js`

预期：FAIL，提示找不到字幕服务。

- [ ] **步骤 3：实现字幕规范**

导出 `buildSubtitles`、`validateSubtitles`、`serializeSrt`、`serializeVtt`。检查每行长度、最多两行、阅读速度、时间重叠、标点、数字/单位、安全区和 RTL direction；烧录字幕与可关闭字幕分别生成版本，不覆盖原片字幕。

- [ ] **步骤 4：运行字幕测试并提交**

运行：`cd backend-node; node --test test/redrawSubtitle.test.js`，预期 PASS。

```powershell
git add backend-node/src/services/redrawSubtitleService.js backend-node/test/redrawSubtitle.test.js
git diff --cached --check
git commit -m "feat: 增加转绘字幕导出与质检"
```

### 任务 3：实现版本化合成和轻量时间线数据

**文件：**
- 创建：`backend-node/src/services/redrawCompositionService.js`
- 创建：`backend-node/test/redrawComposition.test.js`

- [ ] **步骤 1：编写失败的合成测试**

```js
test('重新拼接只消费成功镜头且保留明确版本', async () => {
  const result = await composeVersion(ctx, { version_id: 4, shot_order: [3, 1, 2], disabled_shot_ids: [9] });
  assert.equal(result.status, 'completed');
  assert.deepEqual(readManifest(result.export_id).shot_ids, [3, 1, 2]);
  assert.equal(readVersion(db, 4).source_video_id, sourceVideoId);
});

test('合成失败保留镜头、音频和字幕产物', async () => {
  await assert.rejects(() => composeVersion(failingFfmpegCtx, input), /合成/);
  assert.equal(countShotArtifacts(db, 4), 3);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawComposition.test.js`

预期：FAIL，提示找不到合成服务。

- [ ] **步骤 3：实现合成输入和 FFmpeg 调用**

`composeVersion` 校验每个启用镜头 video/audio/subtitle 可读，生成临时 concat/音频混轨清单，调用现有 `videoMergeService` 或公共 FFmpeg 工具，不复制合并逻辑。每次合成创建新 `redraw_exports` 记录和新 asset，绝不覆盖源片或上一 usable 成片。

- [ ] **步骤 4：实现重新排序/替换/禁用**

保存时间线操作为版本级 `manifest_json`；禁用镜头必须在合成前显式确认，不能默默改变剧情。替换只接受同一版本、同一比例且成功可读的镜头。

- [ ] **步骤 5：运行合成测试并提交**

运行：`cd backend-node; node --test test/redrawComposition.test.js test/videoMergeService.test.js`，预期 PASS。

```powershell
git add backend-node/src/services/redrawCompositionService.js backend-node/test/redrawComposition.test.js
git diff --cached --check
git commit -m "feat: 增加转绘版本化视频合成"
```

### 任务 4：实现下载、剪映工程和导入验证

**文件：**
- 创建：`backend-node/src/services/redrawExportService.js`
- 修改：`backend-node/src/services/redrawOrchestrator.js`
- 修改：`backend-node/src/routes/redraw.js`
- 创建：`backend-node/test/redrawExport.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：编写失败的导出测试**

```js
test('导出归档包含镜头、配音、字幕和时间码引用', () => {
  const manifest = buildJianyingManifest(version, timeline);
  assert.deepEqual(manifest.tracks.map(x => x.type), ['video', 'audio', 'subtitle']);
  assert.equal(manifest.schema_version, 'redraw-jianying-1.0');
});

test('未验证剪映版本只能标记 unavailable', () => {
  assert.equal(validateJianyingImport(manifest, { version: 'unknown' }).status, 'unavailable');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend-node; node --test test/redrawExport.test.js`

预期：FAIL，提示找不到导出服务。

- [ ] **步骤 3：实现受控下载和工程 manifest**

导出服务只返回受控下载 token/URL，不返回绝对路径；支持成片 MP4、SRT、VTT 和带校验和的工程归档。manifest 必须包含镜头顺序、每段时间码、视频/音频/字幕 asset ID、locale、market、style snapshot 和版本号。

- [ ] **步骤 4：实现真实剪映验证状态**

按任务指定的桌面版本导出归档，使用自动化或人工桌面验证实际导入并打开，检查顺序、音频、字幕和时间码；只有导入成功才写 `verified`，版本不兼容写 `unavailable`，不能以 JSON 文件存在代替验证。

- [ ] **步骤 5：实现短剧工厂版本隔离导入**

调用现有 `scriptAnalysisFactoryImportService` 或其明确扩展接口，传入 `work_id/version/export_id`，创建目标项目版本；服务端检查用户/租户所有权，拒绝覆盖源项目或没有成片的导入。

- [ ] **步骤 6：运行导出测试和 API 回归并提交**

运行：`cd backend-node; node --test test/redrawExport.test.js test/redrawRoutes.test.js test/scriptAnalysisFactoryImport.test.js`，预期 PASS。

```powershell
git add backend-node/src/services/redrawExportService.js backend-node/src/services/redrawOrchestrator.js backend-node/src/routes/redraw.js backend-node/test/redrawExport.test.js backend-node/test/redrawRoutes.test.js
git diff --cached --check
git commit -m "feat: 增加转绘下载剪映与工厂导出"
```

### 任务 5：实现第四步 UI

**文件：**
- 创建：`frontweb/src/components/redraw/RedrawEditStep.vue`
- 创建：`frontweb/src/components/redraw/RedrawTimeline.vue`
- 创建：`frontweb/src/components/redraw/RedrawPlayerCompare.vue`
- 创建：`frontweb/src/components/redraw/RedrawExportPanel.vue`
- 创建：`frontweb/src/utils/redrawTimelineState.js`
- 创建：`frontweb/src/views/RedrawExport.vue`
- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/src/views/RedrawWorkspace.vue`
- 创建：`frontweb/test/redrawEdit.test.js`
- 修改：`frontweb/e2e/redraw-workspace.spec.js`

- [ ] **步骤 1：编写失败的第四步 UI 测试**

断言成片播放器、原片/新片切换、时间码、字幕和外语配音开关、稳定时间线、重新拼接、下载 MP4/SRT/VTT、剪映导出和工厂导入按钮存在；断言没有完整 NLE 多轨工具。

- [ ] **步骤 2：运行测试确认失败**

运行：`cd frontweb; node --test test/redrawEdit.test.js`

预期：FAIL，提示组件不存在。

- [ ] **步骤 3：实现播放器和时间线**

时间线使用固定 `minmax(88px, 1fr)` 轨道、固定缩略图比例和可拖拽排序；显示原/新状态和失败状态。禁用、替换、排序操作先更新本地草稿，提交重新拼接后以服务端 manifest 回读为准。

- [ ] **步骤 4：实现字幕/配音开关和导出面板**

开关只控制预览，不改写源片；导出状态由后端回读。下载按钮使用下载图标并提供 tooltip；剪映按钮在 `verified` 前显示校验中/不可用原因；工厂导入要求明确选择目标版本。

- [ ] **步骤 5：运行前端测试、构建和浏览器回归**

运行：`cd frontweb; node --test test/redrawEdit.test.js test/redrawShots.test.js; npm run build; npx playwright test e2e/redraw-workspace.spec.js --project=chromium`

预期：全部 PASS；1440×900、1024×768、390×844 均无遮挡、溢出和文本截断。

- [ ] **步骤 6：提交第四步 UI**

```powershell
git add frontweb/src/components/redraw/RedrawEditStep.vue frontweb/src/components/redraw/RedrawTimeline.vue frontweb/src/components/redraw/RedrawPlayerCompare.vue frontweb/src/components/redraw/RedrawExportPanel.vue frontweb/src/utils/redrawTimelineState.js frontweb/src/views/RedrawExport.vue frontweb/src/api/redraw.js frontweb/src/views/RedrawWorkspace.vue frontweb/test/redrawEdit.test.js frontweb/e2e/redraw-workspace.spec.js
git diff --cached --check
git commit -m "feat: 交付转绘视频编辑与导出界面"
```

### 任务 6：完成真实同链浏览器验收

**文件：**
- 创建：`frontweb/e2e/redraw-real-chain.spec.js`
- 创建：`docs/superpowers/evidence/2026-08-06-one-click-short-drama-redraw-real-chain.md`

- [ ] **步骤 1：准备授权源片和能力清单**

选择用户授权的 15 秒至 3 分钟中国短剧；逐项确认已验证的视频理解、文本本地化、图片、视频、TTS 模型和一个真实可用风格。记录测试租户和目标语言/地区，不记录密钥。

- [ ] **步骤 2：执行真实四步链**

浏览器实际完成上传、分析、检查事实、生成并审批资产（含去人净景）、生成全部分镜、配音、字幕、合成、原片对比、开关、失败重试、刷新恢复和下载。

- [ ] **步骤 3：验证产物和剪映**

使用 FFprobe/文件读取验证 MP4、每个视频片段、音频、SRT/VTT；在任务指定剪映桌面版本实际导入并打开 manifest，检查镜头顺序、音频、字幕和时间码。

- [ ] **步骤 4：验证账本与隔离**

读取后端账本摘要，核对每次冻结、结算、释放与任务终态；确认源视频、源事实和旧版本未改变，工厂导入只创建目标版本。

- [ ] **步骤 5：注入失败与恢复**

分别注入单镜失败、TTS 时长失败、字幕排版失败、FFmpeg 合成失败和服务重启；确认错误可读、产物保留、正确退款/held、可从最近状态继续。

- [ ] **步骤 6：写入证据并运行最终审计**

证据文档包含 source asset fingerprint、project/work/version/task IDs、供应商/模型脱敏标识、浏览器步骤、控制台/后端错误摘要、产物可读取结果、账单摘要和剪映版本/导入结果。运行：

```powershell
cd backend-node
npm test
cd ..\frontweb
node --test test/*.test.js
npm run build
npx playwright test e2e/redraw-real-chain.spec.js --project=chromium
git diff --check
```

预期：全部 PASS；若真实模型或剪映导入任一失败，文档明确标记 `blocked`，不得标记产品完成。

- [ ] **步骤 7：提交验收证据**

```powershell
git add frontweb/e2e/redraw-real-chain.spec.js docs/superpowers/evidence/2026-08-06-one-click-short-drama-redraw-real-chain.md
git diff --cached --check
git commit -m "test: 验收一键转绘真实同链"
```

### 任务 7：发布前保护审计（仅用户授权部署后执行）

- [ ] **步骤 1：从线上实时基线构建候选**

通过 SSH 读取 `/opt/moli-drama/current` 的实时 release、提交、活动任务、磁盘和 AI 音乐进程，从该 release 克隆候选并应用本分支提交；不得用本地旧 worktree 覆盖线上。

- [ ] **步骤 2：运行共享审计器**

确认 `canvas-credit-callout-v1` 所有可生成节点文案仍为加粗“本次预计扣除 X 积分”或“积分待管理员配置”；运行后端测试、前端构建、增量范围审计和许可证审计。

- [ ] **步骤 3：执行受保护切换**

只允许调用：

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
```

切换后检查部署锁、CAS、备份、活动任务、健康、日志和 AI 音乐进程隔离；失败立即保留候选和日志，不直接替换 `current`。
