import argparse
import hashlib
import json
import math
import os
import sys


ERROR_CODE = "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE"
LOCK_SCHEMA = "redraw-full-frame-model-lock-v1"
COMPONENTS = ("face_detector", "person_detector", "text_detector", "tracker")


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


def _load_real_detectors(_model_lock):
    # Real adapters are deliberately late-bound. Missing YOLOX, ByteTrack,
    # MediaPipe, or PaddleOCR packages fail closed before any frame is processed.
    try:
        import yolox  # noqa: F401
        import mediapipe  # noqa: F401
        import paddleocr  # noqa: F401
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc
    raise ProtocolError(ERROR_CODE)


def run_jsonl(args, detectors=None):
    stdin = getattr(args, "stdin", sys.stdin)
    stdout = getattr(args, "stdout", sys.stdout)
    stderr = getattr(args, "stderr", sys.stderr)
    try:
        active_detectors = detectors if detectors is not None else _load_real_detectors(args.model_lock)
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


def bootstrap_models(args, adapters=None):
    try:
        lock_path = args.model_lock
        with open(lock_path, "r", encoding="utf-8") as handle:
            lock = json.load(handle)
        _exact_keys(lock, ("schema_version", "runtime", "components"))
        if lock["schema_version"] != LOCK_SCHEMA:
            _fail()
        if not isinstance(lock["components"], list) or len(lock["components"]) != 4:
            _fail()
        root = os.path.dirname(os.path.realpath(lock_path))
        seen = set()
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
            if component["component"] not in COMPONENTS or component["component"] in seen:
                _fail()
            seen.add(component["component"])
            artifact_path = _safe_join(root, component["artifact_path"])
            license_path = _safe_join(root, component["license_evidence_path"])
            if _sha256_file(artifact_path) != component["artifact_sha256"]:
                _fail()
            if _sha256_file(license_path) != component["license_evidence_sha256"]:
                _fail()
        if seen != set(COMPONENTS):
            _fail()
        if adapters is None:
            _load_real_detectors(lock)
        else:
            probe = getattr(adapters, "probe", None)
            if callable(probe):
                probe(lock)
        return {"status": "ok", "schema_version": LOCK_SCHEMA, "components": sorted(COMPONENTS)}
    except ProtocolError:
        raise
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


def parse_args(argv):
    if sum(1 for item in argv if item == "--model-lock" or item.startswith("--model-lock=")) > 1:
        raise SystemExit(2)
    parser = argparse.ArgumentParser(prog="redraw-full-frame-auditor")
    subparsers = parser.add_subparsers(dest="command", required=True)
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
