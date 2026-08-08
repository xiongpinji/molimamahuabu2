import hashlib
import math
from datetime import datetime, timezone
from pathlib import Path

from .normalization import score_text
from .protocol import HEX_SHA256_RE, SUPPORTED_LOCALE_PACK


REQUIRED_THRESHOLDS = {
    "language_probability_min",
    "word_error_rate_max",
    "character_error_rate_max",
    "us_accent_probability_min",
}
REQUIRED_MODELS = {
    "asr_revision",
    "accent_revision",
    "asr_tree_sha256",
    "accent_tree_sha256",
}


def verify_audio(request, pack, *, allowed_root, asr, accent):
    audio_path = _resolve_audio_path(request.get("audio_path"), allowed_root)
    audio_sha256 = _sha256_file(audio_path) if audio_path is not None else None
    if audio_path is None:
        asr_evidence = {"ok": False, "error_code": "INFERENCE_SKIPPED"}
        accent_evidence = {"ok": False, "error_code": "INFERENCE_SKIPPED"}
    else:
        asr_evidence = _safe_infer(asr, audio_path)
        accent_evidence = _safe_infer(accent, audio_path)
    approved_text = _text_or_empty(request.get("approved_text"))
    transcript_text = _text_or_empty(asr_evidence.get("text"))
    metrics = score_text(approved_text, transcript_text)

    thresholds, thresholds_valid = _thresholds(pack)
    us_label = str(pack.get("us_accent_label", "us")).casefold()
    asr_probability = _strict_float(asr_evidence.get("probability"))
    accent_probability = _strict_float(accent_evidence.get("probability"))
    asr_language = str(asr_evidence.get("language") or "").casefold()
    accent_label = str(accent_evidence.get("label") or "").casefold()

    checks = {
        "locale_pack": request.get("locale_pack") == SUPPORTED_LOCALE_PACK == pack.get("locale_pack"),
        "audio_path": audio_path is not None,
        "audio_sha256_matches_request": audio_sha256 is not None and request.get("audio_sha256") == audio_sha256,
        "asr_inference": asr_evidence.get("ok") is True,
        "accent_inference": accent_evidence.get("ok") is True,
        "calibration_thresholds": thresholds_valid,
        "language": asr_language == "en",
        "language_probability": asr_probability is not None and asr_probability >= thresholds["language_probability_min"],
        "word_error_rate": metrics["word_error_rate"] <= thresholds["word_error_rate_max"],
        "character_error_rate": metrics["character_error_rate"] <= thresholds["character_error_rate_max"],
        "critical_tokens_match": metrics["critical_tokens_match"],
        "us_accent_label": accent_label == us_label,
        "us_accent_probability": accent_probability is not None and accent_probability >= thresholds["us_accent_probability_min"],
        "model_manifest": _valid_hash(pack.get("model_manifest_sha256")),
        "calibration_manifest": _valid_hash(pack.get("calibration_manifest_sha256")),
        "models": _models_valid(pack.get("models")),
        "transcript_present": bool(transcript_text.strip()),
    }
    verified = all(checks.values())
    return {
        "source": "offline-worker",
        "locale_pack": SUPPORTED_LOCALE_PACK,
        "language_verified": verified,
        "detected_locale": "en-US" if verified else None,
        "audio_sha256": audio_sha256,
        "transcript_sha256": _sha256_text(transcript_text),
        "model_manifest_sha256": pack.get("model_manifest_sha256"),
        "calibration_manifest_sha256": pack.get("calibration_manifest_sha256"),
        "models": dict(pack.get("models") or {}),
        "asr": _asr_response(asr_evidence, asr_probability),
        "accent": _accent_response(accent_evidence, accent_probability),
        "metrics": {
            "word_error_rate": metrics["word_error_rate"],
            "character_error_rate": metrics["character_error_rate"],
            "critical_tokens_match": metrics["critical_tokens_match"],
        },
        "checks": checks,
        "tts_invocation": _tts_invocation_evidence(request.get("tts_invocation")),
        "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def _asr_response(evidence, probability):
    if evidence.get("ok") is not True:
        return {"ok": False, "error_code": evidence.get("error_code", "INFERENCE_FAILED")}
    return {
        "ok": True,
        "language": evidence.get("language"),
        "probability": probability,
    }


def _accent_response(evidence, probability):
    if evidence.get("ok") is not True:
        return {"ok": False, "error_code": evidence.get("error_code", "INFERENCE_FAILED")}
    return {
        "ok": True,
        "label": evidence.get("label"),
        "probability": probability,
    }


def _resolve_audio_path(audio_path, allowed_root):
    try:
        root_input = Path(allowed_root)
        path_input = Path(audio_path)
    except TypeError:
        return None
    if not root_input.is_absolute() or not path_input.is_absolute():
        return None
    try:
        root = root_input.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if not root.is_dir():
        return None
    if path_input.is_symlink():
        return None
    try:
        path = path_input.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if not path.is_file():
        return None
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path


def _safe_infer(engine, audio_path):
    try:
        result = engine.infer(audio_path)
    except Exception:
        return {"ok": False, "error_code": "INFERENCE_FAILED"}
    if not isinstance(result, dict):
        return {"ok": False, "error_code": "INFERENCE_INVALID"}
    return {**result, "ok": True}


def _thresholds(pack):
    thresholds = pack.get("thresholds") if isinstance(pack, dict) else None
    closed = {
        "language_probability_min": 1.0,
        "word_error_rate_max": 0.0,
        "character_error_rate_max": 0.0,
        "us_accent_probability_min": 1.0,
    }
    if not isinstance(thresholds, dict) or set(thresholds) != REQUIRED_THRESHOLDS:
        return closed, False
    result = {}
    for key in REQUIRED_THRESHOLDS:
        value = _strict_float(thresholds.get(key))
        if value is None or not math.isfinite(value) or value < 0.0 or value > 1.0:
            return closed, False
        result[key] = value
    return result, True


def _strict_float(value):
    if type(value) not in (int, float):
        return None
    return float(value)


def _sha256_file(path):
    try:
        with Path(path).open("rb") as handle:
            digest = hashlib.sha256()
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
            return digest.hexdigest()
    except (OSError, TypeError, ValueError):
        return None


def _sha256_text(value):
    return hashlib.sha256(_text_or_empty(value).encode("utf-8")).hexdigest()


def _text_or_empty(value):
    if value is None:
        return ""
    return str(value)


def _valid_hash(value):
    return isinstance(value, str) and HEX_SHA256_RE.fullmatch(value) is not None


def _models_valid(models):
    if not isinstance(models, dict) or not REQUIRED_MODELS.issubset(models):
        return False
    return all(isinstance(models[key], str) and models[key] for key in ("asr_revision", "accent_revision")) and all(
        _valid_hash(models[key]) for key in ("asr_tree_sha256", "accent_tree_sha256")
    )


def _tts_invocation_evidence(value):
    if not isinstance(value, dict):
        return {}
    return {
        "provider": value.get("provider"),
        "model": value.get("model"),
        "ai_service_config_id": value.get("ai_service_config_id"),
        "config_updated_at": value.get("config_updated_at"),
        "provider_task_id_sha256": _sha256_text(value.get("provider_task_id")),
    }
