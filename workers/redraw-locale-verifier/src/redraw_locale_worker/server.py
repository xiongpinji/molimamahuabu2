import json
import hashlib
import hmac
import os
import socketserver
import stat
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .errors import LocaleWorkerError, ProtocolError
from .protocol import HEX_SHA256_RE, parse_request

MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
# Covers a 30-minute 16 kHz/16-bit mono PCM WAV under the existing local audio cap.
MAX_SOURCE_AUDIO_BYTES = 64 * 1024 * 1024
READY_TTL_SECONDS = 10
READY_REFRESH_SECONDS = 5
_UnixStreamServerBase = getattr(socketserver, "UnixStreamServer", socketserver.TCPServer)
FORBIDDEN_RESPONSE_FIELDS = frozenset({
    "transcript",
    "transcript_text",
    "approved_text",
    "provider_task_id",
    "task_id",
    "audio_path",
    "path",
    "command",
    "environment",
    "env",
    "key",
    "api_key",
    "authorization",
})
SAFE_ERROR_CODES = frozenset({
    "LOCALE_REQUEST_TOO_LARGE",
    "LOCALE_REQUEST_INVALID_JSON",
    "LOCALE_RESPONSE_TOO_LARGE",
    "LOCALE_VERIFY_FAILED",
    "LOCALE_VERIFY_REQUEST_INVALID",
    "LOCALE_HEALTH_REQUEST_INVALID",
    "LOCALE_PACK_UNSUPPORTED",
    "LOCALE_AUDIO_HASH_INVALID",
    "LOCALE_TTS_INVOCATION_INVALID",
    "LOCALE_VIDEO_INVOCATION_INVALID",
    "LOCALE_LOCAL_TTS_INVOCATION_INVALID",
    "LOCALE_AUDIO_DEADLINE_EXCEEDED",
    "LOCALE_AUDIO_DURATION_INVALID",
    "LOCALE_AUDIO_NORMALIZE_FAILED",
    "LOCALE_AUDIO_PATH_INVALID",
    "LOCALE_AUDIO_PROBE_FAILED",
    "LOCALE_AUDIO_STREAM_INVALID",
    "AUDIO_PATH_NOT_ALLOWED",
    "AUDIO_SHA256_MISMATCH",
})
SOURCE_AUDIO_REQUEST_FIELDS = frozenset({"action", "request_id", "audio_path", "audio_sha256"})
SOURCE_AUDIO_SUFFIXES = frozenset({".wav"})
LOCAL_VOICE_RESULT_FIELDS = frozenset({
    "source",
    "request_id",
    "audio_sha256",
    "approved_text_sha256",
    "locale_pack",
    "language_verified",
    "detected_locale",
    "transcript_sha256",
    "model_manifest_sha256",
    "calibration_manifest_sha256",
    "models",
    "asr",
    "accent",
    "metrics",
    "checks",
    "local_tts_invocation",
    "completed_at",
})
LOCAL_TTS_INVOCATION_FIELDS = frozenset({
    "engine",
    "engine_version",
    "binary_sha256",
    "manifest_sha256",
    "profile",
})
LOCAL_VOICE_CHECK_FIELDS = frozenset({
    "locale_pack",
    "audio_path",
    "audio_sha256_matches_request",
    "asr_inference",
    "accent_inference",
    "calibration_thresholds",
    "language",
    "language_probability",
    "word_error_rate",
    "character_error_rate",
    "critical_tokens_match",
    "us_accent_label",
    "us_accent_probability",
    "model_manifest",
    "calibration_manifest",
    "models",
    "transcript_present",
})


@dataclass(frozen=True)
class LocaleServerConfig:
    pack: dict | None
    allowed_root: Path | tuple[Path, ...]
    pack_by_id: object = None
    asr: object = None
    accent: object = None
    verifier: object = None
    native_verifier: object = None
    local_voice_verifier: object = None
    source_audio_clusterer: object = None
    ready_path: Path | None = None
    socket_path: Path | None = None


class LocaleUnixServer(_UnixStreamServerBase):
    request_queue_size = 8

    def __init__(self, server_address, RequestHandlerClass, config=None, bind_and_activate=True):
        self.config = config
        super().__init__(server_address, RequestHandlerClass, bind_and_activate)
        self.socket_path = Path(server_address)

    def server_close(self):
        try:
            super().server_close()
        finally:
            safe_unlink_socket(getattr(self, "socket_path", None))
            ready_path = getattr(getattr(self, "config", None), "ready_path", None)
            if ready_path is not None:
                _safe_unlink_file(ready_path)


class LocaleTcpTestServer(socketserver.TCPServer):
    allow_reuse_address = True
    request_queue_size = 8

    def __init__(self, server_address, RequestHandlerClass, config=None, bind_and_activate=True):
        host, _port = server_address
        if host != "127.0.0.1":
            raise ValueError("LOCALE_TEST_SERVER_HOST_INVALID")
        self.config = config
        super().__init__(server_address, RequestHandlerClass, bind_and_activate)


class LocaleRequestHandler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline(MAX_REQUEST_BYTES + 2)
        if len(line) > MAX_REQUEST_BYTES:
            self._write_error("LOCALE_REQUEST_TOO_LARGE")
            return
        if not line.endswith(b"\n"):
            self._write_error("LOCALE_REQUEST_INVALID_JSON")
            return
        try:
            raw = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write_error("LOCALE_REQUEST_INVALID_JSON")
            return
        try:
            request = _parse_worker_request(raw)
        except ProtocolError as exc:
            self._write_error(exc.code)
            return
        except LocaleWorkerError as exc:
            self._write_error(exc.code)
            return

        if request["action"] == "health":
            self._write_json({"ok": True, "request_id": request["request_id"], "status": "ready"})
            return

        config = self.server.config
        try:
            if request["action"] == "analyze_source_audio":
                result = _analyze_source_audio_request(request, config)
                self._write_json({"ok": True, "result": result})
                return
            pack = _select_pack(config, request["locale_pack"])
            verifier = _select_verifier(config, request["action"])
            result = verifier(
                request,
                pack,
                allowed_root=config.allowed_root,
                asr=config.asr,
                accent=config.accent,
            )
            if request["action"] == "verify_local_voice" and not _valid_local_voice_result(result, request, pack):
                self._write_error("LOCALE_VERIFY_FAILED")
                return
        except LocaleWorkerError as exc:
            self._write_error(exc.code)
            return
        except Exception:  # noqa: BLE001 - keep the JSONL protocol stable for verifier crashes.
            self._write_error("LOCALE_VERIFY_FAILED")
            return
        self._write_json({"ok": True, "result": result})

    def _write_error(self, code):
        safe_code = code if isinstance(code, str) and code in SAFE_ERROR_CODES else "LOCALE_VERIFY_FAILED"
        self._write_json({"ok": False, "error_code": safe_code})

    def _write_json(self, payload):
        encoded = _encode_response(payload)
        if encoded is None:
            encoded = _encode_response({"ok": False, "error_code": "LOCALE_RESPONSE_TOO_LARGE"})
        self.wfile.write(encoded)
        self.wfile.flush()


def make_test_server(
    verifier,
    *,
    pack=None,
    pack_by_id=None,
    allowed_root,
    asr=None,
    accent=None,
    native_verifier=None,
    local_voice_verifier=None,
    source_audio_clusterer=None,
):
    config = LocaleServerConfig(
        pack=pack,
        pack_by_id=pack_by_id,
        allowed_root=_normalize_allowed_roots(allowed_root),
        asr=asr,
        accent=accent,
        verifier=verifier,
        native_verifier=native_verifier,
        local_voice_verifier=local_voice_verifier,
        source_audio_clusterer=source_audio_clusterer,
    )
    return LocaleTcpTestServer(("127.0.0.1", 0), LocaleRequestHandler, config=config)


def build_ready_payload(
    pack,
    *,
    pack_by_id=None,
    manifest_sha256=None,
    now=None,
    pid=None,
    ttl_seconds=READY_TTL_SECONDS,
):
    if not isinstance(pack, dict):
        raise TypeError("LOCALE_READY_ATTESTATION_INVALID")
    index = None
    primary_pack = pack
    if pack_by_id is not None:
        index = _validated_pack_index(pack_by_id)
        if not index:
            raise ValueError("LOCALE_READY_ATTESTATION_INVALID")
        primary_pack = index.get("en-US@1")
        if primary_pack is None:
            if len(index) != 1:
                raise ValueError("LOCALE_READY_ATTESTATION_INVALID")
            primary_pack = next(iter(index.values()))
        if _pack_identifier(pack) != _pack_identifier(primary_pack):
            raise ValueError("LOCALE_READY_ATTESTATION_INVALID")
    primary = _ready_attestation(primary_pack)
    timestamp = _timestamp(now)
    payload = {
        "schema_version": 1,
        "pid": os.getpid() if pid is None else int(pid),
        "locale_pack": primary["id"],
        "model_manifest_sha256": primary["model_manifest_sha256"],
        "calibration_manifest_sha256": primary["calibration_manifest_sha256"],
        "expires_at": timestamp + ttl_seconds,
    }
    if manifest_sha256 is not None:
        if not isinstance(manifest_sha256, str) or HEX_SHA256_RE.fullmatch(manifest_sha256) is None:
            raise ValueError("LOCALE_READY_ATTESTATION_INVALID")
        payload["manifest_sha256"] = manifest_sha256
    if pack_by_id is not None:
        attestations = [_ready_attestation(index[pack_id]) for pack_id in sorted(index)]
        payload["enabled_pack_ids"] = [item["id"] for item in attestations]
        payload["pack_attestations"] = attestations
    return payload


def write_ready(path, pack, *, pack_by_id=None, manifest_sha256=None, now=None, pid=None):
    ready_path = Path(path)
    ready_path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_ready_payload(
        pack,
        pack_by_id=pack_by_id,
        manifest_sha256=manifest_sha256,
        now=now,
        pid=pid,
    )
    temp_path = ready_path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    os.replace(temp_path, ready_path)


def write_ready_after_startup_checks(
    path,
    pack,
    *,
    model_hash_check,
    smoke_checks,
    pack_by_id=None,
    manifest_sha256=None,
    now=None,
    pid=None,
):
    run_startup_checks(pack, pack_by_id=pack_by_id, model_hash_check=model_hash_check, smoke_checks=smoke_checks)
    write_ready(
        path,
        pack,
        pack_by_id=pack_by_id,
        manifest_sha256=manifest_sha256,
        now=now,
        pid=pid,
    )


def run_startup_checks(pack, *, model_hash_check, smoke_checks, pack_by_id=None):
    if not callable(model_hash_check):
        raise TypeError("LOCALE_STARTUP_CHECK_INVALID")
    if pack_by_id is None:
        if not isinstance(smoke_checks, (list, tuple)) or len(smoke_checks) != 2 or not all(callable(check) for check in smoke_checks):
            raise TypeError("LOCALE_STARTUP_CHECK_INVALID")
        model_hash_check(pack)
        for check in smoke_checks:
            check()
        return

    index = _validated_pack_index(pack_by_id)
    required_smokes = {"asr"}
    if index and any(_pack_requires_accent(item) for item in index.values()):
        required_smokes.add("accent")
    if (
        not index
        or not isinstance(smoke_checks, dict)
        or set(smoke_checks) != required_smokes
        or not all(callable(check) for check in smoke_checks.values())
    ):
        raise TypeError("LOCALE_STARTUP_CHECK_INVALID")
    for pack_id in sorted(index):
        current_pack = index[pack_id]
        model_hash_check(current_pack)
        smoke_checks["asr"]()
        if _pack_requires_accent(current_pack):
            smoke_checks["accent"]()


def is_ready_expired(payload, *, now=None):
    if not isinstance(payload, dict):
        return True
    expires_at = payload.get("expires_at")
    if type(expires_at) not in (int, float):
        return True
    return float(expires_at) <= _timestamp(now)


def safe_unlink_socket(path):
    if path is None:
        return False
    socket_path = Path(path)
    try:
        mode = socket_path.stat().st_mode
    except FileNotFoundError:
        return False
    except OSError:
        return False
    if not stat.S_ISSOCK(mode):
        return False
    socket_path.unlink()
    return True


class ReadyRefresher:
    def __init__(
        self,
        ready_path,
        pack,
        *,
        pack_by_id=None,
        manifest_sha256=None,
        interval_seconds=READY_REFRESH_SECONDS,
    ):
        self.ready_path = Path(ready_path)
        self.pack = pack
        self.pack_by_id = pack_by_id
        self.manifest_sha256 = manifest_sha256
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=self.interval_seconds + 1)

    def _run(self):
        while not self._stop.wait(self.interval_seconds):
            write_ready(
                self.ready_path,
                self.pack,
                pack_by_id=self.pack_by_id,
                manifest_sha256=self.manifest_sha256,
            )


def create_unix_server(
    socket_path,
    *,
    pack,
    pack_by_id=None,
    allowed_root,
    asr,
    accent,
    ready_path=None,
    source_audio_clusterer=None,
):
    config = LocaleServerConfig(
        pack=pack,
        pack_by_id=pack_by_id,
        allowed_root=_normalize_allowed_roots(allowed_root),
        asr=asr,
        accent=accent,
        verifier=_default_verifier("verify"),
        native_verifier=_default_verifier("verify_native_audio"),
        local_voice_verifier=_default_verifier("verify_local_voice"),
        source_audio_clusterer=source_audio_clusterer,
        ready_path=Path(ready_path) if ready_path is not None else None,
        socket_path=Path(socket_path),
    )
    safe_unlink_socket(socket_path)
    return LocaleUnixServer(str(socket_path), LocaleRequestHandler, config=config)


def run_server(
    socket_path,
    *,
    pack,
    pack_by_id=None,
    allowed_root,
    asr,
    accent,
    ready_path,
    model_hash_check,
    smoke_checks,
    manifest_sha256=None,
    source_audio_clusterer=None,
):
    _safe_unlink_file(ready_path)
    server = None
    refresher = None
    try:
        run_startup_checks(pack, pack_by_id=pack_by_id, model_hash_check=model_hash_check, smoke_checks=smoke_checks)
        server = create_unix_server(
            socket_path,
            pack=pack,
            pack_by_id=pack_by_id,
            allowed_root=allowed_root,
            asr=asr,
            accent=accent,
            ready_path=ready_path,
            source_audio_clusterer=source_audio_clusterer,
        )
        write_ready(
            ready_path,
            pack,
            pack_by_id=pack_by_id,
            manifest_sha256=manifest_sha256,
        )
        refresher = ReadyRefresher(
            ready_path,
            pack,
            pack_by_id=pack_by_id,
            manifest_sha256=manifest_sha256,
        )
        refresher.start()
        server.serve_forever()
    finally:
        if refresher is not None:
            refresher.stop()
        if server is not None:
            server.server_close()
        else:
            safe_unlink_socket(socket_path)
        _safe_unlink_file(ready_path)


def _encode_response(payload):
    payload = _sanitize_response(payload)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(encoded) > MAX_RESPONSE_BYTES:
        return None
    return encoded


def _parse_worker_request(value):
    if not isinstance(value, dict) or value.get("action") != "analyze_source_audio":
        return parse_request(value)
    if set(value) != SOURCE_AUDIO_REQUEST_FIELDS:
        raise ProtocolError("LOCALE_VERIFY_REQUEST_INVALID")
    for field in ("request_id", "audio_path"):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise ProtocolError("LOCALE_VERIFY_REQUEST_INVALID")
    if not isinstance(value.get("audio_sha256"), str) or not HEX_SHA256_RE.fullmatch(value["audio_sha256"]):
        raise ProtocolError("LOCALE_AUDIO_HASH_INVALID")
    return value


def _analyze_source_audio_request(request, config):
    audio_path = _resolve_source_audio_path(request.get("audio_path"), config.allowed_root)
    expected_sha256 = request["audio_sha256"]
    if not hmac.compare_digest(_file_sha256(audio_path), expected_sha256):
        raise LocaleWorkerError("AUDIO_SHA256_MISMATCH")
    if config.asr is None or config.source_audio_clusterer is None:
        raise LocaleWorkerError("LOCALE_VERIFY_FAILED")
    from .source_evidence import analyze_source_audio

    result = analyze_source_audio(
        audio_path,
        asr=config.asr,
        clusterer=config.source_audio_clusterer,
    )
    result_sha256 = result.get("audio_sha256") if isinstance(result, dict) else None
    if not isinstance(result_sha256, str) or not hmac.compare_digest(result_sha256, expected_sha256):
        raise LocaleWorkerError("AUDIO_SHA256_MISMATCH")
    return result


def _file_sha256(path):
    digest = hashlib.sha256()
    try:
        with Path(path).open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        raise LocaleWorkerError("AUDIO_PATH_NOT_ALLOWED") from None
    return digest.hexdigest()


def _resolve_source_audio_path(audio_path, allowed_root):
    try:
        path_input = Path(audio_path)
    except TypeError:
        raise LocaleWorkerError("AUDIO_PATH_NOT_ALLOWED") from None
    if not path_input.is_absolute() or path_input.is_symlink():
        raise LocaleWorkerError("AUDIO_PATH_NOT_ALLOWED")
    try:
        path = path_input.resolve(strict=True)
        stat_result = path.stat()
    except (OSError, RuntimeError):
        raise LocaleWorkerError("AUDIO_PATH_NOT_ALLOWED") from None
    if (
        not path.is_file()
        or path.suffix.casefold() not in SOURCE_AUDIO_SUFFIXES
        or stat_result.st_size <= 0
        or stat_result.st_size > MAX_SOURCE_AUDIO_BYTES
    ):
        raise LocaleWorkerError("AUDIO_PATH_NOT_ALLOWED")
    roots = allowed_root if isinstance(allowed_root, (list, tuple, set, frozenset)) else (allowed_root,)
    for root_value in roots:
        try:
            root_input = Path(root_value)
            if not root_input.is_absolute():
                continue
            root = root_input.resolve(strict=True)
            if not root.is_dir():
                continue
            path.relative_to(root)
            return path
        except (TypeError, OSError, RuntimeError, ValueError):
            continue
    raise LocaleWorkerError("AUDIO_PATH_NOT_ALLOWED")


def _valid_local_voice_result(result, request, pack):
    if not isinstance(result, dict) or set(result) != LOCAL_VOICE_RESULT_FIELDS:
        return False
    approved_text_sha256 = hashlib.sha256(request["approved_text"].encode("utf-8")).hexdigest()
    if (
        result.get("source") != "offline-worker"
        or result.get("request_id") != request.get("request_id")
        or result.get("audio_sha256") != request.get("audio_sha256")
        or result.get("approved_text_sha256") != approved_text_sha256
        or result.get("locale_pack") != request.get("locale_pack")
        or result.get("model_manifest_sha256") != pack.get("model_manifest_sha256")
        or result.get("calibration_manifest_sha256") != pack.get("calibration_manifest_sha256")
        or result.get("language_verified") is not True
        or result.get("detected_locale") != "en-US"
        or not _is_sha256(result.get("transcript_sha256"))
        or not _valid_aware_datetime(result.get("completed_at"))
    ):
        return False

    invocation = result.get("local_tts_invocation")
    expected_invocation = request.get("local_tts_invocation")
    if (
        not isinstance(invocation, dict)
        or set(invocation) != LOCAL_TTS_INVOCATION_FIELDS
        or invocation != expected_invocation
    ):
        return False

    models = result.get("models")
    if (
        not isinstance(models, dict)
        or set(models) != {
            "asr_revision",
            "accent_revision",
            "asr_tree_sha256",
            "accent_tree_sha256",
        }
        or not _non_empty_string(models.get("asr_revision"))
        or not _non_empty_string(models.get("accent_revision"))
        or not _is_sha256(models.get("asr_tree_sha256"))
        or not _is_sha256(models.get("accent_tree_sha256"))
    ):
        return False

    asr = result.get("asr")
    accent = result.get("accent")
    metrics = result.get("metrics")
    checks = result.get("checks")
    return (
        isinstance(asr, dict)
        and set(asr) == {"ok", "language", "probability"}
        and asr.get("ok") is True
        and asr.get("language") == "en"
        and _is_probability(asr.get("probability"))
        and isinstance(accent, dict)
        and set(accent) == {"ok", "label", "probability"}
        and accent.get("ok") is True
        and accent.get("label") == "us"
        and _is_probability(accent.get("probability"))
        and isinstance(metrics, dict)
        and set(metrics) == {"word_error_rate", "character_error_rate", "critical_tokens_match"}
        and _is_probability(metrics.get("word_error_rate"))
        and _is_probability(metrics.get("character_error_rate"))
        and metrics.get("critical_tokens_match") is True
        and isinstance(checks, dict)
        and set(checks) == LOCAL_VOICE_CHECK_FIELDS
        and all(value is True for value in checks.values())
    )


def _is_sha256(value):
    return isinstance(value, str) and HEX_SHA256_RE.fullmatch(value) is not None


def _non_empty_string(value):
    return isinstance(value, str) and bool(value.strip())


def _is_probability(value):
    return type(value) in (int, float) and 0.0 <= float(value) <= 1.0


def _valid_aware_datetime(value):
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def _sanitize_response(value):
    if isinstance(value, dict):
        return {key: _sanitize_response(item) for key, item in value.items() if key not in FORBIDDEN_RESPONSE_FIELDS}
    if isinstance(value, list):
        return [_sanitize_response(item) for item in value]
    return value


def _timestamp(value):
    if value is None:
        return datetime.now(timezone.utc).timestamp()
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("LOCALE_READY_ATTESTATION_INVALID")
        return value.timestamp()
    return float(value)


def _safe_unlink_file(path):
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass


def _parse_pack_document(value):
    if not isinstance(value, dict):
        raise ValueError("LOCALE_PACK_INVALID")
    if "packs" not in value:
        pack = dict(value)
        pack_id = _pack_identifier(pack)
        if pack_id is None:
            raise ValueError("LOCALE_PACK_INVALID")
        pack.setdefault("locale_pack", pack_id)
        return pack, None
    if set(value) != {"packs"} or not isinstance(value["packs"], list) or not value["packs"]:
        raise ValueError("LOCALE_PACK_INVALID")

    index = {}
    for item in value["packs"]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip():
            raise ValueError("LOCALE_PACK_INVALID")
        pack = dict(item)
        pack.setdefault("locale_pack", pack["id"])
        pack_id = _pack_identifier(pack)
        if pack_id is None or pack_id in index:
            raise ValueError("LOCALE_PACK_INVALID")
        index[pack_id] = pack
    primary = index.get("en-US@1")
    if primary is None:
        if len(index) != 1:
            raise ValueError("LOCALE_PACK_INVALID")
        primary = next(iter(index.values()))
    return primary, index


def _ready_attestation(pack):
    pack_id = _pack_identifier(pack)
    model_hash = pack.get("model_manifest_sha256") if isinstance(pack, dict) else None
    calibration_hash = pack.get("calibration_manifest_sha256") if isinstance(pack, dict) else None
    if (
        pack_id is None
        or not isinstance(model_hash, str)
        or HEX_SHA256_RE.fullmatch(model_hash) is None
        or not isinstance(calibration_hash, str)
        or HEX_SHA256_RE.fullmatch(calibration_hash) is None
    ):
        raise ValueError("LOCALE_READY_ATTESTATION_INVALID")
    return {
        "id": pack_id,
        "model_manifest_sha256": model_hash,
        "calibration_manifest_sha256": calibration_hash,
    }


def _pack_requires_accent(pack):
    return not isinstance(pack, dict) or pack.get("scope") != "language"


def _select_pack(config, requested_pack_id):
    if config.pack_by_id is not None:
        index = _validated_pack_index(config.pack_by_id)
        if index is None or requested_pack_id not in index:
            raise ProtocolError("LOCALE_PACK_UNSUPPORTED")
        return index[requested_pack_id]
    if _pack_identifier(config.pack) != requested_pack_id:
        raise ProtocolError("LOCALE_PACK_UNSUPPORTED")
    return config.pack


def _validated_pack_index(pack_by_id):
    if not isinstance(pack_by_id, dict):
        return None
    index = {}
    for key, pack in pack_by_id.items():
        pack_id = _pack_identifier(pack)
        if not isinstance(key, str) or not key.strip() or key != pack_id or pack_id in index:
            return None
        index[pack_id] = pack
    return index


def _pack_identifier(pack):
    if not isinstance(pack, dict):
        return None
    pack_id = pack.get("id")
    locale_pack = pack.get("locale_pack")
    if pack_id is not None and locale_pack is not None and pack_id != locale_pack:
        return None
    value = pack_id if pack_id is not None else locale_pack
    return value if isinstance(value, str) and value.strip() else None


def _select_verifier(config, action):
    if action == "verify_native_audio":
        return config.native_verifier or _default_verifier(action)
    if action == "verify_local_voice":
        return config.local_voice_verifier or _default_verifier(action)
    return config.verifier or _default_verifier(action)


def _default_verifier(action="verify"):
    from .verifier import verify_audio, verify_local_voice, verify_native_audio

    if action == "verify_native_audio":
        return verify_native_audio
    if action == "verify_local_voice":
        return verify_local_voice
    return verify_audio


def main():
    try:
        socket_path = _required_env("REDRAW_LOCALE_VERIFIER_SOCKET")
        ready_path = _required_env("REDRAW_LOCALE_VERIFIER_READY_PATH")
        allowed_root = _allowed_roots_from_env(
            _required_env("REDRAW_LOCALE_VERIFIER_ALLOWED_ROOT"),
            os.environ.get("REDRAW_LOCALE_VERIFIER_EXTRA_ALLOWED_ROOTS", ""),
        )
        pack_path = _required_env("REDRAW_LOCALE_VERIFIER_PACK_PATH")
        model_manifest_path = _required_env("REDRAW_LOCALE_VERIFIER_MODEL_MANIFEST_PATH")
        expected_model_hash = _required_env("REDRAW_LOCALE_VERIFIER_MODEL_MANIFEST_SHA256")
        expected_manifest_hash = _required_env("REDRAW_LOCALE_VERIFIER_MANIFEST_SHA256")
        smoke_audio = _required_env("REDRAW_LOCALE_VERIFIER_SMOKE_AUDIO")
        asr_model_dir = _required_env("REDRAW_LOCALE_VERIFIER_ASR_MODEL_DIR")

        pack_document = json.loads(Path(pack_path).read_text(encoding="utf-8"))
        pack, pack_by_id = _parse_pack_document(pack_document)
        packs = pack_by_id.values() if pack_by_id is not None else (pack,)
        manifest_bytes = Path(model_manifest_path).read_bytes()
        actual_model_hash = hashlib.sha256(manifest_bytes).hexdigest()
        if actual_model_hash != expected_model_hash or any(
            item.get("model_manifest_sha256") != expected_model_hash for item in packs
        ):
            raise ValueError("LOCALE_MODEL_MANIFEST_HASH_INVALID")

        from .engines import CommonAccentEngine, FasterWhisperEngine, build_source_audio_clusterer

        asr = FasterWhisperEngine(asr_model_dir)
        source_audio_clusterer = build_source_audio_clusterer()
        accent_required = pack_by_id is None or any(_pack_requires_accent(item) for item in pack_by_id.values())
        accent = None
        if accent_required:
            accent_runtime_dir = _required_env("REDRAW_LOCALE_VERIFIER_ACCENT_RUNTIME_DIR")
            accent = CommonAccentEngine(accent_runtime_dir)
        smoke_path = Path(smoke_audio).resolve(strict=True)

        def model_hash_check(checked_pack):
            if (
                hashlib.sha256(Path(model_manifest_path).read_bytes()).hexdigest() != expected_model_hash
                or checked_pack.get("model_manifest_sha256") != expected_model_hash
            ):
                raise ValueError("LOCALE_MODEL_MANIFEST_HASH_INVALID")

        if pack_by_id is None:
            smoke_checks = [lambda: asr.infer(smoke_path), lambda: accent.infer(smoke_path)]
        else:
            smoke_checks = {"asr": lambda: asr.infer(smoke_path)}
            if accent is not None:
                smoke_checks["accent"] = lambda: accent.infer(smoke_path)

        run_server(
            socket_path,
            pack=pack,
            pack_by_id=pack_by_id,
            allowed_root=allowed_root,
            asr=asr,
            accent=accent,
            ready_path=ready_path,
            model_hash_check=model_hash_check,
            smoke_checks=smoke_checks,
            manifest_sha256=expected_manifest_hash,
            source_audio_clusterer=source_audio_clusterer,
        )
    except Exception as exc:  # noqa: BLE001 - startup must fail closed without secret details.
        raise SystemExit(f"LOCALE_SERVER_STARTUP_FAILED:{type(exc).__name__}") from None


def _required_env(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"{name}_REQUIRED")
    return value


def _normalize_allowed_roots(value):
    values = value if isinstance(value, (list, tuple, set, frozenset)) else (value,)
    roots = []
    for item in values:
        try:
            raw_root = Path(item)
        except TypeError:
            raise ValueError("LOCALE_ALLOWED_ROOT_INVALID") from None
        if not raw_root.is_absolute():
            raise ValueError("LOCALE_ALLOWED_ROOT_INVALID")
        root = raw_root.resolve()
        roots.append(root)
    if not roots:
        raise ValueError("LOCALE_ALLOWED_ROOT_INVALID")
    return roots[0] if len(roots) == 1 else tuple(roots)


def _allowed_roots_from_env(primary, extra):
    values = [primary]
    if extra:
        values.extend(item for item in extra.split(os.pathsep) if item)
    return _normalize_allowed_roots(values)


if __name__ == "__main__":
    main()
