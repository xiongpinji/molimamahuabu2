import hashlib
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


def verify_audio(request, pack, *, asr, accent):
    audio_sha256 = _sha256_file(request.get("audio_path"))
    asr_evidence = _safe_infer(asr, request.get("audio_path"))
    accent_evidence = _safe_infer(accent, request.get("audio_path"))
    approved_text = _text_or_empty(request.get("approved_text"))
    transcript_text = _text_or_empty(asr_evidence.get("text"))
    metrics = score_text(approved_text, transcript_text)

    thresholds = _thresholds(pack)
    us_label = str(pack.get("us_accent_label", "us")).casefold()
    asr_probability = _strict_float(asr_evidence.get("probability"))
    accent_probability = _strict_float(accent_evidence.get("probability"))
    asr_language = str(asr_evidence.get("language") or "").casefold()
    accent_label = str(accent_evidence.get("label") or "").casefold()

    checks = {
        "locale_pack": request.get("locale_pack") == SUPPORTED_LOCALE_PACK == pack.get("locale_pack"),
        "audio_sha256_matches_request": audio_sha256 is not None and request.get("audio_sha256") == audio_sha256,
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
        "asr": {
            "language": asr_evidence.get("language"),
            "probability": asr_probability,
        },
        "accent": {
            "label": accent_evidence.get("label"),
            "probability": accent_probability,
        },
        "metrics": {
            "word_error_rate": metrics["word_error_rate"],
            "character_error_rate": metrics["character_error_rate"],
            "critical_tokens_match": metrics["critical_tokens_match"],
        },
        "checks": checks,
        "tts_invocation": _tts_invocation_evidence(request.get("tts_invocation")),
        "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def _safe_infer(engine, audio_path):
    try:
        result = engine.infer(Path(audio_path))
    except Exception:
        return {}
    return result if isinstance(result, dict) else {}


def _thresholds(pack):
    thresholds = pack.get("thresholds") if isinstance(pack, dict) else None
    result = {}
    if not isinstance(thresholds, dict) or set(thresholds) != REQUIRED_THRESHOLDS:
        return {
            "language_probability_min": 1.0,
            "word_error_rate_max": 0.0,
            "character_error_rate_max": 0.0,
            "us_accent_probability_min": 1.0,
        }
    for key in REQUIRED_THRESHOLDS:
        value = _strict_float(thresholds.get(key))
        result[key] = value if value is not None else _closed_threshold(key)
    return result


def _closed_threshold(key):
    if key.endswith("_max"):
        return 0.0
    return 1.0


def _strict_float(value):
    if type(value) not in (int, float):
        return None
    return float(value)


def _sha256_file(path):
    try:
        with Path(path).resolve(strict=True).open("rb") as handle:
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
