import argparse
import contextlib
import hashlib
import importlib
import importlib.util
import json
import math
import os
import sys
import tarfile
import tempfile
import zipfile
from types import SimpleNamespace

if __package__:
    from .text_subprocess import TextSubprocessAdapter, TextSubprocessError, _trusted_text_stage
else:
    from text_subprocess import TextSubprocessAdapter, TextSubprocessError, _trusted_text_stage


ERROR_CODE = "REDRAW_FULL_FRAME_MODEL_UNAVAILABLE"
_TEXT_LOAD_STAGES = frozenset((
    "validate_lock",
    "import_cv2",
    "import_paddle",
    "build_args",
    "model_dir",
    "detector_init",
    "adapter_init",
    "output_limit",
))
_BOOTSTRAP_STAGES = frozenset((
    "validate_lock",
    "load",
    "load:person",
    "load:tracker",
    "load:face",
    "load:text",
    "probe_frame",
    "probe",
    "probe:person",
    "probe:face",
    "probe:text",
    "probe:tracker",
    "adapter_probe",
    "close",
)) | frozenset(f"load:text:{stage}" for stage in _TEXT_LOAD_STAGES)
_INTERNAL_STAGES = _BOOTSTRAP_STAGES | _TEXT_LOAD_STAGES
_STAGE_TOKEN = object()
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
YOLOXInferenceContext = SimpleNamespace
MediaPipeFaceContext = SimpleNamespace
PaddleTextDetectionContext = SimpleNamespace


class ProtocolError(Exception):
    def __init__(self, _message=ERROR_CODE, *, stage=None, _token=None):
        super().__init__(ERROR_CODE)
        trusted = _token is _STAGE_TOKEN and stage in _INTERNAL_STAGES
        self._trusted_stage = stage if trusted else None
        self._stage_token = _token if trusted else None


def _stage_error(stage):
    if stage not in _INTERNAL_STAGES:
        stage = "load"
    return ProtocolError(ERROR_CODE, stage=stage, _token=_STAGE_TOKEN)


def _trusted_stage(error):
    if (type(error) is ProtocolError
            and getattr(error, "_stage_token", None) is _STAGE_TOKEN
            and getattr(error, "_trusted_stage", None) in _INTERNAL_STAGES):
        return error._trusted_stage
    return None


def _stage_from_error(error, fallback):
    return _stage_error(_trusted_stage(error) or fallback)


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
    _plain_object(item)
    allowed = {"bbox", "confidence", "_frame_width", "_frame_height"}
    if not {"bbox", "confidence"}.issubset(item.keys()) or any(key not in allowed for key in item.keys()):
        _fail()
    result = {"bbox": _bbox(item["bbox"]), "confidence": _bounded_confidence(item["confidence"])}
    if "_frame_width" in item:
        result["_frame_width"] = _finite_number(item["_frame_width"])
    if "_frame_height" in item:
        result["_frame_height"] = _finite_number(item["_frame_height"])
    return result


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
    except Exception:
        raise _stage_error("probe") from None
    try:
        persons = detectors.person.detect(frame["frame_path"])
        if not isinstance(persons, list):
            _fail()
        persons = [_validate_raw_person(item) for item in persons]
    except Exception:
        raise _stage_error("probe:person") from None
    try:
        faces = detectors.face.detect(frame["frame_path"])
    except Exception:
        raise _stage_error("probe:face") from None
    try:
        texts = detectors.text.detect_regions(frame["frame_path"])
    except Exception:
        raise _stage_error("probe:text") from None
    try:
        tracked = detectors.tracker.update(frame["frame_index"], persons)
    except Exception:
        raise _stage_error("probe:tracker") from None
    try:
        return sanitize_result(frame["frame_index"], tracked, faces, texts)
    except Exception:
        raise _stage_error("probe") from None


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ProtocolError(ERROR_CODE)


class YOLOXPersonAdapter:
    def __init__(self, artifact_path, factory):
        self.context = factory(artifact_path)

    def detect(self, frame_path):
        context = self.context
        image = context.cv2.imread(frame_path)
        if image is None or not hasattr(image, "shape") or len(image.shape) < 2:
            _fail()
        height, width = image.shape[0], image.shape[1]
        if height <= 0 or width <= 0:
            _fail()
        transformed = context.transform(image, None, context.input_size)
        tensor_source = transformed[0] if isinstance(transformed, tuple) else transformed
        tensor = context.torch.from_numpy(tensor_source)
        if hasattr(tensor, "unsqueeze"):
            tensor = tensor.unsqueeze(0)
        if hasattr(tensor, "float"):
            tensor = tensor.float()
        with context.torch.no_grad():
            raw = context.model(tensor)
        outputs = context.postprocess(raw, context.num_classes, context.conf, context.nms)
        if outputs is None or not isinstance(outputs, (list, tuple)) or len(outputs) == 0:
            return []
        detections = _to_rows(outputs[0])
        ratio = min(float(context.input_size[0]) / float(height), float(context.input_size[1]) / float(width))
        if ratio <= 0 or not math.isfinite(ratio):
            _fail()
        persons = []
        for row in detections:
            if len(row) < 7:
                _fail()
            x1, y1, x2, y2 = (_finite_number(row[index]) / ratio for index in range(4))
            object_score = _bounded_confidence(row[4])
            class_score = _bounded_confidence(row[5])
            class_id_value = _finite_number(row[6])
            class_id = int(class_id_value)
            if class_id != class_id_value:
                _fail()
            if class_id != 0:
                continue
            persons.append({
                "bbox": _bbox({"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}),
                "confidence": _bounded_confidence(object_score * class_score),
                "_frame_width": float(width),
                "_frame_height": float(height),
            })
        return persons


class ByteTrackAdapter:
    def __init__(self, artifact_path, factory):
        self.tracker = factory(artifact_path)

    def update(self, frame_index, persons):
        frame_width = persons[0].get("_frame_width", 0) if persons else 0
        frame_height = persons[0].get("_frame_height", 0) if persons else 0
        det_rows = []
        for person in persons:
            box = person["bbox"]
            det_rows.append([
                box["x"],
                box["y"],
                box["x"] + box["width"],
                box["y"] + box["height"],
                person["confidence"],
            ])
        dets = det_rows
        try:
            np = importlib.import_module("numpy")
            dets = np.asarray(det_rows, dtype=float)
            if len(det_rows) == 0:
                dets = dets.reshape((0, 5))
        except Exception:
            pass
        targets = self.tracker.update(dets, (frame_height, frame_width), (frame_height, frame_width))
        if targets is None:
            targets = []
        results = []
        for target in targets:
            tlwh = _to_rows(getattr(target, "tlwh"))[0]
            if len(tlwh) < 4:
                _fail()
            track_id = _identifier(str(getattr(target, "track_id")))
            score = _bounded_confidence(getattr(target, "score"))
            results.append({
                "candidate_id": f"person_{track_id}",
                "track_key": f"track_{track_id}",
                "kind": "person_candidate",
                "bbox": _bbox({"x": tlwh[0], "y": tlwh[1], "width": tlwh[2], "height": tlwh[3]}),
                "confidence": score,
            })
        return results


class MediaPipeFaceAdapter:
    def __init__(self, artifact_path, factory):
        self.context = factory(artifact_path)

    def detect(self, frame_path):
        context = self.context
        image = context.cv2.imread(frame_path)
        if image is None or not hasattr(image, "shape") or len(image.shape) < 2:
            _fail()
        rgb = context.cv2.cvtColor(image, context.cv2.COLOR_BGR2RGB)
        mp_image = context.image_class(image_format=context.image_format, data=rgb)
        result = context.detector.detect(mp_image)
        detections = getattr(result, "detections", None) or []
        faces = []
        for index, detection in enumerate(detections):
            box = getattr(detection, "bounding_box", None)
            categories = getattr(detection, "categories", None)
            if box is None or not categories:
                _fail()
            score = getattr(categories[0], "score", None)
            faces.append({
                "candidate_id": f"face_{index + 1}",
                "kind": "face_candidate",
                "bbox": _bbox({
                    "x": getattr(box, "origin_x", None),
                    "y": getattr(box, "origin_y", None),
                    "width": getattr(box, "width", None),
                    "height": getattr(box, "height", None),
                }),
                "confidence": _bounded_confidence(score),
            })
        return faces


class PaddleTextDetectionAdapter:
    def __init__(self, artifact_path, factory):
        self.context = factory(artifact_path)

    def detect_regions(self, frame_path):
        context = self.context
        image = context.cv2.imread(frame_path)
        if image is None or not hasattr(image, "shape") or len(image.shape) < 2:
            _fail()
        raw = context.detector(image)
        if not isinstance(raw, (list, tuple)) or len(raw) == 0:
            _fail()
        boxes = raw[0]
        scores = raw[1] if len(raw) > 1 and isinstance(raw[1], list) else [1.0] * len(boxes)
        texts = []
        for index, box in enumerate(boxes):
            points = _to_rows(box)
            score = scores[index] if index < len(scores) else 1.0
            texts.append({
                "candidate_id": f"text_{index + 1}",
                "kind": "text_candidate",
                "polygon": _polygon([{"x": point[0], "y": point[1]} for point in points]),
                "confidence": _bounded_confidence(score),
            })
        return texts


def _to_rows(value):
    if value is None:
        _fail()
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, tuple):
        value = list(value)
    if not isinstance(value, list):
        _fail()
    if value and not isinstance(value[0], (list, tuple)):
        return [value]
    return [list(row) for row in value]


def _default_person_factory(artifact_path):
    try:
        cv2 = importlib.import_module("cv2")
        torch = importlib.import_module("torch")
        exp_module = importlib.import_module("yolox.exp")
        data_module = importlib.import_module("yolox.data.data_augment")
        utils_module = importlib.import_module("yolox.utils")
        exp = exp_module.get_exp(None, "yolox-s")
        model = exp.get_model()
        checkpoint = torch.load(artifact_path, map_location="cpu")
        model.load_state_dict(checkpoint.get("model", checkpoint))
        model.eval()
        return YOLOXInferenceContext(
            cv2=cv2,
            torch=torch,
            model=model,
            transform=data_module.ValTransform(legacy=False),
            postprocess=utils_module.postprocess,
            input_size=exp.test_size,
            conf=getattr(exp, "test_conf", 0.25),
            nms=getattr(exp, "nmsthre", 0.45),
            num_classes=getattr(exp, "num_classes", 80),
        )
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


def _default_tracker_factory(artifact_path):
    try:
        prepared = _prepare_artifact_path(artifact_path, require_bytetrack=True)
        tracker_module = _load_locked_bytetrack_module(prepared)
        tracker_class = getattr(tracker_module, "BYTETracker")
        tracker = tracker_class(SimpleNamespace(track_thresh=0.5, track_buffer=30, match_thresh=0.8, mot20=False))
        if not hasattr(tracker, "update"):
            _fail()
        return tracker
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


def _default_face_factory(artifact_path):
    try:
        cv2 = importlib.import_module("cv2")
        mediapipe = importlib.import_module("mediapipe")
        vision = mediapipe.tasks.vision
        base_options_class = mediapipe.tasks.BaseOptions
        options = vision.FaceDetectorOptions(
            base_options=base_options_class(model_asset_path=artifact_path),
            running_mode=vision.RunningMode.IMAGE,
        )
        detector = vision.FaceDetector.create_from_options(options)
        if not hasattr(detector, "detect"):
            _fail()
        return MediaPipeFaceContext(cv2=cv2, image_class=mediapipe.Image, image_format=mediapipe.ImageFormat.SRGB, detector=detector)
    except Exception as exc:
        raise ProtocolError(ERROR_CODE) from exc


def _default_text_detector_factory(artifact_path):
    try:
        prepared = _prepare_artifact_path(artifact_path)
    except Exception:
        raise _stage_error("model_dir") from None
    try:
        cv2 = importlib.import_module("cv2")
    except Exception:
        raise _stage_error("import_cv2") from None
    try:
        text_system = importlib.import_module("paddleocr.tools.infer.predict_det")
    except Exception:
        raise _stage_error("import_paddle") from None
    try:
        args_parser = text_system.utility.init_args()
        args = args_parser.parse_args([])
    except Exception:
        raise _stage_error("build_args") from None
    try:
        args.det_model_dir = _find_unique_paddle_det_model_dir(prepared, artifact_path)
    except Exception:
        raise _stage_error("model_dir") from None
    try:
        text_detector_class = getattr(text_system, "TextDetector")
        detector = text_detector_class(args)
        if not callable(detector):
            _fail()
        return PaddleTextDetectionContext(cv2=cv2, detector=detector)
    except Exception:
        raise _stage_error("detector_init") from None


def _find_unique_paddle_det_model_dir(prepared, artifact_path):
    if not os.path.isdir(prepared):
        return os.path.dirname(os.path.realpath(artifact_path))
    candidates = []
    search_roots = [prepared]
    for name in os.listdir(prepared):
        child = os.path.join(prepared, name)
        if os.path.isdir(child):
            search_roots.append(child)
    for candidate in search_roots:
        if os.path.isfile(os.path.join(candidate, "inference.pdmodel")) and os.path.isfile(os.path.join(candidate, "inference.pdiparams")):
            candidates.append(os.path.realpath(candidate))
    if len(candidates) != 1:
        _fail()
    return candidates[0]


def _prepare_artifact_path(artifact_path, require_bytetrack=False):
    if not os.path.isfile(artifact_path):
        _fail()
    lower = artifact_path.lower()
    if not (lower.endswith(".zip") or lower.endswith(".tar") or lower.endswith(".tar.gz") or lower.endswith(".tgz")):
        return artifact_path
    artifact_hash = _sha256_file(artifact_path)
    parent = os.path.dirname(os.path.realpath(artifact_path))
    prepared_root = os.path.join(parent, ".prepared", artifact_hash[:16])
    marker_path = os.path.join(prepared_root, ".redraw-full-frame-artifact.sha256")
    if os.path.isdir(prepared_root):
        try:
            with open(marker_path, "r", encoding="utf-8") as handle:
                if handle.read().strip() != artifact_hash:
                    _fail()
            if require_bytetrack:
                _find_unique_bytetrack_module(prepared_root)
            return prepared_root
        except FileNotFoundError as exc:
            raise ProtocolError(ERROR_CODE) from exc
    os.makedirs(prepared_root, exist_ok=False)
    root_real = os.path.realpath(prepared_root)
    if lower.endswith(".zip"):
        with zipfile.ZipFile(artifact_path) as archive:
            for info in archive.infolist():
                mode = (info.external_attr >> 16) & 0o170000
                if mode == 0o120000:
                    _fail()
                target = os.path.realpath(os.path.join(root_real, info.filename))
                if os.path.commonpath([root_real, target]) != root_real:
                    _fail()
                if info.is_dir():
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with archive.open(info) as source, open(target, "wb") as dest:
                    dest.write(source.read())
        if require_bytetrack:
            _find_unique_bytetrack_module(prepared_root)
        with open(marker_path, "w", encoding="utf-8") as handle:
            handle.write(artifact_hash)
        return prepared_root
    with tarfile.open(artifact_path) as archive:
        for member in archive.getmembers():
            if member.issym() or member.islnk():
                _fail()
            target = os.path.realpath(os.path.join(root_real, member.name))
            if os.path.commonpath([root_real, target]) != root_real:
                _fail()
            if member.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            if member.isfile():
                os.makedirs(os.path.dirname(target), exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    _fail()
                with source, open(target, "wb") as dest:
                    dest.write(source.read())
                continue
            _fail()
    if require_bytetrack:
        _find_unique_bytetrack_module(prepared_root)
    with open(marker_path, "w", encoding="utf-8") as handle:
        handle.write(artifact_hash)
    return prepared_root


def _find_unique_bytetrack_module(root):
    matches = []
    for current_root, _dirs, files in os.walk(root):
        if "byte_tracker.py" in files:
            candidate = os.path.realpath(os.path.join(current_root, "byte_tracker.py"))
            normalized = candidate.replace("\\", "/")
            if normalized.endswith("/yolox/tracker/byte_tracker.py"):
                matches.append(candidate)
    if len(matches) != 1:
        _fail()
    return matches[0]


def _load_locked_bytetrack_module(prepared):
    if os.path.isfile(prepared):
        tracker_module = importlib.import_module("yolox.tracker.byte_tracker")
        module_file = os.path.realpath(getattr(tracker_module, "__file__", ""))
        if not module_file:
            _fail()
        return tracker_module
    module_path = _find_unique_bytetrack_module(prepared)
    package_root = os.path.dirname(os.path.dirname(os.path.dirname(module_path)))
    previous_path = list(sys.path)
    previous_modules = {name: sys.modules.get(name) for name in list(sys.modules) if name == "yolox" or name.startswith("yolox.")}
    try:
        for name in list(sys.modules):
            if name == "yolox" or name.startswith("yolox."):
                del sys.modules[name]
        sys.path.insert(0, package_root)
        module = importlib.import_module("yolox.tracker.byte_tracker")
        module_file = os.path.realpath(getattr(module, "__file__", ""))
        if os.path.commonpath([os.path.realpath(prepared), module_file]) != os.path.realpath(prepared):
            _fail()
        return module
    finally:
        sys.path[:] = previous_path
        for name in list(sys.modules):
            if name == "yolox" or name.startswith("yolox."):
                del sys.modules[name]
        for name, module in previous_modules.items():
            if module is not None:
                sys.modules[name] = module


def _default_factories():
    return SimpleNamespace(
        person=_default_person_factory,
        tracker=_default_tracker_factory,
        face=_default_face_factory,
    )


def _text_worker_path():
    return os.path.join(os.path.dirname(os.path.realpath(__file__)), "text_worker.py")


def _default_text_process_factory(model_lock_path):
    return TextSubprocessAdapter(
        python_path=sys.executable,
        text_worker_path=_text_worker_path(),
        model_lock_path=model_lock_path,
    )


def _close_detectors(detectors):
    text = getattr(detectors, "text", None)
    close = getattr(text, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            raise ProtocolError(ERROR_CODE) from None


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


def _load_real_detectors(model_lock_path, factories=None, text_process_factory=None):
    text = None
    try:
        try:
            _lock, components = _validate_model_lock(model_lock_path)
        except Exception:
            raise _stage_error("validate_lock") from None
        active_factories = factories or _default_factories()
        try:
            person = YOLOXPersonAdapter(
                components["person_detector"]["artifact_abs_path"],
                active_factories.person,
            )
        except Exception:
            raise _stage_error("load:person") from None
        try:
            tracker = ByteTrackAdapter(
                components["tracker"]["artifact_abs_path"],
                active_factories.tracker,
            )
        except Exception:
            raise _stage_error("load:tracker") from None
        try:
            face = MediaPipeFaceAdapter(
                components["face_detector"]["artifact_abs_path"],
                active_factories.face,
            )
        except Exception:
            raise _stage_error("load:face") from None
        active_text_process_factory = text_process_factory or _default_text_process_factory
        try:
            text = active_text_process_factory(model_lock_path=model_lock_path)
        except Exception as exc:
            text_stage = _trusted_text_stage(exc) if type(exc) is TextSubprocessError else None
            if text_stage in _TEXT_LOAD_STAGES:
                raise _stage_error(f"load:text:{text_stage}") from None
            raise _stage_error("load:text") from None
        return SimpleNamespace(
            person=person,
            tracker=tracker,
            face=face,
            text=text,
        )
    except Exception as exc:
        failure = _stage_from_error(exc, "load")
        if text is not None:
            try:
                _close_detectors(SimpleNamespace(text=text))
            except Exception:
                pass
        raise failure from None


def run_jsonl(args, detectors=None, factories=None):
    stdin = getattr(args, "stdin", sys.stdin)
    stdout = getattr(args, "stdout", sys.stdout)
    stderr = getattr(args, "stderr", sys.stderr)
    active_detectors = None
    failed = False
    try:
        active_detectors = detectors if detectors is not None else _load_real_detectors(
            args.model_lock,
            factories=factories,
        )
        for line in stdin:
            if not line.endswith("\n") or not line.strip():
                _fail()
            frame = json.loads(line)
            result = detect_frame(frame, active_detectors)
            stdout.write(json.dumps(result, separators=(",", ":"), ensure_ascii=True) + "\n")
            stdout.flush()
    except Exception:
        failed = True
    finally:
        if active_detectors is not None:
            try:
                _close_detectors(active_detectors)
            except Exception:
                failed = True
    if failed:
        stderr.write(ERROR_CODE + "\n")
        stderr.flush()
        return 1
    return 0


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


@contextlib.contextmanager
def _probe_frame():
    cv2 = importlib.import_module("cv2")
    numpy = importlib.import_module("numpy")
    with tempfile.TemporaryDirectory(prefix="redraw-full-frame-probe-") as root:
        frame_path = os.path.join(root, "probe.png")
        image = numpy.zeros((64, 64, 3), dtype=numpy.uint8)
        if not cv2.imwrite(frame_path, image):
            _fail()
        yield frame_path


def bootstrap_models(args, adapters=None, factories=None, detector_loader=None, probe_frame_factory=None):
    detectors = None
    result = None
    failure = None
    try:
        if detector_loader is None:
            try:
                detectors = _load_real_detectors(args.model_lock, factories=factories)
            except Exception as exc:
                raise _stage_from_error(exc, "load") from None
        else:
            try:
                detectors = detector_loader(args.model_lock)
            except Exception:
                raise _stage_error("load") from None
        probe_factory = probe_frame_factory or _probe_frame
        try:
            with probe_factory() as frame_path:
                try:
                    detect_frame({
                        "frame_index": 0,
                        "timestamp_ms": 0,
                        "frame_path": frame_path,
                    }, detectors)
                except Exception as exc:
                    raise _stage_from_error(exc, "probe") from None
        except Exception as exc:
            raise _stage_from_error(exc, "probe_frame") from None
        if adapters is not None:
            try:
                probe = getattr(adapters, "probe", None)
                if callable(probe):
                    probe(args.model_lock)
            except Exception:
                raise _stage_error("adapter_probe") from None
        result = {"status": "ok", "schema_version": LOCK_SCHEMA, "components": sorted(COMPONENTS)}
    except Exception as exc:
        failure = _stage_from_error(exc, "load")
    finally:
        if detectors is not None:
            try:
                _close_detectors(detectors)
            except Exception:
                if failure is None:
                    failure = _stage_error("close")
    if failure is not None:
        raise failure from None
    return result


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
    command = None
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        command = args.command
        if args.command == "run":
            return run_jsonl(args)
        if args.command == "bootstrap":
            result = bootstrap_models(args)
            sys.stdout.write(json.dumps(result, separators=(",", ":"), ensure_ascii=True) + "\n")
            return 0
        raise ProtocolError(ERROR_CODE)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 1
    except Exception as exc:
        if command == "bootstrap":
            trusted_stage = _trusted_stage(exc)
            stage = trusted_stage if trusted_stage in _BOOTSTRAP_STAGES else "load"
            sys.stderr.write(f"{ERROR_CODE} stage={stage}\n")
        else:
            sys.stderr.write(ERROR_CODE + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
