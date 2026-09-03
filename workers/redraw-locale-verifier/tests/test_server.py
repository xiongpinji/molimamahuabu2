import hashlib
import json
import os
import socket
import tempfile
import threading
import time
import unittest
import wave
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import redraw_locale_worker.server as server_module
from redraw_locale_worker.errors import LocaleWorkerError
from redraw_locale_worker.server import (
    LocaleUnixServer,
    build_ready_payload,
    create_unix_server,
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


class LocalVoiceVerifier:
    def __init__(self):
        self.calls = []

    def __call__(self, request, pack, *, allowed_root, asr, accent):
        self.calls.append((request, pack, allowed_root, asr, accent))
        return _valid_local_voice_result(request, pack)


def _valid_local_voice_result(request, pack):
    approved_text_sha256 = hashlib.sha256(request["approved_text"].encode("utf-8")).hexdigest()
    return {
        "source": "offline-worker",
        "request_id": request["request_id"],
        "audio_sha256": request["audio_sha256"],
        "approved_text_sha256": approved_text_sha256,
        "locale_pack": request["locale_pack"],
        "language_verified": True,
        "detected_locale": "en-US",
        "transcript_sha256": approved_text_sha256,
        "model_manifest_sha256": pack["model_manifest_sha256"],
        "calibration_manifest_sha256": pack["calibration_manifest_sha256"],
        "models": {
            "asr_revision": "asr-pinned",
            "accent_revision": "accent-pinned",
            "asr_tree_sha256": "c" * 64,
            "accent_tree_sha256": "d" * 64,
        },
        "asr": {"ok": True, "language": "en", "probability": 0.99},
        "accent": {"ok": True, "label": "us", "probability": 0.99},
        "metrics": {
            "word_error_rate": 0.0,
            "character_error_rate": 0.0,
            "critical_tokens_match": True,
        },
        "checks": {
            "locale_pack": True,
            "audio_path": True,
            "audio_sha256_matches_request": True,
            "asr_inference": True,
            "accent_inference": True,
            "calibration_thresholds": True,
            "language": True,
            "language_probability": True,
            "word_error_rate": True,
            "character_error_rate": True,
            "critical_tokens_match": True,
            "us_accent_label": True,
            "us_accent_probability": True,
            "model_manifest": True,
            "calibration_manifest": True,
            "models": True,
            "transcript_present": True,
        },
        "local_tts_invocation": dict(request["local_tts_invocation"]),
        "completed_at": "2026-08-28T00:00:01Z",
    }


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
            "locale": "en-US",
            "model_manifest_sha256": "a" * 64,
            "calibration_manifest_sha256": "b" * 64,
        }
        self.native_request = {
            "action": "verify_native_audio",
            "request_id": "req-native-1",
            "audio_path": str(self.audio_path),
            "audio_sha256": "a" * 64,
            "approved_text": "Hola, pequeño.",
            "locale_pack": "es@1",
            "video_invocation": {
                "provider": "toapis",
                "model": "seedance-2-fast",
                "ai_service_config_id": 16,
                "config_updated_at": "2026-08-09T00:00:00Z",
                "provider_task_id": "provider-real-1",
                "artifact_sha256": "b" * 64,
            },
        }
        self.native_pack = {
            "id": "es@1",
            "language": "es",
            "scope": "language",
            "model_manifest_sha256": "c" * 64,
            "calibration_manifest_sha256": "d" * 64,
        }
        self.local_request = {
            "action": "verify_local_voice",
            "request_id": "req-local-1",
            "audio_path": str(self.audio_path),
            "audio_sha256": "a" * 64,
            "approved_text": "Anna did not pay 50 dollars",
            "locale_pack": "en-US@1",
            "local_tts_invocation": {
                "engine": "eSpeak NG",
                "engine_version": "1.52.0",
                "binary_sha256": "e" * 64,
                "manifest_sha256": "f" * 64,
                "profile": "role-1",
            },
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

    def test_server_dispatches_action_to_matching_verifier_and_pack_id(self):
        legacy = CountingVerifier()
        native = CountingVerifier()
        local = LocalVoiceVerifier()
        self.server = make_test_server(
            legacy,
            native_verifier=native,
            local_voice_verifier=local,
            pack=self.pack,
            pack_by_id={"en-US@1": self.pack, "es@1": self.native_pack},
            allowed_root=self.root,
        )
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        legacy_response = self._send_json(self.request)
        native_response = self._send_json(self.native_request)
        local_response = self._send_json(self.local_request)

        self.assertTrue(legacy_response["ok"])
        self.assertTrue(native_response["ok"])
        self.assertTrue(local_response["ok"])
        self.assertEqual(len(legacy.calls), 1)
        self.assertEqual(len(native.calls), 1)
        self.assertEqual(len(local.calls), 1)
        self.assertIs(legacy.calls[0][1], self.pack)
        self.assertIs(native.calls[0][1], self.native_pack)
        self.assertIs(local.calls[0][1], self.pack)

    def test_server_dispatches_source_audio_analysis_without_using_locale_verifiers(self):
        source_path = self.root / "source.wav"
        with wave.open(str(source_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16_000)
            handle.writeframes(b"\x00\x00" * 16_000)

        class FakeAsr:
            def infer(self, audio_path):
                self.audio_path = Path(audio_path)
                return {
                    "language": "zh",
                    "probability": 0.98,
                    "segments": [{"start": 0.0, "end": 0.5, "text": "你回来了"}],
                }

        class FakeClusterer:
            def embed(self, waveform, sample_rate):
                self.embedding_input = (len(waveform), sample_rate)
                return [1.0, 0.0]

            def cluster(self, embeddings):
                self.embeddings = embeddings
                return [0]

        verifier = CountingVerifier()
        asr = FakeAsr()
        clusterer = FakeClusterer()
        self.server = make_test_server(
            verifier,
            pack=self.pack,
            allowed_root=self.root,
            asr=asr,
            source_audio_clusterer=clusterer,
        )
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        response = self._send_json({
            "action": "analyze_source_audio",
            "request_id": "source-1",
            "audio_path": str(source_path),
        })

        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["source_language"], "zh")
        self.assertEqual(response["result"]["segments"][0]["speaker_cluster_id"], "speaker-cluster-1")
        self.assertNotIn(str(source_path), json.dumps(response, ensure_ascii=False))
        self.assertEqual(verifier.calls, [])
        self.assertEqual(asr.audio_path, source_path)
        self.assertEqual(clusterer.embedding_input, (8_000, 16_000))

    def test_source_audio_action_accepts_seventeen_second_pcm_wav_inside_allowed_root(self):
        source_path = self.root / "seventeen-seconds.wav"
        with wave.open(str(source_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16_000)
            handle.writeframes(b"\x00\x00" * (16_000 * 17))
        self.assertEqual(source_path.stat().st_size, 544_044)
        calls = []

        class FakeAsr:
            def infer(self, audio_path):
                calls.append(("asr", Path(audio_path)))
                return {
                    "language": "zh",
                    "probability": 0.98,
                    "segments": [{"start": 0.0, "end": 0.5, "text": "整集对白"}],
                }

        class FakeClusterer:
            def embed(self, waveform, sample_rate):
                calls.append(("embed", len(waveform), sample_rate))
                return [1.0, 0.0]

            def cluster(self, embeddings):
                calls.append(("cluster", len(embeddings)))
                return [0]

        self.server = make_test_server(
            CountingVerifier(),
            pack=self.pack,
            allowed_root=self.root,
            asr=FakeAsr(),
            source_audio_clusterer=FakeClusterer(),
        )
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        response = self._send_json({
            "action": "analyze_source_audio",
            "request_id": "source-seventeen-seconds",
            "audio_path": str(source_path),
        })

        self.assertTrue(response["ok"])
        self.assertEqual(
            calls,
            [("asr", source_path), ("embed", 8_000, 16_000), ("cluster", 1)],
        )

    def test_source_audio_action_rejects_paths_outside_allowed_roots(self):
        with tempfile.TemporaryDirectory() as outside_dir:
            outside_path = Path(outside_dir).resolve() / "outside.wav"
            outside_path.write_bytes(b"RIFF")
            self.server = make_test_server(
                CountingVerifier(),
                pack=self.pack,
                allowed_root=self.root,
                asr=object(),
                source_audio_clusterer=object(),
            )
            thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            thread.start()

            response = self._send_json({
                "action": "analyze_source_audio",
                "request_id": "source-outside",
                "audio_path": str(outside_path),
            })

        self.assertEqual(response, {"ok": False, "error_code": "AUDIO_PATH_NOT_ALLOWED"})

    def test_source_audio_action_rejects_unsafe_type_and_size_before_asr(self):
        unsupported_path = self.root / "source.mp3"
        unsupported_path.write_bytes(b"audio")
        oversized_path = self.root / "oversized.wav"
        with oversized_path.open("wb") as handle:
            handle.seek(64 * 1024 * 1024)
            handle.write(b"0")
        self.server = make_test_server(
            CountingVerifier(),
            pack=self.pack,
            allowed_root=self.root,
            asr=object(),
            source_audio_clusterer=object(),
        )
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        for index, audio_path in enumerate((unsupported_path, oversized_path), start=1):
            with self.subTest(audio_path=audio_path):
                response = self._send_json({
                    "action": "analyze_source_audio",
                    "request_id": f"source-unsafe-{index}",
                    "audio_path": str(audio_path),
                })
                self.assertEqual(response, {"ok": False, "error_code": "AUDIO_PATH_NOT_ALLOWED"})

    def test_local_voice_server_rejects_mixed_request_before_verifier(self):
        local = CountingVerifier()
        self.server = make_test_server(
            CountingVerifier(),
            local_voice_verifier=local,
            pack=self.pack,
            allowed_root=self.root,
        )
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        response = self._send_json({
            **self.local_request,
            "tts_invocation": self.request["tts_invocation"],
        })

        self.assertFalse(response["ok"])
        self.assertEqual(response["error_code"], "LOCALE_VERIFY_REQUEST_INVALID")
        self.assertEqual(local.calls, [])

    def test_local_voice_response_redacts_text_paths_commands_environment_and_keys(self):
        def local_verifier(request, pack, **kwargs):
            del kwargs
            return {
                **_valid_local_voice_result(request, pack),
                "approved_text": request["approved_text"],
                "audio_path": request["audio_path"],
                "command": ["espeak-ng", "--secret"],
                "environment": {"API_KEY": "key-secret"},
                "api_key": "key-secret",
            }

        self.server = make_test_server(
            CountingVerifier(),
            local_voice_verifier=local_verifier,
            pack=self.pack,
            allowed_root=self.root,
        )
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        response = self._send_json(self.local_request)

        self.assertEqual(response, {"ok": False, "error_code": "LOCALE_VERIFY_FAILED"})
        serialized = json.dumps(response, sort_keys=True)
        for secret in (
            self.local_request["approved_text"],
            self.local_request["audio_path"],
            "espeak-ng",
            "key-secret",
        ):
            self.assertNotIn(secret, serialized)

    def test_local_voice_unsafe_or_unknown_worker_error_code_is_replaced_without_leakage(self):
        for code in ("C:/private/voice.wav API_KEY=secret", "UNKNOWN_SAFE_LOOKING_CODE"):
            with self.subTest(code=code):
                def local_verifier(request, pack, **kwargs):
                    del request, pack, kwargs
                    raise LocaleWorkerError(code)

                self.server = make_test_server(
                    CountingVerifier(),
                    local_voice_verifier=local_verifier,
                    pack=self.pack,
                    allowed_root=self.root,
                )
                thread = threading.Thread(target=self.server.serve_forever, daemon=True)
                thread.start()

                response = self._send_json(self.local_request)

                self.assertEqual(response, {"ok": False, "error_code": "LOCALE_VERIFY_FAILED"})
                self.assertEqual(set(response), {"ok", "error_code"})
                serialized = json.dumps(response, sort_keys=True)
                self.assertNotIn("private", serialized)
                self.assertNotIn("secret", serialized)
                self.assertNotIn("UNKNOWN", serialized)
                self.server.shutdown()
                self.server.server_close()
                self.server = None

    def test_known_legacy_worker_error_code_remains_exact_and_stable(self):
        def verifier(request, pack, **kwargs):
            del request, pack, kwargs
            raise LocaleWorkerError("LOCALE_AUDIO_PATH_INVALID")

        self.server = make_test_server(verifier, pack=self.pack, allowed_root=self.root)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        self.assertEqual(
            self._send_json(self.request),
            {"ok": False, "error_code": "LOCALE_AUDIO_PATH_INVALID"},
        )

    def test_local_voice_success_response_requires_exact_complete_bound_evidence(self):
        invalid_overrides = [
            {"extra": True},
            {"provider": "minimax"},
            {"model": "speech-02-hd"},
            {"provider_task_id": "provider-secret-task"},
            {"audio_path": str(self.audio_path)},
            {"api_key": "key-secret"},
            {"approved_text": self.local_request["approved_text"]},
            {"audio_sha256": "0" * 64},
            {"approved_text_sha256": "0" * 64},
            {"locale_pack": "en-GB@1"},
            {"detected_locale": "en-GB"},
        ]
        for override in invalid_overrides:
            with self.subTest(override=override):
                def local_verifier(request, pack, **kwargs):
                    del kwargs
                    return {**_valid_local_voice_result(request, pack), **override}

                self.server = make_test_server(
                    CountingVerifier(),
                    local_voice_verifier=local_verifier,
                    pack=self.pack,
                    allowed_root=self.root,
                )
                thread = threading.Thread(target=self.server.serve_forever, daemon=True)
                thread.start()

                response = self._send_json(self.local_request)

                self.assertEqual(response, {"ok": False, "error_code": "LOCALE_VERIFY_FAILED"})
                self.server.shutdown()
                self.server.server_close()
                self.server = None

        def mixed_invocation(request, pack, **kwargs):
            del kwargs
            result = _valid_local_voice_result(request, pack)
            result["local_tts_invocation"]["provider"] = "minimax"
            return result

        self.server = make_test_server(
            CountingVerifier(),
            local_voice_verifier=mixed_invocation,
            pack=self.pack,
            allowed_root=self.root,
        )
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.assertEqual(
            self._send_json(self.local_request),
            {"ok": False, "error_code": "LOCALE_VERIFY_FAILED"},
        )

    def test_server_unknown_duplicate_and_missing_pack_fail_closed(self):
        cases = [
            {"en-US@1": self.pack},
            {"es@1": self.native_pack, "duplicate": dict(self.native_pack)},
            None,
        ]
        for pack_by_id in cases:
            with self.subTest(pack_by_id=pack_by_id):
                native = CountingVerifier()
                self.server = make_test_server(
                    CountingVerifier(),
                    native_verifier=native,
                    pack=None,
                    pack_by_id=pack_by_id,
                    allowed_root=self.root,
                )
                thread = threading.Thread(target=self.server.serve_forever, daemon=True)
                thread.start()

                response = self._send_json(self.native_request)

                self.assertFalse(response["ok"])
                self.assertEqual(response["error_code"], "LOCALE_PACK_UNSUPPORTED")
                self.assertEqual(native.calls, [])
                self.server.shutdown()
                self.server.server_close()
                self.server = None

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
                "video_invocation": {
                    "provider_task_id": "provider-secret-task",
                    "task_id": "legacy-secret-task",
                    "provider_task_id_sha256": "d" * 64,
                },
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
        self.assertNotIn("provider-secret-task", serialized)
        self.assertNotIn("legacy-secret-task", serialized)
        self.assertEqual(response["result"]["video_invocation"]["provider_task_id_sha256"], "d" * 64)

    def test_ready_payload_is_atomic_short_lived_and_expirable(self):
        ready_path = self.root / "run" / "worker.ready.json"
        now = datetime(2026, 8, 8, 7, 0, 0, tzinfo=timezone.utc)

        write_ready(ready_path, self.pack, now=now, pid=1234)
        payload = json.loads(ready_path.read_text(encoding="utf-8"))

        self.assertEqual(
            set(payload),
            {
                "schema_version",
                "pid",
                "locale_pack",
                "model_manifest_sha256",
                "calibration_manifest_sha256",
                "expires_at",
            },
        )
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
            build_ready_payload(self.pack, manifest_sha256="bad")
        with self.assertRaisesRegex(ValueError, "LOCALE_READY_ATTESTATION_INVALID"):
            build_ready_payload({**self.pack, "id": ""})

    def test_modern_ready_payload_binds_signed_registry_manifest(self):
        modern_pack = {
            "id": "en@1",
            "language": "en",
            "locale": None,
            "scope": "language",
            "prompt_language_label": "English",
            "model_manifest_sha256": "a" * 64,
            "calibration_manifest_sha256": "b" * 64,
            "thresholds": {
                "language_probability_min": 0.75,
                "dialogue_similarity_min": 0.8,
                "speech_chars_per_second_max": 20.0,
            },
        }
        payload = build_ready_payload(
            modern_pack,
            manifest_sha256="c" * 64,
            now=datetime(2026, 8, 8, 7, 0, 0, tzinfo=timezone.utc),
            pid=1234,
        )
        self.assertEqual(payload["manifest_sha256"], "c" * 64)

    def test_ready_after_startup_checks_preserves_manifest_hash_for_modern_pack(self):
        ready_path = self.root / "worker.ready.json"
        modern_pack = {
            "id": "en@1",
            "language": "en",
            "locale": None,
            "scope": "language",
            "prompt_language_label": "English",
            "model_manifest_sha256": "a" * 64,
            "calibration_manifest_sha256": "b" * 64,
            "thresholds": {
                "language_probability_min": 0.75,
                "dialogue_similarity_min": 0.8,
                "speech_chars_per_second_max": 20.0,
            },
        }
        write_ready_after_startup_checks(
            ready_path,
            modern_pack,
            model_hash_check=lambda pack: None,
            smoke_checks=(lambda: None, lambda: None),
            manifest_sha256="c" * 64,
            now=datetime(2026, 8, 8, 7, 0, 0, tzinfo=timezone.utc),
            pid=1234,
        )
        payload = json.loads(ready_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["manifest_sha256"], "c" * 64)

    def test_multi_pack_ready_keeps_legacy_fields_and_binds_sorted_pack_attestations(self):
        pack_by_id = {"es@1": self.native_pack, "en-US@1": self.pack}
        try:
            payload = build_ready_payload(
                self.pack,
                pack_by_id=pack_by_id,
                now=datetime(2026, 8, 8, 7, 0, 0, tzinfo=timezone.utc),
                pid=1234,
            )
        except TypeError as exc:
            self.fail(f"multi-pack ready is not implemented: {exc}")

        self.assertEqual(payload["locale_pack"], "en-US@1")
        self.assertEqual(payload["model_manifest_sha256"], "a" * 64)
        self.assertEqual(payload["calibration_manifest_sha256"], "b" * 64)
        self.assertEqual(payload["enabled_pack_ids"], ["en-US@1", "es@1"])
        self.assertEqual(
            payload["pack_attestations"],
            [
                {
                    "id": "en-US@1",
                    "model_manifest_sha256": "a" * 64,
                    "calibration_manifest_sha256": "b" * 64,
                },
                {
                    "id": "es@1",
                    "model_manifest_sha256": "c" * 64,
                    "calibration_manifest_sha256": "d" * 64,
                },
            ],
        )

    def test_pack_bundle_requires_exact_shape_unique_non_empty_ids_and_legacy_primary(self):
        parser = getattr(server_module, "_parse_pack_document", None)
        self.assertTrue(callable(parser), "production pack bundle parser is missing")
        if not callable(parser):
            return

        single_pack, single_index = parser(self.pack)
        self.assertEqual(single_pack["id"], "en-US@1")
        self.assertIsNone(single_index)

        primary, pack_by_id = parser({"packs": [self.native_pack, self.pack]})
        self.assertEqual(primary["id"], "en-US@1")
        self.assertEqual(sorted(pack_by_id), ["en-US@1", "es@1"])

        missing_id = dict(self.native_pack)
        missing_id.pop("id")
        invalid_documents = [
            {"packs": [self.pack, dict(self.pack)]},
            {"packs": [missing_id]},
            {"packs": [self.pack], "extra": True},
            {"packs": []},
        ]
        for document in invalid_documents:
            with self.subTest(document=document), self.assertRaisesRegex(ValueError, "LOCALE_PACK_INVALID"):
                parser(document)

    def test_main_loads_bundle_and_builds_per_pack_startup_smokes(self):
        model_manifest_path = self.root / "model-manifest.json"
        model_manifest_path.write_text('{"models":{}}', encoding="utf-8")
        expected_model_hash = hashlib.sha256(model_manifest_path.read_bytes()).hexdigest()
        bundle_path = self.root / "packs.json"
        en_pack = {**self.pack, "model_manifest_sha256": expected_model_hash}
        es_pack = {**self.native_pack, "model_manifest_sha256": expected_model_hash}
        bundle_path.write_text(json.dumps({"packs": [es_pack, en_pack]}), encoding="utf-8")
        smoke_audio = self.root / "smoke.wav"
        smoke_audio.write_bytes(b"RIFF")
        asr_dir = self.root / "asr"
        accent_dir = self.root / "accent"
        asr_dir.mkdir()
        accent_dir.mkdir()
        private_audio_root = self.root / "private-audio"
        private_audio_root.mkdir()
        calls = []
        captured = {}

        class FakeAsrEngine:
            def __init__(self, model_dir):
                self.model_dir = model_dir

            def infer(self, audio_path):
                calls.append(("asr", Path(audio_path)))
                return {}

        class FakeAccentEngine:
            def __init__(self, runtime_dir):
                self.runtime_dir = runtime_dir

            def infer(self, audio_path):
                calls.append(("accent", Path(audio_path)))
                return {}

        def capture_run_server(socket_path, **kwargs):
            captured["socket_path"] = socket_path
            captured.update(kwargs)

        env = {
            "REDRAW_LOCALE_VERIFIER_SOCKET": str(self.root / "worker.sock"),
            "REDRAW_LOCALE_VERIFIER_READY_PATH": str(self.root / "worker.ready.json"),
            "REDRAW_LOCALE_VERIFIER_ALLOWED_ROOT": str(self.root),
            "REDRAW_LOCALE_VERIFIER_EXTRA_ALLOWED_ROOTS": str(private_audio_root),
            "REDRAW_LOCALE_VERIFIER_PACK_PATH": str(bundle_path),
            "REDRAW_LOCALE_VERIFIER_MODEL_MANIFEST_PATH": str(model_manifest_path),
            "REDRAW_LOCALE_VERIFIER_MODEL_MANIFEST_SHA256": expected_model_hash,
            "REDRAW_LOCALE_VERIFIER_MANIFEST_SHA256": "e" * 64,
            "REDRAW_LOCALE_VERIFIER_SMOKE_AUDIO": str(smoke_audio),
            "REDRAW_LOCALE_VERIFIER_ASR_MODEL_DIR": str(asr_dir),
            "REDRAW_LOCALE_VERIFIER_ACCENT_RUNTIME_DIR": str(accent_dir),
        }
        with (
            patch.dict(os.environ, env, clear=True),
            patch("redraw_locale_worker.engines.FasterWhisperEngine", FakeAsrEngine),
            patch("redraw_locale_worker.engines.CommonAccentEngine", FakeAccentEngine),
            patch.object(server_module, "run_server", side_effect=capture_run_server),
        ):
            try:
                server_module.main()
            except SystemExit as exc:
                self.fail(f"production main rejected valid pack bundle: {exc}")

        self.assertEqual(captured["pack"]["id"], "en-US@1")
        self.assertEqual(sorted(captured["pack_by_id"]), ["en-US@1", "es@1"])
        self.assertEqual(captured["allowed_root"], (self.root, private_audio_root))
        self.assertEqual(captured["manifest_sha256"], "e" * 64)
        server_module.run_startup_checks(
            captured["pack"],
            pack_by_id=captured["pack_by_id"],
            model_hash_check=captured["model_hash_check"],
            smoke_checks=captured["smoke_checks"],
        )
        self.assertEqual(calls, [("asr", smoke_audio), ("accent", smoke_audio), ("asr", smoke_audio)])

        native_only_order = []
        server_module.run_startup_checks(
            es_pack,
            pack_by_id={"es@1": es_pack},
            model_hash_check=lambda checked_pack: native_only_order.append(("hash", checked_pack["id"])),
            smoke_checks={"asr": lambda: native_only_order.append(("asr", "es@1"))},
        )
        self.assertEqual(native_only_order, [("hash", "es@1"), ("asr", "es@1")])

    def test_allowed_root_environment_rejects_relative_extra_root(self):
        with self.assertRaisesRegex(ValueError, "LOCALE_ALLOWED_ROOT_INVALID"):
            server_module._allowed_roots_from_env(str(self.root), "private-audio")

    def test_run_server_and_create_unix_server_preserve_multi_pack_config(self):
        pack_by_id = {"es@1": self.native_pack, "en-US@1": self.pack}
        ready_path = self.root / "worker.ready.json"
        socket_path = self.root / "worker.sock"
        order = []
        active_pack = {"id": None}

        def model_hash_check(pack):
            active_pack["id"] = pack["id"]
            order.append(("hash", pack["id"]))

        def asr_smoke():
            order.append(("asr", active_pack["id"]))

        def accent_smoke():
            order.append(("accent", active_pack["id"]))

        def fail_create(socket_path_arg, **kwargs):
            self.assertEqual(Path(socket_path_arg), socket_path)
            self.assertIs(kwargs["pack_by_id"], pack_by_id)
            raise OSError

        with patch.object(server_module, "create_unix_server", side_effect=fail_create):
            try:
                run_server(
                    socket_path,
                    pack=self.pack,
                    pack_by_id=pack_by_id,
                    allowed_root=self.root,
                    asr=object(),
                    accent=object(),
                    ready_path=ready_path,
                    model_hash_check=model_hash_check,
                    smoke_checks={"asr": asr_smoke, "accent": accent_smoke},
                )
            except OSError:
                pass
            except TypeError as exc:
                self.fail(f"run_server does not accept production pack_by_id: {exc}")
            else:
                self.fail("patched bind failure was not reached")

        self.assertEqual(
            order,
            [
                ("hash", "en-US@1"),
                ("asr", "en-US@1"),
                ("accent", "en-US@1"),
                ("hash", "es@1"),
                ("asr", "es@1"),
            ],
        )

        captured = {}

        class FakeUnixServer:
            def __init__(self, server_address, handler, config=None):
                captured.update(address=server_address, handler=handler, config=config)

        def isolated_verifier(request, pack, **kwargs):
            del request, kwargs
            return {"locale_pack": pack["id"]}

        with (
            patch.object(server_module, "LocaleUnixServer", FakeUnixServer),
            patch.object(server_module, "_default_verifier", return_value=isolated_verifier),
        ):
            try:
                create_unix_server(
                    socket_path,
                    pack=self.pack,
                    pack_by_id=pack_by_id,
                    allowed_root=self.root,
                    asr=object(),
                    accent=object(),
                )
            except TypeError as exc:
                self.fail(f"create_unix_server does not accept production pack_by_id: {exc}")

        self.assertIs(captured["config"].pack_by_id, pack_by_id)
        self.server = server_module.LocaleTcpTestServer(
            ("127.0.0.1", 0),
            server_module.LocaleRequestHandler,
            config=captured["config"],
        )
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        legacy_response = self._send_json(self.request)
        native_response = self._send_json(self.native_request)

        self.assertTrue(legacy_response["ok"])
        self.assertEqual(legacy_response["result"]["locale_pack"], "en-US@1")
        self.assertTrue(native_response["ok"])
        self.assertEqual(native_response["result"]["locale_pack"], "es@1")

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
        write_ready(ready_path, self.pack, now=datetime(2026, 8, 8, 7, 0, 0, tzinfo=timezone.utc), pid=1234)
        self.assertTrue(ready_path.exists())

        def model_hash_check(pack):
            self.assertFalse(ready_path.exists())
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

    def test_run_server_removes_stale_ready_before_startup_check_failure(self):
        ready_path = self.root / "worker.ready.json"
        socket_path = self.root / "worker.sock"
        write_ready(ready_path, self.pack, now=datetime(2026, 8, 8, 7, 0, 0, tzinfo=timezone.utc), pid=1234)
        self.assertTrue(ready_path.exists())

        def model_hash_check(pack):
            self.assertFalse(ready_path.exists())
            raise RuntimeError

        with self.assertRaises(RuntimeError):
            run_server(
                socket_path,
                pack=self.pack,
                allowed_root=self.root,
                asr=object(),
                accent=object(),
                ready_path=ready_path,
                model_hash_check=model_hash_check,
                smoke_checks=(lambda: None, lambda: None),
            )

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
