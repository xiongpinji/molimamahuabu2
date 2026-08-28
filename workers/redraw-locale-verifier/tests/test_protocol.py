import unittest

from redraw_locale_worker.errors import ProtocolError
from redraw_locale_worker.protocol import parse_request

VALID_VERIFY_REQUEST = {
    "action": "verify",
    "request_id": "req-1",
    "audio_path": "C:/tmp/audio.wav",
    "audio_sha256": "a" * 64,
    "approved_text": "Anna did not pay 50 dollars",
    "locale_pack": "en-US@1",
    "tts_invocation": {
        "provider": "minimax",
        "model": "speech-2.5-hd-preview",
        "ai_service_config_id": 7,
        "config_updated_at": "2026-08-08T12:30:00+08:00",
        "provider_task_id": "provider-task-1",
    },
}

VALID_NATIVE_AUDIO_REQUEST = {
    "action": "verify_native_audio",
    "request_id": "req-native-1",
    "audio_path": "C:/tmp/native-audio.wav",
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

VALID_LOCAL_VOICE_REQUEST = {
    "action": "verify_local_voice",
    "request_id": "req-local-1",
    "audio_path": "C:/tmp/local-voice.wav",
    "audio_sha256": "c" * 64,
    "approved_text": "Anna did not pay 50 dollars",
    "locale_pack": "en-US@1",
    "local_tts_invocation": {
        "engine": "eSpeak NG",
        "engine_version": "1.52.0",
        "binary_sha256": "d" * 64,
        "manifest_sha256": "e" * 64,
        "profile": "role-1",
    },
}


class ProtocolTests(unittest.TestCase):
    def test_health_accepts_only_action_and_request_id(self):
        self.assertEqual(
            parse_request({"action": "health", "request_id": "req-1"}),
            {"action": "health", "request_id": "req-1"},
        )
        with self.assertRaisesRegex(ProtocolError, "LOCALE_HEALTH_REQUEST_INVALID"):
            parse_request({"action": "health", "request_id": "req-1", "locale_pack": "en-US@1"})
        with self.assertRaisesRegex(ProtocolError, "LOCALE_HEALTH_REQUEST_INVALID"):
            parse_request({"action": "health", "request_id": ""})

    def test_verify_request_requires_exact_server_fields(self):
        with self.assertRaisesRegex(ProtocolError, "LOCALE_VERIFY_REQUEST_INVALID"):
            parse_request({"action": "verify", "locale_pack": "en-US@1"})
        with self.assertRaisesRegex(ProtocolError, "LOCALE_VERIFY_REQUEST_INVALID"):
            parse_request({**VALID_VERIFY_REQUEST, "detected_locale": "en-US"})
        with self.assertRaisesRegex(ProtocolError, "LOCALE_VERIFY_REQUEST_INVALID"):
            parse_request({**VALID_VERIFY_REQUEST, "request_id": ""})
        with self.assertRaisesRegex(ProtocolError, "LOCALE_VERIFY_REQUEST_INVALID"):
            parse_request({**VALID_VERIFY_REQUEST, "approved_text": None})
        with self.assertRaisesRegex(ProtocolError, "LOCALE_VERIFY_REQUEST_INVALID"):
            parse_request(["verify"])

    def test_verify_allows_only_en_us_pack_and_lowercase_sha256(self):
        parsed = parse_request(dict(VALID_VERIFY_REQUEST))
        self.assertEqual(parsed["locale_pack"], "en-US@1")

        with self.assertRaisesRegex(ProtocolError, "LOCALE_PACK_UNSUPPORTED"):
            parse_request({**VALID_VERIFY_REQUEST, "locale_pack": "en-GB@1"})
        with self.assertRaisesRegex(ProtocolError, "LOCALE_AUDIO_HASH_INVALID"):
            parse_request({**VALID_VERIFY_REQUEST, "audio_sha256": "A" * 64})
        with self.assertRaisesRegex(ProtocolError, "LOCALE_AUDIO_HASH_INVALID"):
            parse_request({**VALID_VERIFY_REQUEST, "audio_sha256": "a" * 63})

    def test_tts_invocation_is_exact_and_strictly_typed(self):
        invalid_cases = [
            {"provider": ""},
            {"model": ""},
            {"provider_task_id": ""},
            {"ai_service_config_id": 0},
            {"ai_service_config_id": True},
            {"ai_service_config_id": "7"},
            {"config_updated_at": "2026-08-08T12:30:00"},
            {"extra": "ignored"},
        ]
        for override in invalid_cases:
            invocation = dict(VALID_VERIFY_REQUEST["tts_invocation"])
            invocation.update(override)
            with (
                self.subTest(override=override),
                self.assertRaisesRegex(ProtocolError, "LOCALE_TTS_INVOCATION_INVALID"),
            ):
                parse_request({**VALID_VERIFY_REQUEST, "tts_invocation": invocation})

    def test_native_audio_request_requires_exact_video_invocation(self):
        try:
            parsed = parse_request(dict(VALID_NATIVE_AUDIO_REQUEST))
        except ProtocolError as exc:
            self.fail(f"native audio request should be accepted: {exc.code}")

        self.assertEqual(parsed["action"], "verify_native_audio")
        self.assertEqual(parsed["locale_pack"], "es@1")
        self.assertEqual(parsed["video_invocation"]["artifact_sha256"], "b" * 64)

    def test_native_audio_rejects_tts_invocation_and_unknown_fields(self):
        invalid_requests = [
            {
                **VALID_NATIVE_AUDIO_REQUEST,
                "tts_invocation": VALID_NATIVE_AUDIO_REQUEST["video_invocation"],
            },
            {**VALID_NATIVE_AUDIO_REQUEST, "detected_locale": "es-MX"},
            {**VALID_NATIVE_AUDIO_REQUEST, "thresholds": {"language_probability_min": 0.0}},
            {**VALID_NATIVE_AUDIO_REQUEST, "unknown": True},
        ]
        for request in invalid_requests:
            with (
                self.subTest(fields=sorted(request)),
                self.assertRaisesRegex(ProtocolError, "LOCALE_VERIFY_REQUEST_INVALID"),
            ):
                parse_request(request)

    def test_native_audio_hash_config_id_and_timestamp_are_strict(self):
        invalid_cases = [
            ({"audio_sha256": "A" * 64}, "LOCALE_AUDIO_HASH_INVALID"),
            ({"audio_sha256": "a" * 63}, "LOCALE_AUDIO_HASH_INVALID"),
            ({"video_invocation": {**VALID_NATIVE_AUDIO_REQUEST["video_invocation"], "artifact_sha256": "B" * 64}}, "LOCALE_VIDEO_INVOCATION_INVALID"),
            ({"video_invocation": {**VALID_NATIVE_AUDIO_REQUEST["video_invocation"], "ai_service_config_id": True}}, "LOCALE_VIDEO_INVOCATION_INVALID"),
            ({"video_invocation": {**VALID_NATIVE_AUDIO_REQUEST["video_invocation"], "config_updated_at": "2026-08-09T00:00:00"}}, "LOCALE_VIDEO_INVOCATION_INVALID"),
            ({"video_invocation": {**VALID_NATIVE_AUDIO_REQUEST["video_invocation"], "provider_task_id": ""}}, "LOCALE_VIDEO_INVOCATION_INVALID"),
        ]
        for override, code in invalid_cases:
            with self.subTest(override=override), self.assertRaisesRegex(ProtocolError, code):
                parse_request({**VALID_NATIVE_AUDIO_REQUEST, **override})

        with self.assertRaisesRegex(ProtocolError, "LOCALE_PACK_UNSUPPORTED"):
            parse_request({**VALID_NATIVE_AUDIO_REQUEST, "locale_pack": "es-MX@1"})

    def test_local_voice_request_accepts_only_exact_local_invocation(self):
        parsed = parse_request(dict(VALID_LOCAL_VOICE_REQUEST))

        self.assertEqual(parsed["action"], "verify_local_voice")
        self.assertEqual(parsed["local_tts_invocation"], VALID_LOCAL_VOICE_REQUEST["local_tts_invocation"])

        forbidden_fields = {
            "tts_invocation": VALID_VERIFY_REQUEST["tts_invocation"],
            "video_invocation": VALID_NATIVE_AUDIO_REQUEST["video_invocation"],
            "provider": "minimax",
            "model": "speech-02-hd",
            "ai_service_config_id": 7,
            "provider_task_id": "secret-task",
            "extra": True,
        }
        for key, value in forbidden_fields.items():
            with (
                self.subTest(field=key),
                self.assertRaisesRegex(ProtocolError, "LOCALE_VERIFY_REQUEST_INVALID"),
            ):
                parse_request({**VALID_LOCAL_VOICE_REQUEST, key: value})

    def test_local_voice_invocation_is_exact_typed_and_hash_bound(self):
        invalid_cases = [
            {"engine": ""},
            {"engine": "other"},
            {"engine_version": ""},
            {"binary_sha256": "D" * 64},
            {"binary_sha256": "d" * 63},
            {"manifest_sha256": "E" * 64},
            {"manifest_sha256": "e" * 63},
            {"profile": ""},
            {"provider": "minimax"},
            {"model": "speech-02-hd"},
            {"ai_service_config_id": 7},
            {"provider_task_id": "secret-task"},
        ]
        for override in invalid_cases:
            invocation = dict(VALID_LOCAL_VOICE_REQUEST["local_tts_invocation"])
            invocation.update(override)
            with (
                self.subTest(override=override),
                self.assertRaisesRegex(ProtocolError, "LOCALE_LOCAL_TTS_INVOCATION_INVALID"),
            ):
                parse_request({**VALID_LOCAL_VOICE_REQUEST, "local_tts_invocation": invocation})

        for override, code in (
            ({"approved_text": ""}, "LOCALE_VERIFY_REQUEST_INVALID"),
            ({"audio_sha256": "C" * 64}, "LOCALE_AUDIO_HASH_INVALID"),
            ({"locale_pack": "en-GB@1"}, "LOCALE_PACK_UNSUPPORTED"),
        ):
            with self.subTest(override=override), self.assertRaisesRegex(ProtocolError, code):
                parse_request({**VALID_LOCAL_VOICE_REQUEST, **override})


if __name__ == "__main__":
    unittest.main()
