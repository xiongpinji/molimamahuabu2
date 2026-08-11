# iCreat Mini 参考视频真实镜头验证实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 在不开放线上入口、不部署的前提下，为 iCreat Seedance 2.0 Mini 补齐参考视频与英文原生音轨接线，并用批准的 4 秒真人拉美演员镜头完成一次受控真实候选验证。

**架构：** 先用 TDD 扩展现有 iCreat 请求体和转绘能力门禁，再为 iCreat 原生音轨路径生成无中文音轨的 H.264 源片片段。独立本地运行器负责输入指纹、演员裁剪、临时环回文件服务、OpenSSH 临时 HTTPS 隧道、一次性提交锁、轮询、下载和脱敏证据；默认只执行 dry-run，只有生产冲突解除且用户再次明确授权后才允许一笔付费提交。

**技术栈：** Node.js 20、node:test、better-sqlite3、FFmpeg/ffprobe、Sharp、原生 HTTP/OpenSSH、iCreat task API。

---

## 文件结构与职责

- 修改：backend-node/src/services/videoClient.js
  - 构造并传递 iCreat reference_video；日志只记录数量。
- 修改：backend-node/test/icreatVideo.test.js
  - 覆盖 URL 安全、内容顺序、调用入口和脱敏。
- 修改：backend-node/src/services/redrawSourceConditioningService.js
  - 新增默认关闭的 strip 音轨模式；默认 H.264/AAC 不变。
- 修改：backend-node/test/redrawSourceConditioning.test.js
  - 覆盖 preserve/strip 独立缓存和真实 ffprobe。
- 修改：backend-node/src/services/redrawGenerationService.js
  - 只为精确 iCreat Mini 开放视频 conditioning、原生音频和 4 秒时长。
- 修改：backend-node/test/redrawGeneration.test.js
  - 覆盖 exact-model 门禁、4 秒、strip 和证据 pin。
- 创建：backend-node/src/services/icreatMiniReferenceVideoCaseService.js
  - 校验案例、准备媒体、维护一次性状态、验证候选和固化证据。
- 创建：backend-node/test/icreatMiniReferenceVideoCase.test.js
  - 无网络覆盖案例服务和证据边界。
- 创建：backend-node/src/services/temporaryMediaTunnelService.js
  - 环回媒体服务和 localhost.run OpenSSH 临时隧道。
- 创建：backend-node/test/temporaryMediaTunnel.test.js
  - 注入 spawn/fetch 测试 URL 解析、HEAD 预检和关闭。
- 创建：backend-node/scripts/run-icreat-mini-reference-video-case.js
  - dry-run、明确付费授权、一笔提交、轮询、下载和审核 CLI。
- 修改：backend-node/package.json
  - 添加 verify:icreat-mini-reference-video。
- 修改：.gitignore
  - 允许提交运行器，忽略本地证据输出。

## 环境与硬门禁

- 工作树：C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r12-merge-20260809
- 分支：codex/redraw-r12-merge-20260809
- 计划基线：d6520139b4581d597843d62c5df701a7cea863d1
- 本机已有 ffmpeg.exe、ffprobe.exe 和 C:\Windows\System32\OpenSSH\ssh.exe。
- 本机没有 cloudflared；不得静默安装。
- 临时隧道使用 localhost.run 官方 OpenSSH 方式：
  - https://localhost.run/docs/
  - https://localhost.run/docs/cli/
- 真实调用前必须同时满足：
  1. 生产发布协调明确解除付费调用冻结；
  2. 用户再次明确授权一笔 iCreat Mini 调用；
  3. 当前费用不超过 50 积分且不超过 0.25 美元；
  4. Key 只读连接测试和模型分组通过；
  5. 三份临时媒体的 HTTPS HEAD 预检通过。
- 任一条件不满足只能停在 dry-run；不得提交、重试、切换模型、写生产数据库或使用生产 MinIO。

### 任务 1：iCreat reference_video 请求合同

**文件：**
- 修改：backend-node/src/services/videoClient.js:4087-4381
- 修改：backend-node/test/icreatVideo.test.js:22-299

- [ ] **步骤 1：编写失败的请求体测试**

在 iCreat describe 中加入：

~~~javascript
it('builds Mini reference video plus reviewed actor references and native audio', () => {
  const body = buildIcreatVideoBody({
    prompt: 'Keep the shot and replace every person with live-action Latino actors.',
    model: 'bytedance/seedance-2-0-mini',
    duration: 4,
    aspect_ratio: '9:16',
    resolution: '480p',
    reference_video_urls: ['https://case.example/shot.mp4?token=video-secret'],
    reference_urls: [
      'https://case.example/mateo.png?token=image-secret-1',
      'https://case.example/cast.png?token=image-secret-2',
    ],
    generate_audio: true,
  });
  assert.deepEqual(body.content.map((part) => part.role || part.type), [
    'text',
    'reference_video',
    'reference_image',
    'reference_image',
  ]);
  assert.deepEqual(body.content[1], {
    type: 'video_url',
    video_url: { url: 'https://case.example/shot.mp4?token=video-secret' },
    role: 'reference_video',
    need_review: true,
  });
  assert.equal(body.content.slice(2).every((part) => part.need_review === true), true);
  assert.equal(body.generate_audio, true);
  assert.equal(body.duration, 4);
  assert.equal(body.ratio, '9:16');
  assert.equal(body.resolution, '480p');
});
~~~

- [ ] **步骤 2：编写失败的 URL 与数量门禁测试**

~~~javascript
it('rejects unsafe or excessive iCreat reference videos before fetch', () => {
  for (const value of [
    'http://case.example/shot.mp4',
    'https://localhost/shot.mp4',
    'https://127.0.0.1/shot.mp4',
    'file:///C:/shot.mp4',
    'data:video/mp4;base64,AAAA',
    'https://user:pass@case.example/shot.mp4',
  ]) {
    assert.throws(
      () => buildIcreatVideoBody({ reference_video_urls: [value] }),
      (error) => error.code === 'ICREAT_REFERENCE_VIDEO_URL_INVALID',
      value,
    );
  }
  assert.throws(
    () => buildIcreatVideoBody({
      reference_video_urls: [1, 2, 3, 4].map((id) => 'https://case.example/' + id + '.mp4'),
    }),
    (error) => error.code === 'ICREAT_REFERENCE_VIDEO_LIMIT_EXCEEDED',
  );
  assert.throws(
    () => buildIcreatVideoBody({
      reference_video_urls: [
        'https://case.example/shot.mp4',
        'https://case.example/shot.mp4',
      ],
    }),
    (error) => error.code === 'ICREAT_REFERENCE_VIDEO_DUPLICATE',
  );
});
~~~

- [ ] **步骤 3：编写失败的生产入口和日志脱敏测试**

~~~javascript
it('routes reviewed reference videos without logging signed URLs', async () => {
  const events = [];
  const safeLog = {
    info(message, meta) { events.push({ message, meta }); },
    warn(message, meta) { events.push({ message, meta }); },
    error(message, meta) { events.push({ message, meta }); },
  };
  let request;
  global.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ taskId: 'icreat-ref-video-1', status: 'SUBMITTED' }),
    };
  };
  const result = await callIcreatVideoApi({
    provider: 'icreat',
    api_protocol: 'icreat_task',
    base_url: 'https://api.icreat.ai',
    api_key: 'secret',
  }, safeLog, {
    model: 'bytedance/seedance-2-0-mini',
    prompt: 'test',
    reference_video_urls: ['https://case.example/shot.mp4?signature=do-not-log'],
    reference_urls: ['https://case.example/mateo.png?signature=do-not-log-image'],
    generate_audio: true,
  });
  assert.equal(result.task_id, 'icreat-ref-video-1');
  assert.equal(request.body.content.some((part) => part.role === 'reference_video'), true);
  assert.equal(JSON.stringify(events).includes('do-not-log'), false);
  assert.equal(JSON.stringify(events).includes('secret'), false);
  assert.equal(events.at(-1).meta.reference_video_count, 1);
  assert.equal(events.at(-1).meta.reference_image_count, 1);
  assert.equal(events.at(-1).meta.generate_audio, true);
});
~~~

- [ ] **步骤 4：运行测试并确认失败**

~~~powershell
cd backend-node
node --test --test-concurrency=1 test/icreatVideo.test.js
~~~

预期：新增测试 FAIL；当前请求体不包含 reference_video。

- [ ] **步骤 5：实现最小 URL 校验和视频内容**

在 iCreat 模型函数附近加入：

~~~javascript
function icreatVideoInputError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeIcreatReferenceVideoUrls(values) {
  const urls = [];
  for (const raw of Array.isArray(values) ? values : []) {
    let parsed;
    try {
      parsed = new URL(String(raw || '').trim());
    } catch (_) {
      throw icreatVideoInputError('ICREAT_REFERENCE_VIDEO_URL_INVALID', 'iCreat 参考视频必须是 HTTPS URL');
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || host === 'localhost' || host.endsWith('.localhost')
      || (net.isIP(host) && isPrivateAddress(host))) {
      throw icreatVideoInputError('ICREAT_REFERENCE_VIDEO_URL_INVALID', 'iCreat 参考视频必须是公网 HTTPS URL');
    }
    const value = parsed.toString();
    if (urls.includes(value)) {
      throw icreatVideoInputError('ICREAT_REFERENCE_VIDEO_DUPLICATE', 'iCreat 参考视频 URL 不得重复');
    }
    urls.push(value);
  }
  if (urls.length > 3) {
    throw icreatVideoInputError('ICREAT_REFERENCE_VIDEO_LIMIT_EXCEEDED', 'iCreat 参考视频最多 3 个');
  }
  return urls;
}
~~~

扩展 buildIcreatVideoBody 参数，并在参考图前插入：

~~~javascript
const videoUrls = normalizeIcreatReferenceVideoUrls(reference_video_urls);
if (hasFrameRole && videoUrls.length > 0) {
  throw icreatVideoInputError(
    'ICREAT_REFERENCE_MODE_CONFLICT',
    'iCreat 首尾帧模式不能与参考视频模式混用',
  );
}
for (const url of videoUrls) {
  content.push({
    type: 'video_url',
    video_url: { url },
    role: 'reference_video',
    need_review: true,
  });
}
~~~

callIcreatVideoApi 日志只记录：

~~~javascript
log?.info?.('[iCreat video] 提交', {
  video_gen_id: opts.video_gen_id,
  model,
  reference_video_count: body.content.filter((part) => part.role === 'reference_video').length,
  reference_image_count: body.content.filter((part) => part.role === 'reference_image').length,
  has_voice_reference: body.content.some((part) => part.role === 'reference_audio'),
  generate_audio: body.generate_audio === true,
});
~~~

- [ ] **步骤 6：运行测试验证通过**

~~~powershell
node --test --test-concurrency=1 test/icreatVideo.test.js
~~~

预期：PASS；原有首尾帧、参考图和参考音频测试继续通过。

- [ ] **步骤 7：提交任务 1**

~~~powershell
git add backend-node/src/services/videoClient.js backend-node/test/icreatVideo.test.js
git commit -m "feat: 支持 iCreat 参考视频输入"
~~~

### 任务 2：为 iCreat 原生音轨准备无中文音频的源片

**文件：**
- 修改：backend-node/src/services/redrawSourceConditioningService.js:14-470
- 修改：backend-node/test/redrawSourceConditioning.test.js:33-117

- [ ] **步骤 1：编写失败的 strip 模式测试**

~~~javascript
test('iCreat 原生音轨 conditioning 使用独立无音轨缓存且默认 AAC 行为不变', async (t) => {
  if (!hasLocalFfmpeg()) return t.skip('ffmpeg unavailable');
  const storageRoot = makeTempRoot(t);
  const sourceRelativePath = 'redraw-sources/source.mp4';
  const sourcePath = path.join(storageRoot, sourceRelativePath);
  createSourceVideo(sourcePath);
  const sourceFingerprint = sha256File(sourcePath);
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const now = new Date(NOW_MS).toISOString();
  const sourceAssetId = db.prepare(
    "INSERT INTO assets (name,type,category,url,local_path,mime_type,created_at,updated_at) VALUES ('source.mp4','video','redraw-source','/static/redraw-sources/source.mp4',?,'video/mp4',?,?)"
  ).run(sourceRelativePath, now, now).lastInsertRowid;
  const base = {
    db,
    shot: { id: 91 },
    sourceAssetId,
    sourceFingerprint,
    startMs: 0,
    endMs: 4000,
    storageRoot,
    storageBaseUrl: 'https://media.example.test/static',
    signingSecret: SIGNING_SECRET,
    nowMs: NOW_MS,
  };
  const preserved = await prepareSourceConditioning(base);
  const stripped = await prepareSourceConditioning({ ...base, audioMode: 'strip' });
  const strippedAgain = await prepareSourceConditioning({ ...base, audioMode: 'strip' });
  assert.notEqual(preserved.segmentSha256, stripped.segmentSha256);
  assert.equal(preserved.auditSnapshot.audio_codec, 'aac');
  assert.equal(stripped.auditSnapshot.audio_codec, null);
  assert.equal(stripped.auditSnapshot.audio_mode, 'strip');
  assert.equal(strippedAgain.reused, true);
  assert.equal(strippedAgain.segmentSha256, stripped.segmentSha256);
});
~~~

- [ ] **步骤 2：运行测试并确认失败**

~~~powershell
node --test --test-concurrency=1 test/redrawSourceConditioning.test.js
~~~

预期：FAIL；缓存键不含 audioMode，FFmpeg 总是映射 AAC。

- [ ] **步骤 3：把 audioMode 纳入缓存和元数据**

~~~javascript
const DEFAULT_SEGMENT_VERSION = 'h264-aac-v1';
const STRIPPED_SEGMENT_VERSION = 'h264-video-only-v1';

function normalizeAudioMode(value) {
  return value === 'strip' ? 'strip' : 'preserve';
}

function segmentVersion(audioMode) {
  return audioMode === 'strip' ? STRIPPED_SEGMENT_VERSION : DEFAULT_SEGMENT_VERSION;
}

function conditioningKey(sourceAssetId, sourceFingerprint, startMs, endMs, audioMode) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      version: segmentVersion(audioMode),
      audio_mode: audioMode,
      source_asset_id: sourceAssetId,
      source_fingerprint: sourceFingerprint,
      start_ms: startMs,
      end_ms: endMs,
    }))
    .digest('hex');
}
~~~

expected、metadata、cachedMetadata 和 auditSnapshot 都保存并比较 version/audio_mode。

- [ ] **步骤 4：仅 strip 模式传入 -an**

~~~javascript
const audioArgs = expected.audio_mode === 'strip'
  ? ['-an']
  : ['-map', '0:a:0?', '-c:a', 'aac'];

await runner(input.ffmpegPath || getFfmpegPath(), [
  '-y', '-v', 'error',
  '-i', sourcePath,
  '-ss', startSeconds,
  '-t', durationSeconds,
  '-map', '0:v:0',
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  ...audioArgs,
  '-movflags', '+faststart',
  '-avoid_negative_ts', 'make_zero',
  targetTemp,
], {
  timeout: Number(input.ffmpegTimeoutMs || 120000),
  maxBuffer: 8 * 1024 * 1024,
  windowsHide: true,
});
~~~

probe 要求 H.264，并按 audio_mode 要求 AAC 或无音轨：

~~~javascript
if (requirements?.videoCodec === 'h264' && video.codec_name !== 'h264') {
  throw codedError('REDRAW_SOURCE_CONDITIONING_CODEC_INVALID', 'conditioning segment 必须是 H.264 MP4');
}
if (requirements?.audioMode === 'preserve' && audio?.codec_name !== 'aac') {
  throw codedError('REDRAW_SOURCE_CONDITIONING_CODEC_INVALID', 'conditioning segment 必须包含 AAC 音轨');
}
if (requirements?.audioMode === 'strip' && audio) {
  throw codedError('REDRAW_SOURCE_CONDITIONING_CODEC_INVALID', 'conditioning segment 不得保留源音轨');
}
~~~

- [ ] **步骤 5：运行测试验证通过**

~~~powershell
node --test --test-concurrency=1 test/redrawSourceConditioning.test.js
~~~

预期：PASS；默认 preserve 和新增 strip 都通过。

- [ ] **步骤 6：提交任务 2**

~~~powershell
git add backend-node/src/services/redrawSourceConditioningService.js backend-node/test/redrawSourceConditioning.test.js
git commit -m "feat: 支持转绘源片移除原音轨"
~~~

### 任务 3：只为已验证的 iCreat Mini 开放 4 秒参考视频原生声画路径

**文件：**
- 修改：`backend-node/src/services/redrawGenerationService.js:116-127,202-235,367-437,533-564,662-683`
- 修改：`backend-node/test/redrawGeneration.test.js`

- [ ] **步骤 1：编写失败的精确 capability 门禁测试**

在现有 `assertVideoConditioningCapability` 测试组加入：

~~~javascript
test('仅精确 iCreat Mini capability 支持源片 conditioning', () => {
  const exact = {
    config_id: 7,
    config_updated_at: '2026-08-11T00:00:00.000Z',
    provider: 'icreat',
    protocol: 'icreat_task',
    model: 'bytedance/seedance-2-0-mini',
  };
  assert.deepEqual(assertVideoConditioningCapability(exact), { ...exact, max_videos: 3 });
  for (const patch of [
    { protocol: 'openai' },
    { model: 'bytedance/seedance-2-0-fast' },
    { model: 'bytedance/seedance-2-0' },
  ]) {
    assert.throws(
      () => assertVideoConditioningCapability({ ...exact, ...patch }),
      (error) => error.code === 'REDRAW_VIDEO_CONDITIONING_UNSUPPORTED',
    );
  }
});
~~~

- [ ] **步骤 2：编写失败的 4 秒、原生音轨和 strip 接线测试**

复用 `redrawGeneration.test.js` 已有的已审核版本/locale pack/能力证据夹具，注入精确 iCreat
Mini capability，并让服务端镜头时长为 `4000` 毫秒。断言：

~~~javascript
assert.equal(capturedConditioning.audioMode, 'strip');
assert.equal(capturedVideoRequest.model, 'bytedance/seedance-2-0-mini');
assert.equal(capturedVideoRequest.duration, 4);
assert.equal(capturedVideoRequest.generate_audio, true);
assert.deepEqual(capturedVideoRequest.reference_video_urls, ['https://media.example.test/shot.mp4']);
assert.equal(createdVideo.generate_audio, 1);
assert.equal(JSON.parse(createdVideo.request_snapshot).config_updated_at, exact.config_updated_at);
~~~

同组负例必须证明：错误协议、Fast/完整模型、缺少 locale capability evidence、不可读 evidence
artifact 均在准备 conditioning、积分预留和供应商调用前失败；非 iCreat 路径传入 4 秒继续返回
`INVALID_VIDEO_DURATION`。

- [ ] **步骤 3：运行测试确认失败**

~~~powershell
node --test --test-concurrency=1 test/redrawGeneration.test.js
~~~

预期：FAIL；iCreat 仍被源视频/原生音频门禁拒绝，4 秒仍被全局时长门禁拒绝。

- [ ] **步骤 4：实现最小精确 capability 判断**

~~~javascript
const ICREAT_MINI_MODEL = 'bytedance/seedance-2-0-mini';

function isIcreatMiniCapability(capability) {
  return String(capability?.protocol || '').trim().toLowerCase() === 'icreat_task'
    && String(capability?.model || '').trim().toLowerCase() === ICREAT_MINI_MODEL;
}

function normalizeDuration(value, options = {}) {
  const duration = Number(value);
  const minimum = options.allowFourSeconds === true ? 4 : 5;
  if (!Number.isSafeInteger(duration) || duration < minimum || duration > 15) {
    throw codedError('INVALID_VIDEO_DURATION', `视频时长必须是 ${minimum} 到 15 秒之间的整数`);
  }
  return duration;
}
~~~

`supportsVideoConditioning` 和 `assertVideoConditioningCapability` 对精确 iCreat Mini 返回
`max_videos: 3`；`assertNativeAudioCapability` 只额外接受同一精确协议/模型，仍要求该能力来自
现有已验证 locale capability，不增加按模型名兜底。

- [ ] **步骤 5：接通 4 秒、strip 和 iCreat 请求预检**

`buildNativeGeneration` 在 `assertNativeAudioCapability` 后调用：

~~~javascript
const duration = normalizeDuration(
  compiled.duration ?? parsed.draft.duration ?? durationFromShotMs(shot),
  { allowFourSeconds: isIcreatMiniCapability(selected) },
);
~~~

`prepareServerSourceConditioning(ctx, shot, generation)` 向 conditioning 服务传入：

~~~javascript
audioMode: generation.generateAudio === true && isIcreatMiniCapability(generation)
  ? 'strip'
  : 'preserve',
~~~

`preflightVideoGeneration` 对 `icreat_task` 调用已导出的 `buildIcreatVideoBody`，传入参考视频、
参考图、4 秒和 `generate_audio`；任何输入错误统一映射为 `REDRAW_GENERATION_INPUT_INVALID`。

- [ ] **步骤 6：运行测试验证通过**

~~~powershell
node --test --test-concurrency=1 test/redrawGeneration.test.js
~~~

预期：PASS；精确 iCreat Mini 绿灯，所有相邻负例和原有转绘生成测试继续通过。

- [ ] **步骤 7：提交任务 3**

~~~powershell
git add backend-node/src/services/redrawGenerationService.js backend-node/test/redrawGeneration.test.js
git commit -m "feat: 接通 iCreat Mini 转绘声画门禁"
~~~

### 任务 4：实现私有临时媒体服务和 HTTPS 隧道生命周期

**文件：**
- 创建：`backend-node/src/services/temporaryMediaTunnelService.js`
- 创建：`backend-node/test/temporaryMediaTunnel.test.js`

- [ ] **步骤 1：编写失败的路由、解析和关闭测试**

测试使用临时目录中的三个小文件和注入的 `spawnTunnel`，不连接公网。断言：

~~~javascript
const tunnel = await startTemporaryMediaTunnel({
  assets: [
    { id: 'shot', path: shotPath, contentType: 'video/mp4' },
    { id: 'mateo', path: mateoPath, contentType: 'image/png' },
    { id: 'cast', path: castPath, contentType: 'image/png' },
  ],
  spawnTunnel: fakeTunnelReturning('https://random.localhost.run'),
  fetchImpl: async (url, options) => localHeadProbe(url, options),
  maxLifetimeMs: 1000,
});
assert.equal(tunnel.urls.every((item) => item.url.startsWith('https://random.localhost.run/')), true);
assert.equal(tunnel.urls.every((item) => !item.url.includes(path.basename(item.path))), true);
assert.equal(tunnel.urls.every((item) => item.head_ok === true), true);
await tunnel.close();
assert.equal(tunnel.closed, true);
~~~

另测 `parseLocalhostRunUrl` 忽略 ANSI/日志噪音，只接受 `https://*.localhost.run`；GET/HEAD 以外
返回 405，未知随机路径返回 404，响应含 `Cache-Control: no-store`，关闭执行两次不报错。

- [ ] **步骤 2：运行测试确认失败**

~~~powershell
node --test --test-concurrency=1 test/temporaryMediaTunnel.test.js
~~~

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现最小环回服务**

~~~javascript
const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405);
  const asset = routes.get(new URL(req.url, 'http://127.0.0.1').pathname);
  if (!asset) return send(res, 404);
  res.writeHead(200, {
    'Content-Type': asset.contentType,
    'Content-Length': asset.size,
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(asset.path).pipe(res);
});
server.listen(0, '127.0.0.1');
~~~

每个路由使用 `crypto.randomBytes(24).toString('hex')`，不得使用原文件名或开放目录浏览。

- [ ] **步骤 4：实现 OpenSSH 隧道和强制清理**

默认命令固定为：

~~~javascript
spawn(sshPath, [
  '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=15', '-R', `80:127.0.0.1:${port}`,
  'nokey@localhost.run',
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
~~~

在 20 秒内解析公网 URL；逐个执行 HTTPS HEAD 并校验 200、内容类型和长度。任一步失败立即
终止 SSH 子进程、关闭 HTTP 服务并抛出 `TEMP_MEDIA_TUNNEL_UNAVAILABLE`。15 分钟定时器和
显式 `close()` 都执行同一幂等清理。

- [ ] **步骤 5：运行测试验证通过**

~~~powershell
node --test --test-concurrency=1 test/temporaryMediaTunnel.test.js
~~~

预期：PASS；测试中没有公网连接和 SSH 进程。

- [ ] **步骤 6：提交任务 4**

~~~powershell
git add backend-node/src/services/temporaryMediaTunnelService.js backend-node/test/temporaryMediaTunnel.test.js
git commit -m "feat: 增加一次性媒体隧道服务"
~~~

### 任务 5：实现 iCreat Mini 真人镜头案例、一次性提交锁和脱敏证据

**文件：**
- 创建：`backend-node/src/services/icreatMiniReferenceVideoCaseService.js`
- 创建：`backend-node/test/icreatMiniReferenceVideoCase.test.js`

- [ ] **步骤 1：编写失败的输入与提示词合同测试**

测试固定源片 SHA、`0–4000ms`、Mateo 裁剪框 `{ left:176, top:330, width:510, height:1100 }`、
模型、480p、9:16、英文台词和全部人物替换要求。错误 SHA、时长、尺寸、HEVC/AAC 参数、
演员合照 SHA 均返回 `ICREAT_CASE_INPUT_MISMATCH`。

~~~javascript
const snapshot = buildIcreatMiniCaseSnapshot({
  sourceSha256: EXPECTED_SOURCE_SHA256,
  segmentUrl: 'https://case.localhost.run/a',
  mateoUrl: 'https://case.localhost.run/b',
  castUrl: 'https://case.localhost.run/c',
});
assert.equal(snapshot.model, 'bytedance/seedance-2-0-mini');
assert.equal(snapshot.duration, 4);
assert.equal(snapshot.resolution, '480p');
assert.equal(snapshot.aspect_ratio, '9:16');
assert.equal(snapshot.generate_audio, true);
assert.match(snapshot.prompt, /Dude, who are you\?/);
assert.match(snapshot.prompt, /every visible person/i);
~~~

- [ ] **步骤 2：编写失败的一次性提交锁和证据脱敏测试**

~~~javascript
const lock = createSubmissionLock(statePath, requestHash);
assert.equal(lock.consumed, false);
consumeSubmissionLock(statePath, requestHash, { attempted_at: NOW });
assert.throws(
  () => consumeSubmissionLock(statePath, requestHash, { attempted_at: NOW }),
  (error) => error.code === 'ICREAT_CASE_ALREADY_SUBMITTED',
);
const manifest = buildRedactedEvidence({
  api_key: 'must-not-appear',
  task_id: 'provider-task-secret',
  signed_urls: ['https://case.localhost.run/a?token=must-not-appear'],
});
assert.equal(JSON.stringify(manifest).includes('must-not-appear'), false);
assert.equal(manifest.provider_task_id_sha256.length, 64);
assert.equal(manifest.visual_actor_replacement_verified, false);
~~~

并测试任意一次 POST 尝试后即消费锁；没有 task ID 时状态为 `submission_unknown`，不得重试。

- [ ] **步骤 3：运行测试确认失败**

~~~powershell
node --test --test-concurrency=1 test/icreatMiniReferenceVideoCase.test.js
~~~

预期：FAIL，案例服务不存在。

- [ ] **步骤 4：实现媒体准备和不可变请求快照**

`prepareCaseMedia` 在新建私有临时目录中：重新计算源片和演员合照 SHA；用 FFprobe 校验合同；
调用 FFmpeg 生成 4 秒 H.264/yuv420p/faststart/无音轨片段；用 Sharp 按固定裁剪框生成 Mateo
PNG；再次探测片段并记录三个临时媒体 SHA。所有路径必须位于该次临时根目录内。

请求快照使用规范 JSON 计算 SHA-256；完整签名 URL 只保存在内存，不写入证据文件。

- [ ] **步骤 5：实现候选媒体验证和人工审核模板**

自动验证要求 MP4 可读、视频和音频流存在、竖屏、480p 档位、时长 `3.75–4.25` 秒、非静音，
并记录字节数和 SHA。证据默认写入：

~~~javascript
manual_review: {
  live_action_humans: 'uncertain',
  foreground_mateo: 'uncertain',
  background_actor_replacement: 'uncertain',
  shot_motion_timing_preserved: 'uncertain',
  english_dialogue_correct: 'uncertain',
  lip_sync_acceptable: 'uncertain',
  no_severe_artifacts: 'uncertain',
},
visual_actor_replacement_verified: false,
~~~

只有全部七项均为 `passed` 时，审核更新函数才允许把最终布尔值设为 `true`。

- [ ] **步骤 6：运行测试验证通过**

~~~powershell
node --test --test-concurrency=1 test/icreatMiniReferenceVideoCase.test.js
~~~

预期：PASS；测试只使用临时文件和注入的 FFmpeg/FFprobe/Sharp 替身，不访问网络。

- [ ] **步骤 7：提交任务 5**

~~~powershell
git add backend-node/src/services/icreatMiniReferenceVideoCaseService.js backend-node/test/icreatMiniReferenceVideoCase.test.js
git commit -m "feat: 增加 iCreat Mini 真人镜头验证案例"
~~~

### 任务 6：接通默认 dry-run 的本地 CLI 并完成本地验证

**文件：**
- 创建：`backend-node/scripts/run-icreat-mini-reference-video-case.js`
- 修改：`backend-node/package.json`
- 修改：`.gitignore`
- 测试：`backend-node/test/icreatMiniReferenceVideoCase.test.js`

- [ ] **步骤 1：编写失败的 CLI 门禁测试**

通过导出的 `parseArgs`/`assertPaidAuthorization` 断言：默认模式为 dry-run；只有同时传入
`--submit-paid-once`、`--max-credits <= 50`、`--max-usd <= 0.25` 和精确确认短语
`ICREAT_MINI_ONE_PAID_SUBMISSION` 才可进入提交分支。缺失费用、价格不可确认、Key 分组只读
检查失败、HEAD 预检失败或锁已消费时均在 `callVideoApi` 之前失败。

- [ ] **步骤 2：运行测试确认失败**

~~~powershell
node --test --test-concurrency=1 test/icreatMiniReferenceVideoCase.test.js
~~~

预期：FAIL，CLI 导出和 package 命令不存在。

- [ ] **步骤 3：实现 dry-run 和 package 接线**

~~~json
"verify:icreat-mini-reference-video": "node scripts/run-icreat-mini-reference-video-case.js"
~~~

默认命令只执行媒体校验、片段/裁剪准备、请求体构建和脱敏清单写入，不启动隧道、不读取 Key、
不调用供应商。默认输入源片为用户指定路径，也允许显式 `--source` 覆盖但仍受 SHA 合同约束。

- [ ] **步骤 4：实现受保护的一笔提交分支**

付费分支顺序固定为：读取本地配置到内存并脱敏 → 只读权限/价格/余额检查 → 启动临时隧道并
三份 HEAD 预检 → 独占创建并消费提交锁 → 调用现有 `videoClient.callVideoApi` 一次 → 每
10–15 秒轮询、最长 10 分钟 → 下载一次 → 校验候选 → 写证据 → `finally` 关闭隧道并删除
临时副本。POST 后任何异常都写 `submission_unknown`/`needs_attention`，绝不再次提交或换模型。

- [ ] **步骤 5：更新忽略边界并运行真实源片 dry-run**

`.gitignore` 加入：

~~~gitignore
!backend-node/scripts/run-icreat-mini-reference-video-case.js
backend-node/output/icreat-mini-reference-video/
~~~

运行：

~~~powershell
npm run verify:icreat-mini-reference-video -- --source "C:\Users\canqu\Desktop\ac087bcd4cf5f856f85182834794853a.mp4"
~~~

预期：exit 0；输出明确 `mode=dry-run`、源片/片段/演员素材 SHA、请求快照 SHA；无 task ID、
无 SSH 隧道、无供应商调用、无数据库写入。

- [ ] **步骤 6：运行精确回归和后端全量**

~~~powershell
node --test --test-concurrency=1 test/icreatVideo.test.js test/redrawSourceConditioning.test.js test/redrawGeneration.test.js test/temporaryMediaTunnel.test.js test/icreatMiniReferenceVideoCase.test.js
npm test
~~~

预期：0 FAIL。再运行 `git diff --check` 和 `git status --short`，确认没有临时媒体、证据输出、
API Key、签名 URL、task ID 或既有未跟踪目录进入提交范围。

- [ ] **步骤 7：提交任务 6，不推送、不部署**

~~~powershell
git add .gitignore backend-node/package.json backend-node/scripts/run-icreat-mini-reference-video-case.js backend-node/test/icreatMiniReferenceVideoCase.test.js docs/superpowers/plans/2026-08-11-redraw-icreat-mini-reference-video-real-shot.md
git commit -m "test: 接通 iCreat Mini 真人镜头 dry-run"
~~~

## 执行边界

- 当前只执行任务 1–6 的本地代码、测试和 dry-run；不执行真实供应商 POST。
- 不访问 `/opt/moli-drama`，不制作候选，不写生产数据库，不恢复线上一键转绘入口，不推送。
- 用户以后明确授权的一笔付费调用仍需在调用当时重新完成费用、权限、生产冲突和三份媒体
  HEAD 门禁；本地实现通过不等于真实模型、人工视觉或产品 E2E 已通过。
