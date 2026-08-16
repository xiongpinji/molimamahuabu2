import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
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

    def test_rejects_unknown_request_fields_zero_id_non_contiguous_id_and_empty_path(self):
        bad_inputs = [
            json.dumps({"request_id": 1, "frame_path": "a.png", "extra": True}) + "\n",
            json.dumps({"request_id": 0, "frame_path": "a.png"}) + "\n",
            json.dumps({"request_id": 2, "frame_path": "a.png"}) + "\n",
            json.dumps({"request_id": 1, "frame_path": ""}) + "\n",
        ]
        for stdin_text in bad_inputs:
            with self.subTest(stdin_text=stdin_text):
                code, stdout_lines, stderr, detector = self.run_worker(stdin_text)
                self.assertNotEqual(code, 0)
                self.assertEqual(stdout_lines, ['{"status":"ok","schema_version":"redraw-full-frame-text-subprocess-v1"}'])
                self.assertEqual(stderr, "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
                self.assertEqual(detector.calls, [])

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
                model_artifact="C:/secret/model",
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

    def test_cli_unknown_arguments_fail_without_leaking_usage_or_paths(self):
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

    def test_load_detector_binds_text_component_only_with_bounded_log_discard(self):
        events = []

        def fake_factory(artifact_path):
            print("x" * (1024 * 1024 + 32))
            print("stderr load noise", file=sys.stderr)
            events.append(("factory", pathlib.Path(artifact_path).name))
            return worker.PaddleTextDetectionContext(cv2=object(), detector=lambda _image: [])

        class FakeAdapter:
            def __init__(self, artifact_path, factory):
                events.append(("adapter", pathlib.Path(artifact_path).name, factory is fake_factory))
                self.context = factory(artifact_path)

        original_factory = text_worker.worker._default_text_detector_factory
        original_adapter = text_worker.worker.PaddleTextDetectionAdapter
        try:
            text_worker.worker._default_text_detector_factory = fake_factory
            text_worker.worker.PaddleTextDetectionAdapter = FakeAdapter
            with tempfile.TemporaryDirectory() as root:
                stdout = io.StringIO()
                stderr = io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    detector = text_worker.load_detector(str(pathlib.Path(root) / "paddle-det.zip"))
        finally:
            text_worker.worker._default_text_detector_factory = original_factory
            text_worker.worker.PaddleTextDetectionAdapter = original_adapter

        self.assertIsInstance(detector, FakeAdapter)
        self.assertEqual(events, [
            ("adapter", "paddle-det.zip", True),
            ("factory", "paddle-det.zip"),
        ])
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
