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


if __name__ == "__main__":
    unittest.main()
