# 全帧审核 PaddleOCR 进程隔离实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 PaddleOCR text detection 隔离到同一虚拟环境的常驻本地子进程，消除 Torch/YOLOX 与 PaddlePaddle 的 OpenMP 进程内冲突，并保持外层全帧审核协议不变。

**架构：** Node.js 仍只启动主 Python worker。主 worker 加载 YOLOX、ByteTrack 和 MediaPipe，并通过固定 JSONL 协议管理只加载 PaddleOCR detection 的同环境子进程；主 worker 校验、合并文字多边形并负责超时和关闭。模型 bootstrap 使用本地生成的无敏感探针帧真实运行 4 个组件，任何失败都阻止模型缓存发布。

**技术栈：** Python 3.12 标准库、`subprocess.Popen`、`threading`、`queue`、JSONL、YOLOX、ByteTrack、MediaPipe、PaddleOCR、Node.js 20、`node:test`、`unittest`、SHA-256。

---

## 文件职责

- 创建：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_worker.py`：PaddleOCR 专用内部 CLI、严格 JSONL 协议和文字 detection 执行。
- 创建：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_subprocess.py`：主 worker 侧的安全环境、常驻子进程、超时、输出上限和关闭生命周期。
- 创建：`workers/redraw-full-frame-auditor/tests/test_text_worker.py`：Paddle 内部 CLI 协议、OCR/路径字段拒绝和稳定错误码测试。
- 创建：`workers/redraw-full-frame-auditor/tests/test_text_subprocess.py`：命令、环境、握手、请求响应、超时、EPIPE 和关闭测试。
- 修改：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py`：默认 detector 组装改用文字子进程，bootstrap 执行真实无敏感探针，并在 `finally` 关闭子进程。
- 修改：`workers/redraw-full-frame-auditor/tests/test_worker.py`：默认主进程不调用 Paddle 工厂、bootstrap 探针和 close 回归。
- 修改：`backend-node/test/redrawFullFrameDetectorProcess.test.js`：模型 bootstrap 失败路径的稳定错误码与脱敏回归。

实现不得修改外层 `redrawFullFrameDetectorProcess.js` API、coverage schema、review decisions schema、供应商适配器、数据库或部署文件。

### 任务 1：实现 Paddle 专用内部 JSONL worker

**文件：**

- 创建：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_worker.py`
- 创建：`workers/redraw-full-frame-auditor/tests/test_text_worker.py`
- 复用：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py` 中的 `_validate_model_lock`、`PaddleTextDetectionAdapter`、`_default_text_detector_factory` 和 `_text_candidate`

- [ ] **步骤 1：编写严格协议红灯测试**

在 `test_text_worker.py` 中创建 fake detector，并覆盖成功、输入白名单和输出白名单：

```python
import io
import json
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from redraw_full_frame_auditor import text_worker


class FakeTextDetector:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def detect_regions(self, frame_path):
        self.calls.append(frame_path)
        return json.loads(json.dumps(self.result))


class TextWorkerTests(unittest.TestCase):
    def test_run_text_jsonl_emits_handshake_and_exact_response(self):
        detector = FakeTextDetector([{
            "candidate_id": "text_1",
            "kind": "text_candidate",
            "polygon": [
                {"x": 1, "y": 2},
                {"x": 4, "y": 2},
                {"x": 4, "y": 5},
            ],
            "confidence": 0.9,
        }])
        stdout = io.StringIO()
        code = text_worker.run_text_jsonl(
            detector=detector,
            stdin=io.StringIO('{"request_id":1,"frame_path":"D:/redraw-local/frame.png"}\n'),
            stdout=stdout,
            stderr=io.StringIO(),
        )
        lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(code, 0)
        self.assertEqual(lines[0], {
            "status": "ok",
            "schema_version": "redraw-full-frame-text-subprocess-v1",
        })
        self.assertEqual(lines[1]["request_id"], 1)
        self.assertEqual(lines[1]["texts"][0]["candidate_id"], "text_1")
        self.assertEqual(detector.calls, ["D:/redraw-local/frame.png"])

    def test_run_text_jsonl_rejects_unknown_input_and_ocr_output(self):
        invalid_inputs = [
            '{"request_id":1,"frame_path":"D:/redraw-local/frame.png","extra":true}\n',
            '{"request_id":0,"frame_path":"D:/redraw-local/frame.png"}\n',
            '{"request_id":1,"frame_path":""}\n',
        ]
        for payload in invalid_inputs:
            with self.subTest(payload=payload):
                self.assertNotEqual(text_worker.run_text_jsonl(
                    detector=FakeTextDetector([]),
                    stdin=io.StringIO(payload),
                    stdout=io.StringIO(),
                    stderr=io.StringIO(),
                ), 0)

        for forbidden_key in ("text", "ocr_text", "recognized_text", "frame_path"):
            with self.subTest(forbidden_key=forbidden_key):
                item = {
                    "candidate_id": "text_1",
                    "kind": "text_candidate",
                    "polygon": [{"x": 1, "y": 2}, {"x": 4, "y": 2}, {"x": 4, "y": 5}],
                    "confidence": 0.9,
                    forbidden_key: "forbidden",
                }
                stderr = io.StringIO()
                code = text_worker.run_text_jsonl(
                    detector=FakeTextDetector([item]),
                    stdin=io.StringIO('{"request_id":1,"frame_path":"D:/redraw-local/frame.png"}\n'),
                    stdout=io.StringIO(),
                    stderr=stderr,
                )
                self.assertNotEqual(code, 0)
                self.assertEqual(stderr.getvalue(), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
```

- [ ] **步骤 2：运行测试确认红灯**

运行：

```powershell
& $env:REDRAW_AUDITOR_PYTHON -m unittest workers/redraw-full-frame-auditor/tests/test_text_worker.py -v
```

预期：FAIL，原因是 `redraw_full_frame_auditor.text_worker` 尚不存在。

- [ ] **步骤 3：实现最小内部 CLI 与协议**

创建 `text_worker.py`，只在 `load_detector()` 中调用现有 Paddle 工厂：

```python
import argparse
import contextlib
import json
import os
import sys

if __package__:
    from . import worker as audit_worker
else:
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import worker as audit_worker


TEXT_SCHEMA = "redraw-full-frame-text-subprocess-v1"
ERROR_CODE = audit_worker.ERROR_CODE
MAX_REQUEST_ID = 9007199254740991
MAX_MODEL_LOG_CHARS = 1024 * 1024


def _fail():
    raise audit_worker.ProtocolError(ERROR_CODE)


class _BoundedDiscard:
    def __init__(self):
        self.count = 0

    def write(self, value):
        if not isinstance(value, str):
            _fail()
        self.count += len(value.encode("utf-8"))
        if self.count > MAX_MODEL_LOG_CHARS:
            _fail()
        return len(value)

    def flush(self):
        return None


@contextlib.contextmanager
def _discard_model_logs():
    sink = _BoundedDiscard()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        yield


def _request(value, expected_request_id):
    audit_worker._exact_keys(value, ("request_id", "frame_path"))
    request_id = value["request_id"]
    if (not isinstance(request_id, int) or isinstance(request_id, bool)
            or request_id < 1 or request_id > MAX_REQUEST_ID
            or request_id != expected_request_id):
        _fail()
    frame_path = value["frame_path"]
    if not isinstance(frame_path, str) or not frame_path:
        _fail()
    return request_id, frame_path


def load_detector(model_lock_path):
    _lock, components = audit_worker._validate_model_lock(model_lock_path)
    return audit_worker.PaddleTextDetectionAdapter(
        components["text_detector"]["artifact_abs_path"],
        audit_worker._default_text_detector_factory,
    )


def run_text_jsonl(detector, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr):
    try:
        stdout.write(json.dumps({
            "status": "ok",
            "schema_version": TEXT_SCHEMA,
        }, separators=(",", ":")) + "\n")
        stdout.flush()
        expected_request_id = 1
        for line in stdin:
            if not line.endswith("\n") or not line.strip():
                _fail()
            request = json.loads(line)
            request_id, frame_path = _request(request, expected_request_id)
            with _discard_model_logs():
                texts = detector.detect_regions(frame_path)
            if not isinstance(texts, list):
                _fail()
            sanitized = [audit_worker._text_candidate(item) for item in texts]
            stdout.write(json.dumps({
                "request_id": request_id,
                "texts": sanitized,
            }, separators=(",", ":"), ensure_ascii=True) + "\n")
            stdout.flush()
            expected_request_id += 1
        return 0
    except Exception:
        stderr.write(ERROR_CODE + "\n")
        stderr.flush()
        return 1


def parse_args(argv):
    parser = audit_worker.SafeArgumentParser(prog="redraw-full-frame-text-worker")
    parser.add_argument("command", choices=("run",))
    parser.add_argument("--model-lock", required=True)
    return parser.parse_args(argv)


def main(argv=None):
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        with _discard_model_logs():
            detector = load_detector(args.model_lock)
        return run_text_jsonl(detector)
    except Exception:
        sys.stderr.write(ERROR_CODE + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

实现中不得初始化 PaddleOCR recognition。增加 `_BoundedDiscard.write()` 和 `_discard_model_logs()`，累计超过 1 MiB 即 `_fail()`；模型加载以及 `detector.detect_regions(frame_path)` 都必须在该上下文中运行。Paddle 原生 stderr 由父进程持续排空但不转发，协议 stdout 只能包含握手和响应 JSONL。

- [ ] **步骤 4：补齐 CLI 和模型锁失败测试并跑绿灯**

新增断言：

```python
def test_cli_rejects_unknown_args_with_stable_error(self):
    import contextlib

    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        self.assertNotEqual(text_worker.main(["run", "--unknown"]), 0)
    self.assertEqual(stderr.getvalue(), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")

def test_load_detector_uses_only_text_component(self):
    events = []
    original_validate = text_worker.audit_worker._validate_model_lock
    original_factory = text_worker.audit_worker._default_text_detector_factory
    try:
        text_worker.audit_worker._validate_model_lock = lambda _path: ({}, {
            "text_detector": {"artifact_abs_path": "D:/models/text.tar"},
        })
        text_worker.audit_worker._default_text_detector_factory = lambda path: events.append(path) or object()
        detector = text_worker.load_detector("D:/models/model-lock.json")
        self.assertEqual(events, ["D:/models/text.tar"])
        self.assertIsNotNone(detector)
    finally:
        text_worker.audit_worker._validate_model_lock = original_validate
        text_worker.audit_worker._default_text_detector_factory = original_factory
```

另加以下用例，证明父进程管道 EOF 会让子进程自行结束，并拒绝不连续请求：

```python
def test_eof_exits_after_handshake_and_request_ids_must_be_contiguous(self):
    stdout = io.StringIO()
    self.assertEqual(text_worker.run_text_jsonl(
        detector=FakeTextDetector([]),
        stdin=io.StringIO(""),
        stdout=stdout,
        stderr=io.StringIO(),
    ), 0)
    self.assertEqual(len(stdout.getvalue().splitlines()), 1)

    stderr = io.StringIO()
    code = text_worker.run_text_jsonl(
        detector=FakeTextDetector([]),
        stdin=io.StringIO(
            '{"request_id":1,"frame_path":"D:/redraw-local/frame-1.png"}\n'
            '{"request_id":3,"frame_path":"D:/redraw-local/frame-3.png"}\n'
        ),
        stdout=io.StringIO(),
        stderr=stderr,
    )
    self.assertNotEqual(code, 0)
    self.assertEqual(stderr.getvalue(), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
```

运行：

```powershell
& $env:REDRAW_AUDITOR_PYTHON -m unittest workers/redraw-full-frame-auditor/tests/test_text_worker.py -v
& $env:REDRAW_AUDITOR_PYTHON -m py_compile workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_worker.py workers/redraw-full-frame-auditor/tests/test_text_worker.py
```

预期：全部 PASS，`py_compile` exit 0。

- [ ] **步骤 5：提交任务 1**

```powershell
git add workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_worker.py workers/redraw-full-frame-auditor/tests/test_text_worker.py
git commit -m "feat(转绘): 增加 Paddle 文字检测子进程协议"
```

### 任务 2：实现安全常驻子进程与生命周期

**文件：**

- 创建：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_subprocess.py`
- 创建：`workers/redraw-full-frame-auditor/tests/test_text_subprocess.py`

- [ ] **步骤 1：编写环境、命令和正常请求红灯测试**

使用可注入的 `process_factory`。fake process 必须记录 argv、env、stdin，并为 stdout 提供握手和响应：

```python
import io
import json
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from redraw_full_frame_auditor import text_subprocess


class FakeProcess:
    def __init__(self, stdout_lines, returncode=None):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(b"".join(stdout_lines))
        self.stderr = io.BytesIO(b"")
        self.returncode = returncode
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return 0

    def kill(self):
        self.killed = True
        self.returncode = -9


class TextSubprocessTests(unittest.TestCase):
    def test_adapter_uses_fixed_command_safe_env_and_exact_protocol(self):
        captured = {}
        process = FakeProcess([
            b'{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}\n',
            b'{"request_id":1,"texts":[]}\n',
        ])

        def factory(argv, **options):
            captured.update({"argv": argv, **options})
            return process

        adapter = text_subprocess.TextSubprocessAdapter(
            python_path="D:/venv/python.exe",
            text_worker_path="D:/worker/text_worker.py",
            model_lock_path="D:/models/model-lock.json",
            process_factory=factory,
            source_env={
                "PATH": "safe-path",
                "SystemRoot": "C:/Windows",
                "API_KEY": "forbidden",
                "Authorization": "forbidden",
                "HTTPS_PROXY": "forbidden",
                "PYTHONPATH": "forbidden",
                "KMP_DUPLICATE_LIB_OK": "TRUE",
            },
        )
        self.assertEqual(captured["argv"], [
            "D:/venv/python.exe",
            "D:/worker/text_worker.py",
            "run",
            "--model-lock",
            "D:/models/model-lock.json",
        ])
        self.assertEqual(sorted(captured["env"]), ["PATH", "PYTHONIOENCODING", "PYTHONUTF8", "SystemRoot"])
        self.assertEqual(adapter.detect_regions("D:/redraw-local/frame.png"), [])
        request = json.loads(process.stdin.getvalue().decode("utf-8").strip())
        self.assertEqual(request, {"request_id": 1, "frame_path": "D:/redraw-local/frame.png"})
        adapter.close()
```

- [ ] **步骤 2：运行测试确认红灯**

运行：

```powershell
& $env:REDRAW_AUDITOR_PYTHON -m unittest workers/redraw-full-frame-auditor/tests/test_text_subprocess.py -v
```

预期：FAIL，原因是 `redraw_full_frame_auditor.text_subprocess` 尚不存在。

- [ ] **步骤 3：实现固定环境、后台读取和同步请求**

创建 `text_subprocess.py`，锁定常量：启动 120 秒、单帧 60 秒、关闭 5 秒、单行 1 MiB、stderr 1 MiB。

```python
import json
import os
import queue
import subprocess
import threading


ERROR_CODE = "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE"
TEXT_SCHEMA = "redraw-full-frame-text-subprocess-v1"
START_TIMEOUT_SECONDS = 120
FRAME_TIMEOUT_SECONDS = 60
SHUTDOWN_TIMEOUT_SECONDS = 5
MAX_LINE_BYTES = 1024 * 1024
MAX_STDERR_BYTES = 1024 * 1024
ENV_ALLOWLIST = ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP")


class TextSubprocessError(Exception):
    pass


def safe_text_env(source_env=None):
    source = os.environ if source_env is None else source_env
    env = {key: source[key] for key in ENV_ALLOWLIST if isinstance(source.get(key), str)}
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


class TextSubprocessAdapter:
    def __init__(self, python_path, text_worker_path, model_lock_path,
                 process_factory=subprocess.Popen, source_env=None,
                 start_timeout=START_TIMEOUT_SECONDS,
                 frame_timeout=FRAME_TIMEOUT_SECONDS):
        self._queue = queue.Queue(maxsize=2)
        self._stderr_bytes = 0
        self._protocol_failed = threading.Event()
        self._request_id = 0
        self._frame_timeout = frame_timeout
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self._process = process_factory(
            [python_path, text_worker_path, "run", "--model-lock", model_lock_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=safe_text_env(source_env),
            shell=False,
            creationflags=creationflags,
        )
        self._stdout_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()
        handshake = self._next_message(start_timeout)
        if handshake != {"status": "ok", "schema_version": TEXT_SCHEMA}:
            self._abort()
            raise TextSubprocessError(ERROR_CODE)

    def _read_stdout(self):
        while True:
            line = self._process.stdout.readline(MAX_LINE_BYTES + 1)
            if not line:
                self._queue.put(None)
                return
            if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
                self._protocol_failed.set()
                self._queue.put(None)
                return
            try:
                self._queue.put(json.loads(line.decode("utf-8", errors="strict")))
            except Exception:
                self._protocol_failed.set()
                self._queue.put(None)
                return

    def _drain_stderr(self):
        for chunk in iter(lambda: self._process.stderr.read(65536), b""):
            self._stderr_bytes += len(chunk)
            if self._stderr_bytes > MAX_STDERR_BYTES:
                self._protocol_failed.set()
                self._abort()
                return

    def _next_message(self, timeout):
        try:
            message = self._queue.get(timeout=timeout)
        except queue.Empty as exc:
            self._abort()
            raise TextSubprocessError(ERROR_CODE) from exc
        if message is None or self._protocol_failed.is_set() or self._process.poll() is not None:
            self._abort()
            raise TextSubprocessError(ERROR_CODE)
        return message

    def detect_regions(self, frame_path):
        if not isinstance(frame_path, str) or not frame_path:
            raise TextSubprocessError(ERROR_CODE)
        self._request_id += 1
        payload = json.dumps({
            "request_id": self._request_id,
            "frame_path": frame_path,
        }, separators=(",", ":")).encode("utf-8") + b"\n"
        try:
            self._process.stdin.write(payload)
            self._process.stdin.flush()
        except Exception as exc:
            self._abort()
            raise TextSubprocessError(ERROR_CODE) from exc
        response = self._next_message(self._frame_timeout)
        if not isinstance(response, dict) or set(response) != {"request_id", "texts"}:
            self._abort()
            raise TextSubprocessError(ERROR_CODE)
        if response["request_id"] != self._request_id or not isinstance(response["texts"], list):
            self._abort()
            raise TextSubprocessError(ERROR_CODE)
        return response["texts"]

    def _abort(self):
        process = getattr(self, "_process", None)
        if process is not None and process.poll() is None:
            process.kill()

    def close(self):
        process = getattr(self, "_process", None)
        if process is None:
            return
        try:
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.close()
            process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
            self._stdout_thread.join(timeout=SHUTDOWN_TIMEOUT_SECONDS)
            self._stderr_thread.join(timeout=SHUTDOWN_TIMEOUT_SECONDS)
            if self._stdout_thread.is_alive() or self._stderr_thread.is_alive():
                raise TextSubprocessError(ERROR_CODE)
        except Exception as exc:
            self._abort()
            raise TextSubprocessError(ERROR_CODE) from exc
```

实现时不得输出或保留 stderr 内容；`_abort()` 和 `close()` 必须幂等。

- [ ] **步骤 4：补齐失败矩阵并确认全部绿灯**

为 fake process 增加以下模式，每个模式独立断言 `TextSubprocessError(ERROR_CODE)`：

```python
def test_failures_are_stable_and_close_kills_hung_child(self):
    cases = {
        "bad-handshake": [b'{"status":"wrong","schema_version":"redraw-full-frame-text-subprocess-v1"}\n'],
        "invalid-json": [b'{bad\n'],
        "mismatch": [
            b'{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}\n',
            b'{"request_id":2,"texts":[]}\n',
        ],
        "extra-field": [
            b'{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}\n',
            b'{"request_id":1,"texts":[],"ocr_text":"forbidden"}\n',
        ],
    }
    for name, lines in cases.items():
        with self.subTest(name=name):
            process = FakeProcess(lines)
            with self.assertRaises(text_subprocess.TextSubprocessError):
                adapter = text_subprocess.TextSubprocessAdapter(
                    "python", "text_worker.py", "model-lock.json",
                    process_factory=lambda *_args, **_kwargs: process,
                    start_timeout=0.1,
                    frame_timeout=0.1,
                )
                adapter.detect_regions("D:/redraw-local/frame.png")
            self.assertTrue(process.killed or process.returncode is not None)
```

另加专门 fake，覆盖：启动无输出、单帧无输出、EPIPE、stdout 单行超限、stderr 累计超限、提前退出和 `close()` 等待超时。

运行：

```powershell
& $env:REDRAW_AUDITOR_PYTHON -m unittest workers/redraw-full-frame-auditor/tests/test_text_subprocess.py -v
& $env:REDRAW_AUDITOR_PYTHON -m py_compile workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_subprocess.py workers/redraw-full-frame-auditor/tests/test_text_subprocess.py
```

预期：全部 PASS，线程在测试退出前结束或为 daemon，`py_compile` exit 0。

- [ ] **步骤 5：提交任务 2**

```powershell
git add workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_subprocess.py workers/redraw-full-frame-auditor/tests/test_text_subprocess.py
git commit -m "feat(转绘): 增加 Paddle 子进程生命周期门禁"
```

### 任务 3：接入主 worker 并执行真实四组件探针

**文件：**

- 修改：`workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py`
- 修改：`workers/redraw-full-frame-auditor/tests/test_worker.py`

- [ ] **步骤 1：编写默认隔离和 close 红灯测试**

新增一个 fake text process factory，并证明默认路径不调用 Paddle 工厂：

```python
def test_default_loader_uses_text_process_and_closes_it(self):
    events = []

    class FakeTextProcess:
        def detect_regions(self, _frame_path):
            return []

        def close(self):
            events.append("text-close")

    factories = FakeFactory()
    original_text_factory = worker._default_text_detector_factory
    try:
        worker._default_text_detector_factory = lambda _path: self.fail("main worker loaded Paddle")
        with tempfile.TemporaryDirectory() as root:
            lock_path = write_lock_fixture(pathlib.Path(root))
            detectors = worker._load_real_detectors(
                str(lock_path),
                factories=factories,
                text_process_factory=lambda **_kwargs: FakeTextProcess(),
            )
            worker._close_detectors(detectors)
    finally:
        worker._default_text_detector_factory = original_text_factory
    self.assertEqual(events, ["text-close"])
    self.assertFalse(hasattr(worker._default_factories(), "text_detector"))
```

同时修改现有 `test_real_loader_assembles_four_adapters_from_validated_model_lock_without_recognition_pipeline`：调用 `_load_real_detectors` 时显式传入 `text_process_factory=lambda **_kwargs: FakeTextDetector([])`，不再从 `FakeFactory.text_detector` 构造生产默认文字路径。

新增 bootstrap 探针断言：

```python
def test_bootstrap_runs_probe_and_always_closes_detectors(self):
    import contextlib

    events = []
    detectors = FakeDetectors()
    detectors.text.close = lambda: events.append("closed")
    args = worker.SimpleNamespace(model_lock="D:/models/model-lock.json")
    result = worker.bootstrap_models(
        args,
        detector_loader=lambda _path: detectors,
        probe_frame_factory=lambda: contextlib.nullcontext("D:/redraw-local/probe.png"),
    )
    self.assertEqual(result["status"], "ok")
    self.assertEqual(detectors.person.calls, ["D:/redraw-local/probe.png"])
    self.assertEqual(detectors.face.calls, ["D:/redraw-local/probe.png"])
    self.assertEqual(detectors.text.calls, ["D:/redraw-local/probe.png"])
    self.assertEqual(events, ["closed"])
```

- [ ] **步骤 2：运行测试确认红灯**

运行：

```powershell
& $env:REDRAW_AUDITOR_PYTHON -m unittest workers/redraw-full-frame-auditor/tests/test_worker.py -v
```

预期：FAIL，原因是 `_load_real_detectors` 不接受 `text_process_factory`，且没有 `_close_detectors`、`detector_loader` 和探针执行。

- [ ] **步骤 3：最小接线文字子进程**

在 `worker.py` 中按包/脚本两种入口导入 adapter：

```python
if __package__:
    from .text_subprocess import TextSubprocessAdapter
else:
    from text_subprocess import TextSubprocessAdapter
```

增加固定 worker 路径和关闭帮助函数：

```python
def _text_worker_path():
    return os.path.join(os.path.dirname(os.path.realpath(__file__)), "text_worker.py")


def _default_text_process_factory(model_lock_path):
    return TextSubprocessAdapter(
        python_path=sys.executable,
        text_worker_path=_text_worker_path(),
        model_lock_path=model_lock_path,
    )


def _default_factories():
    return SimpleNamespace(
        person=_default_person_factory,
        tracker=_default_tracker_factory,
        face=_default_face_factory,
    )


def _close_detectors(detectors):
    text = getattr(detectors, "text", None)
    close = getattr(text, "close", None)
    if callable(close):
        close()
```

把真实默认路径和测试注入路径明确分开：

```python
def _load_real_detectors(model_lock_path, factories=None, text_process_factory=None):
    text = None
    try:
        _lock, components = _validate_model_lock(model_lock_path)
        active_factories = factories or _default_factories()
        if text_process_factory is None:
            text_process_factory = _default_text_process_factory
        person = YOLOXPersonAdapter(components["person_detector"]["artifact_abs_path"], active_factories.person)
        tracker = ByteTrackAdapter(components["tracker"]["artifact_abs_path"], active_factories.tracker)
        face = MediaPipeFaceAdapter(components["face_detector"]["artifact_abs_path"], active_factories.face)
        text = text_process_factory(model_lock_path=model_lock_path)
        return SimpleNamespace(
            person=person,
            tracker=tracker,
            face=face,
            text=text,
        )
    except ProtocolError:
        if text is not None:
            _close_detectors(SimpleNamespace(text=text))
        raise
    except Exception as exc:
        if text is not None:
            _close_detectors(SimpleNamespace(text=text))
        raise ProtocolError(ERROR_CODE) from exc
```

测试路径向 `text_process_factory` 注入 `FakeTextDetector`；主 worker 的测试和生产默认路径都不得调用 `_default_text_detector_factory`。

- [ ] **步骤 4：实现真实无敏感探针和 finally 关闭**

增加上下文管理器，默认生成 64×64 黑色 PNG，并在退出时删除：

```python
import contextlib
import tempfile


@contextlib.contextmanager
def _probe_frame():
    cv2 = importlib.import_module("cv2")
    numpy = importlib.import_module("numpy")
    with tempfile.TemporaryDirectory(prefix="redraw-full-frame-probe-") as root:
        frame_path = os.path.join(root, "probe.png")
        image = numpy.zeros((64, 64, 3), dtype=numpy.uint8)
        if not cv2.imwrite(frame_path, image):
            _fail()
        yield frame_path
```

修改 `bootstrap_models` 和 `run_jsonl`：

```python
def bootstrap_models(args, adapters=None, factories=None, detector_loader=None, probe_frame_factory=None):
    detectors = None
    try:
        loader = detector_loader or (lambda path: _load_real_detectors(path, factories=factories))
        detectors = loader(args.model_lock)
        probe_factory = probe_frame_factory or _probe_frame
        with probe_factory() as frame_path:
            detect_frame({"frame_index": 0, "timestamp_ms": 0, "frame_path": frame_path}, detectors)
        if adapters is not None:
            probe = getattr(adapters, "probe", None)
            if callable(probe):
                probe(args.model_lock)
        return {"status": "ok", "schema_version": LOCK_SCHEMA, "components": sorted(COMPONENTS)}
    except ProtocolError:
        raise
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc
    finally:
        if detectors is not None:
            _close_detectors(detectors)
```

`run_jsonl` 使用以下结构汇总主循环与 close 结果；失败时只写 1 次稳定错误码：

```python
def run_jsonl(args, detectors=None, factories=None):
    stdin = getattr(args, "stdin", sys.stdin)
    stdout = getattr(args, "stdout", sys.stdout)
    stderr = getattr(args, "stderr", sys.stderr)
    active_detectors = None
    failed = False
    try:
        active_detectors = detectors if detectors is not None else _load_real_detectors(
            args.model_lock,
            factories=factories,
        )
        for line in stdin:
            if not line.endswith("\n") or not line.strip():
                _fail()
            frame = json.loads(line)
            result = detect_frame(frame, active_detectors)
            stdout.write(json.dumps(result, separators=(",", ":"), ensure_ascii=True) + "\n")
            stdout.flush()
    except Exception:
        failed = True
    finally:
        if active_detectors is not None:
            try:
                _close_detectors(active_detectors)
            except Exception:
                failed = True
    if failed:
        stderr.write(ERROR_CODE + "\n")
        stderr.flush()
        return 1
    return 0
```

主循环或 close 任一失败都返回 1；不能让 `finally` 异常越过稳定错误边界。

- [ ] **步骤 5：运行 Python 联合测试和语法检查**

运行：

```powershell
& $env:REDRAW_AUDITOR_PYTHON -m unittest discover -s workers/redraw-full-frame-auditor/tests -v
& $env:REDRAW_AUDITOR_PYTHON -m py_compile workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_worker.py workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/text_subprocess.py workers/redraw-full-frame-auditor/tests/test_worker.py workers/redraw-full-frame-auditor/tests/test_text_worker.py workers/redraw-full-frame-auditor/tests/test_text_subprocess.py
git diff --check
```

预期：全部 Python tests PASS，`py_compile` 与 `git diff --check` exit 0；测试环境中不存在 `KMP_DUPLICATE_LIB_OK`。

- [ ] **步骤 6：提交任务 3**

```powershell
git add workers/redraw-full-frame-auditor/src/redraw_full_frame_auditor/worker.py workers/redraw-full-frame-auditor/tests/test_worker.py
git commit -m "fix(转绘): 隔离全帧文字检测运行时"
```

### 任务 4：固化 Node 回归并执行真实模型验收

**文件：**

- 修改：`backend-node/test/redrawFullFrameDetectorProcess.test.js`
- 不修改：`backend-node/src/services/redrawFullFrameDetectorProcess.js`
- 不创建仓库内模型文件或运行产物

- [ ] **步骤 1：编写 bootstrap 脱敏红灯测试**

在现有 `runFetchModels` fixture 测试旁新增：

```javascript
const bootstrapFailed = path.join(parent, 'bootstrap-failed');
await assert.rejects(runFetchModels({ outputDir: bootstrapFailed }, {
  ...deps,
  randomHex: () => 'bootstrap123',
  bootstrapWorker: async () => {
    const err = new Error('C:\\private\\model-lock.json Authorization: secret');
    err.code = 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE';
    throw err;
  },
}), (err) => err.code === 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE'
  && err.message === 'REDRAW_FULL_FRAME_MODEL_UNAVAILABLE'
  && !Object.prototype.hasOwnProperty.call(err, 'cause'));
assert.equal(fs.existsSync(bootstrapFailed), false);
```

把这段代码放入现有 `runFetchModels builds a fixture cache, validates lock, and leaves no final directory on failure` 测试尾部，直接复用该测试的 `parent` 和 `deps`，不新增通用抽象。

- [ ] **步骤 2：运行 Node 定向测试确认红灯或合同缺口**

运行：

```powershell
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameModelLock.test.js
Pop-Location
```

预期：FAIL；当前 `runFetchModels` 会原样抛出带私有路径的同码异常，`err.message` 不等于稳定错误码。

- [ ] **步骤 3：仅在红灯时做最小错误转换修复**

只允许在 `runFetchModels` catch 中重新构造稳定错误，不能附加 `cause`：

```javascript
} catch (err) {
  if (err && err.code === OUTPUT_ERROR) throw error(OUTPUT_ERROR);
  throw error(MODEL_ERROR);
}
```

- [ ] **步骤 4：运行全部本地代码回归**

设置 bundled Python 的绝对路径仅到当前进程环境变量，不写入日志或仓库：

```powershell
if (-not $env:REDRAW_AUDITOR_PYTHON) { throw 'REDRAW_AUDITOR_PYTHON_REQUIRED' }
& $env:REDRAW_AUDITOR_PYTHON -m unittest discover -s workers/redraw-full-frame-auditor/tests -v
Push-Location backend-node
node --test --test-concurrency=1 test/redrawFullFrameDetectorProcess.test.js test/redrawFullFrameModelLock.test.js test/redrawFullFrameCoverage.test.js test/redrawFullFrameReview.test.js test/redrawFullFrameCoverageLocal.test.js
Pop-Location
node --check backend-node/scripts/fetch-redraw-full-frame-models-local.js
node --check backend-node/test/redrawFullFrameDetectorProcess.test.js
git diff --check
```

预期：0 fail；Windows 不支持符号链接时，只允许现有 ModelLock symlink 用例以明确 `EPERM` 原因 skip，真实模型 smoke 不能 skip。

- [ ] **步骤 5：提交任务 4 的测试**

```powershell
git add backend-node/test/redrawFullFrameDetectorProcess.test.js backend-node/scripts/fetch-redraw-full-frame-models-local.js
git commit -m "fix(转绘): 脱敏全帧启动失败证据"
```

- [ ] **步骤 6：执行真实官方模型缓存和四组件 smoke**

使用全新的仓库外目录，只运行 1 次：

```powershell
$env:REDRAW_FULL_FRAME_MODEL_CACHE = Join-Path ([IO.Path]::GetTempPath()) ('redraw-full-frame-models-' + [guid]::NewGuid())
npm --prefix backend-node run fetch:redraw-full-frame-models-local -- --output-dir $env:REDRAW_FULL_FRAME_MODEL_CACHE
```

预期：

- 命令 exit 0，stdout 只有 1 个结果 JSON；其中 `canonical_sha256` 为 64 位小写十六进制，`components` 精确为 `face_detector/person_detector/text_detector/tracker`，`runtime_lock` 为 `runtime/pip-freeze.txt`；
- `model-lock.json` 通过 validator；
- person、tracker、face 和 text 真实探针均执行，不能 skip；
- 不出现 OpenMP Error #15；
- 源码、命令环境和子进程环境均不存在 `KMP_DUPLICATE_LIB_OK`；
- 日志不包含源片路径、模型缓存绝对路径、Key、Authorization 或供应商 URL；
- 失败时最终缓存目录不存在，不自动重试或更换镜像。

- [ ] **步骤 7：审查与恢复原任务 6**

运行：

```powershell
git log --oneline -6
git diff 62c9cc14..HEAD --check
git status --short
```

要求：

- 对任务 1 至任务 4 的提交执行规格审查和代码质量审查；
- Critical/Important 必须为 0；
- 全程未读取 Key、未上传源片、未调用供应商、未付费、未写数据库、未 SSH、未部署、未 push；
- 工作树只能保留任务开始前已有的 `.superpowers/`、`frontweb/output/` 和 3 个 locale verifier `__pycache__/` 未跟踪目录；
- 删除本计划创建的仓库外失败诊断目录，只保留成功模型缓存供原任务 6 使用；
- 然后回到 `docs/superpowers/plans/2026-08-15-redraw-full-frame-person-text-audit.md` 的任务 6 步骤 3，继续真实源片 analyze、人工审核、finalize、联合回归和脱敏报告；本计划本身不重复那些步骤。
