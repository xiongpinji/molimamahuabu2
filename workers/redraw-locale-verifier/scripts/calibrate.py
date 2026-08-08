#!/usr/bin/env python3
import argparse
import csv
import json
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
        manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID") from exc
    return manifest


def calibrate(rows, *, model_manifest=None):
    models = _validate_model_manifest(model_manifest)
    normalized = _normalize_rows(rows)
    tune = [row for row in normalized if row["split"] == "tune"]
    eval_rows = [row for row in normalized if row["split"] == "eval"]
    if not tune or not eval_rows:
        raise CalibrationError("CALIBRATION_SPLIT_INVALID")

    thresholds = _search_thresholds(tune)
    eval_result = _evaluate(eval_rows, thresholds)
    if eval_result["false_accept_rate"] > 0.01:
        raise CalibrationError("CALIBRATION_FALSE_ACCEPT_RATE_TOO_HIGH")

    eval_positive = sum(1 for row in eval_rows if _is_positive(row))
    eval_negative = len(eval_rows) - eval_positive
    return {
        "schema_version": 1,
        "locale_pack": LOCALE_PACK,
        "normalization_version": NORMALIZATION_VERSION,
        "sample_counts": {
            "tune": len(tune),
            "eval": len(eval_rows),
            "eval_positive": eval_positive,
            "eval_negative": eval_negative,
        },
        "thresholds": thresholds,
        "eval": eval_result,
        "models": models,
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
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1 or not isinstance(manifest.get("models"), dict):
        raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
    flattened = {}
    for name, expected_revision in EXPECTED_MODEL_REVISIONS.items():
        model = manifest["models"].get(name)
        if not isinstance(model, dict):
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        revision = model.get("revision")
        tree_sha256 = model.get("tree_sha256")
        if revision != expected_revision or not isinstance(revision, str):
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        if not isinstance(tree_sha256, str) or not HEX_SHA256_RE.fullmatch(tree_sha256) or _obvious_placeholder_hash(tree_sha256):
            raise CalibrationError("CALIBRATION_MODEL_MANIFEST_INVALID")
        flattened[f"{name}_revision"] = revision
        flattened[f"{name}_tree_sha256"] = tree_sha256
    return flattened


def _obvious_placeholder_hash(value):
    return len(set(value)) == 1


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
    return {
        "language_probability_min": _round(max(row["language_probability"] for row in positives)),
        "word_error_rate_max": _round(max(row["word_error_rate"] for row in positives)),
        "character_error_rate_max": _round(max(row["character_error_rate"] for row in positives)),
        "us_accent_probability_min": _round(max(row["us_accent_probability"] for row in positives)),
    }


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
    if number < 0 or number > 1:
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
        json.dump(value, handle, ensure_ascii=True, sort_keys=True, indent=2)
        handle.write("\n")
    os.replace(tmp_name, path)


if __name__ == "__main__":
    raise SystemExit(main())
