# 转绘原生外语对白音轨实现计划

> 2026-09-02 增量修复：原生音频 Worker 语言包白名单现支持 `es@1`（西语）和 `en@1`（英语）；`en@1` 只做 ASR/台词验证，不调用 TTS 或口音分类。既有 `en-US@1` TTS 合同保持不变。该修复已通过隔离 Worker 全套回归和 Node 原生对白回归，但 `en@1` 仍需目标模型真实生成、签名 manifest/ready attestation 后才可进入生产语言目录。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让一键转绘默认由已验证的视频模型在单次供应商提交中生成画面、环境声和目标语言对白；生成后以隔离 Worker 验证音轨、语言和批准台词，最终以 `audio_mode=native` 保留原生音轨。TTS 只在用户明确选择、重新报价并再次确认后作为 `audio_mode=replace` 回退。

**架构：** 服务端从版本、分镜和已批准对白编译稳定 prompt/快照，并在 reserve 前锁定支持同步音频的精确视频配置和语言包。视频完成后，Node 媒体门禁抽取 16 kHz 单声道 PCM，Python 单并发 Worker 执行多语 ASR 和文本相似度判定；通过结果、人工检查和精确配置证据写入现有 `request_snapshot`、`draft_json`、配置 `settings` 与导出 manifest。任何供应商提交后的不确定结果统一 `needs_attention + held`，跨幂等键不得重提。

**技术栈：** Node.js 20、`node:test`、SQLite、Vue 3、Element Plus、Vite、Python 3.12、`unittest`、faster-whisper 1.2.1、FFmpeg/ffprobe、Unix domain socket、systemd。

---

## 执行边界

- 实际工作树：`C:\Users\canqu\Documents\茉莉妈妈2\worktrees\redraw-r14-merge-20260809`
- 规格基线：`docs/superpowers/specs/2026-08-09-redraw-native-dialogue-audio-design.md`
- 计划基线提交：`14baff67`
- 本计划不授权真实供应商提交、生产数据库写入、候选制作、服务重启或生产切换。
- 现有 `video_generations.generate_audio`、`video_generations.request_snapshot`、`redraw_shots.draft_json`、`redraw_exports.manifest_json` 和 `ai_service_configs.settings` 足以承载首版合同；没有测试证明缺列前不得新增迁移。
- 现有 `verify` + `tts_invocation` 的 `en-US` TTS Worker 合同必须保持兼容；原生视频音轨使用新增动作，不能把视频任务伪装成 TTS invocation。
- 语言级证据允许 `target_locale=null`；没有地区/口音分类器时，地区必须保持空白/不可选，不能用请求值补齐。
- 所有供应商调用前的确定性失败必须断言 `providerCalls=0`、`reservations=0`；供应商调用后失败必须断言 held、禁止重提。
- 每个任务只提交列出的文件，不还原或格式化同工作树内的其他改动。

## 完成定义

只有同时满足以下条件，代码实现阶段才算完成：

1. 服务端编译目标语言对白且客户端不能覆盖 prompt、locale、模型、配置、音频开关或价格；
2. 精确模型配置在 reserve 前证明 `supportsAudio=true`，请求和恢复均持久化 `generate_audio=true`；
3. completed MP4 经过视频流、音频流、时长、静音、解码、语言和台词门禁；
4. 任一 post-provider 异常进入 `needs_attention + held`，同一快照换幂等键仍不能二次提交；
5. `native` 合成保留每镜音轨，`replace` 原有 TTS 合成回归不变；
6. 前端默认原生音轨，不自动请求 TTS 报价；显式回退必须显示新的积分确认；
7. 语言目录只展示真实 target-key 证据绑定的语言，地区未验证时明确显示“地区待验证”；
8. 自动测试、构建、离线 Worker 基准、真实付费 canary、人工嘴型检查和生产发布分别保留证据等级，不能互相替代。

## 文件总览

### Python Worker

- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/protocol.py`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/verifier.py`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/server.py`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/engines.py`
- 修改：`workers/redraw-locale-verifier/scripts/model_compat_smoke.py`
- 修改：`workers/redraw-locale-verifier/tests/test_protocol.py`
- 修改：`workers/redraw-locale-verifier/tests/test_verifier.py`
- 修改：`workers/redraw-locale-verifier/tests/test_server.py`
- 修改：`workers/redraw-locale-verifier/tests/test_model_staging.py`

### Node 服务端

- 创建：`backend-node/src/services/redrawNativeDialoguePromptService.js`
- 创建：`backend-node/src/services/redrawNativeAudioService.js`
- 创建：`backend-node/scripts/verify-redraw-native-dialogue-audio.js`
- 创建：`backend-node/scripts/promote-redraw-native-dialogue-evidence.js`
- 创建：`backend-node/test/redrawNativeDialoguePrompt.test.js`
- 创建：`backend-node/test/redrawNativeAudio.test.js`
- 创建：`backend-node/test/redrawNativeDialogueCanary.test.js`
- 修改：`backend-node/src/services/redrawLocalePackRegistry.js`
- 修改：`backend-node/src/services/redrawLocaleVerifierClient.js`
- 修改：`backend-node/src/services/redrawCapabilityService.js`
- 修改：`backend-node/src/services/redrawGenerationService.js`
- 修改：`backend-node/src/services/redrawCompositionService.js`
- 修改：`backend-node/src/services/productionPreflightService.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/package.json`
- 修改：`backend-node/test/redrawLocalePackRegistry.test.js`
- 修改：`backend-node/test/redrawLocaleManifestSigning.test.js`
- 修改：`backend-node/test/redrawLocaleVerifierClient.test.js`
- 修改：`backend-node/test/redrawCapabilities.test.js`
- 修改：`backend-node/test/redrawGeneration.test.js`
- 修改：`backend-node/test/redrawShotBilling.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`
- 修改：`backend-node/test/toapisVideoClient.test.js`
- 修改：`backend-node/test/toapisVideoGate.test.js`
- 修改：`backend-node/test/redrawComposition.test.js`
- 修改：`backend-node/test/redrawCompositionRoutes.test.js`
- 修改：`backend-node/test/redrawExport.test.js`
- 修改：`backend-node/test/productionPreflight.test.js`

### 前端

- 修改：`frontweb/src/components/redraw/RedrawSourceStep.vue`
- 修改：`frontweb/src/components/redraw/RedrawEditStep.vue`
- 修改：`frontweb/src/utils/redrawTimelineState.js`
- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/test/redrawFoundation.test.js`
- 修改：`frontweb/test/redrawSourceRuntime.test.js`
- 修改：`frontweb/test/redrawEdit.test.js`

### 运维与证据

- 修改：`.env.production.example`
- 修改：`PUBLIC_PLATFORM_SETUP.md`
- 修改：`docs/WEB_PRODUCTION_DEPLOYMENT.md`
- 修改：`deploy/redraw-locale-verifier/README.md`
- 修改：`deploy/redraw-locale-verifier/moli-redraw-locale-verifier.service`
- 修改：`deploy/release-scopes/redraw-locale-verifier.json`

## 任务 1：扩展 Worker 原生音轨协议并修复离线 smoke 导入顺序

**文件：**
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/protocol.py`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/verifier.py`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/server.py`
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/engines.py`
- 修改：`workers/redraw-locale-verifier/scripts/model_compat_smoke.py`
- 修改：`workers/redraw-locale-verifier/tests/test_protocol.py`
- 修改：`workers/redraw-locale-verifier/tests/test_verifier.py`
- 修改：`workers/redraw-locale-verifier/tests/test_server.py`
- 修改：`workers/redraw-locale-verifier/tests/test_model_staging.py`

- [ ] **步骤 1：先写协议和 smoke 回归红测**

新增断言：

```python
def test_native_audio_request_requires_exact_video_invocation(self):
    parsed = parse_request({
        "action": "verify_native_audio",
        "request_id": "req-1",
        "audio_path": str(self.audio_path),
        "audio_sha256": "a" * 64,
        "approved_text": "Hola, pequeño.",
        "locale_pack": "es@1",
        "video_invocation": {
            "provider": "toapis",
            "model": "seedance-2-fast",
            "ai_service_config_id": 16,
            "config_updated_at": "2026-08-09T00:00:00Z",
            "provider_task_id": "provider-real-1",
            "artifact_sha256": "b" * 64,
        },
    })
    self.assertEqual(parsed["action"], "verify_native_audio")

def test_native_audio_rejects_tts_invocation_and_unknown_fields(self):
    # verify_native_audio 不能接受 tts_invocation、detected_locale 或客户端阈值。
    payload = native_audio_request()
    payload["tts_invocation"] = payload.pop("video_invocation")
    with self.assertRaisesRegex(ProtocolError, "LOCALE_VERIFY_REQUEST_INVALID"):
        parse_request(payload)

def test_smoke_imports_ssl_runtime_before_network_block(self):
    source = Path(MODEL_COMPAT_SMOKE).read_text(encoding="utf-8")
    self.assertLess(source.index("import ssl"), source.index("block_network()"))
```

- [ ] **步骤 2：运行测试确认红灯**

```powershell
python -m unittest discover -s workers/redraw-locale-verifier/tests -p 'test_*.py' -v
```

预期：新增 `verify_native_audio` 和 import-order 测试失败；既有 `verify` TTS 测试仍通过。

- [ ] **步骤 3：实现最小双合同协议**

保留 `action=verify` 的 exact fields 不变；新增：

```python
NATIVE_AUDIO_FIELDS = {
    "action", "request_id", "audio_path", "audio_sha256",
    "approved_text", "locale_pack", "video_invocation",
}
VIDEO_INVOCATION_FIELDS = {
    "provider", "model", "ai_service_config_id", "config_updated_at",
    "provider_task_id", "artifact_sha256",
}
```

`verify_native_audio` 只运行 VAD/ASR/文本评分，不运行英语口音分类器。返回必须包含：

```python
{
    "source": "offline-worker",
    "locale_pack": "es@1",
    "detected_language": "es",
    "detected_locale": None,
    "language_verified": True,
    "locale_verified": False,
    "audio_sha256": "a" * 64,
    "transcript_sha256": "b" * 64,
    "dialogue_similarity": 0.90,
    "segments": [{"start_ms": 0, "end_ms": 1200, "text_sha256": "c" * 64}],
    "video_invocation": {"provider_task_id_sha256": "d" * 64},
}
```

Worker 不能回传原始 transcript；只回传 hash、时间段和评分。`server.py` 按 action 选择 verifier，并从 `pack_by_id[request.locale_pack]` 取服务端加载的包，未知/重复 pack fail closed。

- [ ] **步骤 4：修复真实发现的 socket monkeypatch 兼容缺陷**

`model_compat_smoke.py` 必须在安装断网钩子前导入 `ssl`、`asyncio` 和模型运行时依赖。断网钩子仍需证明 inference 阶段没有 DNS/HTTP；禁止仅删除断网检查。

- [ ] **步骤 5：运行 Worker 全组测试**

```powershell
python -m unittest discover -s workers/redraw-locale-verifier/tests -p 'test_*.py' -v
```

预期：全部通过；既有 `en-US` TTS evidence shape 不变。

- [ ] **步骤 6：Commit**

```bash
git add workers/redraw-locale-verifier/src/redraw_locale_worker/protocol.py \
  workers/redraw-locale-verifier/src/redraw_locale_worker/verifier.py \
  workers/redraw-locale-verifier/src/redraw_locale_worker/server.py \
  workers/redraw-locale-verifier/src/redraw_locale_worker/engines.py \
  workers/redraw-locale-verifier/scripts/model_compat_smoke.py \
  workers/redraw-locale-verifier/tests/test_protocol.py \
  workers/redraw-locale-verifier/tests/test_verifier.py \
  workers/redraw-locale-verifier/tests/test_server.py \
  workers/redraw-locale-verifier/tests/test_model_staging.py
git commit -m "feat: 扩展原生音轨离线验证协议"
```

## 任务 2：让签名语言包注册表和 Node 客户端支持语言级验证

**文件：**
- 修改：`backend-node/src/services/redrawLocalePackRegistry.js`
- 修改：`backend-node/src/services/redrawLocaleVerifierClient.js`
- 修改：`backend-node/src/services/productionPreflightService.js`
- 修改：`backend-node/test/redrawLocalePackRegistry.test.js`
- 修改：`backend-node/test/redrawLocaleManifestSigning.test.js`
- 修改：`backend-node/test/redrawLocaleVerifierClient.test.js`
- 修改：`backend-node/test/productionPreflight.test.js`

- [ ] **步骤 1：写多 pack、语言/地区分离红测**

```js
test('es@1 语言包只证明 es，不声称地区', () => {
  const pack = registry.assertReady({ packId: 'es@1', language: 'es', scope: 'language' });
  assert.equal(pack.language, 'es');
  assert.equal(pack.locale, null);
  assert.equal(pack.scope, 'language');
});

test('请求 es-MX 不能把 es@1 提升为地区包', () => {
  assert.throws(
    () => registry.assertReady({ packId: 'es@1', language: 'es', locale: 'es-MX', scope: 'locale' }),
    { code: 'REDRAW_LOCALE_VERIFIER_NOT_READY' },
  );
});
```

同时覆盖：重复 pack id、过期 ready、pack 未出现在 ready attestation、模型/校准 hash 漂移、签名失败、旧 `en-US@1` TTS 合同兼容。

- [ ] **步骤 2：运行测试确认失败**

```powershell
node --test backend-node/test/redrawLocalePackRegistry.test.js `
  backend-node/test/redrawLocaleManifestSigning.test.js `
  backend-node/test/redrawLocaleVerifierClient.test.js `
  backend-node/test/productionPreflight.test.js
```

- [ ] **步骤 3：实现通用签名 pack 合同**

`enabled_packs` 每项使用服务端签名字段：

```json
{
  "id": "es@1",
  "language": "es",
  "locale": null,
  "scope": "language",
  "prompt_language_label": "西班牙语",
  "model_manifest_sha256": "64-hex",
  "calibration_manifest_sha256": "64-hex",
  "thresholds": {
    "language_probability_min": 0.80,
    "dialogue_similarity_min": 0.80,
    "speech_chars_per_second_max": 20
  }
}
```

注册表公开 `assertReady(expected)`、`assertEvidenceTrusted(evidence, expected)` 和 `listReadyPacks()`；禁止以请求 locale 选择或构造 pack。ready attestation 改为精确 `enabled_pack_ids` + manifest hash；单个 pack 未 ready 时只关闭该 pack，不把未验证地区补成默认值。

- [ ] **步骤 4：为 Node 客户端增加 `verifyNativeAudio`**

```js
await localeVerifier.verifyNativeAudio({
  audioPath,
  audioSha256,
  approvedText,
  expectedLanguage: 'es',
  packId: 'es@1',
  videoInvocation,
});
```

方法内部从 registry 取得 pack，发送 exact `verify_native_audio`，验证 response 的 pack/hash/language/config/task/artifact 绑定。保留原 `verify()` 给 TTS。

- [ ] **步骤 5：生产预检改为检查全部启用 pack**

`runRedrawLocaleVerifierPreflight` 不再硬编码 `assertReady('en-US')`；它必须检查签名 manifest 中每个 enabled pack 与 ready attestation 一致，并在消息中只输出 pack id，不输出路径、密钥或原始 transcript。

- [ ] **步骤 6：运行测试并 Commit**

```powershell
node --test backend-node/test/redrawLocalePackRegistry.test.js `
  backend-node/test/redrawLocaleManifestSigning.test.js `
  backend-node/test/redrawLocaleVerifierClient.test.js `
  backend-node/test/productionPreflight.test.js
git add backend-node/src/services/redrawLocalePackRegistry.js \
  backend-node/src/services/redrawLocaleVerifierClient.js \
  backend-node/src/services/productionPreflightService.js \
  backend-node/test/redrawLocalePackRegistry.test.js \
  backend-node/test/redrawLocaleManifestSigning.test.js \
  backend-node/test/redrawLocaleVerifierClient.test.js \
  backend-node/test/productionPreflight.test.js
git commit -m "feat: 支持语言级离线验证包"
```

## 任务 3：实现服务端原生对白 prompt 编译器

**文件：**
- 创建：`backend-node/src/services/redrawNativeDialoguePromptService.js`
- 创建：`backend-node/test/redrawNativeDialoguePrompt.test.js`

- [ ] **步骤 1：写 prompt 顺序、窗口和 hash 红测**

```js
test('按服务端对白窗口编译西班牙语多人对白', () => {
  const result = compileNativeDialoguePrompt({
    shot: { id: 9, start_ms: 0, end_ms: 13000 },
    basePrompt: '写实风格短剧片段，电影级画质。',
    language: 'es',
    promptLanguageLabel: '西班牙语',
    dialogues: [
      { speaker_id: 'Valeria', start_ms: 7600, end_ms: 8800, text: 'Hola, pequeño.' },
      { speaker_id: 'Valeria', start_ms: 8800, end_ms: 10700, text: '¿Te has perdido?' },
    ],
    modelPin: { config_id: 16, config_updated_at: '2026-08-09T00:00:00Z', model: 'seedance-2-fast' },
  });
  assert.match(result.prompt, /用西班牙语说:<Hola, pequeño\.>/);
  assert.match(result.prompt, /不要出现任何字幕，不允许添加背景 BGM/);
  assert.match(result.dialogue_snapshot_hash, /^[0-9a-f]{64}$/);
});
```

另测：窗口越界、非法重叠、空 speaker/text、预计说话时长超阈值、顺序改变、角色改变、语言或 config pin 改变都会改变 hash。

- [ ] **步骤 2：运行红测**

```powershell
node --test backend-node/test/redrawNativeDialoguePrompt.test.js
```

- [ ] **步骤 3：实现纯函数编译器**

只接受服务端已加载对象。输出：`prompt`、`prompt_hash`、`approved_text`、`dialogue_snapshot`、`dialogue_snapshot_hash`。稳定 hash 使用项目既有 stable stringify + SHA-256；不引入模板引擎。首版不允许对白窗口重叠。

- [ ] **步骤 4：运行绿测并 Commit**

```powershell
node --test backend-node/test/redrawNativeDialoguePrompt.test.js
git add backend-node/src/services/redrawNativeDialoguePromptService.js \
  backend-node/test/redrawNativeDialoguePrompt.test.js
git commit -m "feat: 编译转绘原生外语对白提示词"
```

## 任务 4：增加原生对白能力证据并修复语言/地区目录合同

**文件：**
- 修改：`backend-node/src/services/redrawCapabilityService.js`
- 修改：`backend-node/test/redrawCapabilities.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：写能力证据绑定红测**

覆盖以下条件：

- `native_dialogue_audio` 加入允许能力集合；
- evidence contract 必须为 `redraw-native-dialogue-audio-v1`；
- config id、config updated_at、provider、protocol、model 与承载配置精确一致；
- provider task、artifact id/hash、audio stream、language verification、human review 均完整；
- `target_language='es'` + `target_locale=null` 只能返回语言 `es`、空地区和 `audio_mode='native'`；
- 任一证据漂移、artifact 不可读或 human review 未通过时目录无该选项；
- 现有 TTS 完整证据仍返回 `audio_mode='replace'`；
- `full_output` 接受 `video + native_dialogue_audio`，不再强制同时存在 TTS。

- [ ] **步骤 2：运行红测**

```powershell
node --test backend-node/test/redrawCapabilities.test.js backend-node/test/redrawRoutes.test.js
```

- [ ] **步骤 3：实现最小 evidence 校验和目录聚合**

目录项新增：

```js
{
  language: 'es',
  locale: 'es',
  market: '',
  region_status: 'unverified',
  audio_mode: 'native',
  native_dialogue_audio: true,
  locale_verified: false,
}
```

不把空 market 映射为 US、默认地区或任意国家。真实 evidence 写入仍由后面的付费 canary 和人工审核完成，本任务只实现 fail-closed 读取。

- [ ] **步骤 4：运行绿测并 Commit**

```powershell
node --test backend-node/test/redrawCapabilities.test.js backend-node/test/redrawRoutes.test.js
git add backend-node/src/services/redrawCapabilityService.js \
  backend-node/test/redrawCapabilities.test.js backend-node/test/redrawRoutes.test.js
git commit -m "feat: 增加原生对白能力目录合同"
```

## 任务 5：把原生对白快照、同步音频和精确配置贯穿视频提交

**文件：**
- 修改：`backend-node/src/services/redrawGenerationService.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/test/redrawGeneration.test.js`
- 修改：`backend-node/test/redrawShotBilling.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`
- 修改：`backend-node/test/toapisVideoClient.test.js`
- 修改：`backend-node/test/toapisVideoGate.test.js`

- [ ] **步骤 1：写 reserve 前门禁红测**

测试必须断言：

```js
assert.equal(providerCalls, 0);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tenant_credit_reservations').get().n, 0);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0);
```

触发条件：客户端提交 `model`、`locale`、`prompt`、`generate_audio`、config id、provider、价格；语言包未 ready；无 verified native capability；模型 `supportsAudio!==true`；对白越界/重叠/超时；config updated_at 漂移。

- [ ] **步骤 2：写持久化与恢复红测**

成功创建必须断言：

```js
assert.equal(video.generate_audio, 1);
assert.equal(snapshot.generate_audio, true);
assert.equal(snapshot.prompt_hash, compiled.prompt_hash);
assert.equal(snapshot.dialogue_snapshot_hash, compiled.dialogue_snapshot_hash);
assert.equal(snapshot.ai_service_config_id, 16);
assert.equal(snapshot.config_updated_at, exactUpdatedAt);
assert.equal(snapshot.locale_pack, 'es@1');
```

同一 shot/version/dialogue/config 即使换幂等键也只能有一条 active/unknown generation。对白或 config 快照改变时旧 generation 不能被误复用。

- [ ] **步骤 3：运行红测**

```powershell
node --test backend-node/test/redrawGeneration.test.js `
  backend-node/test/redrawShotBilling.test.js `
  backend-node/test/redrawRoutes.test.js `
  backend-node/test/toapisVideoClient.test.js `
  backend-node/test/toapisVideoGate.test.js
```

- [ ] **步骤 4：接入 prompt 编译器和 native capability**

`generateShot` 必须按以下顺序执行：

1. owner/version/shot gate；
2. 从版本和 `localized_dialogue_json` 编译 prompt；
3. 从签名 pack 和 `native_dialogue_audio` evidence 选择精确 config；
4. 校验 `supportsAudio=true`、时长、分辨率和参考素材；
5. 生成稳定 request snapshot；
6. 查跨幂等键 duplicate；
7. reserve + 创建 task/video row；
8. 供应商紧前再次校验 pinned config/pack；
9. 只提交一次。

INSERT 复用已有列，补齐 `generate_audio=1` 和 `request_snapshot`。调用 ToAPIs 时强制服务端 `generate_audio: true`，客户端 body 不参与。

- [ ] **步骤 5：确保恢复仍使用精确快照**

`videoService` 恢复/首提不得从当前默认配置重算音频开关；必须读取 pinned row + request snapshot。配置停用、删除或 updated_at 漂移时，在网络前进入 `needs_attention`，不退款、不重提。

- [ ] **步骤 6：运行绿测并 Commit**

```powershell
node --test backend-node/test/redrawGeneration.test.js `
  backend-node/test/redrawShotBilling.test.js `
  backend-node/test/redrawRoutes.test.js `
  backend-node/test/toapisVideoClient.test.js `
  backend-node/test/toapisVideoGate.test.js
git add backend-node/src/services/redrawGenerationService.js \
  backend-node/src/routes/redraw.js \
  backend-node/test/redrawGeneration.test.js \
  backend-node/test/redrawShotBilling.test.js \
  backend-node/test/redrawRoutes.test.js \
  backend-node/test/toapisVideoClient.test.js \
  backend-node/test/toapisVideoGate.test.js
git commit -m "feat: 提交转绘原生声画分镜"
```

## 任务 6：实现 MP4 原生音轨媒体门禁和隔离 Worker 验证

**文件：**
- 创建：`backend-node/src/services/redrawNativeAudioService.js`
- 创建：`backend-node/test/redrawNativeAudio.test.js`
- 修改：`backend-node/src/services/redrawGenerationService.js`
- 修改：`backend-node/test/redrawGeneration.test.js`

- [ ] **步骤 1：写媒体门禁纯服务红测**

覆盖：可读普通 MP4、路径逃逸/symlink、无视频流、无音频流、损坏音频、音视频时长差超限、近似静音、PCM 输出超限、ffprobe/ffmpeg 超时、Worker 超时、错语言、错台词、worker evidence/config/task/artifact 不匹配。

成功结果至少为：

```js
{
  contract: 'redraw-native-audio-validation-v1',
  artifact_sha256: 'a'.repeat(64),
  audio_stream: { codec: 'aac', channels: 2, sample_rate: 44100, duration_ms: 12980 },
  video_duration_ms: 13000,
  silence: { rms_db: -24.1, threshold_db: -45 },
  verification: {
    detected_language: 'es',
    detected_locale: null,
    language_verified: true,
    locale_verified: false,
    transcript_sha256: 'b'.repeat(64),
    dialogue_similarity: 0.90,
  },
  validation_hash: 'c'.repeat(64),
}
```

- [ ] **步骤 2：运行红测**

```powershell
node --test backend-node/test/redrawNativeAudio.test.js
```

- [ ] **步骤 3：实现有界媒体处理**

- `ffprobe` 必须返回全部 streams；
- `ffmpeg` 抽取 16 kHz mono s16le/WAV 到 storage root 内受控临时目录；
- 15 秒 PCM 采用流式 RMS，设置严格最大字节和总超时；
- `finally` 删除临时 PCM；
- Worker 请求只使用服务端 approved text、pack 和 video invocation；
- Node 不记录原始 transcript，也不把 request locale 当 detected locale。

- [ ] **步骤 4：把验证接到 provider completed 之后、结算之前**

媒体验证通过后，在与产物绑定/积分确认一致的事务中写：

```js
draft.native_audio_validation = {
  ...compactEvidence,
  status: 'verified',
  human_review: { status: 'pending' },
};
```

自动验证失败但 MP4/音轨可读时保留 candidate 资产和证据，shot/task/video 进入 `needs_attention`，reservation held。无音轨或不可读也同样 held，但标记为不可人工接受。自动验证通过的正常分镜直接按现有原子结算合同完成，不强制逐镜人工点击。

- [ ] **步骤 5：写 post-provider 失败与跨 key 防重红绿测试**

分别注入：下载异常、ffprobe 异常、Worker 超时、证据写失败、资产注册失败、settlement 失败。每项断言：`providerCalls=1`、reservation held、状态 `needs_attention`、第二次不同 idempotency key 仍 `providerCalls=1`。

- [ ] **步骤 6：运行测试并 Commit**

```powershell
node --test backend-node/test/redrawNativeAudio.test.js `
  backend-node/test/redrawGeneration.test.js `
  backend-node/test/redrawShotBilling.test.js
git add backend-node/src/services/redrawNativeAudioService.js \
  backend-node/src/services/redrawGenerationService.js \
  backend-node/test/redrawNativeAudio.test.js \
  backend-node/test/redrawGeneration.test.js \
  backend-node/test/redrawShotBilling.test.js
git commit -m "feat: 验证转绘原生对白音轨"
```

## 任务 7：增加异常原生音轨人工处理与安全结算 API

**文件：**
- 修改：`backend-node/src/services/redrawGenerationService.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/src/routes/index.js`
- 修改：`backend-node/test/redrawGeneration.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：写 owner、CAS 和证据 hash 红测**

新增路由：

```text
POST /api/v1/redraw/shots/:id/native-audio-review
```

body exact fields：

```json
{
  "validation_hash": "64-hex",
  "expected_updated_at": "ISO-8601",
  "decision": "approved",
  "speaker_order": "passed",
  "lip_sync": "passed",
  "extra_dialogue": "passed"
}
```

测试跨租户 404、旧 hash 409、旧 updated_at 409、缺音轨/不可读不能批准、重复相同审批幂等、不同审批冲突。

- [ ] **步骤 2：运行红测**

```powershell
node --test backend-node/test/redrawGeneration.test.js backend-node/test/redrawRoutes.test.js
```

- [ ] **步骤 3：实现人工审批状态机**

- 自动验证通过的普通分镜可直接完成；只有真实付费 capability canary 必须另行完成人工 speaker/lip-sync/extra-dialogue 检查后才可成为能力 evidence；
- 自动语言/文本不通过但媒体可读时，用户可明确接受本次分镜，但必须记录 `manual_override=true`，且该结果不能提升全局语言能力；
- 批准时在单一事务内绑定 candidate 资产、结算 reservation、更新 shot/task/video 和 human review；
- 事务失败保持 `needs_attention + held`；
- reject 只记录原因，不删除候选，不自动 TTS、不自动退款重提。

- [ ] **步骤 4：运行绿测并 Commit**

```powershell
node --test backend-node/test/redrawGeneration.test.js backend-node/test/redrawRoutes.test.js
git add backend-node/src/services/redrawGenerationService.js \
  backend-node/src/routes/redraw.js backend-node/src/routes/index.js \
  backend-node/test/redrawGeneration.test.js backend-node/test/redrawRoutes.test.js
git commit -m "feat: 增加原生音轨人工验收门禁"
```

## 任务 8：实现 `audio_mode=native` 合成并保持 `replace` 回归

**文件：**
- 修改：`backend-node/src/services/redrawCompositionService.js`
- 修改：`backend-node/src/routes/redraw.js`
- 修改：`backend-node/test/redrawComposition.test.js`
- 修改：`backend-node/test/redrawCompositionRoutes.test.js`
- 修改：`backend-node/test/redrawExport.test.js`

- [ ] **步骤 1：写 native plan 和 FFmpeg 红测**

断言 native plan：

- 每镜同时使用 `[i:v]` 与 `[i:a]`；
- 使用 `aresample`/`aformat` 统一采样率和声道；
- `concat=n=N:v=1:a=1`；
- 不读取 TTS audio assets，不执行 `amix`；
- manifest/audio_mode/request hash 为 `native`；
- 最终 ffprobe 存在视频和音频流。

同时断言 replace 仍为当前视频 `concat=n=N:v=1:a=0` + TTS `amix` 合同。

- [ ] **步骤 2：写输入漂移红测**

任一 shot id、video generation id、provider task id、MP4 hash、validation hash、dialogue snapshot hash 或 config pin 漂移时，在创建 export/reserve 之前失败。分镜既未自动验证通过、也未被用户明确接受，或仍存在未解决 `needs_attention` 时不能合成。

- [ ] **步骤 3：运行红测**

```powershell
node --test backend-node/test/redrawComposition.test.js `
  backend-node/test/redrawCompositionRoutes.test.js `
  backend-node/test/redrawExport.test.js
```

- [ ] **步骤 4：实现双模式计划与路由 allowlist**

`compositionStartInput` 只允许 exact `native|replace`。`createComposition` 根据 audioMode 走独立 plan builder，不能在一个复杂 filter 中混合分支。字幕继续来自批准台词，不从 ASR transcript 回写。

- [ ] **步骤 5：运行绿测并 Commit**

```powershell
node --test backend-node/test/redrawComposition.test.js `
  backend-node/test/redrawCompositionRoutes.test.js `
  backend-node/test/redrawExport.test.js
git add backend-node/src/services/redrawCompositionService.js \
  backend-node/src/routes/redraw.js \
  backend-node/test/redrawComposition.test.js \
  backend-node/test/redrawCompositionRoutes.test.js \
  backend-node/test/redrawExport.test.js
git commit -m "feat: 保留转绘视频原生对白音轨"
```

## 任务 9：修复源片页语言/地区空白和伪默认值

**文件：**
- 修改：`frontweb/src/components/redraw/RedrawSourceStep.vue`
- 修改：`frontweb/test/redrawFoundation.test.js`
- 修改：`frontweb/test/redrawSourceRuntime.test.js`

- [ ] **步骤 1：写语言与地区分离红测**

```js
assert.deepEqual(languageOptions.map((item) => item.language), ['es']);
assert.deepEqual(regionOptions, []);
assert.equal(localizationBody.locale, 'es');
assert.equal(localizationBody.market, '');
```

同时断言：

- 不再将语言数组直接复用为地区数组；
- 不显示“默认地区”；
- 地区未验证时 selector disabled，文案“地区待验证”；
- 不再将空选择静默替换成 `en-US`/`US`；
- 没有可用语言时按钮禁用并显示“积分待管理员配置”或能力未验证提示。

- [ ] **步骤 2：运行红测**

```powershell
node --test frontweb/test/redrawFoundation.test.js frontweb/test/redrawSourceRuntime.test.js
```

- [ ] **步骤 3：实现最小 UI 数据派生**

语言按 `language` 去重；地区只取当前语言中 `region_status==='verified'` 且 market 非空的条目。语言级 `es` 可选时 body 使用 `locale:'es', market:''`。

- [ ] **步骤 4：运行绿测并 Commit**

```powershell
node --test frontweb/test/redrawFoundation.test.js frontweb/test/redrawSourceRuntime.test.js
git add frontweb/src/components/redraw/RedrawSourceStep.vue \
  frontweb/test/redrawFoundation.test.js frontweb/test/redrawSourceRuntime.test.js
git commit -m "fix: 分离转绘语言与地区选择"
```

## 任务 10：把编辑页改为原生音轨优先、TTS 显式回退

**文件：**
- 修改：`frontweb/src/components/redraw/RedrawEditStep.vue`
- 修改：`frontweb/src/utils/redrawTimelineState.js`
- 修改：`frontweb/src/api/redraw.js`
- 修改：`frontweb/test/redrawEdit.test.js`

- [ ] **步骤 1：写默认 native 行为红测**

断言 `audio_mode=native` 版本首次进入页面：

- 不调用 `quoteDialogue`；
- 不显示“英文配音”；
- 显示“原生声画音轨”、每镜音频验证、检测语言/概率和 `needs_attention` 原因；
- 可鉴权试听本次分镜音轨；
- 只有每镜自动验证通过或已明确人工接受、且无未解决 attention 后，`canStartComposition(verifiedShots, null, null, 'native')` 为 true；
- compose body 为 `{ audio_mode:'native' }`。

- [ ] **步骤 2：写显式 TTS 回退红测**

首次点击“改用 TTS”只请求新报价并展示积分，不启动任务。第二次用户确认且 quote hash 未漂移才调用 `startDialogue`；完成后 compose 使用 `replace`。原生证据和资产仍保留。

- [ ] **步骤 3：写人工检查 API 红测**

`redrawAPI.reviewNativeAudio(shotId, body)` 使用 authenticated request；202/`needs_attention` 显示 warning，不显示成功。验证 hash 或 updated_at 冲突后刷新，不自动重试。

- [ ] **步骤 4：运行红测**

```powershell
node --test frontweb/test/redrawEdit.test.js
```

- [ ] **步骤 5：实现最小双模式状态机**

`redrawTimelineState.js` 提供：

```js
canComposeNative(shots, compositionTask)
canStartTtsFallback(quote, dialogueTask)
resolveAudioMode(version, localeCapability)
```

不要把两种模式的状态塞进一个布尔表达式。页面只有用户明确点击回退后才加载 TTS quote。

- [ ] **步骤 6：运行绿测、前端构建并 Commit**

```powershell
node --test frontweb/test/redrawEdit.test.js
npm --prefix frontweb run build
git add frontweb/src/components/redraw/RedrawEditStep.vue \
  frontweb/src/utils/redrawTimelineState.js frontweb/src/api/redraw.js \
  frontweb/test/redrawEdit.test.js
git commit -m "feat: 默认使用转绘原生对白音轨"
```

## 任务 11：实现单提交真实付费 canary 和证据提升工具

**文件：**
- 创建：`backend-node/scripts/verify-redraw-native-dialogue-audio.js`
- 创建：`backend-node/scripts/promote-redraw-native-dialogue-evidence.js`
- 创建：`backend-node/test/redrawNativeDialogueCanary.test.js`
- 修改：`backend-node/package.json`
- 修改：`backend-node/src/services/productionPreflightService.js`
- 修改：`backend-node/test/productionPreflight.test.js`

- [ ] **步骤 1：写默认零网络/零写入红测**

未设置精确确认串时：

```js
assert.equal(fetchCalls, 0);
assert.equal(providerSubmissions, 0);
assert.equal(dbWriteCalls, 0);
assert.equal(outputFiles.length, 0);
```

脚本必须要求：精确 config id、只读生产 DB、隔离 output/storage、4–15 秒授权分镜、目标语言包、固定 prompt/dialogue snapshot、最大一次 submit、成本上限和显式确认串。

- [ ] **步骤 2：写状态机红测**

覆盖：提交前失败零调用；submit unknown 立即停止；已有 provider task 只 poll 不重提；下载/媒体/Worker失败写 failure evidence 但不生成 capability；completed + 自动验证后输出 `human_review.status='pending'`；仅人工签字后的 evidence 才可提升。

- [ ] **步骤 3：实现可恢复的单提交 canary**

新增 package scripts：

```json
{
  "verify:redraw-native-dialogue": "node scripts/verify-redraw-native-dialogue-audio.js",
  "promote:redraw-native-dialogue": "node scripts/promote-redraw-native-dialogue-evidence.js"
}
```

canary 必须复用项目低层 ToAPIs 请求/轮询合同但禁止 failover/retry；每次新运行最多一次 POST。私有 state 保存 provider task id，公开 evidence 脱敏且不含 key、原始 transcript、绝对密钥路径。

- [ ] **步骤 4：实现默认 dry-run 的 evidence 提升工具**

提升工具必须同时验证：

- evidence 文件 SHA-256；
- contract/config id/updated_at/provider/protocol/model；
- provider task completed；
- artifact 可读及 hash；
- audio stream；
- Worker pack/model/calibration hash；
- `language_verified=true`；
- human speaker/lip-sync/order 全 passed；
- 当前 DB 精确 config 未漂移。

默认只打印脱敏 diff。真正写入要求单独 `--commit` 确认串、数据库备份路径和事务；只允许更新目标配置 `settings.redraw_locale_capabilities`，不得输出或修改 api_key。

- [ ] **步骤 5：生产预检拒绝未提升 evidence**

即使模型 preset 声称 `supportsAudio=true`，没有通过提升的 `native_dialogue_audio` evidence 时 `/redraw/locales` 和生产预检仍 fail closed。

- [ ] **步骤 6：运行测试并 Commit**

```powershell
node --test backend-node/test/redrawNativeDialogueCanary.test.js `
  backend-node/test/productionPreflight.test.js
git add backend-node/scripts/verify-redraw-native-dialogue-audio.js \
  backend-node/scripts/promote-redraw-native-dialogue-evidence.js \
  backend-node/test/redrawNativeDialogueCanary.test.js \
  backend-node/src/services/productionPreflightService.js \
  backend-node/test/productionPreflight.test.js backend-node/package.json
git commit -m "feat: 增加原生对白真实验收门禁"
```

## 任务 12：补齐部署合同和受保护发布范围

**文件：**
- 修改：`.env.production.example`
- 修改：`PUBLIC_PLATFORM_SETUP.md`
- 修改：`docs/WEB_PRODUCTION_DEPLOYMENT.md`
- 修改：`deploy/redraw-locale-verifier/README.md`
- 修改：`deploy/redraw-locale-verifier/moli-redraw-locale-verifier.service`
- 修改：`deploy/release-scopes/redraw-locale-verifier.json`

- [ ] **步骤 1：先更新部署合同测试/审计断言**

在现有 Worker/release scope 测试中断言：单并发、Unix socket、无网络、固定模型根、ready attestation 多 pack、5 GiB 内存上限、明确超时、日志不含 transcript/key。

- [ ] **步骤 2：记录两类能力开关**

文档明确：

- `REDRAW_LOCALE_VERIFIER_ENABLED` 只代表 Worker 运行；
- 语言目录可用还需要 signed pack + target-key native evidence；
- 语言级 `es` 不等于 `es-ES`/`es-MX`；
- 关闭 Worker 或移除 evidence 后只关闭 native language option，不自动切 TTS；
- TTS 回退仍需独立报价和用户确认。

- [ ] **步骤 3：记录隔离安装和回滚**

生产模型、venv 和 manifests 进入 `/opt/moli-drama/shared/redraw-locale-verifier`；release 只含代码和 service unit，不复制大模型。回滚先关闭新语言能力证据，再回滚应用；不得删除历史 evidence 或 provider task。

- [ ] **步骤 4：运行文档/门禁测试并 Commit**

```powershell
node --test backend-node/test/productionPreflight.test.js `
  backend-node/test/redrawLocaleManifestSigning.test.js
git diff --check
git add .env.production.example PUBLIC_PLATFORM_SETUP.md \
  docs/WEB_PRODUCTION_DEPLOYMENT.md \
  deploy/redraw-locale-verifier/README.md \
  deploy/redraw-locale-verifier/moli-redraw-locale-verifier.service \
  deploy/release-scopes/redraw-locale-verifier.json
git commit -m "docs: 记录原生对白部署与回滚门禁"
```

## 任务 13：执行同一工作树全量回归与独立审查

**文件：**
- 不新增文件；只修复本计划引入的失败。

- [ ] **步骤 1：运行 Worker 全组**

```powershell
python -m unittest discover -s workers/redraw-locale-verifier/tests -p 'test_*.py' -v
```

- [ ] **步骤 2：运行 Node 转绘/视频/计费/恢复组合**

```powershell
node --test --test-concurrency=1 `
  backend-node/test/redrawNativeDialoguePrompt.test.js `
  backend-node/test/redrawNativeAudio.test.js `
  backend-node/test/redrawNativeDialogueCanary.test.js `
  backend-node/test/redrawLocalePackRegistry.test.js `
  backend-node/test/redrawLocaleManifestSigning.test.js `
  backend-node/test/redrawLocaleVerifierClient.test.js `
  backend-node/test/redrawCapabilities.test.js `
  backend-node/test/redrawGeneration.test.js `
  backend-node/test/redrawShotBilling.test.js `
  backend-node/test/redrawRoutes.test.js `
  backend-node/test/redrawComposition.test.js `
  backend-node/test/redrawCompositionRoutes.test.js `
  backend-node/test/redrawExport.test.js `
  backend-node/test/toapisVideoClient.test.js `
  backend-node/test/toapisVideoGate.test.js `
  backend-node/test/videoBilling.test.js `
  backend-node/test/videoRecovery.test.js `
  backend-node/test/productionPreflight.test.js
```

- [ ] **步骤 3：运行前端转绘测试和生产构建**

```powershell
node --test frontweb/test/redraw*.test.js
npm --prefix frontweb run build
```

- [ ] **步骤 4：运行静态门禁**

```powershell
node --check backend-node/src/services/redrawNativeDialoguePromptService.js
node --check backend-node/src/services/redrawNativeAudioService.js
node --check backend-node/scripts/verify-redraw-native-dialogue-audio.js
node --check backend-node/scripts/promote-redraw-native-dialogue-evidence.js
git diff --check
git status --short
```

- [ ] **步骤 5：逐条回看规格 13.1 的 12 项自动化验收**

建立规格项到测试名的核对表；任一项没有可执行测试时不得声明代码完成。

- [ ] **步骤 6：请求独立 code review**

审查范围：权限/租户隔离、供应商单提交、计费状态、恢复、防重、exact config pin、证据真实性、路径/进程安全、native/replace FFmpeg、前端显式 TTS consent。修复后重新运行同一完整命令组。

- [ ] **步骤 7：Commit 审查修复**

```bash
# 先用 git diff --name-only 核对本轮审查修复，再逐个执行 git add -- 精确路径；禁止目录级 add。
git commit -m "fix: 收紧原生对白验收边界"
```

## 任务 14：目标机隔离基准与西班牙语校准（需要目标机写入授权，不调用供应商）

**前置门禁：** 任务 1–13 全绿；用户明确授权目标机隔离目录写入。不得修改 `/opt/moli-drama/current`、生产 DB、生产配置或应用服务。

- [ ] **步骤 1：SSH 只读确认实时环境**

确认当前 release、服务 active/NRestarts、可用 CPU/RAM/磁盘、Python/ffmpeg 版本和既有隔离目录。不得读取/打印密钥。

- [ ] **步骤 2：复核已下载固定模型**

验证：

```text
/home/ubuntu/moli-redraw-locale-benchmark-20260809T145929CST
model manifest sha256 = b3f2ae06d8a17b860ea4291babb1234dc7c0cf84bf10282e904054ece5454ff8
```

若目录或 hash 漂移，停止；不得隐式重新下载或替换 revision。

- [ ] **步骤 3：使用修复后的 smoke 做离线重验**

不再使用预加载 workaround。断网钩子应由脚本自身正确安装；记录 cold/warm latency、峰值 RSS、CPU、模型 hash、0 网络调用。基线参考但不作为强制成功值：faster-whisper 13.030731s、CommonAccent 14.808719s、峰值 RSS 2712629248 bytes、单并发。

- [ ] **步骤 4：建立授权西班牙语小型校准集**

授权目录由操作员显式提供；仓库和日志不保存原音频。至少包含短/长、男/女、安静/轻噪声、近音词、缺词/多词、非西语对抗样本。输出只保存样本 hash、标签、评分和阈值，不保存 transcript/音频。

- [ ] **步骤 5：签署 `es@1` manifest 候选**

签名产物仍留隔离目录，未完成真实付费 canary 前不得安装为 production enabled pack。

## 任务 15：真实付费同链验收（单独批准后执行）

**前置门禁：** 任务 14 通过；用户在执行当次明确批准一次付费提交、成本上限、精确 config id、授权源片和目标台词。普通“继续”不构成批准。

- [ ] **步骤 1：读取实时精确配置并锁定一次提交预算**

只读确认生产 config id、updated_at、provider、protocol、model、endpoint host、价格状态和 `supportsAudio=true`；不输出 key。任何漂移都回到计划评审。

- [ ] **步骤 2：运行 canary dry-run**

确认 `providerSubmissions=0`，输出 exact prompt/dialogue/config/pack/artifact 路径摘要和预估积分/成本。

- [ ] **步骤 3：执行一次真实提交**

使用授权 4–15 秒分镜、短西班牙语对白、`generate_audio=true`。只允许一次 submit；网络/响应不确定立即停止，保留 provider task/state，不重提。

- [ ] **步骤 4：等待终态并验证产物**

验证 MP4 可读、视频/音频流、时长、hash、非静音；隔离 Worker 验证 `es` 和批准台词；输出脱敏 evidence。

- [ ] **步骤 5：人工检查**

人工逐项记录角色、嘴型、说话顺序、额外台词、串音和环境声。任一失败则 evidence 保持 blocked，不能进入目录。

- [ ] **步骤 6：验证 native 导出和失败路径**

用同一产物执行 native composition，确认最终 MP4 音轨仍存在。再使用不产生供应商费用的故障注入验证 `needs_attention + held`、不自动 TTS、不二次提交；不得为“失败案例”再付费提交。

- [ ] **步骤 7：人工批准 evidence 提升**

先 dry-run 脱敏 diff；再次取得生产配置写入批准后，备份 DB 并事务性加入该语言的 `native_dialogue_audio` evidence。写后读取 `/redraw/locales`，只应出现西班牙语，地区仍为空/待验证。

## 任务 16：制作生产候选与发布（另行批准，不能随实现自动执行）

- [ ] **步骤 1：协调同项目其他会话**

确认没有其他会话持有 deploy lock、没有候选正在 activate；收集最新实时 current。旧候选一律废弃，不叠加激活。

- [ ] **步骤 2：从实时 current 制作候选**

通过 SSH 读取 `/opt/moli-drama/current`，只从该 release 克隆候选；按审计 allowlist 三方合并本计划文件。不得以本地 worktree 整体覆盖。

- [ ] **步骤 3：受保护门禁**

候选内运行 Worker/Node/front 测试、构建、production preflight、共享审计器、`canvas-credit-callout-v1`、备份、活动任务、AI 音乐隔离、日志和健康检查。

- [ ] **步骤 4：等待单独生产切换批准**

只有用户明确批准该候选路径和 expected current 后，才允许：

```bash
sudo /opt/moli-drama/shared/release-guard/activate-protected-release.sh CANDIDATE EXPECTED_CURRENT
```

- [ ] **步骤 5：同一运行验收**

在生产 UI 选择“西班牙语 / 地区待验证”，上传授权源片，完成分析、资产、单镜原生声画、人工检查、native 合成、打开/下载最终 MP4、审计积分和任务状态。不得用单测、mock、构建或历史 canary 替代浏览器真实同链。

## 最终自检

- [ ] 没有未实现占位、空测试体或伪造 provider task id。
- [ ] 旧 `verify` TTS 合同和 `audio_mode=replace` 回归通过。
- [ ] `verify_native_audio` 的 task/config/artifact 证据来自真实视频调用，不复制请求 locale。
- [ ] 语言级 `es` 不声称任何地区；UI 不补默认地区。
- [ ] 客户端无法覆盖 prompt、对白、locale、generate_audio、model、provider、config 或 credits。
- [ ] pre-provider 失败为 0 reserve/0 provider；post-provider 失败 held/no replay。
- [ ] native composition 输入 hash 覆盖全部七类绑定字段。
- [ ] TTS 回退只在明确点击、重新报价、再次确认后发生。
- [ ] 真实付费、evidence 提升、候选制作和生产切换均是独立批准门禁。
- [ ] 发布候选从执行当时的实时 current 制作并保留 `canvas-credit-callout-v1`。
