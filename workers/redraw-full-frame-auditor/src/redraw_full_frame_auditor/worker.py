import argparse
import hashlib
import importlib
import json
import math
import os
import sys
from types import SimpleNamespace


ERROR_CODE = "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE"
LOCK_SCHEMA = "redraw-full-frame-model-lock-v1"
COMPONENTS = ("face_detector", "person_detector", "text_detector", "tracker")
PROJECT_BY_COMPONENT = {
    "face_detector": "MediaPipe face detection",
    "person_detector": "YOLOX",
    "text_detector": "PaddleOCR",
    "tracker": "ByteTrack",
}
REPOSITORY_BY_COMPONENT = {
    "face_detector": "google-ai-edge/mediapipe",
    "person_detector": "Megvii-BaseDetection/YOLOX",
    "text_detector": "PaddlePaddle/PaddleOCR",
    "tracker": "FoundationVision/ByteTrack",
}


class ProtocolError(Exception):
    pass


def _fail():
    raise ProtocolError(ERROR_CODE)


def _plain_object(value):
    if not isinstance(value, dict):
        _fail()


def _exact_keys(value, keys):
    _plain_object(value)
    if set(value.keys()) != set(keys):
        _fail()


def _finite_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        _fail()
    value = float(value)
    if not math.isfinite(value):
        _fail()
    return value


def _bounded_confidence(value):
    value = _finite_number(value)
    if value < 0 or value > 1:
        _fail()
    return value


def _identifier(value):
    if not isinstance(value, str) or not value or len(value) > 128:
        _fail()
    if not all(ch.isalnum() or ch in "_:-" for ch in value):
        _fail()
    return value


def _bbox(value):
    _exact_keys(value, ("x", "y", "width", "height"))
    box = {key: _finite_number(value[key]) for key in ("x", "y", "width", "height")}
    if box["width"] <= 0 or box["height"] <= 0:
        _fail()
    return box


def _polygon(value):
    if not isinstance(value, list) or len(value) < 3:
        _fail()
    points = []
    for point in value:
        _exact_keys(point, ("x", "y"))
        points.append({"x": _finite_number(point["x"]), "y": _finite_number(point["y"])})
    area = 0.0
    for index, point in enumerate(points):
        other = points[(index + 1) % len(points)]
        area += point["x"] * other["y"] - other["x"] * point["y"]
    if abs(area) <= 1e-9:
        _fail()
    return points


def _validate_frame(frame):
    _exact_keys(frame, ("frame_index", "timestamp_ms", "frame_path"))
    if not isinstance(frame["frame_index"], int) or isinstance(frame["frame_index"], bool) or frame["frame_index"] < 0:
        _fail()
    if not isinstance(frame["timestamp_ms"], int) or isinstance(frame["timestamp_ms"], bool) or frame["timestamp_ms"] < 0:
        _fail()
    if not isinstance(frame["frame_path"], str) or not frame["frame_path"]:
        _fail()


def _validate_raw_person(item):
    _exact_keys(item, ("bbox", "confidence"))
    return {"bbox": _bbox(item["bbox"]), "confidence": _bounded_confidence(item["confidence"])}


def _person_candidate(item):
    _exact_keys(item, ("candidate_id", "track_key", "kind", "bbox", "confidence"))
    if item["kind"] != "person_candidate":
        _fail()
    return {
        "candidate_id": _identifier(item["candidate_id"]),
        "track_key": _identifier(item["track_key"]),
        "kind": "person_candidate",
        "bbox": _bbox(item["bbox"]),
        "confidence": _bounded_confidence(item["confidence"]),
    }


def _face_candidate(item):
    _exact_keys(item, ("candidate_id", "kind", "bbox", "confidence"))
    if item["kind"] != "face_candidate":
        _fail()
    return {
        "candidate_id": _identifier(item["candidate_id"]),
        "kind": "face_candidate",
        "bbox": _bbox(item["bbox"]),
        "confidence": _bounded_confidence(item["confidence"]),
    }


def _text_candidate(item):
    _exact_keys(item, ("candidate_id", "kind", "polygon", "confidence"))
    if item["kind"] != "text_candidate":
        _fail()
    return {
        "candidate_id": _identifier(item["candidate_id"]),
        "kind": "text_candidate",
        "polygon": _polygon(item["polygon"]),
        "confidence": _bounded_confidence(item["confidence"]),
    }


def _candidate_sort_key(item):
    if "bbox" in item:
        box = item["bbox"]
        return (item["candidate_id"], box["x"], box["y"])
    first = item["polygon"][0]
    return (item["candidate_id"], first["x"], first["y"])


def sanitize_result(frame_index, tracked, faces, texts):
    if not isinstance(tracked, list) or not isinstance(faces, list) or not isinstance(texts, list):
        _fail()
    persons = sorted((_person_candidate(item) for item in tracked), key=_candidate_sort_key)
    face_items = sorted((_face_candidate(item) for item in faces), key=_candidate_sort_key)
    text_items = sorted((_text_candidate(item) for item in texts), key=_candidate_sort_key)
    return {
        "frame_index": frame_index,
        "persons": persons,
        "faces": face_items,
        "texts": text_items,
    }


def detect_frame(frame, detectors):
    try:
        _validate_frame(frame)
        persons = detectors.person.detect(frame["frame_path"])
        if not isinstance(persons, list):
            _fail()
        persons = [_validate_raw_person(item) for item in persons]
        faces = detectors.face.detect(frame["frame_path"])
        texts = detectors.text.detect_regions(frame["frame_path"])
        tracked = detectors.tracker.update(frame["frame_index"], persons)
        return sanitize_result(frame["frame_index"], tracked, faces, texts)
    except ProtocolError:
        raise
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ProtocolError(ERROR_CODE)


class YOLOXPersonAdapter:
    def __init__(self, artifact_path, factory):
        self.model = factory(artifact_path)

    def detect(self, frame_path):
        raw = self.model.detect(frame_path)
        if not isinstance(raw, list):
            _fail()
        persons = []
        for item in raw:
            _plain_object(item)
            class_id = item.get("class_id", item.get("category_id"))
            class_name = item.get("class_name", item.get("label"))
            if class_id not in (None, 0) and class_name != "person":
                continue
            if class_id is None and class_name not in (None, "person"):
                continue
            persons.append({"bbox": _bbox(item.get("bbox")), "confidence": _bounded_confidence(item.get("confidence"))})
        return persons


class ByteTrackAdapter:
    def __init__(self, artifact_path, factory):
        self.tracker = factory(artifact_path)

    def update(self, frame_index, persons):
        raw = self.tracker.update(frame_index, persons)
        if raw is None:
            raw = [
                {
                    "candidate_id": f"person_{frame_index}_{index + 1}",
                    "track_key": f"track_{frame_index}_{index + 1}",
                    "kind": "person_candidate",
                    "bbox": person["bbox"],
                    "confidence": person["confidence"],
                }
                for index, person in enumerate(persons)
            ]
        return raw


class MediaPipeFaceAdapter:
    def __init__(self, artifact_path, factory):
        self.detector = factory(artifact_path)

    def detect(self, frame_path):
        return self.detector.detect(frame_path)


class PaddleTextDetectionAdapter:
    def __init__(self, artifact_path, factory):
        self.detector = factory(artifact_path)

    def detect_regions(self, frame_path):
        return self.detector.detect_regions(frame_path)


def _default_person_factory(artifact_path):
    try:
        torch = importlib.import_module("torch")
        exp_module = importlib.import_module("yolox.exp")
        exp = exp_module.get_exp(None, None)
        model = exp.get_model()
        checkpoint = torch.load(artifact_path, map_location="cpu")
        model.load_state_dict(checkpoint.get("model", checkpoint))
        model.eval()
        if not hasattr(model, "detect"):
            _fail()
        return model
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


def _default_tracker_factory(artifact_path):
    try:
        tracker_module = importlib.import_module("yolox.tracker.byte_tracker")
        tracker_class = getattr(tracker_module, "BYTETracker")
        tracker = tracker_class(SimpleNamespace(track_thresh=0.5, track_buffer=30, match_thresh=0.8, mot20=False))
        if not hasattr(tracker, "update"):
            _fail()
        return tracker
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


def _default_face_factory(artifact_path):
    try:
        mediapipe = importlib.import_module("mediapipe")
        face_detection = mediapipe.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5)
        if not hasattr(face_detection, "detect"):
            _fail()
        return face_detection
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


def _default_text_detector_factory(artifact_path):
    try:
        text_system = importlib.import_module("paddleocr.tools.infer.predict_det")
        args_factory = getattr(text_system, "parse_args")
        text_detector_class = getattr(text_system, "TextDetector")
        args = args_factory([])
        args.det_model_dir = os.path.dirname(artifact_path)
        detector = text_detector_class(args)
        if not hasattr(detector, "detect_regions"):
            _fail()
        return detector
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


def _default_factories():
    return SimpleNamespace(
        person=_default_person_factory,
        tracker=_default_tracker_factory,
        face=_default_face_factory,
        text_detector=_default_text_detector_factory,
    )


def _validate_model_lock(model_lock_path):
    with open(model_lock_path, "r", encoding="utf-8") as handle:
        lock = json.load(handle)
    _exact_keys(lock, ("schema_version", "runtime", "components"))
    if lock["schema_version"] != LOCK_SCHEMA:
        _fail()
    if not isinstance(lock["components"], list) or len(lock["components"]) != 4:
        _fail()
    root = os.path.dirname(os.path.realpath(model_lock_path))
    by_component = {}
    for component in lock["components"]:
        _exact_keys(component, (
            "component",
            "project",
            "repository",
            "revision",
            "artifact_name",
            "artifact_path",
            "artifact_sha256",
            "license_name",
            "license_evidence_path",
            "license_evidence_sha256",
        ))
        name = component["component"]
        if name not in COMPONENTS or name in by_component:
            _fail()
        if component["project"] != PROJECT_BY_COMPONENT[name] or component["repository"] != REPOSITORY_BY_COMPONENT[name]:
            _fail()
        artifact_path = _safe_join(root, component["artifact_path"])
        license_path = _safe_join(root, component["license_evidence_path"])
        if _sha256_file(artifact_path) != component["artifact_sha256"]:
            _fail()
        if _sha256_file(license_path) != component["license_evidence_sha256"]:
            _fail()
        by_component[name] = {**component, "artifact_abs_path": artifact_path}
    if set(by_component) != set(COMPONENTS):
        _fail()
    return lock, by_component


def _load_real_detectors(model_lock_path, factories=None):
    try:
        _lock, components = _validate_model_lock(model_lock_path)
        active_factories = factories or _default_factories()
        return SimpleNamespace(
            person=YOLOXPersonAdapter(components["person_detector"]["artifact_abs_path"], active_factories.person),
            tracker=ByteTrackAdapter(components["tracker"]["artifact_abs_path"], active_factories.tracker),
            face=MediaPipeFaceAdapter(components["face_detector"]["artifact_abs_path"], active_factories.face),
            text=PaddleTextDetectionAdapter(components["text_detector"]["artifact_abs_path"], active_factories.text_detector),
        )
    except ProtocolError:
        raise
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


def run_jsonl(args, detectors=None, factories=None):
    stdin = getattr(args, "stdin", sys.stdin)
    stdout = getattr(args, "stdout", sys.stdout)
    stderr = getattr(args, "stderr", sys.stderr)
    try:
        active_detectors = detectors if detectors is not None else _load_real_detectors(args.model_lock, factories=factories)
        for line in stdin:
            if line.endswith("\n"):
                line = line[:-1]
            if not line:
                _fail()
            try:
                frame = json.loads(line)
            except Exception as exc:
                raise ProtocolError(ERROR_CODE) from exc
            result = detect_frame(frame, active_detectors)
            stdout.write(json.dumps(result, separators=(",", ":"), ensure_ascii=True) + "\n")
            stdout.flush()
        return 0
    except Exception:
        stderr.write(ERROR_CODE + "\n")
        stderr.flush()
        return 1


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_join(root, relative_path):
    if not isinstance(relative_path, str) or not relative_path or os.path.isabs(relative_path):
        _fail()
    if "\\" in relative_path:
        relative_path = relative_path.replace("\\", "/")
    parts = relative_path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        _fail()
    root_real = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root_real, *parts))
    if os.path.commonpath([root_real, target]) != root_real:
        _fail()
    return target


def bootstrap_models(args, adapters=None, factories=None):
    try:
        _load_real_detectors(args.model_lock, factories=factories)
        if adapters is not None:
            probe = getattr(adapters, "probe", None)
            if callable(probe):
                probe(args.model_lock)
        return {"status": "ok", "schema_version": LOCK_SCHEMA, "components": sorted(COMPONENTS)}
    except ProtocolError:
        raise
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


def parse_args(argv):
    if sum(1 for item in argv if item == "--model-lock" or item.startswith("--model-lock=")) > 1:
        raise ProtocolError(ERROR_CODE)
    parser = SafeArgumentParser(prog="redraw-full-frame-auditor")
    subparsers = parser.add_subparsers(dest="command", required=True, parser_class=SafeArgumentParser)
    for command in ("run", "bootstrap"):
        child = subparsers.add_parser(command)
        child.add_argument("--model-lock", required=True)
    return parser.parse_args(argv)


def main(argv=None):
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        if args.command == "run":
            return run_jsonl(args)
        if args.command == "bootstrap":
            result = bootstrap_models(args)
            sys.stdout.write(json.dumps(result, separators=(",", ":"), ensure_ascii=True) + "\n")
            return 0
        raise ProtocolError(ERROR_CODE)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 1
    except Exception:
        sys.stderr.write(ERROR_CODE + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
