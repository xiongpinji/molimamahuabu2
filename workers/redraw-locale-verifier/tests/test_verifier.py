import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from redraw_locale_worker.verifier import verify_audio


class FakeAsr:
    def __init__(self, language, probability, text):
        self.result = {
            "language": language,
            "probability": probability,
            "text": text,
        }

    def infer(self, audio_path):
        self.seen_audio_path = audio_path
        return dict(self.result)


class FakeAccent:
    def __init__(self, label, probability):
        self.result = {
            "label": label,
            "probability": probability,
        }

    def infer(self, audio_path):
        self.seen_audio_path = audio_path
        return dict(self.result)


class VerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.audio_path = Path(self.temp_dir.name) / "voice.wav"
        self.audio_path.write_bytes(b"fake local audio bytes")
        self.audio_sha256 = hashlib.sha256(self.audio_path.read_bytes()).hexdigest()
        self.text = "Anna did not pay 50 dollars"
        self.request = {
            "request_id": "req-1",
            "audio_path": str(self.audio_path),
            "audio_sha256": self.audio_sha256,
            "approved_text": self.text,
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
            "schema_version": 1,
            "locale_pack": "en-US@1",
            "model_manifest_sha256": "a" * 64,
            "calibration_manifest_sha256": "b" * 64,
            "models": {
                "asr_revision": "2ec96c5472da50d38d40c0cfe0602af2e94b4c8a",
                "accent_revision": "cc5dc6a56db647149d9e52856d6e55114c1045a8",
                "asr_tree_sha256": "c" * 64,
                "accent_tree_sha256": "d" * 64,
            },
            "thresholds": {
                "language_probability_min": 0.95,
                "word_error_rate_max": 0.05,
                "character_error_rate_max": 0.05,
                "us_accent_probability_min": 0.90,
            },
            "us_accent_label": "us",
        }

    def test_locale_is_verified_only_when_all_gates_pass(self):
        result = verify_audio(
            self.request,
            self.pack,
            asr=FakeAsr("en", 0.98, self.text),
            accent=FakeAccent("us", 0.94),
        )

        self.assertTrue(result["language_verified"])
        self.assertEqual(result["detected_locale"], "en-US")
        self.assertEqual(result["audio_sha256"], self.audio_sha256)
        self.assertEqual(result["transcript_sha256"], hashlib.sha256(self.text.encode("utf-8")).hexdigest())
        self.assertEqual(result["model_manifest_sha256"], "a" * 64)
        self.assertEqual(result["calibration_manifest_sha256"], "b" * 64)
        self.assertEqual(result["models"]["asr_revision"], self.pack["models"]["asr_revision"])
        self.assertEqual(result["models"]["accent_revision"], self.pack["models"]["accent_revision"])
        self.assertEqual(result["models"]["asr_tree_sha256"], "c" * 64)
        self.assertEqual(result["models"]["accent_tree_sha256"], "d" * 64)
        self.assertEqual(result["tts_invocation"]["provider"], "minimax")
        self.assertEqual(result["tts_invocation"]["model"], "speech-02-hd")
        self.assertNotIn(self.text, json.dumps(result, sort_keys=True))
        self.assertNotIn("transcript_text", result)
        self.assertNotIn("approved_text", result)

    def test_request_locale_cannot_override_non_us_audio(self):
        result = verify_audio(
            self.request,
            self.pack,
            asr=FakeAsr("en", 0.99, self.text),
            accent=FakeAccent("england", 0.97),
        )

        self.assertFalse(result["language_verified"])
        self.assertIsNone(result["detected_locale"])
        self.assertEqual(result["checks"]["us_accent_label"], False)

    def test_any_gate_failure_returns_false_and_null_locale(self):
        cases = [
            FakeAsr("es", 0.99, self.text),
            FakeAsr("en", 0.94, self.text),
            FakeAsr("en", 0.99, "Anna paid fifty dollars"),
        ]
        for asr in cases:
            with self.subTest(asr=asr.result):
                result = verify_audio(self.request, self.pack, asr=asr, accent=FakeAccent("us", 0.94))
                self.assertFalse(result["language_verified"])
                self.assertIsNone(result["detected_locale"])

        result = verify_audio(self.request, self.pack, asr=FakeAsr("en", 0.99, self.text), accent=FakeAccent("us", 0.89))
        self.assertFalse(result["language_verified"])
        self.assertIsNone(result["detected_locale"])

    def test_empty_transcript_and_invalid_evidence_fail_closed(self):
        for asr in (
            FakeAsr("en", 0.99, ""),
            FakeAsr("en", "0.99", self.text),
            FakeAsr("en", 0.99, None),
        ):
            with self.subTest(asr=asr.result):
                result = verify_audio(self.request, self.pack, asr=asr, accent=FakeAccent("us", 0.94))
                self.assertFalse(result["language_verified"])
                self.assertIsNone(result["detected_locale"])

        result = verify_audio(self.request, self.pack, asr=FakeAsr("en", 0.99, self.text), accent=FakeAccent("us", "0.94"))
        self.assertFalse(result["language_verified"])
        self.assertIsNone(result["detected_locale"])

    def test_client_threshold_override_and_audio_hash_are_not_trusted(self):
        request = {
            **self.request,
            "audio_sha256": "0" * 64,
            "thresholds": {
                "language_probability_min": 0.0,
                "word_error_rate_max": 1.0,
                "character_error_rate_max": 1.0,
                "us_accent_probability_min": 0.0,
            },
        }
        result = verify_audio(
            request,
            self.pack,
            asr=FakeAsr("en", 0.99, "wrong transcript"),
            accent=FakeAccent("england", 0.99),
        )

        self.assertFalse(result["language_verified"])
        self.assertIsNone(result["detected_locale"])
        self.assertEqual(result["audio_sha256"], self.audio_sha256)
        self.assertEqual(result["checks"]["audio_sha256_matches_request"], False)


if __name__ == "__main__":
    unittest.main()
