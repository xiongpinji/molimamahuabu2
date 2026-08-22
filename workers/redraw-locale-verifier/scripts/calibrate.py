#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path


REQUIRED_FIELDS = {
    "audio_path",
    "audio_sha256",
    "approved_text",
    "expected_language",
    "expected_accent",
    "split",
}
METRIC_FIELDS = {
    "language_probability",
    "word_error_rate",
    "character_error_rate",
    "us_accent_probability",
}
HEX_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
LOCALE_PACK = "en-US@1"
NORMALIZATION_VERSION = "english-text-v1"
EXPECTED_MODEL_REVISIONS = {
    "asr": "2ec96c5472da50d38d40c0cfe0602af2e94b4c8a",
    "accent": "cc5dc6a56db647149d9e52856d6e55114c1045a8",
    "wav2vec": "b61310a3ecdfdc01af29ef1c203d708047a51184",
}
EXPECTED_MODEL_REPOS = {
    "asr": "Systran/faster-whisper-small",
    "accent": "Jzuluaga/accent-id-commonaccent_xlsr-en-english",
    "wav2vec": "facebook/wav2vec2-large-xlsr-53",
}


class CalibrationError(ValueError):
    pass


def load_rows(path):
    path = Path(path)
    if path.suffix.casefold() == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        rows = payload["rows"] if isinstance(payload, dict) and "rows" in payload else payload
        if not isinstance(rows, list):
            raise CalibrationError("CALIBRATION_INPUT_INVALID")
        return rows
    with path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or not REQUIRED_FIELDS.issubset(set(reader.fieldnames)):
            raise CalibrationError("CALIBRATION_CSV_INVALID")
        return list(reader)


def load_model_manifest(path):
    try:
        raw = Path(path).read_bytes()
        manifest = json.loads(raw.decode("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID") from exc
    return {"manifest": manifest, "sha256": hashlib.sha256(raw).hexdigest()}


def calibrate(rows, *, model_manifest=None):
    model_binding = _validate_model_manifest(model_manifest)
    normalized = _normalize_rows(rows)
    tune = [row for row in normalized if row["split"] == "tune"]
    eval_rows = [row for row in normalized if row["split"] == "eval"]
    if not tune or not eval_rows:
        raise CalibrationError("CALIBRATION_SPLIT_INVALID")

    thresholds = _search_thresholds(tune)
    eval_positive = sum(1 for row in eval_rows if _is_positive(row))
    eval_negative = len(eval_rows) - eval_positive
    if eval_positive == 0 or eval_negative == 0:
        raise CalibrationError("CALIBRATION_EVAL_SPLIT_INVALID")

    eval_result = _evaluate(eval_rows, thresholds)
    if eval_result["false_accept_rate"] > 0.01:
        raise CalibrationError("CALIBRATION_FALSE_ACCEPT_RATE_TOO_HIGH")
    if eval_result["false_reject_rate"] >= 1.0:
        raise CalibrationError("CALIBRATION_FALSE_REJECT_RATE_TOO_HIGH")

    return {
        "schema_version": 1,
        "locale_pack": LOCALE_PACK,
        "normalization_version": NORMALIZATION_VERSION,
        "model_manifest_sha256": model_binding["sha256"],
        "sample_counts": {
            "tune": len(tune),
            "eval": len(eval_rows),
            "eval_positive": eval_positive,
            "eval_negative": eval_negative,
        },
        "thresholds": thresholds,
        "eval": eval_result,
        "models": model_binding["models"],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Calibrate redraw locale verifier thresholds.")
    parser.add_argument("--input", required=True, help="CSV or JSON rows with calibration metrics.")
    parser.add_argument("--model-manifest", required=True, help="Task1 staged model manifest.json.")
    parser.add_argument("--output", required=True, help="Manifest output path.")
    args = parser.parse_args(argv)
    output = _safe_output_path(args.output)
    manifest = calibrate(load_rows(args.input), model_manifest=load_model_manifest(args.model_manifest))
    _atomic_write_json(output, manifest)
    return 0


def _validate_model_manifest(manifest):
    if not isinstance(manifest, dict):
        raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
    manifest_sha256 = manifest.get("sha256")
    payload = manifest.get("manifest")
    if not isinstance(manifest_sha256, str) or not HEX_SHA256_RE.fullmatch(manifest_sha256):
        raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
    if not isinstance(payload, dict) or payload.get("schema_version") != 1 or not isinstance(payload.get("models"), dict):
        raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
    flattened = {}
    for name, expected_revision in EXPECTED_MODEL_REVISIONS.items():
        model = payload["models"].get(name)
        if not isinstance(model, dict):
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        revision = model.get("revision")
        tree_sha256 = model.get("tree_sha256")
        repo_id = model.get("repo_id")
        files = model.get("files")
        if repo_id != EXPECTED_MODEL_REPOS[name]:
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        if revision != expected_revision or not isinstance(revision, str):
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        if not isinstance(tree_sha256, str) or not HEX_SHA256_RE.fullmatch(tree_sha256) or _obvious_placeholder_hash(tree_sha256):
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        if _model_files_tree_sha256(files) != tree_sha256:
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        flattened[f"{name}_revision"] = revision
        flattened[f"{name}_tree_sha256"] = tree_sha256
    return {"sha256": manifest_sha256, "models": flattened}


def _obvious_placeholder_hash(value):
    return len(set(value)) == 1


def _model_files_tree_sha256(files):
    if not isinstance(files, list) or not files:
        raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
    seen_paths = set()
    digest = hashlib.sha256()
    for item in files:
        if not isinstance(item, dict):
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        path = item.get("path")
        sha256 = item.get("sha256")
        size = item.get("size")
        if (
            not isinstance(path, str)
            or not path
            or path.startswith("/")
            or "\\" in path
            or any(part in {"", ".", ".."} for part in path.split("/"))
            or path in seen_paths
        ):
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        seen_paths.add(path)
        if not isinstance(sha256, str) or not HEX_SHA256_RE.fullmatch(sha256) or _obvious_placeholder_hash(sha256):
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        if type(size) is not int or size <= 0:
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
    for item in sorted(files, key=lambda value: value["path"]):
        digest.update(item["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(item["sha256"]))
    return digest.hexdigest()


def _normalize_rows(rows):
    normalized = []
    split_by_hash = {}
    for raw in rows:
        if not isinstance(raw, dict) or not REQUIRED_FIELDS.issubset(raw):
            raise CalibrationError("CALIBRATION_ROW_INVALID")
        row = {key: str(raw[key]) for key in REQUIRED_FIELDS}
        row["split"] = row["split"].strip()
        if row["split"] not in {"tune", "eval"}:
            raise CalibrationError("CALIBRATION_SPLIT_INVALID")
        row["audio_sha256"] = row["audio_sha256"].strip().casefold()
        if not HEX_SHA256_RE.fullmatch(row["audio_sha256"]):
            raise CalibrationError("CALIBRATION_AUDIO_HASH_INVALID")
        if not row["approved_text"].strip():
            raise CalibrationError("CALIBRATION_TEXT_EMPTY")
        previous_split = split_by_hash.setdefault(row["audio_sha256"], row["split"])
        if previous_split != row["split"]:
            raise CalibrationError("CALIBRATION_SPLIT_INVALID")
        for field in METRIC_FIELDS:
            if field not in raw:
                raise CalibrationError("CALIBRATION_METRIC_INVALID")
            row[field] = _metric(raw[field], field)
        normalized.append(row)
    return sorted(normalized, key=lambda item: (item["split"], item["audio_sha256"], item["audio_path"]))


def _search_thresholds(tune):
    positives = [row for row in tune if _is_positive(row)]
    if not positives:
        raise CalibrationError("CALIBRATION_TUNE_INVALID")
    candidates = {
        "language_probability_min": sorted({0.0, 1.0, *(row["language_probability"] for row in tune)}),
        "word_error_rate_max": sorted({0.0, 1.0, *(row["word_error_rate"] for row in tune)}),
        "character_error_rate_max": sorted({0.0, 1.0, *(row["character_error_rate"] for row in tune)}),
        "us_accent_probability_min": sorted({0.0, 1.0, *(row["us_accent_probability"] for row in tune)}),
    }
    best = None
    for language_probability_min in candidates["language_probability_min"]:
        for word_error_rate_max in candidates["word_error_rate_max"]:
            for character_error_rate_max in candidates["character_error_rate_max"]:
                for us_accent_probability_min in candidates["us_accent_probability_min"]:
                    thresholds = {
                        "language_probability_min": _round(language_probability_min),
                        "word_error_rate_max": _round(word_error_rate_max),
                        "character_error_rate_max": _round(character_error_rate_max),
                        "us_accent_probability_min": _round(us_accent_probability_min),
                    }
                    result = _evaluate(tune, thresholds)
                    if result["false_accept_rate"] > 0.01 or result["false_reject_rate"] >= 1.0:
                        continue
                    key = (
                        result["false_reject_rate"],
                        result["false_accept_rate"],
                        -thresholds["language_probability_min"],
                        thresholds["word_error_rate_max"],
                        thresholds["character_error_rate_max"],
                        -thresholds["us_accent_probability_min"],
                    )
                    if best is None or key < best[0]:
                        best = (key, thresholds)
    if best is None:
        raise CalibrationError("CALIBRATION_TUNE_OPERATING_POINT_INVALID")
    return best[1]


def _evaluate(rows, thresholds):
    positives = [row for row in rows if _is_positive(row)]
    negatives = [row for row in rows if not _is_positive(row)]
    false_accepts = sum(1 for row in negatives if _accepted(row, thresholds))
    false_rejects = sum(1 for row in positives if not _accepted(row, thresholds))
    return {
        "false_accepts": false_accepts,
        "false_rejects": false_rejects,
        "false_accept_rate": _rate(false_accepts, len(negatives)),
        "false_reject_rate": _rate(false_rejects, len(positives)),
    }


def _accepted(row, thresholds):
    return (
        row["language_probability"] >= thresholds["language_probability_min"]
        and row["word_error_rate"] <= thresholds["word_error_rate_max"]
        and row["character_error_rate"] <= thresholds["character_error_rate_max"]
        and row["us_accent_probability"] >= thresholds["us_accent_probability_min"]
    )


def _is_positive(row):
    return row["expected_language"].casefold() == "en" and row["expected_accent"].casefold() in {"us", "en-us"}


def _metric(value, field):
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise CalibrationError("CALIBRATION_METRIC_INVALID") from exc
    if not math.isfinite(number) or number < 0 or number > 1:
        raise CalibrationError("CALIBRATION_METRIC_INVALID")
    return number


def _rate(count, total):
    if total == 0:
        return 0.0
    return _round(count / total)


def _round(value):
    return round(float(value), 6)


def _safe_output_path(value):
    path = Path(value)
    if path.exists() and path.is_dir():
        raise CalibrationError("CALIBRATION_OUTPUT_INVALID")
    parent = path.parent if path.parent != Path("") else Path(".")
    parent.resolve(strict=True)
    return path


def _atomic_write_json(path, value):
    path = Path(path)
    parent = path.parent if path.parent != Path("") else Path(".")
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=parent, delete=False) as handle:
        tmp_name = handle.name
        json.dump(value, handle, ensure_ascii=True, sort_keys=True, indent=2, allow_nan=False)
        handle.write("\n")
    os.replace(tmp_name, path)


if __name__ == "__main__":
    raise SystemExit(main())
