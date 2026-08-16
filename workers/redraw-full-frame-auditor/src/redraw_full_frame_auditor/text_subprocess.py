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


class TextSubprocessError(Exception):
    pass


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

        handshake = self._next_message(start_timeout)
        if handshake != {"status": "ok", "schema_version": TEXT_SCHEMA}:
            self._fail_closed()

    def _raise_stable(self):
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
                self._stderr_bytes += len(chunk)
                if self._stderr_bytes > MAX_STDERR_BYTES:
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

    def _next_message(self, timeout):
        timed_out = False
        try:
            message = self._queue.get(timeout=timeout)
        except queue.Empty:
            timed_out = True
            message = None
        if (timed_out or message is None or self._protocol_failed.is_set()
                or not self._process_is_alive()):
            self._fail_closed()
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

    def _fail_closed(self):
        self._abort()
        try:
            self.close()
        except TextSubprocessError:
            pass
        self._raise_stable()

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
