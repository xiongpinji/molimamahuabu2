# 短剧转绘离线语言验证 Worker 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不信任请求 locale 和 TTS 自报语言字段的前提下，用隔离、离线、单并发 Python Worker 为 `en-US` 转绘音色和对白生成可审计的语言、台词与 US 口音证据。

**架构：** Python Worker 通过 Unix domain socket 提供单请求 JSONL 协议，顺序运行 faster-whisper CPU INT8 和 CommonAccent 英语口音分类器。Node 侧用签名语言包清单和短时效本机 ready attestation 在积分冻结和供应商提交前 fail closed；TTS 完成后再调用 Worker，只有完整证据才允许生成 production voice，否则进入 `needs_attention + held` 且禁止重提。

**技术栈：** Node.js 20、`node:test`、`node:net`、`node:crypto`、Python 3.12、`unittest`、faster-whisper 1.2.1、CTranslate2 4.8.1、SpeechBrain 1.1.0、PyTorch/TorchAudio 2.11.0 CPU、JiWER 4.0.0、FFmpeg/ffprobe、systemd。

---

## 执行边界

- 实际工作树：`C:\Users\canqu\Documents\茉莉妈妈2\worktrees\baseline-canvas-video-first-last-20260806`
- 当前工作树已有大量转绘实现改动。执行者不得还原、格式化或顺带修改这些既有改动。
- 任务 1 的真实模型兼容性和资源门禁未通过时立即停止，不得继续写入 production capability。
- 本地实现不授权生产部署、服务重启、生产数据库写入或付费 TTS 调用。
- 生产候选必须从实时 `/opt/moli-drama/current` 制作，并通过共享 release guard；不得用本工作树整体覆盖生产。

## 文件结构

### 新建 Python Worker

- `workers/redraw-locale-verifier/requirements.in`：直接依赖与精确版本。
- `workers/redraw-locale-verifier/requirements.lock`：Linux x86_64 / Python 3.12 哈希锁。
- `workers/redraw-locale-verifier/THIRD_PARTY_NOTICES.md`：依赖、模型 revision、许可证和审计来源。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/__init__.py`：Worker package 标识。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/errors.py`：稳定错误码。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/protocol.py`：JSONL 请求/响应验证。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/manifest.py`：模型与校准清单 hash 验证。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/audio.py`：允许根目录校验和 FFmpeg 16 kHz 单声道规范化。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/normalization.py`：英文文本规范化、WER/CER。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/commonaccent_interface.py`：经审计的 SpeechBrain 1.1 兼容接口，不执行远程代码。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/engines.py`：离线 ASR 和口音分类适配器。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/verifier.py`：三项联合判定与证据生成。
- `workers/redraw-locale-verifier/src/redraw_locale_worker/server.py`：单并发 Unix socket server 和 ready attestation。
- `workers/redraw-locale-verifier/scripts/stage_models.py`：显式联网阶段下载固定 revision、改写本地路径并生成文件 hash 清单。
- `workers/redraw-locale-verifier/scripts/model_compat_smoke.py`：在非生产隔离目录加载三份本地模型并记录峰值 RSS。
- `workers/redraw-locale-verifier/scripts/benchmark.py`：延迟、RSS、CPU 和失败率基准。
- `workers/redraw-locale-verifier/scripts/calibrate.py`：从独立标注集生成阈值 manifest。
- `workers/redraw-locale-verifier/tests/*.py`：纯函数、协议、模型假实现和 server 测试。
- `workers/redraw-locale-verifier/tests/fixtures/synthetic-index.json`：不含真人语音的 benchmark 合同 fixture。

### 新建 Node 接入

- `backend-node/src/services/redrawLocalePackRegistry.js`：验证 Ed25519 签名清单、ready attestation 和历史 evidence。
- `backend-node/src/services/redrawLocaleVerifierClient.js`：有界 JSONL Unix socket 客户端。
- `backend-node/scripts/sign-redraw-locale-manifest.js`：离线签署校准/语言包 manifest。
- `backend-node/test/redrawLocalePackRegistry.test.js`：签名、hash、过期和语言包门禁。
- `backend-node/test/redrawLocaleVerifierClient.test.js`：socket、超时、大小限制和单响应合同。

### 修改现有链路

- `backend-node/src/routes/index.js:221-267`：只创建一个 registry/client，并注入 redraw provider 与 route context。
- `backend-node/src/routes/redraw.js:1027-1053`：资产和对白上下文注入 locale verifier。
- `backend-node/src/services/redrawAssetBatchService.js:282-325`：voice 报价前校验语言包 ready，并把语言包 hash 纳入 quote hash。
- `backend-node/src/services/redrawProviderAdapters.js:580-712,752-856`：TTS 前复核 ready，TTS 后调用 Worker，禁止使用供应商自报 locale 作为验证结果。
- `backend-node/src/services/redrawAssetService.js:484-673`：只接受完整 Worker evidence。
- `backend-node/src/services/redrawVoiceService.js:21-272`：列表、绑定和对白前复核历史 evidence 仍属于已启用语言包。
- `backend-node/src/services/redrawDialogueService.js:542-678`：把 locale evidence 写入 segment audit，并保持 post-provider failure 为 held。
- `backend-node/src/services/productionPreflightService.js:28-147`：检查 feature 配置、签名 manifest、模型清单和 ready attestation。
- `backend-node/scripts/preproduction-check.js`、`backend-node/package.json`：增加 Worker 专项预检命令。
- `.env.production.example`、`PUBLIC_PLATFORM_SETUP.md`、`docs/WEB_PRODUCTION_DEPLOYMENT.md`：记录关闭态、启用门禁和回滚路径。
- `deploy/redraw-locale-verifier/moli-redraw-locale-verifier.service`：5 GiB/300% CPU/AF_UNIX/无网络 systemd 沙箱。
- `deploy/redraw-locale-verifier/README.md`：隔离安装、基准、校准、部署和恢复步骤。
- `deploy/release-scopes/redraw-locale-verifier.json`：候选允许变更文件白名单。

## 任务 1：固定依赖并完成真实模型兼容性硬门禁

**文件：**
- 创建：`workers/redraw-locale-verifier/requirements.in`
- 创建：`workers/redraw-locale-verifier/requirements.lock`
- 创建：`workers/redraw-locale-verifier/THIRD_PARTY_NOTICES.md`
- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/commonaccent_interface.py`
- 创建：`workers/redraw-locale-verifier/scripts/stage_models.py`
- 创建：`workers/redraw-locale-verifier/scripts/model_compat_smoke.py`
- 创建：`workers/redraw-locale-verifier/tests/test_model_staging.py`

- [ ] **步骤 1：编写失败的模型 staging 测试**

```python
def test_stage_manifest_requires_exact_revisions_and_hashes(self):
    manifest = build_model_manifest(self.model_root, revisions={
        "asr": "2ec96c5472da50d38d40c0cfe0602af2e94b4c8a",
        "accent": "cc5dc6a56db647149d9e52856d6e55114c1045a8",
        "wav2vec": "b61310a3ecdfdc01af29ef1c203d708047a51184",
    })
    self.assertEqual(manifest["schema_version"], 1)
    self.assertRegex(manifest["models"]["asr"]["tree_sha256"], r"^[0-9a-f]{64}$")
    self.assertRegex(manifest["models"]["accent"]["tree_sha256"], r"^[0-9a-f]{64}$")
    self.assertNotIn("main", json.dumps(manifest))

def test_commonaccent_loader_uses_only_the_vendored_local_interface(self):
    source = Path(MODEL_COMPAT_SMOKE).read_text(encoding="utf-8")
    self.assertIn("CommonAccentClassifier", source)
    self.assertNotIn("EncoderClassifier", source)
    self.assertNotIn("foreign_class", source)
    self.assertNotIn("trust_remote_code", source)
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
python -m unittest discover workers/redraw-locale-verifier/tests -p 'test_model_staging.py' -v
```

预期：FAIL，错误包含 `ModuleNotFoundError` 或 `build_model_manifest` 未定义。

- [ ] **步骤 3：写入精确依赖和最小 staging 实现**

`requirements.in` 使用：

```text
faster-whisper==1.2.1
ctranslate2==4.8.1
huggingface-hub==0.36.2
jiwer==4.0.0
psutil==7.2.2
PyYAML==6.0.3
soundfile==0.14.0
speechbrain==1.1.0
torch==2.11.0
torchaudio==2.11.0
transformers==4.57.6
```

`stage_models.py` 必须使用固定 revision，并在复制完成后遍历普通文件，按相对路径和文件 SHA-256
生成确定性 tree hash。对 CommonAccent 的工作副本只允许两项确定性改写：把
`wav2vec2_hub` 改为本地固定目录，把 `pretrained_path` 改为本地 CommonAccent 目录；改写前必须断言
原始两行与固定 revision 内容一致。

固定 CommonAccent snapshot 的模块集合是 `wav2vec2/avg_pool/output_mlp`，不能用要求
`compute_features/mean_var_norm/embedding_model/classifier` 的通用 `EncoderClassifier`。任务 1 先实现并
审计仓库内 `CommonAccentClassifier(Pretrained)`，仅保留该固定模型需要的
`wav2vec2 -> avg_pool -> output_mlp` 推理路径；通过 SpeechBrain 1.1 的
`pretrained_from_hparams(cls=CommonAccentClassifier, source=<local-runtime>)` 加载。禁止动态导入模型
snapshot 的 `custom_interface.py`、`foreign_class` 和 `trust_remote_code`。vendored interface 的文件
SHA-256 必须进入 runtime manifest，HyperPyYAML 可实例化的类路径必须与固定模板逐项 allowlist 比对。

```python
REVISIONS = {
    "asr": ("Systran/faster-whisper-small", "2ec96c5472da50d38d40c0cfe0602af2e94b4c8a"),
    "accent": ("Jzuluaga/accent-id-commonaccent_xlsr-en-english", "cc5dc6a56db647149d9e52856d6e55114c1045a8"),
    "wav2vec": ("facebook/wav2vec2-large-xlsr-53", "b61310a3ecdfdc01af29ef1c203d708047a51184"),
}

def tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()
```

- [ ] **步骤 4：生成 Linux/Python 3.12 哈希锁并运行兼容性 smoke**

在隔离、非生产目录执行：

```bash
uv pip compile workers/redraw-locale-verifier/requirements.in \
  --python-version 3.12 \
  --python-platform linux \
  --extra-index-url https://download.pytorch.org/whl/cpu \
  --generate-hashes \
  --no-emit-index-url \
  --output-file workers/redraw-locale-verifier/requirements.lock
python3.12 -m venv /tmp/moli-locale-compat
/tmp/moli-locale-compat/bin/pip install --require-hashes \
  -r workers/redraw-locale-verifier/requirements.lock \
  --extra-index-url https://download.pytorch.org/whl/cpu
/tmp/moli-locale-compat/bin/python workers/redraw-locale-verifier/scripts/stage_models.py \
  --output /tmp/moli-locale-models
# 由执行者预先放入一条已授权、3-10 秒的 US English 本地语音；不得提交到仓库。
test -f /tmp/moli-locale-smoke/us-english.wav
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  /tmp/moli-locale-compat/bin/python workers/redraw-locale-verifier/scripts/model_compat_smoke.py \
  --models /tmp/moli-locale-models \
  --audio /tmp/moli-locale-smoke/us-english.wav \
  --max-rss-bytes 4831838208
/tmp/moli-locale-compat/bin/python -m unittest discover \
  -s workers/redraw-locale-verifier/tests -p 'test_model_staging.py' -v
```

预期：PASS；staging manifest 含三个固定 revision 和非空 tree SHA-256；关闭网络后仍能加载所有本地
配置。若 SpeechBrain/模型 revision 不兼容、发生隐式下载或峰值 RSS 已超过 4.5 GiB，停止本计划，
记录实测错误并转独立推理主机设计，不尝试换成未经批准模型。

- [ ] **步骤 5：Commit**

```bash
git add workers/redraw-locale-verifier/requirements.in \
  workers/redraw-locale-verifier/requirements.lock \
  workers/redraw-locale-verifier/THIRD_PARTY_NOTICES.md \
  workers/redraw-locale-verifier/src/redraw_locale_worker/commonaccent_interface.py \
  workers/redraw-locale-verifier/scripts/stage_models.py \
  workers/redraw-locale-verifier/scripts/model_compat_smoke.py \
  workers/redraw-locale-verifier/tests/test_model_staging.py
git commit -m "build: 固定转绘语言验证运行时"
```

## 任务 2：实现协议、manifest 与英文台词评分纯函数

**文件：**
- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/errors.py`
- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/__init__.py`
- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/protocol.py`
- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/manifest.py`
- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/audio.py`
- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/normalization.py`
- 创建：`workers/redraw-locale-verifier/tests/test_protocol.py`
- 创建：`workers/redraw-locale-verifier/tests/test_normalization.py`

- [ ] **步骤 1：编写失败测试，锁定客户端不可控字段和错误码**

```python
def test_verify_request_requires_server_fields(self):
    with self.assertRaisesRegex(ProtocolError, "LOCALE_VERIFY_REQUEST_INVALID"):
        parse_request({"action": "verify", "locale_pack": "en-US@1"})

def test_english_metrics_preserve_negation_names_and_numbers(self):
    metrics = score_text("Anna did not pay 50 dollars", "Anna paid fifty dollars")
    self.assertGreater(metrics["word_error_rate"], 0)
    self.assertFalse(metrics["critical_tokens_match"])

def test_audio_path_rejects_symlink_escape(self):
    with self.assertRaisesRegex(AudioInputError, "LOCALE_AUDIO_PATH_INVALID"):
        normalize_audio(self.symlink_outside_root, self.allowed_root, self.temp_root)
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
$env:PYTHONPATH='workers/redraw-locale-verifier/src'
python -m unittest discover -s workers/redraw-locale-verifier/tests -p 'test_protocol.py' -v
python -m unittest discover -s workers/redraw-locale-verifier/tests -p 'test_normalization.py' -v
```

预期：FAIL，缺少 `parse_request` 和 `score_text`。

- [ ] **步骤 3：实现最小协议和评分**

```python
REQUIRED_VERIFY_FIELDS = {
    "request_id", "audio_path", "audio_sha256", "approved_text",
    "locale_pack", "tts_invocation",
}

def parse_request(value: dict) -> dict:
    if value.get("action") == "health" and value.get("request_id"):
        return {"action": "health", "request_id": str(value["request_id"])}
    allowed = REQUIRED_VERIFY_FIELDS | {"action"}
    if value.get("action") != "verify" or set(value) != allowed:
        raise ProtocolError("LOCALE_VERIFY_REQUEST_INVALID")
    if value["locale_pack"] != "en-US@1":
        raise ProtocolError("LOCALE_PACK_UNSUPPORTED")
    if not re.fullmatch(r"[0-9a-f]{64}", str(value["audio_sha256"])):
        raise ProtocolError("LOCALE_AUDIO_HASH_INVALID")
    return value
```

`tts_invocation` 还必须严格限定为 `provider/model/ai_service_config_id/config_updated_at/provider_task_id`，
拒绝空 provider task id、非正整数 config id、无时区时间戳和任何额外字段。health 请求同样只允许
`action/request_id` 两个字段，防止客户端字段被静默忽略。

`score_text()` 使用 JiWER 计算 WER/CER；英文规范化只能处理 Unicode、大小写、标点、数字形式和空白，
同时显式比较批准台词中的否定词、数字和大小写前专有名词集合。空批准台词永远不通过。

`normalize_audio()` 必须对允许根目录和输入逐级执行 `resolve(strict=True)`，拒绝符号链接逃逸，使用
FFmpeg 的 `-nostdin -v error -ac 1 -ar 16000` 生成 Worker 临时 WAV，并用 ffprobe 拒绝无音轨、
零时长和超过 60 秒的输入。FFmpeg 总 deadline 为 30 秒，临时 WAV 在 `finally` 中删除。

- [ ] **步骤 4：验证纯函数全部通过**

运行：

```powershell
$env:PYTHONPATH='workers/redraw-locale-verifier/src'
python -m unittest discover -s workers/redraw-locale-verifier/tests -v
```

预期：PASS；请求 locale 不会被转换成 detected locale，未知字段会被稳定拒绝。

- [ ] **步骤 5：Commit**

```bash
git add workers/redraw-locale-verifier/src workers/redraw-locale-verifier/tests
git commit -m "feat: 定义语言验证协议与台词评分"
```

## 任务 3：实现离线模型适配器与联合判定

**文件：**
- 修改：`workers/redraw-locale-verifier/src/redraw_locale_worker/commonaccent_interface.py`
- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/engines.py`
- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/verifier.py`
- 创建：`workers/redraw-locale-verifier/tests/test_verifier.py`
- 修改：`workers/redraw-locale-verifier/tests/test_model_staging.py`

- [ ] **步骤 1：用假引擎编写联合门禁失败测试**

```python
def test_locale_is_verified_only_when_all_gates_pass(self):
    result = verify_audio(self.request, self.pack, asr=FakeAsr("en", 0.98, self.text),
                          accent=FakeAccent("us", 0.94))
    self.assertTrue(result["language_verified"])
    self.assertEqual(result["detected_locale"], "en-US")

def test_request_locale_cannot_override_non_us_audio(self):
    result = verify_audio(self.request, self.pack, asr=FakeAsr("en", 0.99, self.text),
                          accent=FakeAccent("england", 0.97))
    self.assertFalse(result["language_verified"])
    self.assertIsNone(result["detected_locale"])
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
$env:PYTHONPATH='workers/redraw-locale-verifier/src'
python -m unittest discover workers/redraw-locale-verifier/tests -p 'test_verifier.py' -v
```

预期：FAIL，`verify_audio` 未定义。

- [ ] **步骤 3：实现离线模型和联合判定**

ASR 必须用绝对本地目录和 `local_files_only=True`：

```python
class FasterWhisperEngine:
    def __init__(self, model_dir: Path):
        self.model = WhisperModel(str(model_dir), device="cpu", compute_type="int8",
                                  local_files_only=True)

    def infer(self, audio_path: Path) -> dict:
        segments, info = self.model.transcribe(str(audio_path), beam_size=5, vad_filter=True)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return {"language": info.language, "probability": float(info.language_probability), "text": text}
```

CommonAccent 沿用任务 1 已通过真实兼容性门禁的本地接口和 `runtime-hyperparams.yaml`，补充业务级
engine 封装；`FetchConfig` 明确禁止网络。
输出概率由 log posterior 做 `exp()`，不得把原始 log score 当概率。

```python
class CommonAccentEngine:
    def infer(self, audio_path: Path) -> dict:
        out_prob, score, index, labels = self.classifier.classify_file(str(audio_path))
        return {"label": str(labels[0]), "probability": float(score[0].exp().item())}
```

`verify_audio()` 必须重新计算文件 SHA-256，并按 calibration manifest 的四个阈值同时判断：语言概率、
WER、CER、US accent 概率；还必须要求 `critical_tokens_match=True`。响应写入 ASR/accent revision、
tree hash、calibration manifest hash 和 transcript SHA-256，不回传完整 transcript。

- [ ] **步骤 4：运行假引擎与真实离线 smoke**

运行：

```bash
PYTHONPATH=workers/redraw-locale-verifier/src \
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
python3.12 -m unittest discover workers/redraw-locale-verifier/tests -p 'test_verifier.py' -v
PYTHONPATH=workers/redraw-locale-verifier/src \
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
python3.12 -m unittest discover workers/redraw-locale-verifier/tests -p 'test_model_staging.py' -v
```

预期：PASS；执行期间拦截 socket/DNS 后没有外部连接；真实模型 smoke 返回 `en` 和 CommonAccent
已知标签，不要求 smoke 样本达到生产阈值。

- [ ] **步骤 5：Commit**

```bash
git add workers/redraw-locale-verifier/src/redraw_locale_worker \
  workers/redraw-locale-verifier/tests/test_verifier.py \
  workers/redraw-locale-verifier/tests/test_model_staging.py
git commit -m "feat: 增加离线英语与口音联合验证"
```

## 任务 4：实现单并发 Unix socket Worker 与 ready attestation

**文件：**
- 创建：`workers/redraw-locale-verifier/src/redraw_locale_worker/server.py`
- 创建：`workers/redraw-locale-verifier/tests/test_server.py`

- [ ] **步骤 1：编写失败的顺序执行、大小限制和 ready 过期测试**

```python
def test_server_processes_only_one_verify_request_at_a_time(self):
    server = make_test_server(self.verifier)
    results = send_two_requests(server)
    self.assertEqual(self.verifier.max_active, 1)
    self.assertEqual(len(results), 2)

def test_oversized_json_line_is_rejected(self):
    response = send_raw(self.server, b"{" + b"x" * 65536 + b"}\n")
    self.assertEqual(response["error_code"], "LOCALE_REQUEST_TOO_LARGE")
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
$env:PYTHONPATH='workers/redraw-locale-verifier/src'
python -m unittest discover workers/redraw-locale-verifier/tests -p 'test_server.py' -v
```

预期：FAIL，server factory 未定义。

- [ ] **步骤 3：实现顺序 server 和原子 ready 文件**

```python
class LocaleUnixServer(socketserver.UnixStreamServer):
    request_queue_size = 8

def write_ready(path: Path, pack: dict) -> None:
    payload = {
        "schema_version": 1,
        "pid": os.getpid(),
        "locale_pack": pack["id"],
        "model_manifest_sha256": pack["model_manifest_sha256"],
        "calibration_manifest_sha256": pack["calibration_manifest_sha256"],
        "expires_at": datetime.now(timezone.utc).timestamp() + 10,
    }
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    os.replace(temp, path)
```

server 每条请求最多 64 KiB、响应最多 256 KiB；生产只创建 `UnixStreamServer`，不使用 ThreadingMixIn。
启动顺序为：校验模型 hash → 两个引擎分别完成一次本地 smoke → 写 ready → 接受请求。每 5 秒刷新
ready；单独的 daemon heartbeat 线程只能刷新 attestation，不得执行模型推理。退出时删除 ready 和
socket。测试专用 TCP server 只绑定 `127.0.0.1`。
真实 AF_UNIX 集成测试使用 `@unittest.skipUnless(os.name == "posix", "requires AF_UNIX")`；队列、协议和
attestation 纯逻辑测试必须在 Windows 也运行。Windows 的 skip 只允许作为开发机结果，任务 12 的 Linux
回归必须实际执行并通过 AF_UNIX 集成测试，不能以 skip 代替生产门禁。

- [ ] **步骤 4：运行 server 全测试**

运行：

```powershell
$env:PYTHONPATH='workers/redraw-locale-verifier/src'
python -m unittest discover workers/redraw-locale-verifier/tests -p 'test_server.py' -v
```

预期：PASS；两个并发客户端的 `max_active` 为 1；退出后 ready/socket 均不存在。

- [ ] **步骤 5：Commit**

```bash
git add workers/redraw-locale-verifier/src/redraw_locale_worker/server.py \
  workers/redraw-locale-verifier/tests/test_server.py
git commit -m "feat: 增加单并发语言验证 worker"
```

## 任务 5：实现基准、校准和 Ed25519 签署工具

**文件：**
- 创建：`workers/redraw-locale-verifier/scripts/benchmark.py`
- 创建：`workers/redraw-locale-verifier/scripts/calibrate.py`
- 创建：`workers/redraw-locale-verifier/tests/test_calibration.py`
- 创建：`workers/redraw-locale-verifier/tests/fixtures/synthetic-index.json`
- 创建：`backend-node/scripts/sign-redraw-locale-manifest.js`
- 创建：`backend-node/test/redrawLocaleManifestSigning.test.js`

- [ ] **步骤 1：编写失败的校准门禁测试**

```python
def test_calibration_rejects_overlap_and_far_over_one_percent(self):
    with self.assertRaisesRegex(CalibrationError, "CALIBRATION_SPLIT_INVALID"):
        calibrate(self.rows_with_duplicate_audio_hash)
    with self.assertRaisesRegex(CalibrationError, "CALIBRATION_FALSE_ACCEPT_RATE_TOO_HIGH"):
        calibrate(self.rows_with_two_false_accepts_in_one_hundred_negatives)
```

Node 签名测试生成临时 Ed25519 keypair，签名后验证成功，修改一个阈值后验证失败。

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
$env:PYTHONPATH='workers/redraw-locale-verifier/src'
python -m unittest discover workers/redraw-locale-verifier/tests -p 'test_calibration.py' -v
Push-Location backend-node
node --test test/redrawLocaleManifestSigning.test.js
Pop-Location
```

预期：FAIL，缺少校准器和签名脚本。

- [ ] **步骤 3：实现确定性校准与签名**

校准 CSV 必须包含：`audio_path,audio_sha256,approved_text,expected_language,expected_accent,split`。
`split` 只能是 `tune` 或 `eval`；同一 audio hash 不得跨 split。阈值只从 tune 集搜索，eval 集只验证。
最终 manifest 必须含样本计数、规范化版本、四个阈值、eval FAR/FRR、三个 model revision/tree hash。

签名脚本使用 Node 内置 crypto：

```js
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

const payload = Buffer.from(JSON.stringify(canonicalize(manifest)), 'utf8');
const signature = crypto.sign(null, payload, fs.readFileSync(privateKeyPath));
fs.writeFileSync(signaturePath, signature.toString('base64') + '\n', { mode: 0o600 });
```

私钥路径只从 CLI 参数读取，禁止把私钥或内容写入日志、manifest 或仓库。

- [ ] **步骤 4：运行校准/签名测试与 synthetic benchmark**

运行：

```bash
PYTHONPATH=workers/redraw-locale-verifier/src \
python3.12 -m unittest discover workers/redraw-locale-verifier/tests -p 'test_calibration.py' -v
cd backend-node && node --test test/redrawLocaleManifestSigning.test.js
python3.12 workers/redraw-locale-verifier/scripts/benchmark.py \
  --fixture workers/redraw-locale-verifier/tests/fixtures/synthetic-index.json \
  --output /tmp/redraw-locale-benchmark.json
```

预期：PASS；synthetic benchmark 输出 schema、p50/p95/max、peak_rss_bytes、cpu_seconds 和失败计数。

- [ ] **步骤 5：Commit**

```bash
git add workers/redraw-locale-verifier/scripts workers/redraw-locale-verifier/tests/test_calibration.py \
  backend-node/scripts/sign-redraw-locale-manifest.js \
  backend-node/test/redrawLocaleManifestSigning.test.js
git commit -m "feat: 增加语言模型基准与校准工具"
```

## 任务 6：实现 Node 签名语言包 registry 与有界 socket 客户端

**文件：**
- 创建：`backend-node/src/services/redrawLocalePackRegistry.js`
- 创建：`backend-node/src/services/redrawLocaleVerifierClient.js`
- 创建：`backend-node/test/redrawLocalePackRegistry.test.js`
- 创建：`backend-node/test/redrawLocaleVerifierClient.test.js`

- [ ] **步骤 1：编写失败的签名、ready 和 socket 测试**

```js
test('registry rejects an expired or hash-mismatched ready attestation', () => {
  const registry = createRegistry(validFixture({ expires_at: 1 }));
  assert.throws(() => registry.assertReady('en-US'), { code: 'REDRAW_LOCALE_VERIFIER_NOT_READY' });
});

test('client rejects response hash drift and oversized bodies', async () => {
  await assert.rejects(client.verify(validRequest()), { code: 'REDRAW_LOCALE_EVIDENCE_INVALID' });
  assert.equal(server.requestCount, 1);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
Push-Location backend-node
node --test test/redrawLocalePackRegistry.test.js test/redrawLocaleVerifierClient.test.js
Pop-Location
```

预期：FAIL，两个 service 模块不存在。

- [ ] **步骤 3：实现 registry 和 client**

```js
function assertReady(locale) {
  const pack = requireEnabledPack(locale);
  const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
  if (Number(ready.expires_at) <= now() / 1000
    || ready.locale_pack !== pack.id
    || ready.model_manifest_sha256 !== pack.model_manifest_sha256
    || ready.calibration_manifest_sha256 !== pack.calibration_manifest_sha256) {
    throw codedError('REDRAW_LOCALE_VERIFIER_NOT_READY', '语言验证 Worker 未就绪');
  }
  return pack;
}
```

registry 对 canonical JSON 使用 `crypto.verify(null, payload, publicKey, signature)`；只允许 `en-US@1`。
client 使用 `node:net`，请求/响应各一行 JSON，180 秒总 deadline，64 KiB 请求和 256 KiB 响应上限，
禁止 retry。`assertReady()` 还要验证 ready PID 存活且 socket 是 Unix socket。响应的 request id、
audio hash、模型 hash、manifest hash 任一不匹配即拒绝。关闭 feature 时注入一个稳定抛出
`REDRAW_LOCALE_VERIFIER_DISABLED` 的 verifier，不能回退到 TTS 自报字段。

只有 client 负责把 Node 内部 camelCase 转为 Worker 协议 snake_case，映射固定为：
`requestId -> request_id`、`audioPath -> audio_path`、`approvedText -> approved_text`、
`locale -> locale_pack`（先由 registry 解析成精确 pack id）、`ttsInvocation -> tts_invocation`。
client 在发请求前流式计算文件 SHA-256 写入 `audio_sha256`；Worker 规范化前重新计算源文件 hash，二者
不一致即拒绝，不能使用响应值覆盖请求 hash。
业务 service 不得直接拼 Worker JSON；client 收到响应后也只返回经过 schema、hash 和签名上下文校验的
camelCase 对象，避免两套字段名在调用链中漂移。

- [ ] **步骤 4：运行 Node 单测**

运行：

```powershell
Push-Location backend-node
node --test test/redrawLocalePackRegistry.test.js test/redrawLocaleVerifierClient.test.js
Pop-Location
```

预期：PASS；timeout、close-before-newline、invalid JSON、oversize 都只提交一次并返回稳定错误码。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/src/services/redrawLocalePackRegistry.js \
  backend-node/src/services/redrawLocaleVerifierClient.js \
  backend-node/test/redrawLocalePackRegistry.test.js \
  backend-node/test/redrawLocaleVerifierClient.test.js
git commit -m "feat: 增加转绘语言包验证客户端"
```

## 任务 7：接入生产预检和配置文档

**文件：**
- 修改：`backend-node/src/services/productionPreflightService.js:28-147`
- 修改：`backend-node/scripts/preproduction-check.js`
- 修改：`backend-node/package.json`
- 修改：`backend-node/test/productionPreflight.test.js`
- 修改：`.env.production.example`
- 修改：`PUBLIC_PLATFORM_SETUP.md`
- 修改：`docs/WEB_PRODUCTION_DEPLOYMENT.md`

- [ ] **步骤 1：编写失败的 disabled/required/mismatch 预检测试**

```js
test('production preflight allows a disabled verifier but blocks an enabled stale attestation', () => {
  const disabled = runProductionPreflight({ config, env: env({ REDRAW_LOCALE_VERIFIER_ENABLED: 'false' }), db });
  assert.equal(check(disabled, 'redraw_locale_verifier').status, 'pass');
  const enabled = runProductionPreflight({
    config,
    env: env({ REDRAW_LOCALE_VERIFIER_ENABLED: 'true' }),
    db,
    localeRegistry: registryWithExpiredReady(),
  });
  assert.equal(check(enabled, 'redraw_locale_verifier').status, 'fail');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
Push-Location backend-node
node --test test/productionPreflight.test.js
Pop-Location
```

预期：FAIL，report 没有 `redraw_locale_verifier` check。

- [ ] **步骤 3：实现配置和预检**

新增环境变量：

```dotenv
REDRAW_LOCALE_VERIFIER_ENABLED=false
REDRAW_LOCALE_VERIFIER_SOCKET=/run/moli-drama/redraw-locale-verifier.sock
REDRAW_LOCALE_VERIFIER_READY_PATH=/run/moli-drama/redraw-locale-verifier.ready.json
REDRAW_LOCALE_PACK_REGISTRY_PATH=/opt/moli-drama/shared/redraw-locale-verifier/manifests/enabled-packs.json
REDRAW_LOCALE_PACK_SIGNATURE_PATH=/opt/moli-drama/shared/redraw-locale-verifier/manifests/enabled-packs.sig
REDRAW_LOCALE_PACK_PUBLIC_KEY_PATH=/opt/moli-drama/shared/redraw-locale-verifier/manifests/ed25519-public.pem
REDRAW_LOCALE_VERIFIER_TIMEOUT_MS=180000
```

关闭态只代表生产音色功能不可用，不阻断平台其他业务；启用态必须通过签名、路径、hash、ready 时效和
socket 类型检查。`npm run preflight:redraw-locale` 只读执行 registry `assertReady('en-US')` 并输出 JSON。

- [ ] **步骤 4：运行预检与既有生产合同测试**

运行：

```powershell
Push-Location backend-node
node --test test/productionPreflight.test.js test/webProductionDeploymentContract.test.js
node --check scripts/preproduction-check.js
Pop-Location
```

预期：测试 PASS；脚本语法检查 exit 0，失败报告测试不泄露路径内容、私钥或完整 manifest。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/src/services/productionPreflightService.js \
  backend-node/scripts/preproduction-check.js backend-node/package.json \
  backend-node/test/productionPreflight.test.js .env.production.example \
  PUBLIC_PLATFORM_SETUP.md docs/WEB_PRODUCTION_DEPLOYMENT.md
git commit -m "feat: 增加语言验证生产预检"
```

## 任务 8：在 voice/dialogue 供应商适配器中执行真实输出验证

**文件：**
- 修改：`backend-node/src/routes/index.js:221-267`
- 修改：`backend-node/src/services/redrawProviderAdapters.js:371-377,580-712,752-856`
- 修改：`backend-node/test/redrawProviderAdapters.test.js`
- 修改：`backend-node/test/redrawVoiceAssetIntegration.test.js`

- [ ] **步骤 1：编写失败的供应商前 ready 和供应商后 evidence 测试**

```js
test('voice adapter never trusts TTS detected_locale and uses worker evidence', async () => {
  const result = await adapters.generateAsset(voiceRequest({ ttsDetectedLocale: 'en-US' }));
  assert.equal(result.voice_evidence.detected_locale, 'en-US');
  assert.equal(result.voice_evidence.locale_verification.source, 'offline-worker');
  assert.equal(verifier.verifyCalls, 1);
});

test('worker failure after TTS is provider-completed unknown', async () => {
  await assert.rejects(adapters.generateAsset(voiceRequest()), (error) =>
    error.code === 'REDRAW_LOCALE_VERIFY_UNKNOWN' && error.provider_completed === true);
  assert.equal(ttsCalls, 1);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
Push-Location backend-node
node --test test/redrawProviderAdapters.test.js test/redrawVoiceAssetIntegration.test.js
Pop-Location
```

预期：FAIL，adapter 仍读取 TTS 的 `language_verified/detected_locale`。

- [ ] **步骤 3：注入 verifier 并替换证据来源**

`routes/index.js` 创建单例 registry/client 后，通过 `createRedrawProviderAdapters({ localeVerifier })` 注入。
voice 和 dialogue 在 `ttsService.synthesize()` 前调用 `localeVerifier.assertReady(locale)`；TTS 完成、路径和时长
验证后调用：

```js
const localeEvidence = await localeVerifier.verify({
  requestId: `${normalized.taskId}:locale`,
  audioPath: absolutePath,
  approvedText: text,
  locale: normalized.locale,
  ttsInvocation: {
    provider: actualProvider,
    model,
    ai_service_config_id: Number(config.id),
    config_updated_at: String(config.updated_at),
    provider_task_id: providerTaskId,
  },
});
```

adapter 必须删除从 TTS result 推导 `languageVerified/detectedLocale` 的逻辑。Worker 未验证、超时、hash
漂移或 socket 断开，都包装为 `providerCompletedError`；不得删除已生成音频或退款。

- [ ] **步骤 4：运行 adapter/真实 shape 回归**

运行：

```powershell
Push-Location backend-node
node --test test/minimaxTtsService.test.js test/redrawProviderAdapters.test.js \
  test/redrawVoiceAssetIntegration.test.js
Pop-Location
```

预期：PASS；MiniMax 原始返回继续保持 `language_verified=false`，最终 verified evidence 仅来自 Worker。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/src/routes/index.js \
  backend-node/src/services/redrawProviderAdapters.js \
  backend-node/test/redrawProviderAdapters.test.js \
  backend-node/test/redrawVoiceAssetIntegration.test.js
git commit -m "feat: 验证转绘语音实际语言输出"
```

## 任务 9：在报价、冻结与提交前 fail closed

**文件：**
- 修改：`backend-node/src/routes/redraw.js:1027-1053,2082-2191`
- 修改：`backend-node/src/services/redrawAssetBatchService.js:282-325`
- 修改：`backend-node/src/services/redrawVoiceService.js:274-353`
- 修改：`backend-node/src/services/redrawDialogueService.js:542-591`
- 修改：`backend-node/test/redrawAssetBatch.test.js`
- 修改：`backend-node/test/redrawAssets.test.js`
- 修改：`backend-node/test/redrawDialogue.test.js`
- 修改：`backend-node/test/redrawRoutes.test.js`

- [ ] **步骤 1：编写失败测试，证明未就绪时零冻结零供应商调用**

```js
test('voice quote fails before reserve when en-US worker is not ready', async () => {
  const quote = await quoteAssetBatch(context({ localeVerifier: notReadyVerifier() }), voiceInput());
  assert.equal(quote.priced, false);
  assert.equal(quote.blocked[0].code, 'REDRAW_LOCALE_VERIFIER_NOT_READY');
  assert.equal(reservationCount(db), 0);
});

test('revoked ready attestation between reserve and provider refunds with zero provider calls', async () => {
  const result = await startWithBeforeProviderReadyFailure();
  assert.equal(result.status, 'failed');
  assert.equal(providerCalls, 0);
  assert.equal(reservationStatus(db), 'refunded');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
Push-Location backend-node
node --test test/redrawAssetBatch.test.js test/redrawAssets.test.js \
  test/redrawDialogue.test.js test/redrawRoutes.test.js
Pop-Location
```

预期：FAIL，报价和 dialogue plan 未检查 locale verifier。

- [ ] **步骤 3：接入同步 ready 门禁并绑定 quote hash**

`rowToItem()` 对 `capabilityName === 'tts'` 调用 `ctx.localeVerifier.assertReady(version.locale)`，并把以下
字段写入 server-derived item 和 quote hash：

```js
locale_pack: pack.id,
model_manifest_sha256: pack.model_manifest_sha256,
calibration_manifest_sha256: pack.calibration_manifest_sha256,
```

single voice 继续复用 batch 单项报价，不能绕过。`validateTtsBatch()` 和 dialogue quote 也必须调用同一
ready gate。provider adapter 紧前再校验一次；紧前校验的确定性失败发生在网络调用前，退款并记录
`providerCalls=0`，不进入 held。

- [ ] **步骤 4：运行计费、防重和路由组合测试**

运行：

```powershell
Push-Location backend-node
node --test test/redrawAssetBatch.test.js test/redrawAssets.test.js \
  test/redrawDialogue.test.js test/redrawDialogueOrchestrator.test.js \
  test/redrawRoutes.test.js
Pop-Location
```

预期：PASS；ready 在 GET quote 与 POST start 间改变会导致 quote hash 冲突或零 provider 的明确失败。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/src/routes/redraw.js \
  backend-node/src/services/redrawAssetBatchService.js \
  backend-node/src/services/redrawVoiceService.js \
  backend-node/src/services/redrawDialogueService.js \
  backend-node/test/redrawAssetBatch.test.js backend-node/test/redrawAssets.test.js \
  backend-node/test/redrawDialogue.test.js backend-node/test/redrawRoutes.test.js
git commit -m "fix: 在语音计费前校验语言 worker"
```

## 任务 10：固化 voice evidence、列表绑定和 dialogue 审计

**文件：**
- 修改：`backend-node/src/services/redrawAssetService.js:484-673`
- 修改：`backend-node/src/services/redrawVoiceService.js:21-272`
- 修改：`backend-node/src/services/redrawDialogueService.js:59-60,641-675`
- 修改：`backend-node/test/redrawVoices.test.js`
- 修改：`backend-node/test/redrawVoices.routes.test.js`
- 修改：`backend-node/test/redrawDialogue.test.js`
- 修改：`backend-node/test/redrawDialogueOrchestrator.test.js`

- [ ] **步骤 1：编写失败的历史 evidence 和 held 状态测试**

```js
test('voice evidence without exact worker model and calibration hashes is not production-ready', () => {
  const result = finalizeVoice(providerResult({ locale_verification: null }));
  assert.equal(result.status, 'needs_attention');
  assert.equal(reservationStatus(db), 'held');
});

test('disabled pack hides an old voice and blocks dialogue without provider replay', async () => {
  assert.deepEqual(listProductionVoices(contextWithDisabledPack()), []);
  const plan = buildDialoguePlan(contextWithDisabledPack());
  assert.equal(plan.status, 'needs_rewrite');
  assert.equal(providerCalls, 0);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
Push-Location backend-node
node --test test/redrawVoices.test.js test/redrawVoices.routes.test.js \
  test/redrawDialogue.test.js test/redrawDialogueOrchestrator.test.js
Pop-Location
```

预期：FAIL，现有 evidence 没有 locale pack/model/calibration hash 强校验。

- [ ] **步骤 3：扩展并严格验证 evidence**

`verifiedVoiceEvidence()` 只有在以下字段全部存在且与 registry/音频/配置一致时返回证据：

```js
locale_verification: {
  source: 'offline-worker',
  locale_pack: 'en-US@1',
  audio_sha256: worker.audio_sha256,
  transcript_sha256: worker.transcript_sha256,
  model_manifest_sha256: worker.model_manifest_sha256,
  calibration_manifest_sha256: worker.calibration_manifest_sha256,
  asr_revision: worker.models.asr_revision,
  accent_revision: worker.models.accent_revision,
  metrics: worker.metrics,
  completed_at: worker.completed_at,
},
```

`redrawVoiceService` 的 normalize/sameEvidence 必须保留并比较完整对象。list、bind、preview、
`validateTtsBatch` 都调用 `localeRegistry.assertEvidenceTrusted(evidence)`。dialogue segment audit 和 audio
asset metadata 保留相同 evidence；Worker/post-provider 本地异常仍为 `needs_attention + held`，跨 key
不得再次提交。

- [ ] **步骤 4：运行 voice/dialogue 全组**

运行：

```powershell
Push-Location backend-node
node --test test/redrawVoices.test.js test/redrawVoices.routes.test.js \
  test/redrawVoiceAssetIntegration.test.js test/redrawAssetBatch.test.js \
  test/redrawAssets.test.js test/redrawDialogue.test.js \
  test/redrawDialogueOrchestrator.test.js test/redrawProviderAdapters.test.js
Pop-Location
```

预期：PASS；缺任何 Worker 字段都不可列、不可绑、不可对白，并且不会形成 completed/charged 假阳性。

- [ ] **步骤 5：Commit**

```bash
git add backend-node/src/services/redrawAssetService.js \
  backend-node/src/services/redrawVoiceService.js \
  backend-node/src/services/redrawDialogueService.js \
  backend-node/test/redrawVoices.test.js backend-node/test/redrawVoices.routes.test.js \
  backend-node/test/redrawDialogue.test.js backend-node/test/redrawDialogueOrchestrator.test.js
git commit -m "fix: 绑定转绘音色离线验证证据"
```

## 任务 11：增加 systemd 沙箱和受保护发布材料

**文件：**
- 创建：`deploy/redraw-locale-verifier/moli-redraw-locale-verifier.service`
- 创建：`deploy/redraw-locale-verifier/README.md`
- 创建：`deploy/release-scopes/redraw-locale-verifier.json`
- 修改：`backend-node/test/webProductionDeploymentContract.test.js`

- [ ] **步骤 1：编写失败的部署合同测试**

```js
test('locale verifier unit is single-process offline and resource bounded', () => {
  const unit = fs.readFileSync(unitPath, 'utf8');
  assert.match(unit, /MemoryMax=5G/);
  assert.match(unit, /CPUQuota=300%/);
  assert.match(unit, /PrivateNetwork=true/);
  assert.match(unit, /RestrictAddressFamilies=AF_UNIX/);
  assert.doesNotMatch(unit, /https?:\/\//);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
Push-Location backend-node
node --test test/webProductionDeploymentContract.test.js
Pop-Location
```

预期：FAIL，systemd unit 不存在。

- [ ] **步骤 3：编写最小安全 unit 和 runbook**

unit 的核心配置必须是：

```ini
[Service]
Type=simple
User=moli-drama
Group=moli-drama
Environment=HF_HUB_OFFLINE=1
Environment=TRANSFORMERS_OFFLINE=1
ExecStart=/opt/moli-drama/shared/redraw-locale-verifier/venv/bin/python -m redraw_locale_worker.server
Restart=on-failure
RestartSec=5
MemoryMax=5G
CPUQuota=300%
TasksMax=64
PrivateNetwork=true
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_UNIX
ReadWritePaths=/run/moli-drama /var/tmp/moli-redraw-locale
UMask=0077
```

runbook 明确：模型和 venv 只在共享 verifier 目录安装；release 只带源码、unit 和清单；先基准、再签名、
再 disabled 部署、再另行批准 paid canary。release scope 罗列本计划全部变更文件，不允许
`/opt/moli-drama/shared/release-guard` 的任何文件。

- [ ] **步骤 4：运行部署合同和 scope 审计器测试**

运行：

```powershell
Push-Location backend-node
node --test test/webProductionDeploymentContract.test.js test/incrementalReleaseScope.test.js
Pop-Location
```

预期：PASS；白名单没有密钥、模型权重、venv、生产 DB、current symlink 或共享 release guard。

- [ ] **步骤 5：Commit**

```bash
git add deploy/redraw-locale-verifier deploy/release-scopes/redraw-locale-verifier.json \
  backend-node/test/webProductionDeploymentContract.test.js
git commit -m "ops: 增加语言验证 worker 沙箱"
```

## 任务 12：完整本地回归、目标机基准与付费验收关卡

**文件：**
- 修改：`deploy/redraw-locale-verifier/README.md`
- 创建：`docs/superpowers/reports/2026-08-08-redraw-locale-worker-gate.md`

- [ ] **步骤 1：运行全部 Worker 单测和静态检查**

运行：

```bash
PYTHONPATH=workers/redraw-locale-verifier/src \
python3.12 -m unittest discover -s workers/redraw-locale-verifier/tests -v
python3.12 -m compileall -q workers/redraw-locale-verifier/src workers/redraw-locale-verifier/scripts
```

预期：全部 PASS，compileall exit 0。

- [ ] **步骤 2：运行后端目标组和完整回归**

运行：

```powershell
Push-Location backend-node
node --test test/redrawLocaleManifestSigning.test.js \
  test/redrawLocalePackRegistry.test.js test/redrawLocaleVerifierClient.test.js \
  test/minimaxTtsService.test.js test/productionPreflight.test.js \
  test/redrawProviderAdapters.test.js test/redrawVoiceAssetIntegration.test.js \
  test/redrawVoices.test.js test/redrawVoices.routes.test.js \
  test/redrawAssetBatch.test.js test/redrawAssets.test.js \
  test/redrawDialogue.test.js test/redrawDialogueOrchestrator.test.js \
  test/redrawRoutes.test.js test/webProductionDeploymentContract.test.js
npm test
Pop-Location
```

预期：目标组和 `npm test` 全部 PASS，进程无 open handle。

- [ ] **步骤 3：在目标机隔离目录执行性能基准，不接业务流量**

运行位置必须是 `/home/ubuntu/moli-redraw-locale-benchmark-<run>`，不得写 `/opt/moli-drama/current`、
生产 DB 或 storage。使用至少 30 条、五个时长档位各至少 6 条授权音频：

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
python workers/redraw-locale-verifier/scripts/benchmark.py \
  --fixture benchmark-index.json \
  --output benchmark-result.json
```

预期门禁：peak RSS ≤ 4.5 GiB；系统可用内存始终 ≥ 1.5 GiB；15 秒热运行 p95 ≤ 90 秒；
`moli-drama.service` 无重启。未达标即停止本机方案。

- [ ] **步骤 4：完成独立准确率校准和签名**

使用不少于 200 条、tune/eval 不重叠的授权标注音频生成 manifest。eval 非 US 误接受率必须 ≤ 1%；
失败则不启用 `en-US@1`。签名命令：

```bash
node backend-node/scripts/sign-redraw-locale-manifest.js \
  --manifest calibration-en-US-1.json \
  --private-key /secure/offline/ed25519-private.pem \
  --signature calibration-en-US-1.sig
```

预期：公钥验证成功；修改 manifest 任意字节后验证失败；私钥未进入 release 或日志。

- [ ] **步骤 5：写入 gate 报告并 Commit**

报告必须记录：commit、依赖 lock SHA-256、三个模型 revision/tree hash、校准 manifest/signature hash、
样本计数、FAR/FRR、延迟/RSS、测试命令和退出码；不记录音频、台词、密钥或私钥路径内容。

```bash
git add deploy/redraw-locale-verifier/README.md \
  docs/superpowers/reports/2026-08-08-redraw-locale-worker-gate.md
git commit -m "docs: 记录语言验证 worker 门禁"
```

- [ ] **步骤 6：停在生产与付费批准关卡**

只有以上所有门禁通过后，另行向用户报告：实时 current、候选路径、release scope hash、共享门禁结果、
Worker 基准、校准结果和预计付费积分。没有新的明确批准，不安装生产 Worker、不重启服务、不写能力
evidence、不切 current、不调用 TTS。批准后的真实 canary 仍必须验证可播放音频、Worker evidence、
积分、任务状态、预览、绑定和跨 key 防重全链。

## 规格覆盖自检映射

- 隔离 Worker、单并发、离线与资源限制：任务 1、3、4、11、12。
- ASR、台词一致性、US 口音联合判定：任务 2、3、5。
- 模型/校准 hash、签名和历史 evidence：任务 1、5、6、10。
- reserve/TTS 前 fail closed：任务 7、8、9。
- post-provider `needs_attention + held`、禁止重提：任务 8、9、10。
- voice 列表、绑定和 dialogue audit：任务 10。
- 目标机 30 条性能基准和 200 条独立校准：任务 5、12。
- 多语言扩展边界：registry 接口支持语言包，但本计划只允许 `en-US@1`；新增语言必须另开规格和计划。
- 生产发布与真实付费验收边界：任务 11、12，且保留独立人工批准关卡。
