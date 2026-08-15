import argparse
import copy
import hashlib
import io
import json
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import redraw_full_frame_auditor
from redraw_full_frame_auditor import worker


class FakePersonDetector:
    def __init__(self, result=None, loaded=True):
        self.result = result or []
        self.loaded = loaded
        self.calls = []

    def detect(self, frame_path):
        self.calls.append(frame_path)
        if not self.loaded:
            raise RuntimeError("model missing at C:/secret/model.bin")
        return copy.deepcopy(self.result)


class FakeFaceDetector:
    def __init__(self, result=None):
        self.result = result or []
        self.calls = []

    def detect(self, frame_path):
        self.calls.append(frame_path)
        return copy.deepcopy(self.result)


class FakeTextDetector:
    def __init__(self, result=None):
        self.result = result or []
        self.calls = []

    def detect_regions(self, frame_path):
        self.calls.append(frame_path)
        return copy.deepcopy(self.result)


class FakeTracker:
    def __init__(self, result=None):
        self.result = result or []
        self.calls = []

    def update(self, frame_index, persons):
        self.calls.append((frame_index, copy.deepcopy(persons)))
        return copy.deepcopy(self.result)


class FakeDetectors:
    def __init__(self, persons=None, tracked=None, faces=None, texts=None, person_loaded=True):
        self.person = FakePersonDetector(persons, loaded=person_loaded)
        self.face = FakeFaceDetector(faces)
        self.text = FakeTextDetector(texts)
        self.tracker = FakeTracker(tracked)


def valid_frame(index=2):
    return {
        "frame_index": index,
        "timestamp_ms": 120,
        "frame_path": "fixture/frame.png",
    }


def write_model_lock(root):
    components = []
    for component in ["face_detector", "person_detector", "text_detector", "tracker"]:
        artifact_path = pathlib.Path("models") / component / "model.bin"
        license_path = pathlib.Path("licenses") / component / "LICENSE.txt"
        artifact_bytes = f"{component}:artifact".encode("utf-8")
        license_bytes = f"{component}:license".encode("utf-8")
        artifact_target = pathlib.Path(root) / artifact_path
        license_target = pathlib.Path(root) / license_path
        artifact_target.parent.mkdir(parents=True, exist_ok=True)
        license_target.parent.mkdir(parents=True, exist_ok=True)
        artifact_target.write_bytes(artifact_bytes)
        license_target.write_bytes(license_bytes)
        components.append({
            "component": component,
            "project": {
                "face_detector": "MediaPipe face detection",
                "person_detector": "YOLOX",
                "text_detector": "PaddleOCR",
                "tracker": "ByteTrack",
            }[component],
            "repository": {
                "face_detector": "google-ai-edge/mediapipe",
                "person_detector": "Megvii-BaseDetection/YOLOX",
                "text_detector": "PaddlePaddle/PaddleOCR",
                "tracker": "FoundationVision/ByteTrack",
            }[component],
            "revision": f"fixed-{component}-20260815",
            "artifact_name": "model.bin",
            "artifact_path": artifact_path.as_posix(),
            "artifact_sha256": hashlib.sha256(artifact_bytes).hexdigest(),
            "license_name": "LICENSE.txt",
            "license_evidence_path": license_path.as_posix(),
            "license_evidence_sha256": hashlib.sha256(license_bytes).hexdigest(),
        })
    lock = {
        "schema_version": "redraw-full-frame-model-lock-v1",
        "runtime": {"python_version": "3.11.9"},
        "components": components,
    }
    lock_path = pathlib.Path(root) / "model-lock.json"
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    return lock_path


class FakeFactory:
    def __init__(self):
        self.calls = []

    def person(self, artifact_path):
        self.calls.append(("person", pathlib.Path(artifact_path).name))

        class PersonModel:
            def detect(self, frame_path):
                return [
                    {"class_id": 0, "bbox": {"x": 1, "y": 2, "width": 3, "height": 4}, "confidence": 0.9},
                    {"class_id": 1, "bbox": {"x": 10, "y": 20, "width": 30, "height": 40}, "confidence": 0.8},
                ]

        return PersonModel()

    def tracker(self, artifact_path):
        self.calls.append(("tracker", pathlib.Path(artifact_path).name))

        class TrackerModel:
            def update(self, frame_index, persons):
                return [
                    {
                        "candidate_id": "person_1",
                        "track_key": f"track_{frame_index}_1",
                        "kind": "person_candidate",
                        "bbox": persons[0]["bbox"],
                        "confidence": persons[0]["confidence"],
                    }
                ]

        return TrackerModel()

    def face(self, artifact_path):
        self.calls.append(("face", pathlib.Path(artifact_path).name))

        class FaceModel:
            def detect(self, frame_path):
                return [{"candidate_id": "face_1", "kind": "face_candidate", "bbox": {"x": 5, "y": 6, "width": 7, "height": 8}, "confidence": 0.7}]

        return FaceModel()

    def text_detector(self, artifact_path):
        self.calls.append(("text_detector", pathlib.Path(artifact_path).name))

        class TextModel:
            def detect_regions(self, frame_path):
                return [{"candidate_id": "text_1", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 3, "y": 0}, {"x": 0, "y": 3}], "confidence": 0.6}]

        return TextModel()

    def paddle_ocr(self, artifact_path):
        self.calls.append(("paddle_ocr", pathlib.Path(artifact_path).name))
        raise AssertionError("recognition pipeline must not be used")


class WorkerProtocolTests(unittest.TestCase):
    def test_package_exports_public_worker_api(self):
        self.assertIs(redraw_full_frame_auditor.detect_frame, worker.detect_frame)
        self.assertIs(redraw_full_frame_auditor.sanitize_result, worker.sanitize_result)
        self.assertIs(redraw_full_frame_auditor.parse_args, worker.parse_args)
        self.assertIs(redraw_full_frame_auditor.run_jsonl, worker.run_jsonl)
        self.assertIs(redraw_full_frame_auditor.bootstrap_models, worker.bootstrap_models)
        self.assertIs(redraw_full_frame_auditor.main, worker.main)
        self.assertEqual(redraw_full_frame_auditor.__all__, [
            "detect_frame",
            "sanitize_result",
            "parse_args",
            "run_jsonl",
            "bootstrap_models",
            "main",
        ])

    def test_detect_frame_normalizes_and_sorts_candidates_without_leaking_source_fields(self):
        detectors = FakeDetectors(
            persons=[
                {"bbox": {"x": 30, "y": 10, "width": 20, "height": 40}, "confidence": 0.7},
            ],
            tracked=[
                {"candidate_id": "person_b", "track_key": "track_2", "kind": "person_candidate", "bbox": {"x": 15, "y": 10, "width": 5, "height": 7}, "confidence": 0.6},
                {"candidate_id": "person_a", "track_key": "track_1", "kind": "person_candidate", "bbox": {"x": 1, "y": 2, "width": 3, "height": 4}, "confidence": 0.9},
            ],
            faces=[
                {"candidate_id": "face_2", "kind": "face_candidate", "bbox": {"x": 10, "y": 1, "width": 4, "height": 4}, "confidence": 0.5},
                {"candidate_id": "face_1", "kind": "face_candidate", "bbox": {"x": 2, "y": 2, "width": 4, "height": 4}, "confidence": 0.8},
            ],
            texts=[
                {"candidate_id": "text_2", "kind": "text_candidate", "polygon": [{"x": 5, "y": 1}, {"x": 8, "y": 1}, {"x": 8, "y": 4}], "confidence": 0.6},
                {"candidate_id": "text_1", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 4, "y": 0}, {"x": 0, "y": 3}], "confidence": 0.9},
            ],
        )
        frame = valid_frame()
        before = copy.deepcopy(frame)

        result = worker.detect_frame(frame, detectors)
        again = worker.detect_frame(frame, detectors)

        self.assertEqual(frame, before)
        self.assertEqual(result, again)
        self.assertEqual(detectors.person.calls[0], frame["frame_path"])
        self.assertEqual(detectors.face.calls[0], frame["frame_path"])
        self.assertEqual(detectors.text.calls[0], frame["frame_path"])
        self.assertEqual(detectors.tracker.calls[0][0], frame["frame_index"])
        self.assertEqual([item["candidate_id"] for item in result["persons"]], ["person_a", "person_b"])
        self.assertEqual([item["candidate_id"] for item in result["faces"]], ["face_1", "face_2"])
        self.assertEqual([item["candidate_id"] for item in result["texts"]], ["text_1", "text_2"])
        serialized = json.dumps(result, sort_keys=True)
        self.assertNotIn("frame_path", serialized)
        self.assertNotIn("secret OCR", serialized)
        self.assertEqual(result["frame_index"], frame["frame_index"])

    def test_rejects_invalid_input_and_detector_shapes_fail_closed(self):
        detectors = FakeDetectors(
            tracked=[
                {"candidate_id": "person_a", "track_key": "track_1", "kind": "person_candidate", "bbox": {"x": 0, "y": 0, "width": 10, "height": 10}, "confidence": 1},
            ],
        )
        for bad_frame in [
            {"frame_index": -1, "timestamp_ms": 1, "frame_path": "a.png"},
            {"frame_index": 1, "timestamp_ms": -1, "frame_path": "a.png"},
            {"frame_index": 1, "timestamp_ms": 1, "frame_path": ""},
            {"frame_index": 1, "timestamp_ms": 1, "frame_path": "a.png", "extra": True},
        ]:
            with self.subTest(bad_frame=bad_frame):
                with self.assertRaises(worker.ProtocolError):
                    worker.detect_frame(bad_frame, detectors)

        invalid_detector_cases = [
            FakeDetectors(tracked=[{"candidate_id": "person_a", "track_key": "track_1", "kind": "person_candidate", "bbox": {"x": 0, "y": 0, "width": 0, "height": 10}, "confidence": 1}]),
            FakeDetectors(faces=[{"candidate_id": "face_a", "kind": "face_candidate", "bbox": {"x": 0, "y": 0, "width": 1, "height": 1}, "confidence": float("nan")}]),
            FakeDetectors(texts=[{"candidate_id": "text_a", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 1, "y": 1}, {"x": 2, "y": 2}], "confidence": 1}]),
            FakeDetectors(texts=[{"candidate_id": "text_a", "kind": "text_candidate", "polygon": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "confidence": 1, "text": "secret OCR"}]),
            FakeDetectors(faces=[{"candidate_id": "face_a", "kind": "face_candidate", "bbox": {"x": 0, "y": 0, "width": 1, "height": 1}, "confidence": 1, "extra": True}]),
            FakeDetectors(tracked=[{"candidate_id": "person_a", "track_key": "track_1", "kind": "other", "bbox": {"x": 0, "y": 0, "width": 1, "height": 1}, "confidence": 1}]),
            FakeDetectors(person_loaded=False),
        ]
        for bad_detectors in invalid_detector_cases:
            with self.subTest(bad_detectors=bad_detectors):
                with self.assertRaises(worker.ProtocolError):
                    worker.detect_frame(valid_frame(), bad_detectors)

    def test_run_jsonl_writes_one_response_per_frame_and_sanitizes_failures(self):
        detectors = FakeDetectors(
            tracked=[
                {"candidate_id": "person_a", "track_key": "track_1", "kind": "person_candidate", "bbox": {"x": 1, "y": 2, "width": 3, "height": 4}, "confidence": 0.9},
            ],
        )
        args = argparse.Namespace(
            stdin=io.StringIO(json.dumps(valid_frame(7)) + "\n"),
            stdout=io.StringIO(),
            stderr=io.StringIO(),
            model_lock="fixture-lock.json",
        )

        code = worker.run_jsonl(args, detectors=detectors)

        self.assertEqual(code, 0)
        rows = [json.loads(line) for line in args.stdout.getvalue().splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["frame_index"], 7)
        self.assertEqual(args.stderr.getvalue(), "")

        bad_args = argparse.Namespace(
            stdin=io.StringIO("{not json C:/secret/frame.png}\n"),
            stdout=io.StringIO(),
            stderr=io.StringIO(),
            model_lock="fixture-lock.json",
        )
        self.assertNotEqual(worker.run_jsonl(bad_args, detectors=detectors), 0)
        self.assertEqual(bad_args.stdout.getvalue(), "")
        self.assertEqual(bad_args.stderr.getvalue().strip(), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE")
        self.assertNotIn("secret", bad_args.stderr.getvalue())

    def test_real_loader_assembles_four_adapters_from_validated_model_lock_without_recognition_pipeline(self):
        with tempfile.TemporaryDirectory() as root:
            lock_path = write_model_lock(root)
            factories = FakeFactory()
            detectors = worker._load_real_detectors(str(lock_path), factories=factories)
            result = worker.detect_frame(valid_frame(3), detectors)

        self.assertEqual([call[0] for call in factories.calls], ["person", "tracker", "face", "text_detector"])
        self.assertEqual(result["persons"][0]["track_key"], "track_3_1")
        self.assertEqual(result["faces"][0]["candidate_id"], "face_1")
        self.assertEqual(result["texts"][0]["candidate_id"], "text_1")

    def test_bootstrap_models_uses_same_loader_and_reports_only_sanitized_success(self):
        with tempfile.TemporaryDirectory() as root:
            lock_path = write_model_lock(root)
            factories = FakeFactory()
            args = argparse.Namespace(model_lock=str(lock_path))
            result = worker.bootstrap_models(args, factories=factories)

        self.assertEqual(result, {
            "status": "ok",
            "schema_version": "redraw-full-frame-model-lock-v1",
            "components": ["face_detector", "person_detector", "text_detector", "tracker"],
        })
        self.assertEqual([call[0] for call in factories.calls], ["person", "tracker", "face", "text_detector"])
        self.assertNotIn(str(lock_path), json.dumps(result))

    def test_cli_argument_errors_are_sanitized_and_help_still_works(self):
        help_stdout = io.StringIO()
        old_stdout = sys.stdout
        try:
            sys.stdout = help_stdout
            self.assertEqual(worker.main(["--help"]), 0)
        finally:
            sys.stdout = old_stdout
        self.assertIn("usage:", help_stdout.getvalue())

        for argv in [
            ["run"],
            ["run", "--unknown", "C:/secret/frame.png"],
            ["run", "--model-lock", "a.json", "--model-lock", "C:/secret/lock.json"],
            ["bootstrap", "--model-lock=C:/secret/a.json", "--model-lock=C:/secret/b.json"],
        ]:
            stderr = io.StringIO()
            old_stderr = sys.stderr
            try:
                sys.stderr = stderr
                self.assertNotEqual(worker.main(argv), 0)
            finally:
                sys.stderr = old_stderr
            self.assertEqual(stderr.getvalue().strip(), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE")
            self.assertNotIn("secret", stderr.getvalue())
            self.assertNotIn("usage:", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
