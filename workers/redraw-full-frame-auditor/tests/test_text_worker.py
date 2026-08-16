import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from redraw_full_frame_auditor import text_worker
from redraw_full_frame_auditor import worker


PYTHON = pathlib.Path(r"C:\Users\canqu\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe")


class FakeDetector:
    def __init__(self, result=None):
        self.result = result or [
            {
                "candidate_id": "text_1",
                "kind": "text_candidate",
                "polygon": [{"x": 0, "y": 0}, {"x": 8, "y": 0}, {"x": 8, "y": 4}],
                "confidence": 0.75,
            }
        ]
        self.calls = []

    def detect_regions(self, frame_path):
        print("detect stdout noise")
        print("detect stderr noise", file=sys.stderr)
        self.calls.append(frame_path)
        return self.result


class TextWorkerProtocolTests(unittest.TestCase):
    def run_worker(self, stdin_text, detector=None):
        stdout = io.StringIO()
        stderr = io.StringIO()
        detector = detector or FakeDetector()
        code = text_worker.run_jsonl(
            stdin=io.StringIO(stdin_text),
            stdout=stdout,
            stderr=stderr,
            detector=detector,
        )
        return code, stdout.getvalue().splitlines(), stderr.getvalue(), detector

    def test_successful_handshake_and_response_are_protocol_only(self):
        code, stdout_lines, stderr, detector = self.run_worker(
            json.dumps({"request_id": 1, "frame_path": "C:/frames/a.png"}) + "\n"
        )

        self.assertEqual(code, 0)
        self.assertEqual(stdout_lines[0], '{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}')
        self.assertEqual(json.loads(stdout_lines[1]), {
            "request_id": 1,
            "texts": [
                {
                    "candidate_id": "text_1",
                    "kind": "text_candidate",
                    "polygon": [{"x": 0.0, "y": 0.0}, {"x": 8.0, "y": 0.0}, {"x": 8.0, "y": 4.0}],
                    "confidence": 0.75,
                }
            ],
        })
        self.assertEqual(stderr, "")
        self.assertEqual(detector.calls, ["C:/frames/a.png"])

    def test_subprocess_pipe_responds_after_one_line_and_stays_alive(self):
        script = textwrap.dedent(
            f"""
            import pathlib
            import sys
            sys.path.insert(0, {str(ROOT / "src")!r})
            from redraw_full_frame_auditor import text_worker

            class Detector:
                def detect_regions(self, frame_path):
                    return [{{
                        "candidate_id": "text_1",
                        "kind": "text_candidate",
                        "polygon": [{{"x": 0, "y": 0}}, {{"x": 2, "y": 0}}, {{"x": 2, "y": 2}}],
                        "confidence": 1,
                    }}]

            raise SystemExit(text_worker.run_jsonl(detector=Detector()))
            """
        )
        proc = subprocess.Popen(
            [str(PYTHON), "-u", "-c", script],
            cwd=str(ROOT),
            text=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            handshake = proc.stdout.readline()
            self.assertEqual(handshake, '{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}\n')

            proc.stdin.write(json.dumps({"request_id": 1, "frame_path": "C:/frames/live.png"}) + "\n")
            proc.stdin.flush()

            response = proc.stdout.readline()
            self.assertEqual(json.loads(response), {
                "request_id": 1,
                "texts": [{
                    "candidate_id": "text_1",
                    "kind": "text_candidate",
                    "polygon": [{"x": 0.0, "y": 0.0}, {"x": 2.0, "y": 0.0}, {"x": 2.0, "y": 2.0}],
                    "confidence": 1.0,
                }],
            })
            self.assertIsNone(proc.poll())

            proc.stdin.close()
            self.assertEqual(proc.wait(timeout=10), 0)
            self.assertEqual(proc.stderr.read(), "")
            proc.stdout.close()
            proc.stderr.close()
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
            if proc.stdout and not proc.stdout.closed:
                proc.stdout.close()
            if proc.stderr and not proc.stderr.closed:
                proc.stderr.close()

    def test_rejects_unknown_request_fields_zero_id_non_contiguous_id_and_empty_path(self):
        bad_inputs = [
            json.dumps({"request_id": 1, "frame_path": "a.png", "extra": True}) + "\n",
            json.dumps({"request_id": 0, "frame_path": "a.png"}) + "\n",
            json.dumps({"request_id": 2, "frame_path": "a.png"}) + "\n",
            json.dumps({"request_id": 1, "frame_path": ""}) + "\n",
            json.dumps({"request_id": text_worker.MAX_SAFE_INTEGER + 1, "frame_path": "a.png"}) + "\n",
        ]
        for stdin_text in bad_inputs:
            with self.subTest(stdin_text=stdin_text):
                code, stdout_lines, stderr, detector = self.run_worker(stdin_text)
                self.assertNotEqual(code, 0)
                self.assertEqual(stdout_lines, ['{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}'])
                self.assertEqual(stderr, "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
                self.assertEqual(detector.calls, [])

    def test_accepts_maximum_safe_request_id_when_sequence_reaches_it(self):
        stdout = io.StringIO()
        stderr = io.StringIO()
        detector = FakeDetector()

        original_validate = text_worker._validate_request
        try:
            text_worker._validate_request = lambda value, expected: original_validate(value, text_worker.MAX_SAFE_INTEGER)
            code = text_worker.run_jsonl(
                stdin=io.StringIO(json.dumps({"request_id": text_worker.MAX_SAFE_INTEGER, "frame_path": "a.png"}) + "\n"),
                stdout=stdout,
                stderr=stderr,
                detector=detector,
            )
        finally:
            text_worker._validate_request = original_validate

        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue().splitlines()[1])["request_id"], text_worker.MAX_SAFE_INTEGER)
        self.assertEqual(stderr.getvalue(), "")

    def test_eof_after_handshake_exits_successfully(self):
        code, stdout_lines, stderr, _detector = self.run_worker("")

        self.assertEqual(code, 0)
        self.assertEqual(stdout_lines, ['{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}'])
        self.assertEqual(stderr, "")

    def test_model_load_failure_writes_only_sanitized_stderr(self):
        def fail_load(_model_artifact):
            raise RuntimeError("C:/secret/model")

        original_load_detector = text_worker.load_detector
        try:
            text_worker.load_detector = fail_load
            stdout = io.StringIO()
            stderr = io.StringIO()
            code = text_worker.run_jsonl(
                stdin=io.StringIO(""),
                stdout=stdout,
                stderr=stderr,
                model_lock="C:/secret/model",
            )
        finally:
            text_worker.load_detector = original_load_detector

        self.assertNotEqual(code, 0)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
        self.assertNotIn("secret", stderr.getvalue())

    def test_rejects_missing_newline_illegal_json_and_non_contiguous_followup(self):
        bad_inputs = [
            json.dumps({"request_id": 1, "frame_path": "a.png"}),
            "{not json}\n",
            json.dumps({"request_id": 1, "frame_path": "a.png"}) + "\n" + json.dumps({"request_id": 3, "frame_path": "b.png"}) + "\n",
        ]
        for stdin_text in bad_inputs:
            with self.subTest(stdin_text=stdin_text):
                code, stdout_lines, stderr, _detector = self.run_worker(stdin_text)
                self.assertNotEqual(code, 0)
                self.assertEqual(stdout_lines[0], '{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}')
                self.assertEqual(stderr, "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")

    def test_rejects_ocr_path_unknown_output_fields_bad_polygon_and_bad_confidence(self):
        bad_outputs = [
            [{"candidate_id": "text_1", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "confidence": 1, "text": "leak"}],
            [{"candidate_id": "text_1", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "confidence": 1, "ocr_text": "leak"}],
            [{"candidate_id": "text_1", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "confidence": 1, "recognized_text": "leak"}],
            [{"candidate_id": "text_1", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "confidence": 1, "frame_path": "C:/secret.png"}],
            [{"candidate_id": "text_1", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "confidence": 1, "unknown": True}],
            [{"candidate_id": "text_1", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 1, "y": 1}, {"x": 2, "y": 2}], "confidence": 1}],
            [{"candidate_id": "text_1", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "confidence": float("nan")}],
        ]
        for output in bad_outputs:
            with self.subTest(output=output):
                code, stdout_lines, stderr, _detector = self.run_worker(
                    json.dumps({"request_id": 1, "frame_path": "C:/secret.png"}) + "\n",
                    detector=FakeDetector(output),
                )
                self.assertNotEqual(code, 0)
                self.assertEqual(stdout_lines, ['{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}'])
                self.assertEqual(stderr, "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
                self.assertNotIn("secret", stderr)

    def test_cli_accepts_only_run_model_lock_and_unknown_arguments_are_sanitized(self):
        proc = subprocess.run(
            [str(PYTHON), "-m", "redraw_full_frame_auditor.text_worker", "--unknown", "C:/secret/model"],
            cwd=str(ROOT),
            env={**os.environ, "PYTHONPATH": str(ROOT / "src")},
            text=True,
            input="",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )

        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")
        self.assertEqual(proc.stderr, "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
        self.assertNotIn("secret", proc.stderr)
        self.assertNotIn("usage:", proc.stderr.lower())

        direct_proc = subprocess.run(
            [str(PYTHON), str(ROOT / "src" / "redraw_full_frame_auditor" / "text_worker.py"), "--unknown", "C:/secret/model"],
            cwd=str(ROOT),
            env={**os.environ, "PYTHONPATH": str(ROOT / "src")},
            text=True,
            input="",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        self.assertNotEqual(direct_proc.returncode, 0)
        self.assertEqual(direct_proc.stdout, "")
        self.assertEqual(direct_proc.stderr, "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
        self.assertNotIn("secret", direct_proc.stderr)
        self.assertNotIn("usage:", direct_proc.stderr.lower())

        args = text_worker.parse_args(["run", "--model-lock", "C:/locks/model-lock.json"])
        self.assertEqual(args.model_lock, "C:/locks/model-lock.json")
        with self.assertRaises(worker.ProtocolError):
            text_worker.parse_args(["--model-artifact", "C:/secret/model"])
        with self.assertRaises(worker.ProtocolError):
            text_worker.parse_args(["run", "--model-lock", "C:/secret/lock.json", "--extra"])

    def test_load_detector_validates_model_lock_and_binds_text_component_only(self):
        events = []

        def fake_factory(artifact_path):
            print("stderr load noise", file=sys.stderr)
            events.append(("factory", pathlib.Path(artifact_path).name))
            return worker.PaddleTextDetectionContext(cv2=object(), detector=lambda _image: [])

        class FakeAdapter:
            def __init__(self, artifact_path, factory):
                events.append(("adapter", pathlib.Path(artifact_path).name, factory is fake_factory))
                self.context = factory(artifact_path)

        def fake_validate(model_lock):
            events.append(("validate", pathlib.Path(model_lock).name))
            return {}, {
                "text_detector": {"artifact_abs_path": "C:/models/text-det.zip"},
                "person_detector": {"artifact_abs_path": "C:/models/person.bin"},
                "face_detector": {"artifact_abs_path": "C:/models/face.task"},
                "tracker": {"artifact_abs_path": "C:/models/tracker.py"},
            }

        original_validate = text_worker.worker._validate_model_lock
        original_factory = text_worker.worker._default_text_detector_factory
        original_adapter = text_worker.worker.PaddleTextDetectionAdapter
        try:
            text_worker.worker._validate_model_lock = fake_validate
            text_worker.worker._default_text_detector_factory = fake_factory
            text_worker.worker.PaddleTextDetectionAdapter = FakeAdapter
            with tempfile.TemporaryDirectory() as root:
                stdout = io.StringIO()
                stderr = io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    detector = text_worker.load_detector(str(pathlib.Path(root) / "model-lock.json"))
        finally:
            text_worker.worker._validate_model_lock = original_validate
            text_worker.worker._default_text_detector_factory = original_factory
            text_worker.worker.PaddleTextDetectionAdapter = original_adapter

        self.assertIsInstance(detector, FakeAdapter)
        self.assertEqual(events, [
            ("validate", "model-lock.json"),
            ("adapter", "text-det.zip", True),
            ("factory", "text-det.zip"),
        ])
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")

    def test_load_and_detect_logs_over_one_mib_fail_closed_without_leaking_paths(self):
        def noisy_load(_model_lock):
            print("é" * ((1024 * 1024 // 2) + 1))
            raise AssertionError("factory should not be reached after log overflow C:/secret/model")

        original_validate = text_worker.worker._validate_model_lock
        original_factory = text_worker.worker._default_text_detector_factory
        try:
            text_worker.worker._validate_model_lock = lambda _model_lock: ({}, {"text_detector": {"artifact_abs_path": "C:/secret/model"}})
            text_worker.worker._default_text_detector_factory = noisy_load
            stdout = io.StringIO()
            stderr = io.StringIO()
            code = text_worker.run_jsonl(
                stdin=io.StringIO(""),
                stdout=stdout,
                stderr=stderr,
                model_lock="C:/secret/lock.json",
            )
        finally:
            text_worker.worker._validate_model_lock = original_validate
            text_worker.worker._default_text_detector_factory = original_factory

        self.assertNotEqual(code, 0)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
        self.assertNotIn("secret", stderr.getvalue())

        class NoisyDetector:
            def detect_regions(self, _frame_path):
                print("é" * ((1024 * 1024 // 2) + 1), file=sys.stderr)
                return []

        code, stdout_lines, stderr, _detector = self.run_worker(
            json.dumps({"request_id": 1, "frame_path": "C:/secret/frame.png"}) + "\n",
            detector=NoisyDetector(),
        )

        self.assertNotEqual(code, 0)
        self.assertEqual(stdout_lines, ['{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}'])
        self.assertEqual(stderr, "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
        self.assertNotIn("secret", stderr)


if __name__ == "__main__":
    unittest.main()
