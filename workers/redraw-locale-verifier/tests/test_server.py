import json
import os
import socket
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import redraw_locale_worker.server as server_module
from redraw_locale_worker.server import (
    LocaleUnixServer,
    build_ready_payload,
    is_ready_expired,
    make_test_server,
    safe_unlink_socket,
    run_server,
    write_ready,
    write_ready_after_startup_checks,
)


class CountingVerifier:
    def __init__(self):
        self.active = 0
        self.max_active = 0
        self.calls = []
        self.lock = threading.Lock()

    def __call__(self, request, pack, *, allowed_root, asr, accent):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(0.05)
            self.calls.append((request, pack, allowed_root, asr, accent))
            return {
                "source": "offline-worker",
                "request_id": request["request_id"],
                "language_verified": True,
                "detected_locale": "en-US",
            }
        finally:
            with self.lock:
                self.active -= 1


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name).resolve()
        self.audio_path = self.root / "voice.wav"
        self.audio_path.write_bytes(b"fake audio")
        self.request = {
            "action": "verify",
            "request_id": "req-1",
            "audio_path": str(self.audio_path),
            "audio_sha256": "a" * 64,
            "approved_text": "Anna did not pay 50 dollars",
            "locale_pack": "en-US@1",
            "tts_invocation": {
                "provider": "minimax",
                "model": "speech-02-hd",
                "ai_service_config_id": 7,
                "config_updated_at": "2026-08-08T07:00:00+00:00",
                "provider_task_id": "provider-task-1",
            },
        }
        self.pack = {
            "id": "en-US@1",
            "locale_pack": "en-US@1",
            "model_manifest_sha256": "a" * 64,
            "calibration_manifest_sha256": "b" * 64,
        }

    def tearDown(self):
        server = getattr(self, "server", None)
        if server is not None:
            server.shutdown()
            server.server_close()

    def test_server_processes_only_one_verify_request_at_a_time(self):
        verifier = CountingVerifier()
        self.server = make_test_server(verifier, pack=self.pack, allowed_root=self.root)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        results = []
        clients = [
            threading.Thread(target=lambda: results.append(self._send_json({**self.request, "request_id": "req-1"}))),
            threading.Thread(target=lambda: results.append(self._send_json({**self.request, "request_id": "req-2"}))),
        ]
        for client in clients:
            client.start()
        for client in clients:
            client.join(timeout=2)

        self.assertEqual(verifier.max_active, 1)
        self.assertEqual(len(results), 2)
        self.assertEqual([result["ok"] for result in results], [True, True])
        self.assertEqual(len(verifier.calls), 2)
        self.assertEqual(verifier.calls[0][2], self.root)

    def test_oversized_json_line_is_rejected(self):
        self.server = make_test_server(CountingVerifier(), pack=self.pack, allowed_root=self.root)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        response = self._send_raw(b"{" + b"x" * 65536 + b"}\n")

        self.assertFalse(response["ok"])
        self.assertEqual(response["error_code"], "LOCALE_REQUEST_TOO_LARGE")

    def test_invalid_json_and_protocol_errors_are_stable(self):
        self.server = make_test_server(CountingVerifier(), pack=self.pack, allowed_root=self.root)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        invalid_json = self._send_raw(b"{not-json}\n")
        protocol_error = self._send_json({"action": "verify", "locale_pack": "en-US@1"})

        self.assertEqual(invalid_json["error_code"], "LOCALE_REQUEST_INVALID_JSON")
        self.assertEqual(protocol_error["error_code"], "LOCALE_VERIFY_REQUEST_INVALID")

    def test_health_and_verify_responses_are_newline_terminated_and_bounded(self):
        def verifier(request, pack, **kwargs):
            return {"ok": True, "debug_blob": "x" * (300 * 1024)}

        self.server = make_test_server(verifier, pack=self.pack, allowed_root=self.root)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        health = self._send_raw_line(b'{"action":"health","request_id":"health-1"}\n')
        oversized = self._send_raw_line(json.dumps(self.request).encode("utf-8") + b"\n")

        self.assertTrue(health.endswith(b"\n"))
        self.assertLessEqual(len(health), 256 * 1024)
        self.assertEqual(json.loads(health), {"ok": True, "request_id": "health-1", "status": "ready"})
        self.assertTrue(oversized.endswith(b"\n"))
        response = json.loads(oversized)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error_code"], "LOCALE_RESPONSE_TOO_LARGE")
        self.assertLessEqual(len(oversized), 256 * 1024)

    def test_verify_response_never_returns_full_transcript_fields(self):
        def verifier(request, pack, **kwargs):
            return {
                "source": "offline-worker",
                "transcript": "Anna did not pay 50 dollars",
                "transcript_text": "Anna did not pay 50 dollars",
                "approved_text": "Anna did not pay 50 dollars",
                "transcript_sha256": "c" * 64,
            }

        self.server = make_test_server(verifier, pack=self.pack, allowed_root=self.root)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        response = self._send_json(self.request)

        self.assertTrue(response["ok"])
        serialized = json.dumps(response, sort_keys=True)
        self.assertNotIn("Anna did not pay", serialized)
        self.assertNotIn("transcript", response["result"])
        self.assertNotIn("transcript_text", response["result"])
        self.assertNotIn("approved_text", response["result"])
        self.assertEqual(response["result"]["transcript_sha256"], "c" * 64)

    def test_ready_payload_is_atomic_short_lived_and_expirable(self):
        ready_path = self.root / "run" / "worker.ready.json"
        now = datetime(2026, 8, 8, 7, 0, 0, tzinfo=timezone.utc)

        write_ready(ready_path, self.pack, now=now, pid=1234)
        payload = json.loads(ready_path.read_text(encoding="utf-8"))

        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["pid"], 1234)
        self.assertEqual(payload["locale_pack"], "en-US@1")
        self.assertEqual(payload["model_manifest_sha256"], "a" * 64)
        self.assertEqual(payload["calibration_manifest_sha256"], "b" * 64)
        self.assertAlmostEqual(payload["expires_at"], now.timestamp() + 10)
        self.assertFalse((ready_path.parent / "worker.ready.tmp").exists())
        self.assertFalse(is_ready_expired(payload, now=now))
        self.assertTrue(is_ready_expired(payload, now=datetime.fromtimestamp(payload["expires_at"] + 0.1, timezone.utc)))

    def test_ready_payload_rejects_bad_hashes_and_missing_ids(self):
        with self.assertRaisesRegex(ValueError, "LOCALE_READY_ATTESTATION_INVALID"):
            build_ready_payload({**self.pack, "model_manifest_sha256": "bad"})
        with self.assertRaisesRegex(ValueError, "LOCALE_READY_ATTESTATION_INVALID"):
            build_ready_payload({**self.pack, "id": ""})

    def test_ready_is_written_only_after_model_hash_and_two_engine_smokes(self):
        ready_path = self.root / "worker.ready.json"
        order = []

        def model_hash_check(pack):
            self.assertFalse(ready_path.exists())
            order.append(("hash", pack["id"]))

        def asr_smoke():
            self.assertFalse(ready_path.exists())
            order.append(("smoke", "asr"))

        def accent_smoke():
            self.assertFalse(ready_path.exists())
            order.append(("smoke", "accent"))

        write_ready_after_startup_checks(
            ready_path,
            self.pack,
            model_hash_check=model_hash_check,
            smoke_checks=(asr_smoke, accent_smoke),
            now=datetime(2026, 8, 8, 7, 0, 0, tzinfo=timezone.utc),
            pid=1234,
        )

        self.assertEqual(order, [("hash", "en-US@1"), ("smoke", "asr"), ("smoke", "accent")])
        self.assertTrue(ready_path.exists())

    def test_startup_ready_requires_exactly_two_smoke_checks(self):
        with self.assertRaisesRegex(TypeError, "LOCALE_STARTUP_CHECK_INVALID"):
            write_ready_after_startup_checks(
                self.root / "worker.ready.json",
                self.pack,
                model_hash_check=lambda pack: None,
                smoke_checks=(lambda: None,),
            )

    def test_run_server_does_not_publish_ready_when_unix_bind_fails(self):
        ready_path = self.root / "worker.ready.json"
        socket_path = self.root / "worker.sock"
        order = []

        def model_hash_check(pack):
            order.append(("hash", pack["id"]))

        def asr_smoke():
            order.append(("smoke", "asr"))

        def accent_smoke():
            order.append(("smoke", "accent"))

        def fail_create(socket_path_arg, **kwargs):
            self.assertEqual(Path(socket_path_arg), socket_path)
            raise OSError

        with patch.object(server_module, "create_unix_server", side_effect=fail_create):
            with self.assertRaises(OSError):
                run_server(
                    socket_path,
                    pack=self.pack,
                    allowed_root=self.root,
                    asr=object(),
                    accent=object(),
                    ready_path=ready_path,
                    model_hash_check=model_hash_check,
                    smoke_checks=(asr_smoke, accent_smoke),
                )

        self.assertEqual(order, [("hash", "en-US@1"), ("smoke", "asr"), ("smoke", "accent")])
        self.assertFalse(ready_path.exists())
        self.assertFalse(socket_path.exists())

    def test_safe_unlink_socket_does_not_remove_unexpected_files(self):
        regular = self.root / "worker.sock"
        regular.write_text("not a socket", encoding="utf-8")

        self.assertFalse(safe_unlink_socket(regular))
        self.assertTrue(regular.exists())

    @unittest.skipUnless(os.name == "posix", "requires AF_UNIX")
    def test_locale_unix_server_uses_af_unix_and_request_queue_size_eight(self):
        socket_path = self.root / "worker.sock"
        server = LocaleUnixServer(str(socket_path), lambda request, client_address, server: None)
        try:
            self.assertEqual(server.address_family, socket.AF_UNIX)
            self.assertEqual(server.request_queue_size, 8)
        finally:
            server.server_close()
            safe_unlink_socket(socket_path)

    def _send_json(self, payload):
        return json.loads(self._send_raw_line(json.dumps(payload).encode("utf-8") + b"\n"))

    def _send_raw(self, payload):
        return json.loads(self._send_raw_line(payload))

    def _send_raw_line(self, payload):
        host, port = self.server.server_address
        with socket.create_connection((host, port), timeout=2) as client:
            client.sendall(payload)
            client.shutdown(socket.SHUT_WR)
            chunks = []
            while True:
                chunk = client.recv(4096)
                if not chunk:
                    break
                chunks.append(chunk)
        return b"".join(chunks)


if __name__ == "__main__":
    unittest.main()
