import io
import json
import os
import pathlib
import subprocess
import sys
import threading
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from redraw_full_frame_auditor import text_subprocess


class BlockingPipe:
    def __init__(self, stop_event, lines=()):
        self._stop_event = stop_event
        self._lines = list(lines)
        self.closed = False

    def readline(self, _limit=-1):
        if self._lines:
            return self._lines.pop(0)
        self._stop_event.wait(2)
        return b""

    def read(self, _size=-1):
        self._stop_event.wait(2)
        return b""

    def close(self):
        self.closed = True
        self._stop_event.set()


class RaisingStdin(io.BytesIO):
    def write(self, _value):
        raise BrokenPipeError("C:/private/Authorization-secret")


class AfterAbortStderr:
    def __init__(self, stop_event, payload):
        self._stop_event = stop_event
        self._payload = payload
        self._sent = False
        self.closed = False

    def read(self, _size=-1):
        self._stop_event.wait(2)
        if not self._sent:
            self._sent = True
            return self._payload
        return b""

    def close(self):
        self.closed = True
        self._stop_event.set()


class FakeProcess:
    def __init__(self, stdout_lines=(), *, stderr=b"", returncode=None,
                 stderr_stream=None, block_stdout=False, stdin=None,
                 wait_hangs=False):
        self._stop_event = threading.Event()
        self.stdin = stdin or io.BytesIO()
        if block_stdout:
            self.stdout = BlockingPipe(self._stop_event, stdout_lines)
        else:
            self.stdout = io.BytesIO(b"".join(stdout_lines))
        self.stderr = stderr_stream or io.BytesIO(stderr)
        self.returncode = returncode
        self.killed = False
        self.wait_hangs = wait_hangs
        self.wait_timeouts = []

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.wait_timeouts.append(timeout)
        if self.wait_hangs and not self.killed:
            raise subprocess.TimeoutExpired("C:/private/model-lock.json", timeout)
        if self.returncode is None:
            self.returncode = -9 if self.killed else 0
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9
        self._stop_event.set()


class TextSubprocessTests(unittest.TestCase):
    HANDSHAKE = b'{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}\n'
    SAFE_STARTUP_STAGES = frozenset((
        "validate_lock",
        "import_cv2",
        "import_paddle",
        "build_args",
        "model_dir",
        "detector_init",
        "adapter_init",
        "output_limit",
    ))

    def assert_stable_error(self, action):
        with self.assertRaises(text_subprocess.TextSubprocessError) as raised:
            action()
        self.assertEqual(str(raised.exception), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE")
        self.assertIsNone(raised.exception.__cause__)
        self.assertIsNone(raised.exception.__context__)
        self.assertNotIn("private", repr(raised.exception).lower())
        self.assertNotIn("authorization", repr(raised.exception).lower())
        return raised.exception

    def make_adapter(self, process, **overrides):
        options = {
            "process_factory": lambda *_args, **_kwargs: process,
            "start_timeout": 0.05,
            "frame_timeout": 0.05,
        }
        options.update(overrides)
        return text_subprocess.TextSubprocessAdapter(
            "D:/venv/python.exe",
            "D:/worker/text_worker.py",
            "D:/models/model-lock.json",
            **options,
        )

    def test_adapter_uses_fixed_command_safe_env_and_exact_protocol(self):
        captured = {}
        process = FakeProcess([
            self.HANDSHAKE,
            b'{"request_id":1,"texts":[]}\n',
            b'{"request_id":2,"texts":[]}\n',
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
                "WINDIR": "C:/Windows",
                "TEMP": "C:/Temp",
                "TMP": "C:/Tmp",
                "API_KEY": "forbidden",
                "Authorization": "forbidden",
                "HTTP_PROXY": "forbidden",
                "https_proxy": "forbidden",
                "ALL_PROXY": "forbidden",
                "NO_PROXY": "forbidden",
                "PYTHONPATH": "forbidden",
                "PYTHONHOME": "forbidden",
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
        self.assertEqual(captured["env"], {
            "PATH": "safe-path",
            "SystemRoot": "C:/Windows",
            "WINDIR": "C:/Windows",
            "TEMP": "C:/Temp",
            "TMP": "C:/Tmp",
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
        })
        self.assertIs(captured["stdin"], subprocess.PIPE)
        self.assertIs(captured["stdout"], subprocess.PIPE)
        self.assertIs(captured["stderr"], subprocess.PIPE)
        self.assertFalse(captured["shell"])
        expected_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.assertEqual(captured["creationflags"], expected_flags)
        self.assertEqual(adapter._queue.maxsize, 2)

        self.assertEqual(adapter.detect_regions("D:/redraw-local/frame-1.png"), [])
        self.assertEqual(adapter.detect_regions("D:/redraw-local/frame-2.png"), [])
        requests = [json.loads(line) for line in process.stdin.getvalue().splitlines()]
        self.assertEqual(requests, [
            {"request_id": 1, "frame_path": "D:/redraw-local/frame-1.png"},
            {"request_id": 2, "frame_path": "D:/redraw-local/frame-2.png"},
        ])
        adapter.close()
        adapter.close()

    def test_safe_env_ignores_non_string_allowed_values(self):
        self.assertEqual(text_subprocess.safe_text_env({
            "PATH": None,
            "SYSTEMROOT": "C:/Windows",
            "TEMP": pathlib.Path("C:/private"),
            "TMP": "C:/Tmp",
            "SECRET_KEY": "forbidden",
        }), {
            "SystemRoot": "C:/Windows",
            "TMP": "C:/Tmp",
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
        })

    def test_protocol_failures_abort_without_restarting(self):
        cases = {
            "bad-handshake": [
                b'{"status":"wrong","schema_version":"redraw-full-frame-text-subprocess-v1"}\n',
            ],
            "handshake-extra": [
                b'{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1","extra":true}\n',
            ],
            "invalid-json": [b'{bad\n'],
            "invalid-utf8": [b'\xff\n'],
            "duplicate-json-key": [
                b'{"status":"ok","status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}\n',
            ],
            "mismatch": [
                self.HANDSHAKE,
                b'{"request_id":2,"texts":[]}\n',
            ],
            "extra-field": [
                self.HANDSHAKE,
                b'{"request_id":1,"texts":[],"ocr_text":"forbidden"}\n',
            ],
            "bad-texts": [
                self.HANDSHAKE,
                b'{"request_id":1,"texts":{}}\n',
            ],
            "boolean-id": [
                self.HANDSHAKE,
                b'{"request_id":true,"texts":[]}\n',
            ],
        }

        for name, lines in cases.items():
            with self.subTest(name=name):
                calls = []
                process = FakeProcess(lines)

                def factory(*_args, **_kwargs):
                    calls.append("spawn")
                    return process

                if len(lines) == 1:
                    self.assert_stable_error(lambda: text_subprocess.TextSubprocessAdapter(
                        "python", "text_worker.py", "model-lock.json",
                        process_factory=factory,
                        start_timeout=0.05,
                        frame_timeout=0.05,
                    ))
                else:
                    adapter = text_subprocess.TextSubprocessAdapter(
                        "python", "text_worker.py", "model-lock.json",
                        process_factory=factory,
                        start_timeout=0.05,
                        frame_timeout=0.05,
                    )
                    self.assert_stable_error(lambda: adapter.detect_regions("D:/redraw-local/frame.png"))
                    adapter.close()
                self.assertEqual(calls, ["spawn"])
                self.assertTrue(process.killed or process.returncode is not None)

    def test_start_and_frame_timeouts_abort(self):
        startup = FakeProcess(block_stdout=True)
        self.assert_stable_error(lambda: self.make_adapter(startup))
        self.assertTrue(startup.killed)
        self.assertTrue(startup.stdin.closed)
        self.assertTrue(startup.stdout.closed)
        self.assertTrue(startup.stderr.closed)
        self.assertTrue(startup.wait_timeouts)

        frame = FakeProcess([self.HANDSHAKE], block_stdout=True)
        adapter = self.make_adapter(frame)
        self.assert_stable_error(lambda: adapter.detect_regions("D:/redraw-local/frame.png"))
        self.assertTrue(frame.killed)
        adapter.close()

    def test_epipe_stdout_limit_stderr_limit_and_early_exit_fail_closed(self):
        epipe = FakeProcess([self.HANDSHAKE], stdin=RaisingStdin())
        adapter = self.make_adapter(epipe)
        self.assert_stable_error(lambda: adapter.detect_regions("D:/redraw-local/frame.png"))
        self.assertTrue(epipe.killed)
        adapter.close()

        oversized_stdout = FakeProcess([b"x" * (1024 * 1024 + 1)])
        self.assert_stable_error(lambda: self.make_adapter(oversized_stdout))
        self.assertTrue(oversized_stdout.killed)

        oversized_stderr = FakeProcess(
            block_stdout=True,
            stderr=b"x" * (1024 * 1024 + 1),
        )
        self.assert_stable_error(lambda: self.make_adapter(oversized_stderr))
        self.assertTrue(oversized_stderr.killed)

        early_exit = FakeProcess([self.HANDSHAKE], returncode=0)
        self.assert_stable_error(lambda: self.make_adapter(early_exit))

    def test_invalid_input_is_stable_and_never_written(self):
        process = FakeProcess([self.HANDSHAKE])
        adapter = self.make_adapter(process)
        for value in (None, "", 1, pathlib.Path("C:/private/frame.png")):
            with self.subTest(value=value):
                self.assert_stable_error(lambda value=value: adapter.detect_regions(value))
        self.assertEqual(process.stdin.getvalue(), b"")
        adapter.close()

    def test_process_factory_failure_is_sanitized(self):
        def fail_factory(*_args, **_kwargs):
            raise OSError("C:/private/model-lock Authorization: secret")

        self.assert_stable_error(lambda: text_subprocess.TextSubprocessAdapter(
            "C:/private/python.exe",
            "C:/private/text_worker.py",
            "C:/private/model-lock.json",
            process_factory=fail_factory,
        ))

    def test_close_timeout_kills_child_joins_threads_and_is_idempotent(self):
        process = FakeProcess([self.HANDSHAKE], wait_hangs=True)
        adapter = self.make_adapter(process)

        self.assert_stable_error(adapter.close)
        self.assertTrue(process.killed)
        self.assertEqual(process.wait_timeouts[0], text_subprocess.SHUTDOWN_TIMEOUT_SECONDS)
        self.assertFalse(adapter._stdout_thread.is_alive())
        self.assertFalse(adapter._stderr_thread.is_alive())
        adapter.close()

    def test_startup_safe_stage_is_trusted_only_after_cleanup(self):
        self.assertEqual(text_subprocess.TEXT_STARTUP_SAFE_STAGES, self.SAFE_STARTUP_STAGES)
        for stage in self.SAFE_STARTUP_STAGES:
            with self.subTest(stage=stage):
                process = FakeProcess(
                    stderr=(
                        b"\n"
                        + f"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage={stage}\r\n".encode("ascii")
                        + b"\n"
                    ),
                    returncode=1,
                )
                error = self.assert_stable_error(lambda: self.make_adapter(process))
                self.assertEqual(text_subprocess._trusted_text_stage(error), stage)
                self.assertEqual(error.args, ("REDRAW_FULL_FRAME_MODEL_UNAVAILABLE",))
                self.assertNotIn(stage, str(error))
                self.assertNotIn(stage, repr(error))
                self.assertTrue(process.stdin.closed)
                self.assertTrue(process.stdout.closed)
                self.assertTrue(process.stderr.closed)

    def test_startup_stage_rejects_raw_spoof_illegal_sensitive_and_exit_zero(self):
        direct_spoof = text_subprocess.TextSubprocessError(
            "C:/private/model-lock Authorization: secret",
            stage="validate_lock",
        )
        self.assertEqual(str(direct_spoof), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE")
        self.assertIsNone(text_subprocess._trusted_text_stage(direct_spoof))

        class SpoofedSubclass(text_subprocess.TextSubprocessError):
            pass

        subclass_spoof = SpoofedSubclass("ignored")
        subclass_spoof._trusted_stage = "validate_lock"
        subclass_spoof._stage_token = getattr(text_subprocess, "_TEXT_STAGE_TOKEN", object())
        self.assertIsNone(text_subprocess._trusted_text_stage(subclass_spoof))

        cases = {
            "raw": b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n",
            "illegal": b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=import_os\n",
            "non-last": (
                b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=validate_lock\n"
                b"later output\n"
            ),
            "authorization": (
                b"Authorization: value\n"
                b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=validate_lock\n"
            ),
            "auth": (
                b"Auth: value\n"
                b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=validate_lock\n"
            ),
            "key": (
                b"API_KEY=value\n"
                b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=validate_lock\n"
            ),
            "sensitive": (
                b"sensitive=value\n"
                b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=validate_lock\n"
            ),
            "path": (
                b"C:/private/model-lock.json\n"
                b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=validate_lock\n"
            ),
            "suffix": b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=validate_lock extra\n",
            "invalid-utf8": (
                b"\xff\n"
                b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=validate_lock\n"
            ),
        }
        for name, stderr in cases.items():
            with self.subTest(name=name):
                error = self.assert_stable_error(lambda stderr=stderr: self.make_adapter(
                    FakeProcess(stderr=stderr, returncode=1)
                ))
                self.assertIsNone(text_subprocess._trusted_text_stage(error))
                self.assertNotIn("secret", repr(error).lower())
                self.assertNotIn("private", repr(error).lower())

        oversized = (
            b"x" * text_subprocess.MAX_STDERR_BYTES
            + b"\nREDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=validate_lock\n"
        )
        overflow_error = self.assert_stable_error(lambda: self.make_adapter(
            FakeProcess(stderr=oversized, returncode=1)
        ))
        self.assertIsNone(text_subprocess._trusted_text_stage(overflow_error))

        exit_zero_error = self.assert_stable_error(lambda: self.make_adapter(FakeProcess(
            stderr=b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=validate_lock\n",
            returncode=0,
        )))
        self.assertIsNone(text_subprocess._trusted_text_stage(exit_zero_error))

    def test_startup_stage_waits_for_stderr_drain_and_request_failures_have_no_stage(self):
        process = FakeProcess(block_stdout=True)
        process.stderr = AfterAbortStderr(
            process._stop_event,
            b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=detector_init\n",
        )
        error = self.assert_stable_error(lambda: self.make_adapter(process))
        self.assertEqual(text_subprocess._trusted_text_stage(error), "detector_init")
        self.assertFalse(any(
            thread.name in {"redraw-text-stdout", "redraw-text-stderr"}
            for thread in threading.enumerate()
        ))

        request_process = FakeProcess(
            [
                self.HANDSHAKE,
                b'{"request_id":2,"texts":[]}\n',
            ],
            stderr=b"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage=model_dir\n",
        )
        adapter = self.make_adapter(request_process)
        request_error = self.assert_stable_error(
            lambda: adapter.detect_regions("D:/redraw-local/frame.png")
        )
        self.assertIsNone(text_subprocess._trusted_text_stage(request_error))
        self.assertEqual(adapter._startup_stderr, bytearray())
        adapter.close()


if __name__ == "__main__":
    unittest.main()
