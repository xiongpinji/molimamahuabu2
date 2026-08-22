# 一键转绘 Fumin Mini 参考包真实样片验证实现计划

> **面向 AI 代理的工作者：** 必需技能：使用 `executing-plans` 逐任务执行，代码任务使用 `test-driven-development`，异常使用 `systematic-debugging`，交付前使用 `verification-before-completion`；创建虚构身份图时使用 `imagegen`，上传 Fumin 第一方素材时使用浏览器控制技能。除非用户另行要求，不启动子代理。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 从用户源视频 `30.000–35.000 秒` 建立真实、脱敏、可审计的单角色参考包，经一键转绘产品链路只提交 1 次 Fumin `seedance-2.0-mini`、480p、16:9、5 秒有声任务，并对同一任务完成下载、媒体、英文台词、人物、文字、运动、费用和人工验收。

**架构：** 以当前 `redraw-reference-bundle-v1` 为事实源，选择性重写旧 Fumin 客户端的最小 Mini 能力，不整体合并旧分支。服务端先把已审核身份图、真实源片派生的无声净化运动参考和唯一英语画外音投影到 Fumin；仓库外运行器以请求哈希建立原子单次锁，分离 `prepare`、`preflight`、`submit`、`resume`、`finalize`，不确定提交永不自动重试。所有真实素材、Key、任务响应、ASR/OCR 明文和成品保存在仓库外私有目录，Git 只保存代码、测试和脱敏报告。

**技术栈：** Node.js 20、`node:test`、`better-sqlite3`、FFmpeg/FFprobe、`sharp`、SHA-256、Python 3.11、`faster-whisper==1.2.1`、`rapidocr==3.9.2`、`onnxruntime==1.28.0`、Fumin `/api/v3/contents/generations/tasks`。

**设计依据：** `docs/superpowers/specs/2026-08-15-redraw-fumin-reference-bundle-live-validation-design.md`

---

## 实施边界与固定事实

- 执行前从包含本计划的当前 HEAD 创建 `codex/redraw-fumin-reference-live-20260815` 和 `worktrees/redraw-fumin-reference-live-20260815`；不得在聚合根目录写代码。
- 旧只读来源仅限 `worktrees/fumin-live-5s-validation-20260814/backend-node/src/services/fuminVideoClient.js` 和该文件对应测试；禁止 `merge` 旧分支，禁止复制 Fast、模型目录、价格表、前端入口或生产发布改动。
- 本地模型别名固定 `fumin-seedance-2.0-mini`，上游固定 `seedance-2.0-mini`；请求固定 `480p`、`16:9`、`5` 秒、`watermark=false`。
- 请求媒体固定为 1 张已审核的虚构 AI 美国成年男性三视图身份图、1 个由源片 `30–35 秒` 派生的 H.264 无声净化运动参考、0 个音频参考。
- 唯一对白固定为 `character-001` / `Ethan` / `voice_over` / `200–3800ms` / `But now he doesn't even have any capital.`；不得携带源中文、源姓名或源音轨。
- 真实 POST 前必须取得同次、精确的费用和余额证据，并让用户确认该精确金额。现有“允许 1 次提交”不代替金额确认。
- 本计划不部署、不 SSH、不写生产数据库、不恢复线上入口、不修改生产模型目录、不 push、不生成第二个付费任务。

## 文件清单

- 创建 `backend-node/src/services/fuminVideoClient.js`：Mini 请求、创建、查询和不确定提交语义。
- 创建 `backend-node/test/fuminVideo.test.js`：Fumin body、响应、单次错误语义和通用 dispatcher 测试。
- 修改 `backend-node/src/services/videoClient.js`：选择性接入 `fumin_video` 创建与轮询。
- 修改 `backend-node/src/services/redrawReferenceBundleService.js`：在对白合同与参考包哈希中固化 `delivery=voice_over`。
- 修改 `backend-node/src/services/redrawGenerationService.js`：Fumin 参考包能力、Mini/480p/16:9/5 秒和原生提示词音频门禁。
- 修改 `backend-node/test/redrawReferenceBundle.test.js`：画外音规范化、哈希和提示词测试。
- 修改 `backend-node/test/redrawGeneration.test.js`：Fumin 唯一能力、失败不计费/不调用和请求快照测试。
- 创建 `backend-node/src/services/redrawLiveMotionSanitizerService.js`：真实源片确定性剪辑、完整画幅适配、不可识别化、去文字、静音和证据验证。
- 创建 `backend-node/test/redrawLiveMotionSanitizer.test.js`：命令、哈希、媒体、覆盖和脱敏门禁。
- 创建 `backend-node/src/services/redrawFuminLiveCaseService.js`：单角色真实源片参考包 case 构建与校验。
- 创建 `backend-node/scripts/run-redraw-fumin-reference-live-case.js`：仓库外 prepare/dry-run 运行器。
- 创建 `backend-node/test/redrawFuminLiveCase.test.js`：真实 case CLI 和脱敏测试。
- 创建 `workers/redraw-live-verifier/requirements.in` 和生成的 `requirements.lock`：固定本地 ASR/OCR 顶层与传递依赖。
- 创建 `workers/redraw-live-verifier/verify_media.py`、`workers/redraw-live-verifier/tests/test_verify_media.py`：成品 ASR、OCR 和媒体候选验收。
- 创建 `backend-node/src/services/redrawFuminLiveRunService.js`：付费前门禁、请求哈希、状态机和原子单次锁。
- 创建 `backend-node/scripts/verify-redraw-fumin-reference-live.js`：`preflight/submit/resume/finalize` 唯一真实验证 CLI。
- 创建 `backend-node/test/redrawFuminReferenceLiveVerification.test.js`：Stub 同链、恢复和永不重复 POST 测试。
- 修改 `backend-node/package.json`、`.gitignore`：显式纳入两个本地验证脚本和 npm 命令。
- 创建 `docs/superpowers/reports/2026-08-15-redraw-fumin-reference-live-verification.md`：最终脱敏证据报告；仅在真实运行终态后创建。

明确不修改 `frontweb/`、迁移、模型价格、生产配置、部署脚本、共享发布门禁和线上导航入口。

### 任务 1：创建隔离实施工作树并锁定基线

**文件：** 不修改业务文件。

- [ ] **步骤 1：确认当前工作树只含既有未跟踪项**

```powershell
Set-Location C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809
git status --short --branch
git log -2 --oneline
```

预期：HEAD 含已批准规格和本计划；仅 `.superpowers/`、`frontweb/output/`、三个 `workers/.../__pycache__/` 为既有未跟踪项。

- [ ] **步骤 2：创建独立分支和工作树**

```powershell
Set-Location C:\Users\canqu\Documents\茉莉妈妈2
git worktree add worktrees\redraw-fumin-reference-live-20260815 -b codex/redraw-fumin-reference-live-20260815 codex/redraw-r12-merge-20260809
Set-Location worktrees\redraw-fumin-reference-live-20260815
git status --short --branch
```

预期：新工作树干净且基线包含本计划；如果分支或目录已存在，停止并只读核对，不删除、不覆盖。

- [ ] **步骤 3：证明未整体合并旧 Fumin 分支**

```powershell
git merge-base --is-ancestor codex/fumin-seedance-20260813 HEAD
```

预期：exit 1；这是预期证据，不执行 merge。

### 任务 2：用 TDD 实现严格的 Fumin Mini 客户端

**文件：** 创建 `backend-node/src/services/fuminVideoClient.js`、`backend-node/test/fuminVideo.test.js`。

- [ ] **步骤 1：先写请求合同红灯**

在 `fuminVideo.test.js` 测试 `buildFuminVideoBody`：

```js
const body = buildFuminVideoBody({
  model: 'fumin-seedance-2.0-mini',
  prompt: "Ethan voice-over, 0.2s-3.8s: But now he doesn't even have any capital.",
  duration: 5,
  resolution: '480p',
  aspect_ratio: '16:9',
  watermark: false,
  reference_urls: ['https://assets.fumin.example/ethan.png'],
  reference_video_urls: ['https://assets.fumin.example/motion.mp4'],
  reference_audio_urls: [],
});
assert.equal(body.model, 'seedance-2.0-mini');
assert.deepEqual(body.content.map(({ type, role }) => [type, role || null]), [
  ['text', null],
  ['image_url', 'reference_image'],
  ['video_url', 'reference_video'],
]);
assert.equal('generate_audio' in body, false);
```

补充逐项单变量拒绝：Fast/未知模型、非 5 秒、非 480p、非 16:9、watermark 非 false、0 或 2 张身份图、0 或 2 个视频、任意音频参考、空提示词、非 HTTPS 媒体 URL。错误码固定为 `FUMIN_LIVE_REQUEST_INVALID`，错误和 JSON 序列化不得包含 URL query、Authorization 或 Key。

- [ ] **步骤 2：运行测试确认模块缺失红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/fuminVideo.test.js
```

预期：`MODULE_NOT_FOUND: ../src/services/fuminVideoClient`。

- [ ] **步骤 3：实现最小请求、创建和查询函数**

仅导出：

```js
resolveFuminModel
buildFuminCreateUrl
buildFuminQueryUrl
buildFuminVideoBody
parseFuminSubmitResponse
parseFuminStatusPayload
callFuminVideoApi
fetchFuminTask
```

固定创建和查询路径为 `/api/v3/contents/generations/tasks` 与 `/api/v3/contents/generations/tasks/{taskId}`。`fetchImpl` 必须注入；创建连接中断、超时、2xx 非 JSON、2xx 无任务 ID/视频地址均返回 `{ indeterminate: true, code: 'FUMIN_SUBMISSION_UNKNOWN' }`。明确 4xx/5xx 返回 `FUMIN_PROVIDER_REJECTED`，不得在客户端循环或重试。日志只记录模型、时长、分辨率、比例和三类引用数量。

- [ ] **步骤 4：增加响应矩阵并运行绿灯**

覆盖 queued/processing/completed+HTTPS 视频/failed/completed 无视频/非 JSON/网络中断；断言 `fetchImpl` 的 POST 次数恰好 1。

```powershell
node --test --test-concurrency=1 test/fuminVideo.test.js
node --check src/services/fuminVideoClient.js
Set-Location ..
git diff --check
git add backend-node/src/services/fuminVideoClient.js backend-node/test/fuminVideo.test.js
git commit -m "feat(视频): 增加 Fumin Mini 严格客户端"
```

### 任务 3：选择性接通通用视频 dispatcher

**文件：** 修改 `backend-node/src/services/videoClient.js`、`backend-node/test/fuminVideo.test.js`。

- [ ] **步骤 1：先写 dispatcher 红灯**

断言：

- `inferVideoProtocol('fumin') === 'fumin_video'`；
- `resolveVideoProtocol({provider:'fumin'}, 'fumin-seedance-2.0-mini') === 'fumin_video'`；
- `callVideoApi` 只把 prompt、Mini、5、480p、16:9、1 图、1 视频、0 音频交给 Fumin 客户端；
- `pollVideoTask` 只查询同一任务 ID，completed 返回同一 HTTPS 成品 URL；
- 非 Fumin 既有测试不改变。

- [ ] **步骤 2：运行红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/fuminVideo.test.js
```

预期：协议仍推断为 `openai`，Fumin 分支未调用。

- [ ] **步骤 3：实现最小 import、推断、创建和轮询分支**

只增加四处：顶部 `require('./fuminVideoClient')`、协议推断/解析、`callVideoApi` 的 Fumin 分支、`pollVideoTask` 的 Fumin 分支。不得复制旧分支的模型目录、Fast、计价或生产证据逻辑；不得让通用 fallback 改写 reference image/video。

- [ ] **步骤 4：运行联合绿灯并提交**

```powershell
node --test --test-concurrency=1 test/fuminVideo.test.js test/toapisVideoIntegration.test.js test/feituoVideo.test.js test/videoGenerationRequestSnapshot.test.js
node --check src/services/videoClient.js
Set-Location ..
git diff --check
git add backend-node/src/services/videoClient.js backend-node/test/fuminVideo.test.js
git commit -m "feat(视频): 接通 Fumin 视频协议"
```

### 任务 4：固化画外音对白与 Fumin 参考包生成门禁

**文件：** 修改 `backend-node/src/services/redrawReferenceBundleService.js`、`backend-node/src/services/redrawGenerationService.js`、`backend-node/test/redrawReferenceBundle.test.js`、`backend-node/test/redrawGeneration.test.js`。

- [ ] **步骤 1：先写 `delivery` 与哈希红灯**

在参考包 fixture 的唯一对白加入 `delivery: 'voice_over'`，断言保存快照保留该值；把它改为 `lip_sync`、空值或未知值均返回 `REDRAW_REFERENCE_BUNDLE_DIALOGUE_INVALID`。相同包仅改变 `delivery` 时哈希必须变化。

提示词断言包含：

```text
Ethan (voice-over), 0.200s-3.800s, say exactly in English:
"But now he doesn't even have any capital."
From 3.800s to 5.000s, add no intelligible dialogue; natural ambience only.
```

同时断言不含中文、源姓名、`lip-sync` 和本地路径。

- [ ] **步骤 2：先写 Fumin 能力和事务红灯**

在 `redrawGeneration.test.js` 创建唯一 verified capability：`provider=fumin`、`protocol=fumin_video`、`model=fumin-seedance-2.0-mini`。断言生成快照固定：

```js
assert.equal(snapshot.model, 'fumin-seedance-2.0-mini');
assert.equal(snapshot.duration, 5);
assert.equal(snapshot.resolution, '480p');
assert.equal(snapshot.aspect_ratio, '16:9');
assert.equal(snapshot.generate_audio, true);
assert.equal(snapshot.reference_image_urls.length, 1);
assert.equal(snapshot.reference_video_urls.length, 1);
assert.deepEqual(snapshot.reference_audio_urls, []);
```

增加失败矩阵：Fast、错误协议、配置/证据版本漂移、第二个 capability、非 en-US/US、非唯一角色/对白、投影多图/多视频/任意音频、运动参考含音轨。每项断言 `video_generations=0`、`async_tasks=0`、积分 reservation=0、供应商调用=0。

- [ ] **步骤 3：运行目标红灯**

```powershell
node --test --test-concurrency=1 test/redrawReferenceBundle.test.js test/redrawGeneration.test.js
```

预期：`delivery` 未保存，Fumin 不满足视频 conditioning/原生音频能力。

- [ ] **步骤 4：实现最小服务端投影**

- `verifyDialogue` 只接受 `voice_over` 并纳入 canonical bundle/hash；
- `buildGenerationPrompt` 使用固定角色名、时间和逐字英文台词；
- 增加 `isFuminMiniReferenceCapability`，仅接受 exact provider/protocol/model；
- `supportsVideoConditioning`、`assertVideoConditioningCapability`、`assertNativeAudioCapability` 仅对该 exact 能力开放；
- 参考包路径在计费/任务创建前强制把 generation 复制为 `5/480p/16:9/count=1/watermark=false/generateAudio=true`；
- 预检要求恰好 1 图、1 视频、0 音频，且 reference bundle 快照和配置证据同一版本；
- 不新增客户端可控字段，不允许 provider fallback。

- [ ] **步骤 5：运行绿灯和回归并提交**

```powershell
node --test --test-concurrency=1 test/redrawReferenceBundle.test.js test/redrawGeneration.test.js test/redrawReviewGate.test.js test/redrawAssets.test.js
node --check src/services/redrawReferenceBundleService.js
node --check src/services/redrawGenerationService.js
Set-Location ..
git diff --check
git add backend-node/src/services/redrawReferenceBundleService.js backend-node/src/services/redrawGenerationService.js backend-node/test/redrawReferenceBundle.test.js backend-node/test/redrawGeneration.test.js
git commit -m "feat(转绘): 固化 Fumin 参考包画外音门禁"
```

### 任务 5：实现真实源片净化运动参考

**文件：** 创建 `backend-node/src/services/redrawLiveMotionSanitizerService.js`、`backend-node/test/redrawLiveMotionSanitizer.test.js`。

- [ ] **步骤 1：写命令和证据红灯**

测试注入 `commandRunner`/`probeRunner`，要求只读源片 `30000–35000ms`，命令包含 `-ss 30.000 -t 5.000 -an -c:v libx264 -pix_fmt yuv420p`，滤镜固定为：

```text
scale=864:496:force_original_aspect_ratio=decrease,
pad=864:496:(ow-iw)/2:(oh-ih)/2,
scale=216:124:flags=area,
gblur=sigma=12:steps=3,
scale=864:496:flags=neighbor,
format=gray
```

该顺序先完整 fit/pad，再做强降采样和模糊，不允许 `crop`。输出 evidence 固定 `duration_ms=5000`、`864x496`、H.264、MP4、0 音轨，并记录 source/segment/coverage/output SHA-256；返回值不得包含绝对路径。

- [ ] **步骤 2：写 fail-closed 矩阵**

逐项覆盖：源媒体非预期 HEVC/720x1280/AAC/时长不足 35 秒、片段边界漂移、`source_character_keys` 不是唯一 `character-001`、coverage 文件没有 1 个完整人物覆盖、逐帧审核发现第 2 位可辨认人物、缺 `text_subtitle` 或 `text_screen`、覆盖未声明逐帧/逐区域审核、输出哈希/时长/尺寸/codec/MIME/音轨漂移、FFmpeg 失败、输出目录逃逸、符号链接/realpath 漂移。固定错误前缀 `REDRAW_LIVE_MOTION_*`。

Coverage manifest 存在仓库外。下例仅是单元测试 fixture 的结构；真实执行必须通过逐帧 OCR 和人工审核写出每个独立可读区域，不得复用 fixture 坐标：

```json
{
  "schema_version": "redraw-live-motion-coverage-v1",
  "clip_start_ms": 30000,
  "clip_end_ms": 35000,
  "source_character_keys": ["character-001"],
  "privacy_transform_scope": "full_frame",
  "person_regions": [{"kind":"full_person","start_ms":0,"end_ms":5000,"polygon":[[0,0],[1,0],[1,1],[0,1]]}],
  "text_regions": [
    {"region_id":"subtitle-001","kind":"text_subtitle","start_ms":0,"end_ms":5000,"polygon":[[0.05,0.78],[0.95,0.78],[0.95,0.94],[0.05,0.94]]},
    {"region_id":"screen-001","kind":"text_screen","start_ms":0,"end_ms":5000,"polygon":[[0.55,0.05],[0.95,0.05],[0.95,0.55],[0.55,0.55]]}
  ],
  "reviewed_frame_count": 120,
  "all_frames_reviewed": true,
  "all_text_regions_reviewed": true
}
```

`privacy_transform_scope=full_frame` 表示不可识别化处理覆盖全帧，不替代独立文字区域登记；service 必须拒绝重复 `region_id`、错误 kind、时间越界、坐标越界和未完成逐帧/逐区域审核。`reviewed_frame_count` 必须与固定 24fps 的 5 秒输出一致。若实际探测帧数不是 120，停止而不是篡改声明。

- [ ] **步骤 3：运行模块缺失红灯并实现**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawLiveMotionSanitizer.test.js
```

预期：`MODULE_NOT_FOUND`。实现时用临时输出加原子 rename；失败清理临时文件，不删除源片或用户目录。先后 probe 源和成品，读取同一文件描述符计算 SHA-256，并对白名单证据做 JSON 投影。

- [ ] **步骤 4：运行绿灯并提交**

```powershell
node --test --test-concurrency=1 test/redrawLiveMotionSanitizer.test.js test/redrawMotionReference.test.js
node --check src/services/redrawLiveMotionSanitizerService.js
Set-Location ..
git diff --check
git add backend-node/src/services/redrawLiveMotionSanitizerService.js backend-node/test/redrawLiveMotionSanitizer.test.js
git commit -m "feat(转绘): 增加真实源片净化运动参考"
```

### 任务 6：构建单角色真实源片参考包 case

**文件：** 创建 `backend-node/src/services/redrawFuminLiveCaseService.js`、`backend-node/scripts/run-redraw-fumin-reference-live-case.js`、`backend-node/test/redrawFuminLiveCase.test.js`；修改 `backend-node/package.json`、`.gitignore`。

- [ ] **步骤 1：先写 service/CLI 红灯**

CLI 只接受：

```text
--source-video FILE
--identity-image FILE
--identity-review FILE
--coverage-file FILE
--output-dir DIR
--dry-run
--help
```

`--dry-run` 必须不接受 `--key-file`、URL 或 Fumin endpoint。测试用合成源片和合成三视图 fixture，断言生成：

- `redraw-fumin-reference-live-manifest.json`；
- `redraw-fumin-reference-live-contact-sheet.jpg`；
- 净化 `motion-reference.mp4`；
- 单角色 `redraw-reference-bundle-v1`，Ethan、US、fictional_ai_generated、verified_18_plus、三视图一致性已批准；
- 唯一 voice-over cue 和固定 prompt；
- 请求 dry-run 只有 1 图、1 视频、0 音频和固定 Mini 参数；
- manifest 仅相对路径与 SHA-256，不含源绝对路径、Key、Authorization、中文台词或源音轨。

- [ ] **步骤 2：运行模块缺失红灯**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawFuminLiveCase.test.js
```

预期：service 或 CLI 模块缺失。

- [ ] **步骤 3：实现最小本地 case**

service 复用现有 identity、motion、text clean 和 reference bundle 服务建立隔离 SQLite fixture；不得复制其规则。身份图必须通过 `sharp` 验证为单张可读图片，人工审核状态通过 `identity-review` 仓库外输入，并绑定 image SHA-256、`character-001`、Ethan、三视图、虚构来源、美国、成年人、一致身份和批准人；不能仅凭文件存在自动批准。CLI 使用 `fs.mkdtemp` 和原子写，重复同一 output-dir 产生相同哈希或明确拒绝漂移。

`package.json` 增加：

```json
"verify:redraw-fumin-reference-live-case": "node scripts/run-redraw-fumin-reference-live-case.js"
```

`.gitignore` 仅增加 `!backend-node/scripts/run-redraw-fumin-reference-live-case.js`，不放开整个 scripts 目录。

- [ ] **步骤 4：绿灯、手工 dry-run 和提交**

```powershell
node --test --test-concurrency=1 test/redrawFuminLiveCase.test.js test/redrawReferenceBundle.test.js test/redrawGeneration.test.js
node --check src/services/redrawFuminLiveCaseService.js
node --check scripts/run-redraw-fumin-reference-live-case.js
npm run verify:redraw-fumin-reference-live-case -- --help
Set-Location ..
git diff --check
git add .gitignore backend-node/package.json backend-node/src/services/redrawFuminLiveCaseService.js backend-node/scripts/run-redraw-fumin-reference-live-case.js backend-node/test/redrawFuminLiveCase.test.js
git commit -m "feat(转绘): 增加 Fumin 真实参考包本地用例"
```

### 任务 7：增加本地 ASR/OCR 成品验证 Worker

**文件：** 创建 `workers/redraw-live-verifier/requirements.in`、`workers/redraw-live-verifier/requirements.lock`、`workers/redraw-live-verifier/verify_media.py`、`workers/redraw-live-verifier/tests/test_verify_media.py`。

- [ ] **步骤 1：写 Python 红灯测试**

使用临时 WAV/帧和注入式 ASR/OCR runner，覆盖：

- 英语概率 `>=0.90`，标准化词序精确等于 `but now he doesn't even have any capital`；
- 标点、大小写和空白可规范化，增词、少词、改词和可辨认额外对白拒绝；
- 0.5/1.5/2.5/3.5/4.5 秒五帧任一 OCR 结果含 Unicode CJK 统一汉字区段即拒绝；
- 无音轨、时长不在 4.5–5.8 秒、视频不可读、height 非 480 或宽高比偏离 16:9 超过 0.02 均拒绝；
- 输出只含 language、probability、word_count、exact_dialogue_match、cjk_text_detected、媒体摘要和固定错误码，不含完整 ASR/OCR 文本或绝对路径。

- [ ] **步骤 2：运行红灯**

```powershell
Set-Location workers\redraw-live-verifier
$pythonExe='C:\Users\canqu\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $pythonExe -m unittest discover -s tests -v
```

预期：`verify_media` 模块缺失。

- [ ] **步骤 3：实现 verifier 并生成哈希锁**

`requirements.in` 固定：

```text
faster-whisper==1.2.1
rapidocr==3.9.2
onnxruntime==1.28.0
```

在仓库外私有 venv 安装 `pip-tools==7.6.1`，不得修改 Codex bundled Python，执行：

```powershell
$pythonExe='C:\Users\canqu\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$venvRoot=Join-Path $env:LOCALAPPDATA 'moli-redraw-evidence\redraw-live-verifier-venv'
& $pythonExe -m venv $venvRoot
$verifierPython=Join-Path $venvRoot 'Scripts\python.exe'
& $verifierPython -m pip install 'pip-tools==7.6.1'
& $verifierPython -m piptools compile --generate-hashes --resolver=backtracking --output-file requirements.lock requirements.in
```

`verify_media.py` 使用本机已缓存的 faster-whisper 模型；缓存缺失时 fail closed，不在付费任务后临时下载模型。RapidOCR 对固定五帧运行；`contains_cjk` 明确检查 U+3400–U+4DBF、U+4E00–U+9FFF 和 U+F900–U+FAFF，不依赖 Python `re` 不支持的 `\p{...}`。所有原始 ASR/OCR 明文只写仓库外私有结果文件。

- [ ] **步骤 4：绿灯并提交**

```powershell
$venvRoot=Join-Path $env:LOCALAPPDATA 'moli-redraw-evidence\redraw-live-verifier-venv'
$verifierPython=Join-Path $venvRoot 'Scripts\python.exe'
& $verifierPython -m pip install --require-hashes -r requirements.lock
& $verifierPython -m unittest discover -s tests -v
& $verifierPython -m py_compile verify_media.py tests\test_verify_media.py
Set-Location ..\..
git diff --check
git add workers/redraw-live-verifier
git commit -m "feat(转绘): 增加英文有声成品本地验证器"
```

### 任务 8：实现付费前门禁、状态机和原子单次锁

**文件：** 创建 `backend-node/src/services/redrawFuminLiveRunService.js`、`backend-node/scripts/verify-redraw-fumin-reference-live.js`、`backend-node/test/redrawFuminReferenceLiveVerification.test.js`；修改 `backend-node/package.json`、`.gitignore`。

- [ ] **步骤 1：先写状态机红灯**

测试仓库外临时 state root，固定状态：

```text
preflight -> submitting -> submitted -> polling -> completed_candidate -> accepted | rejected
```

断言请求 SHA-256 命名的全局锁用 `fs.open(lockPath, 'wx')` 创建；在 POST 前先原子保存 `submitting`。任何已有 `submitting/submitted/polling/completed_candidate/accepted/rejected/submission_unknown` 状态再次执行 `submit` 时均 `POST=0`。网络中断、超时、2xx 非 JSON 或进程恢复发现 `submitting` 无 task ID 时状态固定 `submission_unknown`，不得自动重试。

- [ ] **步骤 2：写付费前门禁红灯**

`preflight` 在读取 Key/POST 前依次验证：

1. 当前 Git HEAD、参考包哈希、请求 body 哈希和资产哈希；
2. identity/motion upload evidence 由 Fumin 第一方上传流程产生，URL 为 HTTPS，HEAD/GET MIME、bytes、SHA-256 一致；
3. motion 为 5 秒 H.264、0 音轨；
4. 从固定 `GET https://fumin.ai/api/pricing` 采集 `seedance-2.0-mini` 当前公开计价，采集时间不超过 15 分钟；若阶梯/分组公式无法唯一计算本请求金额则 fail closed，不沿用旧固定单价；
5. 登录态导出的 `fumin-billing-evidence-v1` 采集时间不超过 15 分钟，模型/480p/5秒/1图1视频一致，`available_balance >= estimated_cost > 0`；
6. 当前 request SHA-256 尚无全局提交锁或历史提交状态。

`submit` 必须重新执行以上全部检查，并额外验证：用 Key 调固定 `GET https://fumin.ai/v1/models` 且目录包含 `seedance-2.0-mini`；用户最终确认金额字符串与 `estimated_cost`、currency 精确一致；`FUMIN_VERIFY_ONE_PAID_SUBMISSION=1` 明确存在；成功取得全局原子锁。live CLI 不接受 base URL 参数，Key 只能发往 `https://fumin.ai`；localhost Stub 只能由测试依赖注入。只有这四项和重复门禁全部通过才读取 Key 并进行 POST。

任一失败断言 `POST=0`，状态 `blocked_before_submit`。Key 文件路径、值、billing 账号字段、媒体 URL query 不进入日志/状态摘要。

- [ ] **步骤 3：定义严格 CLI 阶段**

```text
--stage preflight --manifest FILE --upload-evidence FILE --billing-before FILE --state-root DIR
--stage submit --manifest FILE --upload-evidence FILE --billing-before FILE --key-file FILE --confirmed-cost AMOUNT --state-root DIR
--stage resume --run-id ID --key-file FILE --state-root DIR
--stage finalize --run-id ID --billing-after FILE --human-review FILE --state-root DIR
```

- `preflight` 不读取 Key、不 POST，只输出脱敏 exact amount 和 blocker；
- `submit` 只能执行一次 POST，保存 task ID 后立即返回 `submitted`；不得在该阶段隐式重提或切换任务；
- `resume` 只能查询/下载同一 task，不得包含创建路径；
- `finalize` 调本地 verifier、核对前后余额差额和人工审核，不 POST；
- `--help` exit 0，未知/冲突参数 exit 2；
- state root 必须在仓库外且是用户明确指定的绝对路径。

- [ ] **步骤 4：实现最小服务和 CLI**

使用 canonical JSON 计算 request SHA-256；私有状态使用临时文件+fsync+rename。供应商任务 ID 只在私有 state 保存，提交报告仅写脱敏后缀。下载只接受成功响应内 HTTPS URL，限制重定向和最大字节数，写临时文件后核 SHA-256 再 rename。真实错误必须归类为 `provider_rejected`、`submission_unknown`、`provider_failed`，禁止统一成可重试错误。

`package.json` 增加：

```json
"verify:redraw-fumin-reference-live": "node scripts/verify-redraw-fumin-reference-live.js"
```

`.gitignore` 只增加对应脚本例外。

- [ ] **步骤 5：运行 Stub 绿灯并提交**

本地 Stub 必须捕获完整同链：只读 models/pricing、1 次 POST、同 task 多次 GET、成品下载；测试明确断言 POST 次数 1、请求 1 图/1 视频/0 音频、英语 prompt、Mini/480p/16:9/5 秒。再覆盖未知提交重启后 `POST=0`。

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/redrawFuminReferenceLiveVerification.test.js test/fuminVideo.test.js test/redrawGeneration.test.js
node --check src/services/redrawFuminLiveRunService.js
node --check scripts/verify-redraw-fumin-reference-live.js
Set-Location ..
git diff --check
git add .gitignore backend-node/package.json backend-node/src/services/redrawFuminLiveRunService.js backend-node/scripts/verify-redraw-fumin-reference-live.js backend-node/test/redrawFuminReferenceLiveVerification.test.js
git commit -m "feat(转绘): 增加 Fumin 单次真实验证门禁"
```

### 任务 9：完成全量本地 dry-run 和安全审计

**文件：** 不新增业务文件；按失败原因只修任务 2–8 所属文件。

- [ ] **步骤 1：运行目标联合测试**

```powershell
Set-Location backend-node
node --test --test-concurrency=1 test/fuminVideo.test.js test/redrawReferenceBundle.test.js test/redrawGeneration.test.js test/redrawLiveMotionSanitizer.test.js test/redrawFuminLiveCase.test.js test/redrawFuminReferenceLiveVerification.test.js test/redrawReviewGate.test.js test/redrawAssets.test.js test/redrawMotionReference.test.js test/redrawTextCleanPlateLocalCase.test.js
```

预期：0 fail；现有明确 skip 保留原原因。

- [ ] **步骤 2：运行 Python、语法和 diff 检查**

```powershell
Set-Location ..\workers\redraw-live-verifier
$venvRoot=Join-Path $env:LOCALAPPDATA 'moli-redraw-evidence\redraw-live-verifier-venv'
$verifierPython=Join-Path $venvRoot 'Scripts\python.exe'
& $verifierPython -m unittest discover -s tests -v
& $verifierPython -m py_compile verify_media.py tests\test_verify_media.py
Set-Location ..\..\backend-node
node --check src/services/fuminVideoClient.js
node --check src/services/redrawLiveMotionSanitizerService.js
node --check src/services/redrawFuminLiveCaseService.js
node --check src/services/redrawFuminLiveRunService.js
node --check scripts/run-redraw-fumin-reference-live-case.js
node --check scripts/verify-redraw-fumin-reference-live.js
Set-Location ..
git diff --check
```

- [ ] **步骤 3：执行秘密、路径和外部调用审计**

```powershell
rg -n "sk-[A-Za-z0-9_-]{12,}|Authorization:\s*Bearer\s+[A-Za-z0-9_-]{12,}|[A-Za-z]:\\\\" backend-node/src/services/fuminVideoClient.js backend-node/src/services/redrawFuminLiveRunService.js backend-node/scripts/run-redraw-fumin-reference-live-case.js backend-node/scripts/verify-redraw-fumin-reference-live.js workers/redraw-live-verifier
rg -n "seedance-2\.0-fast|720p|1080p|retry\s*\(" backend-node/src/services/fuminVideoClient.js backend-node/src/services/redrawFuminLiveRunService.js backend-node/scripts/verify-redraw-fumin-reference-live.js
```

预期：无 Key/绝对路径命中；允许文档中的禁止项文字，但运行代码不得支持 Fast/720p/1080p/自动重试。

- [ ] **步骤 4：执行本地 Stub 同链**

使用脚本 fixture 模式或测试注入的 localhost Stub，输出仓库外 manifest、request hash、contact sheet、candidate MP4 和 verifier 摘要。证明同一代码路径创建/轮询/下载/验证，但报告明确标注 `stub_only=true`，不得作为真实供应商证据。

### 任务 10：准备真实身份图、真实净化运动参考和第一方上传证据

**文件：** 真实素材仅写仓库外私有目录；本任务不提交素材。

- [ ] **步骤 1：生成并审核唯一虚构身份图**

使用 `imagegen` 生成 1 张无文字、无 Logo、无其他人物的虚构 AI 美国成年男性 `Ethan` 三视图合成图：同一身份的正面半身、右侧面、全身，写实摄影棚灰背景、成年 30–35 岁、固定同一套目标服装。使用 `view_image` 人工确认三栏是同一人、成年人、全身可见且无第四个人；失败只重新生成本地参考图，不触发 Fumin 付费任务。

- [ ] **步骤 2：对源片 30–35 秒执行净化**

在仓库外创建 `identity-review.json` 和 `coverage.json`：前者绑定身份图哈希与三视图人工结论；后者对固定 120 帧逐帧登记每个独立可读字幕/屏幕文字区域并完成审核。运行 `run-redraw-fumin-reference-live-case.js`。检查联系表和逐帧预览，必须同时确认：源脸、发型、身体细节和衣服不可识别；中文字幕和电视中文不可读；完整竖屏内容以 padding 方式保留；动作和镜头运动仍可辨认。任何一项失败即 `blocked_before_submit`。

- [ ] **步骤 3：使用 Fumin 第一方素材上传流程**

只把已批准 Ethan 身份图和净化无声 motion MP4 上传到 Fumin 控制的素材流程；不得上传原始视频、源片段、coverage、中文音轨或本地数据库。保存仓库外 `upload-evidence.json`：采集时间、Fumin 上传来源、两类 HTTPS URL、MIME、bytes、SHA-256。随后用独立 HEAD/GET 复核与本地哈希一致。

如果 Fumin 第一方流程不能为 API 请求提供可读 HTTPS 素材地址，状态固定 `blocked_before_submit`；不得改用未批准的第三方临时图床或部署本站来绕过。

- [ ] **步骤 4：运行真实 preflight，但停止在金额确认前**

从登录态 Fumin 页面取得 15 分钟内的精确余额和本请求预估费用证据；运行 `--stage preflight`。向用户展示 currency 和精确 amount，请求一次最终金额确认。未确认时保持 `blocked_before_submit`，不读 Key、不 POST。

### 任务 11：在最终金额确认后执行唯一一次真实付费提交

**文件：** 私有运行状态和成品在仓库外；不修改代码。

- [ ] **步骤 1：重新执行付费前门禁**

确认 Git HEAD、工作树、参考包/request/asset 哈希、15 分钟内定价与余额、模型目录、两类素材可读、Fumin 单次锁均在同次运行通过。只在此步骤读取用户指定本地 Key 文件，Key 只进入当前进程。

- [ ] **步骤 2：设置精确一次确认并提交**

```powershell
$privateRoot=Join-Path $env:LOCALAPPDATA 'moli-redraw-evidence\fumin-reference-live'
$manifestPath=Join-Path $privateRoot 'redraw-fumin-reference-live-manifest.json'
$uploadEvidencePath=Join-Path $privateRoot 'upload-evidence.json'
$billingBeforePath=Join-Path $privateRoot 'billing-before.json'
$stateRoot=Join-Path $privateRoot 'state'
$env:FUMIN_VERIFY_ONE_PAID_SUBMISSION='1'
node scripts/verify-redraw-fumin-reference-live.js --stage submit --manifest $manifestPath --upload-evidence $uploadEvidencePath --billing-before $billingBeforePath --key-file $env:FUMIN_VERIFY_KEY_FILE --confirmed-cost $env:FUMIN_VERIFY_CONFIRMED_COST --state-root $stateRoot
Remove-Item Env:FUMIN_VERIFY_ONE_PAID_SUBMISSION
```

`FUMIN_VERIFY_KEY_FILE` 和 `FUMIN_VERIFY_CONFIRMED_COST` 只在当前 PowerShell 进程临时设置，不得把实际值写入 Git 或报告。CLI 必须只产生 1 次 POST。若返回 `submission_unknown`，立即停止，人工核对 Fumin 控制台和账单；禁止第二次提交。

- [ ] **步骤 3：只恢复同一任务**

若取得 task ID，仅用私有 state 中保存的 `run_id` 执行 `--stage resume`，查询同一任务直到明确 completed/failed/超时。超时保持 `polling`，不重新创建。completed 后下载同一成品，记录 bytes/SHA-256，并执行 ffprobe、ASR、OCR 和固定五帧联系表。

### 任务 12：完成人工验收、费用核对和脱敏报告

**文件：** 创建 `docs/superpowers/reports/2026-08-15-redraw-fumin-reference-live-verification.md`。

- [ ] **步骤 1：人工视觉审核**

对源联系表、目标身份图和成品联系表逐项给出 `pass/fail`：目标 Ethan 身份一致；源身份/发型/衣服已替换；没有可读中文、字幕、Logo/水印；动作、构图、方向、节奏对应；无明显漂移、畸变、交换和闪烁。只要一项 fail，终态为 `rejected`；未审核为 `completed_candidate`。

- [ ] **步骤 2：核对提交后余额**

从 Fumin 登录态导出 15 分钟内 `billing-after`，运行 `--stage finalize`。计算前后余额差额并与预估费用比较；缺失或不一致时不得标 `accepted`，保持 `completed_candidate` 并记录费用核对未通过。

- [ ] **步骤 3：写脱敏报告**

报告只记录：Git HEAD、run ID 脱敏后缀、请求/参考包/资产/成品 SHA-256、模型/480p/16:9/5 秒、三类引用数量、任务终态、ffprobe 摘要、ASR 语言概率/词数/逐词一致性、OCR 是否含 CJK、人工审核逐项结果、currency/预估费用/实际差额、测试统计和“无部署/无生产写入/无第二次 POST”。不记录 Key、Authorization、账号、完整任务 ID、媒体 URL、本地绝对路径、完整 ASR/OCR 文本。

- [ ] **步骤 4：最终验证并提交报告**

```powershell
git diff --check
rg -n "sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_-]{12,}|[A-Za-z]:\\\\|https?://.*[?&](token|key|signature)=" docs/superpowers/reports/2026-08-15-redraw-fumin-reference-live-verification.md
git status --short --branch
git add docs/superpowers/reports/2026-08-15-redraw-fumin-reference-live-verification.md
git commit -m "docs(转绘): 记录 Fumin 单次真实样片证据"
```

只有供应商、媒体、英语、台词、人物、文字、运动、费用和人工审核全部通过时，报告终态才写 `accepted`。否则如实写 `blocked_before_submit`、`provider_rejected`、`submission_unknown`、`provider_failed`、`completed_candidate` 或 `rejected`，且不得宣称整集 1:1 已完成。

## 规格覆盖自检

- [ ] 当前参考包基线和旧分支不整体合并：任务 1–3。
- [ ] 真实源片 30–35 秒、完整 fit、全人物/文字净化、无原音：任务 5、6、10。
- [ ] 虚构美国成年 Ethan 单身份三视图：任务 4、6、10。
- [ ] 唯一英语画外音和精确时间：任务 4、6、7。
- [ ] Mini/480p/16:9/5 秒、1 图/1 视频/0 音频：任务 2–4、8。
- [ ] 价格、余额、素材、哈希、原子单次锁和金额最终确认：任务 8、10、11。
- [ ] 不确定提交不重试、恢复只查同一任务：任务 2、8、11。
- [ ] 下载、ffprobe、ASR、OCR、联系表、人工验收和费用差额：任务 7、8、11、12。
- [ ] 不部署、不写生产、不恢复入口、不 push、不做第二次付费提交：全计划边界。
