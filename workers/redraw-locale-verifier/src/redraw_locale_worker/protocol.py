import re
from datetime import datetime

from .errors import ProtocolError

SUPPORTED_LOCALE_PACK = "en-US@1"
SUPPORTED_NATIVE_AUDIO_PACK = "es@1"
HEX_SHA256_RE = re.compile(r"[0-9a-f]{64}")
REQUIRED_VERIFY_FIELDS = {
    "request_id",
    "audio_path",
    "audio_sha256",
    "approved_text",
    "locale_pack",
    "tts_invocation",
}
ALLOWED_VERIFY_FIELDS = REQUIRED_VERIFY_FIELDS | {"action"}
TTS_INVOCATION_FIELDS = {
    "provider",
    "model",
    "ai_service_config_id",
    "config_updated_at",
    "provider_task_id",
}
NATIVE_AUDIO_FIELDS = {
    "action",
    "request_id",
    "audio_path",
    "audio_sha256",
    "approved_text",
    "locale_pack",
    "video_invocation",
}
VIDEO_INVOCATION_FIELDS = {
    "provider",
    "model",
    "ai_service_config_id",
    "config_updated_at",
    "provider_task_id",
    "artifact_sha256",
}
LOCAL_VOICE_FIELDS = {
    "action",
    "request_id",
    "audio_path",
    "audio_sha256",
    "approved_text",
    "locale_pack",
    "local_tts_invocation",
}
LOCAL_TTS_INVOCATION_FIELDS = {
    "engine",
    "engine_version",
    "binary_sha256",
    "manifest_sha256",
    "profile",
}


def parse_request(value):
    if not isinstance(value, dict):
        raise ProtocolError("LOCALE_VERIFY_REQUEST_INVALID")

    action = value.get("action")
    if action == "health":
        return _parse_health(value)
    if action == "verify_native_audio":
        return _parse_native_audio(value)
    if action == "verify_local_voice":
        return _parse_local_voice(value)
    if action != "verify" or set(value) != ALLOWED_VERIFY_FIELDS:
        raise ProtocolError("LOCALE_VERIFY_REQUEST_INVALID")

    _require_non_empty_string(value["request_id"], "LOCALE_VERIFY_REQUEST_INVALID")
    _require_non_empty_string(value["audio_path"], "LOCALE_VERIFY_REQUEST_INVALID")
    _require_non_empty_string(value["approved_text"], "LOCALE_VERIFY_REQUEST_INVALID")

    if value["locale_pack"] != SUPPORTED_LOCALE_PACK:
        raise ProtocolError("LOCALE_PACK_UNSUPPORTED")
    if not isinstance(value["audio_sha256"], str) or not HEX_SHA256_RE.fullmatch(value["audio_sha256"]):
        raise ProtocolError("LOCALE_AUDIO_HASH_INVALID")

    _validate_tts_invocation(value["tts_invocation"])
    return value


def _parse_native_audio(value):
    if set(value) != NATIVE_AUDIO_FIELDS:
        raise ProtocolError("LOCALE_VERIFY_REQUEST_INVALID")
    for key in ("request_id", "audio_path", "approved_text"):
        _require_non_empty_string(value.get(key), "LOCALE_VERIFY_REQUEST_INVALID")
    if value.get("locale_pack") != SUPPORTED_NATIVE_AUDIO_PACK:
        raise ProtocolError("LOCALE_PACK_UNSUPPORTED")
    if not isinstance(value.get("audio_sha256"), str) or not HEX_SHA256_RE.fullmatch(value["audio_sha256"]):
        raise ProtocolError("LOCALE_AUDIO_HASH_INVALID")
    _validate_video_invocation(value.get("video_invocation"))
    return value


def _parse_local_voice(value):
    if set(value) != LOCAL_VOICE_FIELDS:
        raise ProtocolError("LOCALE_VERIFY_REQUEST_INVALID")
    for key in ("request_id", "audio_path", "approved_text"):
        _require_non_empty_string(value.get(key), "LOCALE_VERIFY_REQUEST_INVALID")
    if value.get("locale_pack") != SUPPORTED_LOCALE_PACK:
        raise ProtocolError("LOCALE_PACK_UNSUPPORTED")
    if not isinstance(value.get("audio_sha256"), str) or not HEX_SHA256_RE.fullmatch(value["audio_sha256"]):
        raise ProtocolError("LOCALE_AUDIO_HASH_INVALID")
    _validate_local_tts_invocation(value.get("local_tts_invocation"))
    return value


def _parse_health(value):
    if set(value) != {"action", "request_id"}:
        raise ProtocolError("LOCALE_HEALTH_REQUEST_INVALID")
    _require_non_empty_string(value.get("request_id"), "LOCALE_HEALTH_REQUEST_INVALID")
    return {"action": "health", "request_id": value["request_id"]}


def _validate_tts_invocation(value):
    if not isinstance(value, dict) or set(value) != TTS_INVOCATION_FIELDS:
        raise ProtocolError("LOCALE_TTS_INVOCATION_INVALID")
    for key in ("provider", "model", "config_updated_at", "provider_task_id"):
        _require_non_empty_string(value.get(key), "LOCALE_TTS_INVOCATION_INVALID")
    config_id = value.get("ai_service_config_id")
    if type(config_id) is not int or config_id <= 0:
        raise ProtocolError("LOCALE_TTS_INVOCATION_INVALID")
    try:
        parsed = datetime.fromisoformat(value["config_updated_at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise ProtocolError("LOCALE_TTS_INVOCATION_INVALID") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ProtocolError("LOCALE_TTS_INVOCATION_INVALID")


def _validate_video_invocation(value):
    if not isinstance(value, dict) or set(value) != VIDEO_INVOCATION_FIELDS:
        raise ProtocolError("LOCALE_VIDEO_INVOCATION_INVALID")
    for key in ("provider", "model", "config_updated_at", "provider_task_id"):
        _require_non_empty_string(value.get(key), "LOCALE_VIDEO_INVOCATION_INVALID")
    config_id = value.get("ai_service_config_id")
    if type(config_id) is not int or config_id <= 0:
        raise ProtocolError("LOCALE_VIDEO_INVOCATION_INVALID")
    artifact_sha256 = value.get("artifact_sha256")
    if not isinstance(artifact_sha256, str) or not HEX_SHA256_RE.fullmatch(artifact_sha256):
        raise ProtocolError("LOCALE_VIDEO_INVOCATION_INVALID")
    try:
        parsed = datetime.fromisoformat(value["config_updated_at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise ProtocolError("LOCALE_VIDEO_INVOCATION_INVALID") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ProtocolError("LOCALE_VIDEO_INVOCATION_INVALID")


def _validate_local_tts_invocation(value):
    if not isinstance(value, dict) or set(value) != LOCAL_TTS_INVOCATION_FIELDS:
        raise ProtocolError("LOCALE_LOCAL_TTS_INVOCATION_INVALID")
    if value.get("engine") != "eSpeak NG":
        raise ProtocolError("LOCALE_LOCAL_TTS_INVOCATION_INVALID")
    for key in ("engine_version", "profile"):
        _require_non_empty_string(value.get(key), "LOCALE_LOCAL_TTS_INVOCATION_INVALID")
    for key in ("binary_sha256", "manifest_sha256"):
        if not isinstance(value.get(key), str) or not HEX_SHA256_RE.fullmatch(value[key]):
            raise ProtocolError("LOCALE_LOCAL_TTS_INVOCATION_INVALID")


def _require_non_empty_string(value, code):
    if not isinstance(value, str) or not value.strip():
        raise ProtocolError(code)
