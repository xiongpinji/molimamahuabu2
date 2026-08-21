import json
import hashlib
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
READY_TTL_SECONDS = 10
READY_REFRESH_SECONDS = 5
_UnixStreamServerBase = getattr(socketserver, "UnixStreamServer", socketserver.TCPServer)
FORBIDDEN_RESPONSE_FIELDS = frozenset({"transcript", "transcript_text", "approved_text"})


@dataclass(frozen=True)
class LocaleServerConfig:
    pack: dict
    allowed_root: Path
    asr: object = None
    accent: object = None
    verifier: object = None
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
            request = parse_request(raw)
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
            verifier = config.verifier or _default_verifier()
            result = verifier(
                request,
                config.pack,
                allowed_root=config.allowed_root,
                asr=config.asr,
                accent=config.accent,
            )
        except LocaleWorkerError as exc:
            self._write_error(exc.code)
            return
        except Exception:  # noqa: BLE001 - keep the JSONL protocol stable for verifier crashes.
            self._write_error("LOCALE_VERIFY_FAILED")
            return
        self._write_json({"ok": True, "result": result})

    def _write_error(self, code):
        self._write_json({"ok": False, "error_code": code})

    def _write_json(self, payload):
        encoded = _encode_response(payload)
        if encoded is None:
            encoded = _encode_response({"ok": False, "error_code": "LOCALE_RESPONSE_TOO_LARGE"})
        self.wfile.write(encoded)
        self.wfile.flush()


def make_test_server(verifier, *, pack, allowed_root, asr=None, accent=None):
    config = LocaleServerConfig(
        pack=pack,
        allowed_root=Path(allowed_root).resolve(),
        asr=asr,
        accent=accent,
        verifier=verifier,
    )
    return LocaleTcpTestServer(("127.0.0.1", 0), LocaleRequestHandler, config=config)


def build_ready_payload(pack, *, now=None, pid=None, ttl_seconds=READY_TTL_SECONDS):
    if not isinstance(pack, dict):
        raise TypeError("LOCALE_READY_ATTESTATION_INVALID")
    locale_pack = pack.get("id") if "id" in pack else pack.get("locale_pack")
    model_hash = pack.get("model_manifest_sha256")
    calibration_hash = pack.get("calibration_manifest_sha256")
    if (
        not isinstance(locale_pack, str)
        or not locale_pack.strip()
        or not isinstance(model_hash, str)
        or HEX_SHA256_RE.fullmatch(model_hash) is None
        or not isinstance(calibration_hash, str)
        or HEX_SHA256_RE.fullmatch(calibration_hash) is None
    ):
        raise ValueError("LOCALE_READY_ATTESTATION_INVALID")
    timestamp = _timestamp(now)
    return {
        "schema_version": 1,
        "pid": os.getpid() if pid is None else int(pid),
        "locale_pack": locale_pack,
        "model_manifest_sha256": model_hash,
        "calibration_manifest_sha256": calibration_hash,
        "expires_at": timestamp + ttl_seconds,
    }


def write_ready(path, pack, *, now=None, pid=None):
    ready_path = Path(path)
    ready_path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_ready_payload(pack, now=now, pid=pid)
    temp_path = ready_path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    os.replace(temp_path, ready_path)


def write_ready_after_startup_checks(path, pack, *, model_hash_check, smoke_checks, now=None, pid=None):
    run_startup_checks(pack, model_hash_check=model_hash_check, smoke_checks=smoke_checks)
    write_ready(path, pack, now=now, pid=pid)


def run_startup_checks(pack, *, model_hash_check, smoke_checks):
    if not callable(model_hash_check) or not isinstance(smoke_checks, (list, tuple)) or len(smoke_checks) != 2:
        raise TypeError("LOCALE_STARTUP_CHECK_INVALID")
    if not all(callable(check) for check in smoke_checks):
        raise TypeError("LOCALE_STARTUP_CHECK_INVALID")

    model_hash_check(pack)
    for check in smoke_checks:
        check()


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
    def __init__(self, ready_path, pack, *, interval_seconds=READY_REFRESH_SECONDS):
        self.ready_path = Path(ready_path)
        self.pack = pack
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
            write_ready(self.ready_path, self.pack)


def create_unix_server(socket_path, *, pack, allowed_root, asr, accent, ready_path=None):
    config = LocaleServerConfig(
        pack=pack,
        allowed_root=Path(allowed_root).resolve(),
        asr=asr,
        accent=accent,
        verifier=_default_verifier(),
        ready_path=Path(ready_path) if ready_path is not None else None,
        socket_path=Path(socket_path),
    )
    safe_unlink_socket(socket_path)
    return LocaleUnixServer(str(socket_path), LocaleRequestHandler, config=config)


def run_server(socket_path, *, pack, allowed_root, asr, accent, ready_path, model_hash_check, smoke_checks):
    _safe_unlink_file(ready_path)
    server = None
    refresher = None
    try:
        run_startup_checks(pack, model_hash_check=model_hash_check, smoke_checks=smoke_checks)
        server = create_unix_server(socket_path, pack=pack, allowed_root=allowed_root, asr=asr, accent=accent, ready_path=ready_path)
        write_ready(ready_path, pack)
        refresher = ReadyRefresher(ready_path, pack)
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


def _default_verifier():
    from .verifier import verify_audio

    return verify_audio


def main():
    try:
        socket_path = _required_env("REDRAW_LOCALE_VERIFIER_SOCKET")
        ready_path = _required_env("REDRAW_LOCALE_VERIFIER_READY_PATH")
        allowed_root = _required_env("REDRAW_LOCALE_VERIFIER_ALLOWED_ROOT")
        pack_path = _required_env("REDRAW_LOCALE_VERIFIER_PACK_PATH")
        model_manifest_path = _required_env("REDRAW_LOCALE_VERIFIER_MODEL_MANIFEST_PATH")
        expected_model_hash = _required_env("REDRAW_LOCALE_VERIFIER_MODEL_MANIFEST_SHA256")
        smoke_audio = _required_env("REDRAW_LOCALE_VERIFIER_SMOKE_AUDIO")
        asr_model_dir = _required_env("REDRAW_LOCALE_VERIFIER_ASR_MODEL_DIR")
        accent_runtime_dir = _required_env("REDRAW_LOCALE_VERIFIER_ACCENT_RUNTIME_DIR")

        pack = json.loads(Path(pack_path).read_text(encoding="utf-8"))
        if not isinstance(pack, dict):
            raise ValueError("LOCALE_PACK_INVALID")
        pack.setdefault("locale_pack", pack.get("id"))
        manifest_bytes = Path(model_manifest_path).read_bytes()
        actual_model_hash = hashlib.sha256(manifest_bytes).hexdigest()
        if actual_model_hash != expected_model_hash or pack.get("model_manifest_sha256") != expected_model_hash:
            raise ValueError("LOCALE_MODEL_MANIFEST_HASH_INVALID")

        from .engines import CommonAccentEngine, FasterWhisperEngine

        asr = FasterWhisperEngine(asr_model_dir)
        accent = CommonAccentEngine(accent_runtime_dir)
        smoke_path = Path(smoke_audio).resolve(strict=True)

        def model_hash_check(_pack):
            if hashlib.sha256(Path(model_manifest_path).read_bytes()).hexdigest() != expected_model_hash:
                raise ValueError("LOCALE_MODEL_MANIFEST_HASH_INVALID")

        run_server(
            socket_path,
            pack=pack,
            allowed_root=allowed_root,
            asr=asr,
            accent=accent,
            ready_path=ready_path,
            model_hash_check=model_hash_check,
            smoke_checks=[lambda: asr.infer(smoke_path), lambda: accent.infer(smoke_path)],
        )
    except Exception as exc:  # noqa: BLE001 - startup must fail closed without secret details.
        raise SystemExit(f"LOCALE_SERVER_STARTUP_FAILED:{type(exc).__name__}") from None


def _required_env(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"{name}_REQUIRED")
    return value


if __name__ == "__main__":
    main()
