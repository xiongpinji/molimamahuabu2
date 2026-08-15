import argparse
import copy
import io
import json
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

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


class WorkerProtocolTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
