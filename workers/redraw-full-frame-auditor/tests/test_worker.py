import argparse
import copy
import hashlib
import io
import json
import pathlib
import sys
import tempfile
import unittest
import zipfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import redraw_full_frame_auditor
from redraw_full_frame_auditor import text_subprocess
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
        self.events = []

    def person(self, artifact_path):
        self.calls.append(("person", pathlib.Path(artifact_path).name))
        events = self.events

        class FakeImage:
            shape = (100, 200, 3)

        class FakeTensor:
            def unsqueeze(self, dim):
                events.append(("tensor_unsqueeze", dim))
                return self

            def float(self):
                events.append(("tensor_float",))
                return self

        class FakeTorch:
            def from_numpy(self, value):
                events.append(("torch_from_numpy", value))
                return FakeTensor()

            class _NoGrad:
                def __enter__(self):
                    events.append(("no_grad_enter",))

                def __exit__(self, exc_type, exc, tb):
                    events.append(("no_grad_exit",))

            def no_grad(self):
                return self._NoGrad()

        class FakeModel:
            def detect(self, frame_path):
                raise AssertionError("YOLOX adapter must not call custom detect")

            def __call__(self, tensor):
                events.append(("model_call", tensor.__class__.__name__))
                return "raw-yolox-output"

        def transform(image, _target, input_size):
            events.append(("val_transform", image.shape, input_size))
            return "transformed-image", None

        def postprocess(raw, num_classes, conf, nms):
            events.append(("postprocess", raw, num_classes, conf, nms))
            return [[
                [10, 20, 50, 70, 0.8, 0.5, 0],
                [1, 2, 9, 10, 0.9, 0.9, 1],
            ]]

        class FakeCv2:
            def imread(self, frame_path):
                events.append(("cv2_imread_person", frame_path))
                return FakeImage()

        return worker.YOLOXInferenceContext(
            cv2=FakeCv2(),
            torch=FakeTorch(),
            model=FakeModel(),
            transform=transform,
            postprocess=postprocess,
            input_size=(100, 200),
            conf=0.25,
            nms=0.45,
            num_classes=80,
        )

    def tracker(self, artifact_path):
        self.calls.append(("tracker", pathlib.Path(artifact_path).name))
        events = self.events

        class Target:
            tlwh = [10, 20, 40, 50]
            track_id = 42
            score = 0.4

        class ByteTracker:
            def update(self, dets, img_info, img_size):
                events.append(("bytetrack_update", dets, img_info, img_size))
                return [Target()]

        return ByteTracker()

    def face(self, artifact_path):
        self.calls.append(("face", pathlib.Path(artifact_path).name))
        events = self.events

        class FakeImage:
            shape = (100, 200, 3)

        class FakeCv2:
            COLOR_BGR2RGB = 4

            def imread(self, frame_path):
                events.append(("cv2_imread_face", frame_path))
                return FakeImage()

            def cvtColor(self, image, code):
                events.append(("cvtColor", image.shape, code))
                return "rgb-image"

        class BoundingBox:
            origin_x = 20
            origin_y = 30
            width = 40
            height = 50

        class Category:
            score = 0.95

        class Detection:
            bounding_box = BoundingBox()
            categories = [Category()]

        class FaceModel:
            artifact_path_seen = artifact_path

            def process(self, image):
                raise AssertionError("MediaPipe Tasks adapter must call detect")

            def detect(self, image):
                events.append(("mediapipe_tasks_detect", image.image_format, image.data, self.artifact_path_seen))
                return type("Result", (), {"detections": [Detection()]})()

        class MpImage:
            def __init__(self, image_format, data):
                self.image_format = image_format
                self.data = data

        return worker.MediaPipeFaceContext(
            cv2=FakeCv2(),
            image_class=MpImage,
            image_format="SRGB",
            detector=FaceModel(),
        )

    def paddle_ocr(self, artifact_path):
        self.calls.append(("paddle_ocr", pathlib.Path(artifact_path).name))
        raise AssertionError("recognition pipeline must not be used")


class WorkerProtocolTests(unittest.TestCase):
    def assert_trusted_stage(self, action, expected_stage):
        with self.assertRaises(worker.ProtocolError) as raised:
            action()
        error = raised.exception
        self.assertEqual(str(error), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE")
        self.assertEqual(worker._trusted_stage(error), expected_stage)
        self.assertIsNone(error.__cause__)
        self.assertNotIn("private", repr(error).lower())
        self.assertNotIn("authorization", repr(error).lower())
        return error

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
        close_events = []
        detectors.text.close = lambda: close_events.append("success-close")
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
        self.assertEqual(close_events, ["success-close"])

        bad_detectors = FakeDetectors()
        bad_detectors.text.close = lambda: close_events.append("failure-close")
        bad_args = argparse.Namespace(
            stdin=io.StringIO("{not json C:/secret/frame.png}\n"),
            stdout=io.StringIO(),
            stderr=io.StringIO(),
            model_lock="fixture-lock.json",
        )
        self.assertNotEqual(worker.run_jsonl(bad_args, detectors=bad_detectors), 0)
        self.assertEqual(bad_args.stdout.getvalue(), "")
        self.assertEqual(bad_args.stderr.getvalue().strip(), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE")
        self.assertNotIn("secret", bad_args.stderr.getvalue())
        self.assertEqual(close_events, ["success-close", "failure-close"])

    def test_run_jsonl_sanitizes_text_process_close_failure(self):
        detectors = FakeDetectors()

        def fail_close():
            raise RuntimeError("C:/private/model-lock.json Authorization: secret")

        detectors.text.close = fail_close
        args = argparse.Namespace(
            stdin=io.StringIO(""),
            stdout=io.StringIO(),
            stderr=io.StringIO(),
            model_lock="fixture-lock.json",
        )

        self.assertEqual(worker.run_jsonl(args, detectors=detectors), 1)
        self.assertEqual(args.stdout.getvalue(), "")
        self.assertEqual(args.stderr.getvalue(), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE\n")
        self.assertNotIn("private", args.stderr.getvalue().lower())
        self.assertNotIn("authorization", args.stderr.getvalue().lower())

    def test_real_loader_assembles_four_adapters_from_validated_model_lock_without_recognition_pipeline(self):
        text = FakeTextDetector([{
            "candidate_id": "text_1",
            "kind": "text_candidate",
            "polygon": [{"x": 0, "y": 0}, {"x": 3, "y": 0}, {"x": 3, "y": 3}],
            "confidence": 1.0,
        }])
        with tempfile.TemporaryDirectory() as root:
            lock_path = write_model_lock(root)
            factories = FakeFactory()
            detectors = worker._load_real_detectors(
                str(lock_path),
                factories=factories,
                text_process_factory=lambda **_kwargs: text,
            )
            result = worker.detect_frame(valid_frame(3), detectors)

        self.assertEqual([call[0] for call in factories.calls], ["person", "tracker", "face"])
        self.assertIn(("model_call", "FakeTensor"), factories.events)
        self.assertIn(("postprocess", "raw-yolox-output", 80, 0.25, 0.45), factories.events)
        bytetrack_event = next(event for event in factories.events if event[0] == "bytetrack_update")
        dets = bytetrack_event[1].tolist() if hasattr(bytetrack_event[1], "tolist") else bytetrack_event[1]
        self.assertEqual(dets, [[10.0, 20.0, 50.0, 70.0, 0.4]])
        face_artifact = next(call for call in factories.calls if call[0] == "face")[1]
        self.assertIn(("mediapipe_tasks_detect", "SRGB", "rgb-image", str(pathlib.Path(root) / "models" / "face_detector" / face_artifact)), factories.events)
        self.assertEqual(text.calls, ["fixture/frame.png"])
        self.assertEqual(result["persons"][0]["track_key"], "track_42")
        self.assertEqual(result["persons"][0]["bbox"], {"x": 10.0, "y": 20.0, "width": 40.0, "height": 50.0})
        self.assertEqual(result["faces"][0]["bbox"], {"x": 20.0, "y": 30.0, "width": 40.0, "height": 50.0})
        self.assertEqual(result["texts"][0]["confidence"], 1.0)
        self.assertEqual(result["faces"][0]["candidate_id"], "face_1")
        self.assertEqual(result["texts"][0]["candidate_id"], "text_1")
        self.assertNotIn("_frame_width", json.dumps(result))
        self.assertNotIn("_frame_height", json.dumps(result))

    def test_default_loader_uses_text_process_and_closes_it(self):
        events = []

        class FakeTextProcess(FakeTextDetector):
            def close(self):
                events.append("text-close")

        factories = FakeFactory()
        original_text_factory = worker._default_text_detector_factory
        try:
            worker._default_text_detector_factory = lambda _path: self.fail("main worker loaded Paddle")
            with tempfile.TemporaryDirectory() as root:
                lock_path = write_model_lock(root)

                def text_process_factory(**kwargs):
                    self.assertEqual(kwargs, {"model_lock_path": str(lock_path)})
                    factories.calls.append(("text-process", pathlib.Path(kwargs["model_lock_path"]).name))
                    return FakeTextProcess()

                detectors = worker._load_real_detectors(
                    str(lock_path),
                    factories=factories,
                    text_process_factory=text_process_factory,
                )
                worker._close_detectors(detectors)
        finally:
            worker._default_text_detector_factory = original_text_factory

        self.assertEqual(
            [call[0] for call in factories.calls],
            ["person", "tracker", "face", "text-process"],
        )
        self.assertEqual(events, ["text-close"])
        self.assertFalse(hasattr(worker._default_factories(), "text_detector"))

    def test_real_loader_marks_each_trusted_component_stage_and_rejects_spoofing(self):
        with tempfile.TemporaryDirectory() as root:
            lock_path = write_model_lock(root)

            invalid_lock = pathlib.Path(root) / "invalid-lock.json"
            invalid_lock.write_text("{private Authorization", encoding="utf-8")
            self.assert_trusted_stage(
                lambda: worker._load_real_detectors(str(invalid_lock)),
                "validate_lock",
            )

            for name, expected_stage in (
                ("person", "load:person"),
                ("tracker", "load:tracker"),
                ("face", "load:face"),
            ):
                with self.subTest(name=name):
                    factories = FakeFactory()
                    spoof = worker.ProtocolError(
                        "C:/private/model-lock.json Authorization: secret",
                        stage="load:text",
                    )

                    def fail_factory(_artifact_path, error=spoof):
                        raise error

                    setattr(factories, name, fail_factory)
                    self.assert_trusted_stage(
                        lambda factories=factories: worker._load_real_detectors(
                            str(lock_path),
                            factories=factories,
                            text_process_factory=lambda **_kwargs: FakeTextDetector(),
                        ),
                        expected_stage,
                    )

            factories = FakeFactory()

            def fail_text(**_kwargs):
                error = worker.ProtocolError(
                    "C:/private/model-lock.json Authorization: secret",
                    stage="load:person",
                )
                raise error

            self.assert_trusted_stage(
                lambda: worker._load_real_detectors(
                    str(lock_path),
                    factories=factories,
                    text_process_factory=fail_text,
                ),
                "load:text",
            )

    def test_real_loader_maps_only_exact_trusted_text_process_stages(self):
        expected_text_stages = frozenset((
            "validate_lock",
            "import_cv2",
            "import_paddle",
            "build_args",
            "model_dir",
            "detector_init",
            "adapter_init",
            "output_limit",
        ))
        self.assertEqual(worker._TEXT_LOAD_STAGES, expected_text_stages)
        self.assertEqual(len(worker._BOOTSTRAP_STAGES), 22)
        self.assertTrue({f"load:text:{stage}" for stage in expected_text_stages}.issubset(
            worker._BOOTSTRAP_STAGES
        ))

        with tempfile.TemporaryDirectory() as root:
            lock_path = write_model_lock(root)
            for stage in sorted(expected_text_stages):
                with self.subTest(stage=stage):
                    trusted = text_subprocess.TextSubprocessError(
                        worker.ERROR_CODE,
                        stage=stage,
                        _token=text_subprocess._TEXT_STAGE_TOKEN,
                    )
                    self.assertEqual(text_subprocess._trusted_text_stage(trusted), stage)

                    def fail_text(**_kwargs):
                        raise trusted

                    self.assert_trusted_stage(
                        lambda: worker._load_real_detectors(
                            str(lock_path),
                            factories=FakeFactory(),
                            text_process_factory=fail_text,
                        ),
                        f"load:text:{stage}",
                    )

            class SpoofedSubclass(text_subprocess.TextSubprocessError):
                pass

            subclass_spoof = SpoofedSubclass(worker.ERROR_CODE)
            subclass_spoof._trusted_stage = "import_cv2"
            subclass_spoof._stage_token = text_subprocess._TEXT_STAGE_TOKEN
            fallbacks = (
                RuntimeError("C:/private/model-lock.json Authorization: secret"),
                text_subprocess.TextSubprocessError(worker.ERROR_CODE, stage="import_cv2"),
                subclass_spoof,
                worker._stage_error("import_cv2"),
                text_subprocess.TextSubprocessError(
                    worker.ERROR_CODE,
                    stage="unknown",
                    _token=text_subprocess._TEXT_STAGE_TOKEN,
                ),
            )
            for error in fallbacks:
                with self.subTest(fallback=type(error).__name__, trusted=worker._trusted_stage(error)):
                    self.assert_trusted_stage(
                        lambda error=error: worker._load_real_detectors(
                            str(lock_path),
                            factories=FakeFactory(),
                            text_process_factory=lambda **_kwargs: (_ for _ in ()).throw(error),
                        ),
                        "load:text",
                    )

    def test_default_person_factory_loads_yolox_s_exp_for_locked_artifact(self):
        events = []

        class FakeModel:
            def load_state_dict(self, checkpoint):
                events.append(("load_state_dict", checkpoint))

            def eval(self):
                events.append(("eval",))

        class FakeExpModule:
            def get_exp(self, exp_file, exp_name):
                events.append(("get_exp", exp_file, exp_name))
                if (exp_file, exp_name) != (None, "yolox-s"):
                    raise AssertionError("plz provide exp file or exp name")
                return worker.SimpleNamespace(
                    get_model=lambda: FakeModel(),
                    test_size=(640, 640),
                    test_conf=0.3,
                    nmsthre=0.5,
                    num_classes=80,
                )

        class FakeTorch:
            def load(self, artifact_path, map_location):
                events.append(("torch_load", artifact_path, map_location))
                return {"model": {"weight": "locked-yolox-s"}}

        class FakeDataModule:
            class ValTransform:
                def __init__(self, legacy):
                    events.append(("ValTransform", legacy))

        fake_modules = {
            "cv2": worker.SimpleNamespace(),
            "torch": FakeTorch(),
            "yolox.exp": FakeExpModule(),
            "yolox.data.data_augment": FakeDataModule,
            "yolox.utils": worker.SimpleNamespace(postprocess=lambda *_args: []),
        }
        artifact_path = "C:/models/person_detector/yolox_s.pth"
        original_import_module = worker.importlib.import_module
        try:
            worker.importlib.import_module = lambda name: fake_modules[name]
            context = worker._default_person_factory(artifact_path)
        finally:
            worker.importlib.import_module = original_import_module

        self.assertIn(("get_exp", None, "yolox-s"), events)
        self.assertIn(("torch_load", artifact_path, "cpu"), events)
        self.assertIn(("load_state_dict", {"weight": "locked-yolox-s"}), events)
        self.assertIn(("eval",), events)
        self.assertEqual(context.input_size, (640, 640))
        self.assertEqual(context.conf, 0.3)
        self.assertEqual(context.nms, 0.5)

    def test_default_face_factory_uses_mediapipe_tasks_public_api(self):
        events = []

        class FakeBaseOptions:
            def __init__(self, model_asset_path):
                events.append(("BaseOptions", model_asset_path))
                self.model_asset_path = model_asset_path

        class FakeVision:
            class RunningMode:
                IMAGE = "IMAGE"

            class FaceDetectorOptions:
                def __init__(self, base_options, running_mode):
                    events.append(("FaceDetectorOptions", base_options.model_asset_path, running_mode))
                    self.base_options = base_options
                    self.running_mode = running_mode

            class FaceDetector:
                @staticmethod
                def create_from_options(options):
                    events.append(("create_from_options", options.base_options.model_asset_path, options.running_mode))

                    class Detector:
                        def detect(self, _image):
                            return worker.SimpleNamespace(detections=[])

                    return Detector()

        fake_mediapipe = worker.SimpleNamespace(
            tasks=worker.SimpleNamespace(vision=FakeVision, BaseOptions=FakeBaseOptions),
            Image=lambda **kwargs: kwargs,
            ImageFormat=worker.SimpleNamespace(SRGB="SRGB"),
        )
        fake_modules = {
            "cv2": worker.SimpleNamespace(),
            "mediapipe": fake_mediapipe,
        }
        artifact_path = "C:/models/face_detector/blaze_face_short_range.tflite"
        original_import_module = worker.importlib.import_module
        try:
            worker.importlib.import_module = lambda name: fake_modules[name]
            context = worker._default_face_factory(artifact_path)
        finally:
            worker.importlib.import_module = original_import_module

        self.assertIn(("BaseOptions", artifact_path), events)
        self.assertIn(("FaceDetectorOptions", artifact_path, "IMAGE"), events)
        self.assertIn(("create_from_options", artifact_path, "IMAGE"), events)
        self.assertEqual(context.image_format, "SRGB")

    def test_default_text_detector_factory_uses_unique_prepared_paddle_model_dir(self):
        events = []

        class FakeParser:
            def parse_args(self, argv):
                events.append(("parse_args", argv, sys.argv[:]))
                return worker.SimpleNamespace(det_model_dir=None)

        class FakeUtility:
            @staticmethod
            def init_args():
                events.append(("init_args",))
                return FakeParser()

        class FakeTextSystem:
            utility = FakeUtility

            class TextDetector:
                def __init__(self, args):
                    events.append(("TextDetector", pathlib.Path(args.det_model_dir).name))
                    self.args = args

                def __call__(self, _image):
                    return [[[[0, 0], [1, 0], [1, 1]]]]

        fake_modules = {
            "cv2": worker.SimpleNamespace(),
            "paddleocr.tools.infer.predict_det": FakeTextSystem,
        }
        original_import_module = worker.importlib.import_module
        original_argv = sys.argv[:]
        try:
            sys.argv = ["worker.py", "--unexpected-worker-argv"]
            worker.importlib.import_module = lambda name: fake_modules[name]
            with tempfile.TemporaryDirectory() as root:
                archive_path = pathlib.Path(root) / "paddle.zip"
                with zipfile.ZipFile(archive_path, "w") as archive:
                    archive.writestr("en_PP-OCRv3_det_infer/inference.pdmodel", "model")
                    archive.writestr("en_PP-OCRv3_det_infer/inference.pdiparams", "params")

                context = worker._default_text_detector_factory(str(archive_path))
        finally:
            sys.argv = original_argv
            worker.importlib.import_module = original_import_module

        parse_event = next(event for event in events if event[0] == "parse_args")
        self.assertEqual(parse_event[1], [])
        self.assertEqual(parse_event[2], ["worker.py", "--unexpected-worker-argv"])
        self.assertIn(("init_args",), events)
        self.assertIn(("TextDetector", "en_PP-OCRv3_det_infer"), events)
        self.assertTrue(callable(context.detector))

    def test_default_text_detector_factory_rejects_missing_or_ambiguous_prepared_paddle_model_dirs(self):
        fake_modules = {
            "cv2": worker.SimpleNamespace(),
            "paddleocr.tools.infer.predict_det": worker.SimpleNamespace(
                utility=worker.SimpleNamespace(init_args=lambda: argparse.ArgumentParser()),
                TextDetector=lambda _args: (lambda _image: []),
            ),
        }
        original_import_module = worker.importlib.import_module
        try:
            worker.importlib.import_module = lambda name: fake_modules[name]
            with tempfile.TemporaryDirectory() as root:
                missing_path = pathlib.Path(root) / "missing.zip"
                with zipfile.ZipFile(missing_path, "w") as archive:
                    archive.writestr("en_PP-OCRv3_det_infer/README.txt", "no model")
                with self.assertRaises(worker.ProtocolError):
                    worker._default_text_detector_factory(str(missing_path))

                ambiguous_path = pathlib.Path(root) / "ambiguous.zip"
                with zipfile.ZipFile(ambiguous_path, "w") as archive:
                    for name in ["a_det", "b_det"]:
                        archive.writestr(f"{name}/inference.pdmodel", "model")
                        archive.writestr(f"{name}/inference.pdiparams", "params")
                with self.assertRaises(worker.ProtocolError):
                    worker._default_text_detector_factory(str(ambiguous_path))
        finally:
            worker.importlib.import_module = original_import_module

    def test_bytetrack_empty_persons_uses_empty_nx5_detections(self):
        events = []

        class Tracker:
            def update(self, dets, img_info, img_size):
                events.append((getattr(dets, "shape", None), dets.tolist() if hasattr(dets, "tolist") else dets, img_info, img_size))
                return []

        result = worker.ByteTrackAdapter("tracker.zip", lambda _path: Tracker()).update(9, [])

        self.assertEqual(result, [])
        self.assertEqual(events[0][0], (0, 5))
        self.assertEqual(events[0][1], [])

    def test_prepare_artifact_uses_content_hash_and_rejects_stale_marker(self):
        import zipfile
        with tempfile.TemporaryDirectory() as root:
            first = pathlib.Path(root) / "tracker.zip"
            with zipfile.ZipFile(first, "w") as archive:
                archive.writestr("ByteTrack-main/yolox/tracker/byte_tracker.py", "class BYTETracker: pass\n")
            first_prepared = pathlib.Path(worker._prepare_artifact_path(str(first)))
            self.assertIn(hashlib.sha256(first.read_bytes()).hexdigest()[:16], str(first_prepared))
            marker = first_prepared / ".redraw-full-frame-artifact.sha256"
            marker.write_text("stale", encoding="utf-8")
            with self.assertRaises(worker.ProtocolError):
                worker._prepare_artifact_path(str(first))

            second = pathlib.Path(root) / "tracker2.zip"
            with zipfile.ZipFile(second, "w") as archive:
                archive.writestr("ByteTrack-main/yolox/tracker/byte_tracker.py", "class BYTETracker:\n    pass\n")
            second_prepared = pathlib.Path(worker._prepare_artifact_path(str(second)))
            self.assertNotEqual(first_prepared, second_prepared)

    def test_probe_frame_creates_and_removes_64x64_blank_png(self):
        events = []

        class FakeImage:
            shape = (64, 64, 3)

        class FakeNumpy:
            uint8 = "uint8"

            @staticmethod
            def zeros(shape, dtype):
                events.append(("zeros", shape, dtype))
                return FakeImage()

        class FakeCv2:
            @staticmethod
            def imwrite(frame_path, image):
                events.append(("imwrite", pathlib.Path(frame_path).name, image.shape))
                pathlib.Path(frame_path).write_bytes(b"blank-png-fixture")
                return True

        modules = {"cv2": FakeCv2, "numpy": FakeNumpy}
        original_import_module = worker.importlib.import_module
        try:
            worker.importlib.import_module = lambda name: modules[name]
            with worker._probe_frame() as frame_path:
                target = pathlib.Path(frame_path)
                self.assertTrue(target.is_file())
                self.assertEqual(target.read_bytes(), b"blank-png-fixture")
            self.assertFalse(target.exists())
        finally:
            worker.importlib.import_module = original_import_module

        self.assertEqual(events, [
            ("zeros", (64, 64, 3), "uint8"),
            ("imwrite", "probe.png", (64, 64, 3)),
        ])

    def test_default_text_detector_factory_marks_safe_internal_load_stages(self):
        class Parser:
            def parse_args(self, _argv):
                return worker.SimpleNamespace(det_model_dir=None)

        class Utility:
            @staticmethod
            def init_args():
                return Parser()

        class TextDetector:
            def __init__(self, _args):
                pass

            def __call__(self, _image):
                return []

        text_system = worker.SimpleNamespace(utility=Utility, TextDetector=TextDetector)
        original_import_module = worker.importlib.import_module
        try:
            with tempfile.TemporaryDirectory() as root:
                artifact_path = pathlib.Path(root) / "detector.pdmodel"
                artifact_path.write_bytes(b"fixture")

                cases = {
                    "import_cv2": lambda name: (_ for _ in ()).throw(
                        RuntimeError("C:/private/cv2.pyd Authorization: secret")
                    ) if name == "cv2" else text_system,
                    "import_paddle": lambda name: worker.SimpleNamespace() if name == "cv2" else (
                        _ for _ in ()
                    ).throw(RuntimeError("C:/private/paddle.pyd API_KEY=secret")),
                    "build_args": lambda name: worker.SimpleNamespace() if name == "cv2" else worker.SimpleNamespace(
                        utility=worker.SimpleNamespace(
                            init_args=lambda: (_ for _ in ()).throw(
                                RuntimeError("C:/private/args.py Authorization: secret")
                            )
                        ),
                        TextDetector=TextDetector,
                    ),
                    "detector_init": lambda name: worker.SimpleNamespace() if name == "cv2" else worker.SimpleNamespace(
                        utility=Utility,
                        TextDetector=lambda _args: (_ for _ in ()).throw(
                            RuntimeError("C:/private/model.bin Authorization: secret")
                        ),
                    ),
                }
                for expected_stage, importer in cases.items():
                    with self.subTest(expected_stage=expected_stage):
                        worker.importlib.import_module = importer
                        self.assert_trusted_stage(
                            lambda: worker._default_text_detector_factory(str(artifact_path)),
                            expected_stage,
                        )

                worker.importlib.import_module = lambda name: (
                    worker.SimpleNamespace() if name == "cv2" else text_system
                )
                self.assert_trusted_stage(
                    lambda: worker._default_text_detector_factory(str(pathlib.Path(root) / "missing.zip")),
                    "model_dir",
                )
        finally:
            worker.importlib.import_module = original_import_module

    def test_bootstrap_models_uses_same_loader_runs_probe_and_always_closes(self):
        import contextlib

        close_events = []
        text = FakeTextDetector([])
        text.close = lambda: close_events.append("text-close")
        with tempfile.TemporaryDirectory() as root:
            lock_path = write_model_lock(root)
            factories = FakeFactory()
            args = argparse.Namespace(model_lock=str(lock_path))

            def detector_loader(path):
                self.assertEqual(path, str(lock_path))
                return worker._load_real_detectors(
                    path,
                    factories=factories,
                    text_process_factory=lambda **_kwargs: text,
                )

            result = worker.bootstrap_models(
                args,
                detector_loader=detector_loader,
                probe_frame_factory=lambda: contextlib.nullcontext("D:/redraw-local/probe.png"),
            )

        self.assertEqual(result, {
            "status": "ok",
            "schema_version": "redraw-full-frame-model-lock-v1",
            "components": ["face_detector", "person_detector", "text_detector", "tracker"],
        })
        self.assertEqual([call[0] for call in factories.calls], ["person", "tracker", "face"])
        self.assertIn(("cv2_imread_person", "D:/redraw-local/probe.png"), factories.events)
        self.assertIn(("cv2_imread_face", "D:/redraw-local/probe.png"), factories.events)
        self.assertEqual(text.calls, ["D:/redraw-local/probe.png"])
        self.assertEqual(close_events, ["text-close"])
        self.assertNotIn(str(lock_path), json.dumps(result))

    def test_bootstrap_closes_after_probe_failure_and_sanitizes_close_failure(self):
        import contextlib

        close_events = []
        detectors = FakeDetectors(person_loaded=False)
        detectors.text.close = lambda: close_events.append("probe-failure-close")
        args = argparse.Namespace(model_lock="D:/models/model-lock.json")
        with self.assertRaises(worker.ProtocolError) as raised:
            worker.bootstrap_models(
                args,
                detector_loader=lambda _path: detectors,
                probe_frame_factory=lambda: contextlib.nullcontext("D:/redraw-local/probe.png"),
            )
        self.assertEqual(str(raised.exception), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE")
        self.assertEqual(close_events, ["probe-failure-close"])

        close_failed = FakeDetectors()

        def fail_close():
            raise RuntimeError("C:/private/model-lock.json Authorization: secret")

        close_failed.text.close = fail_close
        with self.assertRaises(worker.ProtocolError) as raised:
            worker.bootstrap_models(
                args,
                detector_loader=lambda _path: close_failed,
                probe_frame_factory=lambda: contextlib.nullcontext("D:/redraw-local/probe.png"),
            )
        self.assertEqual(str(raised.exception), "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE")
        self.assertIsNone(raised.exception.__cause__)
        self.assertNotIn("private", repr(raised.exception).lower())
        self.assertNotIn("authorization", repr(raised.exception).lower())

    def test_bootstrap_marks_probe_components_and_coarse_validation_stage(self):
        import contextlib

        args = argparse.Namespace(model_lock="D:/models/model-lock.json")

        for component, expected_stage in (
            ("person", "probe:person"),
            ("face", "probe:face"),
            ("text", "probe:text"),
            ("tracker", "probe:tracker"),
        ):
            with self.subTest(component=component):
                detectors = FakeDetectors()
                spoof = worker.ProtocolError(
                    "C:/private/frame.png Authorization: secret",
                    stage="probe:text",
                )
                if component == "person":
                    detectors.person.detect = lambda _path, error=spoof: (_ for _ in ()).throw(error)
                elif component == "face":
                    detectors.face.detect = lambda _path, error=spoof: (_ for _ in ()).throw(error)
                elif component == "text":
                    detectors.text.detect_regions = lambda _path, error=spoof: (_ for _ in ()).throw(error)
                else:
                    detectors.tracker.update = lambda _index, _persons, error=spoof: (_ for _ in ()).throw(error)
                self.assert_trusted_stage(
                    lambda detectors=detectors: worker.bootstrap_models(
                        args,
                        detector_loader=lambda _path: detectors,
                        probe_frame_factory=lambda: contextlib.nullcontext("D:/redraw-local/probe.png"),
                    ),
                    expected_stage,
                )

        invalid_result = FakeDetectors(texts=[{
            "candidate_id": "text_1",
            "kind": "text_candidate",
            "polygon": [{"x": 0, "y": 0}, {"x": 1, "y": 1}, {"x": 2, "y": 2}],
            "confidence": 1,
        }])
        self.assert_trusted_stage(
            lambda: worker.bootstrap_models(
                args,
                detector_loader=lambda _path: invalid_result,
                probe_frame_factory=lambda: contextlib.nullcontext("D:/redraw-local/probe.png"),
            ),
            "probe",
        )

    def test_bootstrap_marks_outer_load_probe_frame_adapter_and_close_stages(self):
        import contextlib

        args = argparse.Namespace(model_lock="D:/models/model-lock.json")

        spoof = worker.ProtocolError(
            "C:/private/model-lock.json Authorization: secret",
            stage="load:text",
        )
        self.assert_trusted_stage(
            lambda: worker.bootstrap_models(
                args,
                detector_loader=lambda _path: (_ for _ in ()).throw(spoof),
            ),
            "load",
        )

        @contextlib.contextmanager
        def failed_probe_frame():
            raise RuntimeError("C:/private/probe.png Authorization: secret")
            yield

        self.assert_trusted_stage(
            lambda: worker.bootstrap_models(
                args,
                detector_loader=lambda _path: FakeDetectors(),
                probe_frame_factory=failed_probe_frame,
            ),
            "probe_frame",
        )

        adapters = worker.SimpleNamespace(
            probe=lambda _path: (_ for _ in ()).throw(
                worker.ProtocolError(
                    "C:/private/model-lock.json Authorization: secret",
                    stage="probe:text",
                )
            ),
        )
        self.assert_trusted_stage(
            lambda: worker.bootstrap_models(
                args,
                adapters=adapters,
                detector_loader=lambda _path: FakeDetectors(),
                probe_frame_factory=lambda: contextlib.nullcontext("D:/redraw-local/probe.png"),
            ),
            "adapter_probe",
        )

        class ProbeAccessFailed:
            @property
            def probe(self):
                raise worker.ProtocolError(
                    "C:/private/model-lock.json Authorization: secret",
                    stage="probe:text",
                )

        self.assert_trusted_stage(
            lambda: worker.bootstrap_models(
                args,
                adapters=ProbeAccessFailed(),
                detector_loader=lambda _path: FakeDetectors(),
                probe_frame_factory=lambda: contextlib.nullcontext("D:/redraw-local/probe.png"),
            ),
            "adapter_probe",
        )

        close_failed = FakeDetectors()
        close_failed.text.close = lambda: (_ for _ in ()).throw(
            RuntimeError("C:/private/model-lock.json Authorization: secret")
        )
        self.assert_trusted_stage(
            lambda: worker.bootstrap_models(
                args,
                detector_loader=lambda _path: close_failed,
                probe_frame_factory=lambda: contextlib.nullcontext("D:/redraw-local/probe.png"),
            ),
            "close",
        )

    def test_bootstrap_close_failure_does_not_override_earlier_component_stage(self):
        import contextlib

        args = argparse.Namespace(model_lock="D:/models/model-lock.json")
        detectors = FakeDetectors()
        detectors.person.detect = lambda _path: (_ for _ in ()).throw(
            RuntimeError("C:/private/frame.png Authorization: secret")
        )
        detectors.text.close = lambda: (_ for _ in ()).throw(
            RuntimeError("C:/private/model-lock.json Authorization: secret")
        )

        self.assert_trusted_stage(
            lambda: worker.bootstrap_models(
                args,
                detector_loader=lambda _path: detectors,
                probe_frame_factory=lambda: contextlib.nullcontext("D:/redraw-local/probe.png"),
            ),
            "probe:person",
        )

    def test_main_bootstrap_emits_only_trusted_stage_and_success_has_no_stage(self):
        original_bootstrap = worker.bootstrap_models
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        try:
            success_stdout = io.StringIO()
            success_stderr = io.StringIO()
            sys.stdout = success_stdout
            sys.stderr = success_stderr
            worker.bootstrap_models = lambda _args: {
                "status": "ok",
                "schema_version": worker.LOCK_SCHEMA,
                "components": sorted(worker.COMPONENTS),
            }
            self.assertEqual(worker.main(["bootstrap", "--model-lock", "D:/models/model-lock.json"]), 0)
            self.assertNotIn("stage=", success_stdout.getvalue())
            self.assertEqual(success_stderr.getvalue(), "")

            for error, expected_stage in (
                (worker._stage_error("probe:text"), "probe:text"),
                (worker._stage_error("import_cv2"), "load"),
                (
                    worker.ProtocolError(
                        "C:/private/model-lock.json Authorization: secret",
                        stage="probe:text",
                    ),
                    "load",
                ),
                (RuntimeError("C:/private/model-lock.json Authorization: secret"), "load"),
            ):
                with self.subTest(expected_stage=expected_stage, error=type(error).__name__):
                    stdout = io.StringIO()
                    stderr = io.StringIO()
                    sys.stdout = stdout
                    sys.stderr = stderr

                    def fail_bootstrap(_args, raised=error):
                        raise raised

                    worker.bootstrap_models = fail_bootstrap
                    self.assertEqual(worker.main(["bootstrap", "--model-lock", "D:/models/model-lock.json"]), 1)
                    self.assertEqual(stdout.getvalue(), "")
                    self.assertEqual(
                        stderr.getvalue(),
                        f"REDRAW_FULL_FRAME_MODEL_UNAVAILABLE stage={expected_stage}\n",
                    )
                    self.assertNotIn("private", stderr.getvalue().lower())
                    self.assertNotIn("authorization", stderr.getvalue().lower())
        finally:
            worker.bootstrap_models = original_bootstrap
            sys.stdout = old_stdout
            sys.stderr = old_stderr

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
