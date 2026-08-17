import json
import os
import queue
import subprocess
import threading
import time


ERROR_CODE = "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE"
TEXT_SCHEMA = "redraw-full-frame-text-subprocess-v1"
START_TIMEOUT_SECONDS = 120
FRAME_TIMEOUT_SECONDS = 60
SHUTDOWN_TIMEOUT_SECONDS = 5
MAX_LINE_BYTES = 1024 * 1024
MAX_STDERR_BYTES = 1024 * 1024
MAX_REQUEST_ID = 9007199254740991
ENV_ALLOWLIST = ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP")
TEXT_STARTUP_SAFE_STAGES = frozenset((
    "validate_lock",
    "import_cv2",
    "import_paddle",
    "build_args",
    "model_dir",
    "detector_init",
    "adapter_init",
    "output_limit",
))
_TEXT_STAGE_TOKEN = object()
_SENSITIVE_STARTUP_MARKERS = (
    "auth",
    "authorization",
    "key",
    "sensitive",
    "secret",
    "token",
    "password",
    "credential",
    "bearer",
    "proxy",
    "path",
)


class TextSubprocessError(Exception):
    def __init__(self, _message=ERROR_CODE, *, stage=None, _token=None):
        super().__init__(ERROR_CODE)
        trusted = _token is _TEXT_STAGE_TOKEN and stage in TEXT_STARTUP_SAFE_STAGES
        self._trusted_stage = stage if trusted else None
        self._stage_token = _token if trusted else None


def _trusted_text_stage(error):
    if (type(error) is TextSubprocessError
            and getattr(error, "_stage_token", None) is _TEXT_STAGE_TOKEN
            and getattr(error, "_trusted_stage", None) in TEXT_STARTUP_SAFE_STAGES):
        return error._trusted_stage
    return None


def _parse_startup_stage(stderr_bytes, *, overflowed, exit_code):
    if overflowed or exit_code == 0 or len(stderr_bytes) > MAX_STDERR_BYTES:
        return None
    try:
        value = bytes(stderr_bytes).decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return None
    lowered = value.lower()
    if ("/" in value or "\\" in value
            or any(marker in lowered for marker in _SENSITIVE_STARTUP_MARKERS)):
        return None
    lines = [line for line in value.splitlines() if line.strip()]
    if not lines:
        return None
    last_line = lines[-1]
    for stage in TEXT_STARTUP_SAFE_STAGES:
        if last_line == f"{ERROR_CODE} stage={stage}":
            return stage
    return None


def safe_text_env(source_env=None):
    source = os.environ if source_env is None else source_env
    source_by_lower_key = {
        key.lower(): value
        for key, value in source.items()
        if isinstance(key, str)
    }
    env = {}
    for key in ENV_ALLOWLIST:
        value = source.get(key, source_by_lower_key.get(key.lower()))
        if isinstance(value, str):
            env[key] = value
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _reject_duplicate_keys(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(ERROR_CODE)
        value[key] = item
    return value


def _reject_nonstandard_number(_value):
    raise ValueError(ERROR_CODE)


def _decode_message(line):
    return json.loads(
        line.decode("utf-8", errors="strict"),
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_nonstandard_number,
    )


class TextSubprocessAdapter:
    def __init__(self, python_path, text_worker_path, model_lock_path,
                 process_factory=subprocess.Popen, source_env=None,
                 start_timeout=START_TIMEOUT_SECONDS,
                 frame_timeout=FRAME_TIMEOUT_SECONDS):
        self._queue = queue.Queue(maxsize=2)
        self._stderr_bytes = 0
        self._stderr_lock = threading.Lock()
        self._startup_stderr = bytearray()
        self._collect_startup_stderr = True
        self._stderr_overflow = False
        self._protocol_failed = threading.Event()
        self._request_lock = threading.Lock()
        self._request_id = 0
        self._frame_timeout = frame_timeout
        self._process = None
        self._stdout_thread = None
        self._stderr_thread = None
        self._broken = False
        self._closed = False

        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        spawn_failed = False
        try:
            self._process = process_factory(
                [python_path, text_worker_path, "run", "--model-lock", model_lock_path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=safe_text_env(source_env),
                shell=False,
                creationflags=creationflags,
                bufsize=0,
            )
        except Exception:
            spawn_failed = True
        if spawn_failed or self._process is None:
            self._raise_stable()
        if any(getattr(self._process, name, None) is None for name in ("stdin", "stdout", "stderr")):
            self._fail_closed()

        self._stdout_thread = threading.Thread(
            target=self._read_stdout,
            name="redraw-text-stdout",
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr,
            name="redraw-text-stderr",
            daemon=True,
        )
        thread_start_failed = False
        try:
            self._stdout_thread.start()
            self._stderr_thread.start()
        except Exception:
            thread_start_failed = True
        if thread_start_failed:
            self._fail_closed()

        handshake = self._next_message(start_timeout, startup=True)
        if handshake != {"status": "ok", "schema_version": TEXT_SCHEMA}:
            self._fail_closed(startup=True)
        with self._stderr_lock:
            if self._stderr_overflow:
                startup_overflow = True
            else:
                startup_overflow = False
                self._collect_startup_stderr = False
                self._startup_stderr.clear()
        if startup_overflow:
            self._fail_closed(startup=True)

    def _raise_stable(self, stage=None):
        if stage in TEXT_STARTUP_SAFE_STAGES:
            raise TextSubprocessError(ERROR_CODE, stage=stage, _token=_TEXT_STAGE_TOKEN)
        raise TextSubprocessError(ERROR_CODE)

    def _queue_message(self, message):
        self._queue.put(message)

    def _read_stdout(self):
        try:
            while True:
                line = self._process.stdout.readline(MAX_LINE_BYTES + 1)
                if not line:
                    self._queue_message(None)
                    return
                if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
                    self._protocol_failed.set()
                    self._queue_message(None)
                    return
                self._queue_message(_decode_message(line))
        except Exception:
            self._protocol_failed.set()
            self._queue_message(None)

    def _drain_stderr(self):
        try:
            while True:
                chunk = self._process.stderr.read(65536)
                if not chunk:
                    return
                with self._stderr_lock:
                    self._stderr_bytes += len(chunk)
                    overflowed = self._stderr_bytes > MAX_STDERR_BYTES
                    if overflowed:
                        self._stderr_overflow = True
                        self._startup_stderr.clear()
                    elif self._collect_startup_stderr:
                        self._startup_stderr.extend(chunk)
                if overflowed:
                    self._protocol_failed.set()
                    self._abort()
                    self._queue_message(None)
                    return
        except Exception:
            self._protocol_failed.set()
            self._abort()
            self._queue_message(None)

    def _process_is_alive(self):
        try:
            return self._process is not None and self._process.poll() is None
        except Exception:
            return False

    def _next_message(self, timeout, startup=False):
        timed_out = False
        try:
            message = self._queue.get(timeout=timeout)
        except queue.Empty:
            timed_out = True
            message = None
        if (timed_out or message is None or self._protocol_failed.is_set()
                or not self._process_is_alive()):
            self._fail_closed(startup=startup)
        return message

    def _abort(self):
        self._broken = True
        process = self._process
        if process is None:
            return
        alive = False
        try:
            alive = process.poll() is None
        except Exception:
            alive = True
        if alive:
            try:
                process.kill()
            except Exception:
                pass

    def _join_threads(self, timeout):
        deadline = time.monotonic() + timeout
        current = threading.current_thread()
        for thread in (self._stdout_thread, self._stderr_thread):
            if thread is None or thread is current or thread.ident is None:
                continue
            remaining = max(0.0, deadline - time.monotonic())
            try:
                thread.join(timeout=remaining)
            except Exception:
                pass

    def _process_returncode(self):
        process = self._process
        if process is None:
            return None
        try:
            return process.poll()
        except Exception:
            return None

    def _startup_failure_stage(self, exit_code):
        with self._stderr_lock:
            stderr_bytes = bytes(self._startup_stderr)
            overflowed = self._stderr_overflow
        return _parse_startup_stage(
            stderr_bytes,
            overflowed=overflowed,
            exit_code=exit_code,
        )

    def _fail_closed(self, startup=False):
        exit_code = self._process_returncode()
        self._abort()
        try:
            self.close()
        except TextSubprocessError:
            pass
        stage = self._startup_failure_stage(exit_code) if startup else None
        self._raise_stable(stage)

    def detect_regions(self, frame_path):
        if not isinstance(frame_path, str) or not frame_path:
            self._raise_stable()
        if self._closed or self._broken:
            self._raise_stable()

        with self._request_lock:
            if self._closed or self._broken or self._request_id >= MAX_REQUEST_ID:
                self._fail_closed()
            self._request_id += 1
            payload = json.dumps({
                "request_id": self._request_id,
                "frame_path": frame_path,
            }, separators=(",", ":"), ensure_ascii=True).encode("utf-8") + b"\n"

            write_failed = False
            try:
                self._process.stdin.write(payload)
                self._process.stdin.flush()
            except Exception:
                write_failed = True
            if write_failed:
                self._fail_closed()

            response = self._next_message(self._frame_timeout)
            if not isinstance(response, dict) or set(response) != {"request_id", "texts"}:
                self._fail_closed()
            response_id = response["request_id"]
            if (not isinstance(response_id, int) or isinstance(response_id, bool)
                    or response_id != self._request_id
                    or not isinstance(response["texts"], list)):
                self._fail_closed()
            return response["texts"]

    def close(self):
        if self._closed:
            return
        self._closed = True
        process = self._process
        if process is None:
            return

        failed = False
        stdin = getattr(process, "stdin", None)
        if stdin is not None and not getattr(stdin, "closed", False):
            try:
                stdin.close()
            except Exception:
                failed = True

        wait_failed = False
        try:
            process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
        except Exception:
            wait_failed = True
            failed = True
        if wait_failed or self._process_is_alive():
            self._abort()
            try:
                process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
            except Exception:
                failed = True

        self._join_threads(SHUTDOWN_TIMEOUT_SECONDS)
        for stream_name in ("stdout", "stderr"):
            stream = getattr(process, stream_name, None)
            if stream is not None and not getattr(stream, "closed", False):
                try:
                    stream.close()
                except Exception:
                    failed = True

        self._join_threads(SHUTDOWN_TIMEOUT_SECONDS)
        for thread in (self._stdout_thread, self._stderr_thread):
            if thread is not None and thread.is_alive():
                failed = True
                self._abort()

        if failed:
            self._raise_stable()
