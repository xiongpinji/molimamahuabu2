import hashlib
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def _load_verifier_under_test():
    try:
        import redraw_locale_worker.verifier as module

        return module, False
    except ModuleNotFoundError as exc:
        if exc.name != "jiwer":
            raise

    package_dir = Path(__file__).resolve().parents[1] / "src" / "redraw_locale_worker"

    def edit_distance(reference, hypothesis):
        previous = list(range(len(hypothesis) + 1))
        for row, expected in enumerate(reference, start=1):
            current = [row]
            for column, observed in enumerate(hypothesis, start=1):
                current.append(min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (expected != observed),
                ))
            previous = current
        return previous[-1]

    jiwer_fixture = types.ModuleType("jiwer")
    jiwer_fixture.wer = lambda reference, hypothesis: (
        edit_distance(reference.split(), hypothesis.split()) / max(1, len(reference.split()))
    )
    jiwer_fixture.cer = lambda reference, hypothesis: (
        edit_distance(reference, hypothesis) / max(1, len(reference))
    )

    normalization_name = "redraw_locale_worker._task3_test_normalization"
    normalization_spec = importlib.util.spec_from_file_location(
        normalization_name,
        package_dir / "normalization.py",
    )
    normalization_module = importlib.util.module_from_spec(normalization_spec)
    with patch.dict(sys.modules, {"jiwer": jiwer_fixture, normalization_name: normalization_module}):
        normalization_spec.loader.exec_module(normalization_module)

    verifier_name = "redraw_locale_worker._task3_test_verifier"
    verifier_spec = importlib.util.spec_from_file_location(
        verifier_name,
        package_dir / "verifier.py",
    )
    verifier_module = importlib.util.module_from_spec(verifier_spec)
    with patch.dict(
        sys.modules,
        {
            "redraw_locale_worker.normalization": normalization_module,
            verifier_name: verifier_module,
        },
    ):
        verifier_spec.loader.exec_module(verifier_module)
    return verifier_module, True


verifier_module, USING_ISOLATED_JIWER_FIXTURE = _load_verifier_under_test()
from redraw_locale_worker.engines import FasterWhisperEngine, _score_to_probability

verify_audio = verifier_module.verify_audio
verify_native_audio = getattr(verifier_module, "verify_native_audio", None)
verify_local_voice = getattr(verifier_module, "verify_local_voice", None)


class FakeAsr:
    def __init__(self, language, probability, text):
        self.result = {
            "language": language,
            "probability": probability,
            "text": text,
        }

    def infer(self, audio_path):
        self.seen_audio_path = audio_path
        self.called = True
        return dict(self.result)


class FakeAccent:
    def __init__(self, label, probability):
        self.result = {
            "label": label,
            "probability": probability,
        }

    def infer(self, audio_path):
        self.seen_audio_path = audio_path
        self.called = True
        return dict(self.result)


class ExplodingAccent:
    def infer(self, audio_path):
        raise AssertionError(f"native verification must not call accent inference: {audio_path}")


class RaisingEngine:
    def infer(self, audio_path):
        self.seen_audio_path = audio_path
        raise RuntimeError("provider secret path /tmp/source.wav")


class InvalidEngine:
    def infer(self, audio_path):
        self.seen_audio_path = audio_path
        return "not evidence"


class FakeScore:
    def __init__(self, value):
        self.value = value

    def __getitem__(self, index):
        self.index = index
        return self

    def item(self):
        return self.value


class FakeWhisperModel:
    language_probability = 0.98

    def __init__(self, model_dir, device, compute_type, local_files_only):
        self.init_args = {
            "model_dir": model_dir,
            "device": device,
            "compute_type": compute_type,
            "local_files_only": local_files_only,
        }

    def transcribe(self, audio_path, beam_size, vad_filter):
        del audio_path, beam_size, vad_filter
        segment = types.SimpleNamespace(start=0.25, end=1.5, text="Anna did not pay 50 dollars")
        info = types.SimpleNamespace(language="en", language_probability=self.language_probability)
        return [segment], info


class VerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.audio_path = Path(self.temp_dir.name) / "voice.wav"
        self.allowed_root = Path(self.temp_dir.name).resolve()
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
        self.native_text = "Hola, pequeño."
        self.native_request = {
            "action": "verify_native_audio",
            "request_id": "req-native-1",
            "audio_path": str(self.audio_path),
            "audio_sha256": self.audio_sha256,
            "approved_text": self.native_text,
            "locale_pack": "es@1",
            "video_invocation": {
                "provider": "toapis",
                "model": "seedance-2-fast",
                "ai_service_config_id": 16,
                "config_updated_at": "2026-08-09T00:00:00Z",
                "provider_task_id": "provider-real-1",
                "artifact_sha256": "e" * 64,
            },
        }
        self.native_pack = {
            "id": "es@1",
            "language": "es",
            "locale": None,
            "scope": "language",
            "model_manifest_sha256": "f" * 64,
            "calibration_manifest_sha256": "9" * 64,
            "models": {
                "asr_revision": "2ec96c5472da50d38d40c0cfe0602af2e94b4c8a",
                "asr_tree_sha256": "8" * 64,
            },
            "thresholds": {
                "language_probability_min": 0.80,
                "dialogue_similarity_min": 0.80,
                "speech_chars_per_second_max": 20,
            },
        }
        self.native_english_text = "Mateo, come with me."
        self.native_english_request = {
            **self.native_request,
            "request_id": "req-native-en-1",
            "approved_text": self.native_english_text,
            "locale_pack": "en@1",
        }
        self.native_english_pack = {
            **self.native_pack,
            "id": "en@1",
            "language": "en",
        }
        self.local_request = {
            "action": "verify_local_voice",
            "request_id": "req-local-1",
            "audio_path": str(self.audio_path),
            "audio_sha256": self.audio_sha256,
            "approved_text": self.text,
            "locale_pack": "en-US@1",
            "local_tts_invocation": {
                "engine": "eSpeak NG",
                "engine_version": "1.52.0",
                "binary_sha256": "6" * 64,
                "manifest_sha256": "7" * 64,
                "profile": "role-1",
            },
        }

    def _native_asr(self, *, language="es", probability=0.96, text=None, segments=None):
        transcript = self.native_text if text is None else text
        if segments is None:
            segments = [{"start": 0.0, "end": 1.2, "text": transcript}]
        engine = FakeAsr(language, probability, transcript)
        engine.result["segments"] = segments
        return engine

    def test_missing_jiwer_fixture_is_scoped_to_isolated_modules(self):
        if not USING_ISOLATED_JIWER_FIXTURE:
            self.skipTest("real jiwer dependency is installed")
        self.assertNotIn("jiwer", sys.modules)
        self.assertNotIn("redraw_locale_worker._task3_test_normalization", sys.modules)
        self.assertNotIn("redraw_locale_worker._task3_test_verifier", sys.modules)

    def test_locale_is_verified_only_when_all_gates_pass(self):
        result = verify_audio(
            self.request,
            self.pack,
            allowed_root=self.allowed_root,
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
            allowed_root=self.allowed_root,
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
                result = verify_audio(self.request, self.pack, allowed_root=self.allowed_root, asr=asr, accent=FakeAccent("us", 0.94))
                self.assertFalse(result["language_verified"])
                self.assertIsNone(result["detected_locale"])

        result = verify_audio(
            self.request,
            self.pack,
            allowed_root=self.allowed_root,
            asr=FakeAsr("en", 0.99, self.text),
            accent=FakeAccent("us", 0.89),
        )
        self.assertFalse(result["language_verified"])
        self.assertIsNone(result["detected_locale"])

    def test_empty_transcript_and_invalid_evidence_fail_closed(self):
        for asr in (
            FakeAsr("en", 0.99, ""),
            FakeAsr("en", "0.99", self.text),
            FakeAsr("en", 0.99, None),
        ):
            with self.subTest(asr=asr.result):
                result = verify_audio(self.request, self.pack, allowed_root=self.allowed_root, asr=asr, accent=FakeAccent("us", 0.94))
                self.assertFalse(result["language_verified"])
                self.assertIsNone(result["detected_locale"])

        result = verify_audio(
            self.request,
            self.pack,
            allowed_root=self.allowed_root,
            asr=FakeAsr("en", 0.99, self.text),
            accent=FakeAccent("us", "0.94"),
        )
        self.assertFalse(result["language_verified"])
        self.assertIsNone(result["detected_locale"])

    def test_inference_probability_must_be_finite_unit_interval_number(self):
        invalid_values = [float("inf"), float("nan"), 2.0, -0.1, True]
        for probability in invalid_values:
            with self.subTest(engine="asr", probability=probability):
                result = verify_audio(
                    self.request,
                    self.pack,
                    allowed_root=self.allowed_root,
                    asr=FakeAsr("en", probability, self.text),
                    accent=FakeAccent("us", 0.99),
                )
                self.assertFalse(result["language_verified"])
                self.assertIsNone(result["detected_locale"])
                self.assertIsNone(result["asr"]["probability"])

            with self.subTest(engine="accent", probability=probability):
                result = verify_audio(
                    self.request,
                    self.pack,
                    allowed_root=self.allowed_root,
                    asr=FakeAsr("en", 0.99, self.text),
                    accent=FakeAccent("us", probability),
                )
                self.assertFalse(result["language_verified"])
                self.assertIsNone(result["detected_locale"])
                self.assertIsNone(result["accent"]["probability"])

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
            allowed_root=self.allowed_root,
            asr=FakeAsr("en", 0.99, "wrong transcript"),
            accent=FakeAccent("england", 0.99),
        )

        self.assertFalse(result["language_verified"])
        self.assertIsNone(result["detected_locale"])
        self.assertEqual(result["audio_sha256"], self.audio_sha256)
        self.assertEqual(result["checks"]["audio_sha256_matches_request"], False)

    def test_audio_path_must_be_absolute_regular_file_inside_allowed_root(self):
        cases = [
            ("relative.wav", self.allowed_root),
            (str(self.allowed_root / ".." / "outside.wav"), self.allowed_root),
            (str(self.allowed_root), self.allowed_root),
            (str(self.allowed_root / "missing.wav"), self.allowed_root),
            (str(self.audio_path), self.allowed_root / "missing-root"),
            (str(self.audio_path), Path("relative-root")),
        ]
        for audio_path, allowed_root in cases:
            asr = FakeAsr("en", 0.99, self.text)
            accent = FakeAccent("us", 0.99)
            with self.subTest(audio_path=audio_path, allowed_root=allowed_root):
                result = verify_audio(
                    {**self.request, "audio_path": audio_path},
                    self.pack,
                    allowed_root=allowed_root,
                    asr=asr,
                    accent=accent,
                )
                self.assertFalse(result["language_verified"])
                self.assertIsNone(result["detected_locale"])
                self.assertFalse(result["checks"]["audio_path"])
                self.assertFalse(hasattr(asr, "called"))
                self.assertFalse(hasattr(accent, "called"))

    def test_audio_path_rejects_final_symlink(self):
        link = self.allowed_root / "voice-link.wav"
        try:
            link.symlink_to(self.audio_path)
        except OSError as exc:
            self.skipTest(f"symlink creation unavailable: {exc}")

        asr = FakeAsr("en", 0.99, self.text)
        result = verify_audio(
            {**self.request, "audio_path": str(link)},
            self.pack,
            allowed_root=self.allowed_root,
            asr=asr,
            accent=FakeAccent("us", 0.99),
        )
        self.assertFalse(result["language_verified"])
        self.assertIsNone(result["detected_locale"])
        self.assertFalse(result["checks"]["audio_path"])
        self.assertFalse(hasattr(asr, "called"))

    def test_inference_failures_keep_non_sensitive_stage_evidence(self):
        result = verify_audio(
            self.request,
            self.pack,
            allowed_root=self.allowed_root,
            asr=RaisingEngine(),
            accent=InvalidEngine(),
        )

        self.assertFalse(result["language_verified"])
        self.assertIsNone(result["detected_locale"])
        self.assertFalse(result["checks"]["asr_inference"])
        self.assertFalse(result["checks"]["accent_inference"])
        self.assertEqual(result["asr"], {"ok": False, "error_code": "INFERENCE_FAILED"})
        self.assertEqual(result["accent"], {"ok": False, "error_code": "INFERENCE_INVALID"})
        serialized = json.dumps(result, sort_keys=True)
        self.assertNotIn("provider secret", serialized)
        self.assertNotIn("/tmp/source.wav", serialized)

    def test_calibration_thresholds_must_be_finite_unit_interval_values(self):
        invalid_values = [-0.01, 1.01, float("nan"), float("inf")]
        for key in self.pack["thresholds"]:
            for value in invalid_values:
                pack = {
                    **self.pack,
                    "thresholds": {
                        **self.pack["thresholds"],
                        key: value,
                    },
                }
                with self.subTest(key=key, value=value):
                    result = verify_audio(
                        self.request,
                        pack,
                        allowed_root=self.allowed_root,
                        asr=FakeAsr("en", 1.0, self.text),
                        accent=FakeAccent("us", 1.0),
                    )
                    self.assertFalse(result["language_verified"])
                    self.assertIsNone(result["detected_locale"])
                    self.assertFalse(result["checks"]["calibration_thresholds"])

    def test_commonaccent_score_to_probability_never_returns_invalid_probability(self):
        for value in (True, 2.0, float("inf"), float("nan")):
            with self.subTest(value=value):
                self.assertIsNone(_score_to_probability(FakeScore(value)))

        self.assertAlmostEqual(_score_to_probability(FakeScore(-0.1)), 0.9048374180359595)

    def test_faster_whisper_engine_rejects_invalid_language_probability(self):
        module = types.ModuleType("faster_whisper")
        module.WhisperModel = FakeWhisperModel
        previous = sys.modules.get("faster_whisper")
        sys.modules["faster_whisper"] = module
        try:
            with tempfile.TemporaryDirectory() as tmp:
                model_dir = Path(tmp) / "model"
                model_dir.mkdir()
                engine = FasterWhisperEngine(model_dir)
                for value in (True, float("nan"), float("inf"), 2.0, -0.1):
                    with self.subTest(value=value):
                        FakeWhisperModel.language_probability = value
                        self.assertIsNone(engine.infer(self.audio_path)["probability"])
                FakeWhisperModel.language_probability = 0.98
                evidence = engine.infer(self.audio_path)
                self.assertEqual(evidence["probability"], 0.98)
                self.assertEqual(
                    evidence["segments"],
                    [{"start": 0.25, "end": 1.5, "text": "Anna did not pay 50 dollars"}],
                )
        finally:
            if previous is None:
                sys.modules.pop("faster_whisper", None)
            else:
                sys.modules["faster_whisper"] = previous

    def test_local_voice_verifier_entrypoint_exists(self):
        self.assertTrue(callable(verify_local_voice))

    @unittest.skipUnless(callable(verify_local_voice), "local voice verifier is not implemented yet")
    def test_local_voice_reuses_locale_gates_and_binds_only_local_invocation(self):
        result = verify_local_voice(
            self.local_request,
            self.pack,
            allowed_root=self.allowed_root,
            asr=FakeAsr("en", 0.98, self.text),
            accent=FakeAccent("us", 0.94),
        )

        self.assertTrue(result["language_verified"])
        self.assertEqual(result["detected_locale"], "en-US")
        self.assertEqual(result["request_id"], "req-local-1")
        self.assertEqual(result["audio_sha256"], self.audio_sha256)
        self.assertEqual(result["locale_pack"], "en-US@1")
        self.assertEqual(result["approved_text_sha256"], hashlib.sha256(self.text.encode("utf-8")).hexdigest())
        self.assertEqual(result["local_tts_invocation"], self.local_request["local_tts_invocation"])
        self.assertEqual(
            set(result),
            {
                "source",
                "locale_pack",
                "language_verified",
                "detected_locale",
                "audio_sha256",
                "transcript_sha256",
                "model_manifest_sha256",
                "calibration_manifest_sha256",
                "models",
                "asr",
                "accent",
                "metrics",
                "checks",
                "completed_at",
                "request_id",
                "approved_text_sha256",
                "local_tts_invocation",
            },
        )
        self.assertNotIn("tts_invocation", result)
        self.assertNotIn("video_invocation", result)
        serialized = json.dumps(result, sort_keys=True)
        self.assertNotIn(self.text, serialized)
        for forbidden in ("provider", "model", "ai_service_config_id", "provider_task_id"):
            self.assertNotIn(forbidden, result["local_tts_invocation"])

    @unittest.skipUnless(callable(verify_local_voice), "local voice verifier is not implemented yet")
    def test_local_voice_does_not_trust_request_locale_claims_or_relax_thresholds(self):
        request = {
            **self.local_request,
            "detected_locale": "en-US",
            "thresholds": {
                "language_probability_min": 0,
                "word_error_rate_max": 1,
                "character_error_rate_max": 1,
                "us_accent_probability_min": 0,
            },
        }
        result = verify_local_voice(
            request,
            self.pack,
            allowed_root=self.allowed_root,
            asr=FakeAsr("en", 0.94, self.text),
            accent=FakeAccent("us", 0.99),
        )

        self.assertFalse(result["language_verified"])
        self.assertIsNone(result["detected_locale"])
        self.assertFalse(result["checks"]["language_probability"])
        self.assertEqual(result["local_tts_invocation"], self.local_request["local_tts_invocation"])

    def test_native_audio_verifier_entrypoint_exists(self):
        self.assertTrue(callable(verify_native_audio))

    @unittest.skipUnless(callable(verify_native_audio), "native verifier is not implemented yet")
    def test_native_audio_verifies_language_without_locale_or_accent(self):
        result = verify_native_audio(
            self.native_request,
            self.native_pack,
            allowed_root=self.allowed_root,
            asr=self._native_asr(),
            accent=ExplodingAccent(),
        )

        self.assertTrue(result["language_verified"])
        self.assertFalse(result["locale_verified"])
        self.assertEqual(result["detected_language"], "es")
        self.assertIsNone(result["detected_locale"])
        self.assertEqual(result["locale_pack"], "es@1")
        self.assertEqual(result["dialogue_similarity"], 1.0)
        self.assertEqual(result["asr"], {"ok": True, "language": "es", "probability": 0.96})
        self.assertEqual(
            result["segments"],
            [
                {
                    "start_ms": 0,
                    "end_ms": 1200,
                    "text_sha256": hashlib.sha256(self.native_text.encode("utf-8")).hexdigest(),
                }
            ],
        )
        self.assertEqual(result["model_manifest_sha256"], "f" * 64)
        self.assertEqual(result["calibration_manifest_sha256"], "9" * 64)
        self.assertIn("models", result)
        self.assertEqual(
            result["models"],
            {
                "asr_revision": "2ec96c5472da50d38d40c0cfe0602af2e94b4c8a",
                "asr_tree_sha256": "8" * 64,
            },
        )
        self.assertEqual(
            result["video_invocation"],
            {
                "provider": "toapis",
                "model": "seedance-2-fast",
                "ai_service_config_id": 16,
                "config_updated_at": "2026-08-09T00:00:00Z",
                "artifact_sha256": "e" * 64,
                "provider_task_id_sha256": hashlib.sha256(b"provider-real-1").hexdigest(),
            },
        )
        serialized = json.dumps(result, sort_keys=True, ensure_ascii=False)
        self.assertNotIn(self.native_text, serialized)
        self.assertNotIn("provider-real-1", serialized)
        self.assertNotIn("transcript", result)

    @unittest.skipUnless(callable(verify_native_audio), "native verifier is not implemented yet")
    def test_native_audio_verifies_english_without_tts_or_accent(self):
        result = verify_native_audio(
            self.native_english_request,
            self.native_english_pack,
            allowed_root=self.allowed_root,
            asr=self._native_asr(language="en", text=self.native_english_text),
            accent=ExplodingAccent(),
        )

        self.assertTrue(result["language_verified"])
        self.assertFalse(result["locale_verified"])
        self.assertEqual(result["detected_language"], "en")
        self.assertEqual(result["locale_pack"], "en@1")
        self.assertEqual(result["dialogue_similarity"], 1.0)
        self.assertNotIn("tts_invocation", result)

    @unittest.skipUnless(callable(verify_native_audio), "native verifier is not implemented yet")
    def test_native_audio_uses_asr_language_not_request_locale_claims(self):
        request = {
            **self.native_request,
            "locale": "es-MX",
            "detected_locale": "es-MX",
            "detected_language": "es",
        }
        result = verify_native_audio(
            request,
            self.native_pack,
            allowed_root=self.allowed_root,
            asr=self._native_asr(language="en"),
            accent=ExplodingAccent(),
        )

        self.assertFalse(result["language_verified"])
        self.assertFalse(result["locale_verified"])
        self.assertEqual(result["detected_language"], "en")
        self.assertIsNone(result["detected_locale"])
        self.assertFalse(result["checks"]["language"])

    @unittest.skipUnless(callable(verify_native_audio), "native verifier is not implemented yet")
    def test_native_audio_fails_closed_without_real_speech_segments_and_hides_transcript(self):
        for segments in ([], [{"start": 0.0, "end": 1.0, "text": ""}]):
            with self.subTest(segments=segments):
                transcript = "texto que no coincide"
                result = verify_native_audio(
                    self.native_request,
                    self.native_pack,
                    allowed_root=self.allowed_root,
                    asr=self._native_asr(text=transcript, segments=segments),
                    accent=ExplodingAccent(),
                )

                self.assertFalse(result["language_verified"])
                self.assertIsNone(result["detected_locale"])
                self.assertFalse(result["checks"]["speech_segments_present"])
                serialized = json.dumps(result, sort_keys=True, ensure_ascii=False)
                self.assertNotIn(transcript, serialized)
                self.assertNotIn("provider-real-1", serialized)

    @unittest.skipUnless(callable(verify_native_audio), "native verifier is not implemented yet")
    def test_native_audio_segments_reject_overlap_order_invalid_numbers_and_excess_count(self):
        invalid_segments = [
            [
                {"start": 0.0, "end": 1.0, "text": self.native_text},
                {"start": 0.5, "end": 1.5, "text": self.native_text},
            ],
            [
                {"start": 2.0, "end": 3.0, "text": self.native_text},
                {"start": 1.0, "end": 2.0, "text": self.native_text},
            ],
            [{"start": True, "end": 1.0, "text": self.native_text}],
            [{"start": 0.0, "end": float("nan"), "text": self.native_text}],
            [
                {"start": float(index), "end": float(index + 1), "text": self.native_text}
                for index in range(257)
            ],
        ]
        for segments in invalid_segments:
            with self.subTest(segment_count=len(segments), first=segments[0]):
                result = verify_native_audio(
                    self.native_request,
                    self.native_pack,
                    allowed_root=self.allowed_root,
                    asr=self._native_asr(segments=segments),
                    accent=ExplodingAccent(),
                )

                self.assertFalse(result["language_verified"])
                self.assertFalse(result["checks"]["speech_segments_present"])

    @unittest.skipUnless(callable(verify_native_audio), "native verifier is not implemented yet")
    def test_native_audio_model_binding_fails_closed_when_asr_model_evidence_is_missing_or_invalid(self):
        valid_models = self.native_pack["models"]
        invalid_models = [
            None,
            {"asr_tree_sha256": "8" * 64},
            {**valid_models, "asr_revision": ""},
            {**valid_models, "asr_revision": 7},
            {"asr_revision": valid_models["asr_revision"]},
            {**valid_models, "asr_tree_sha256": "8" * 63},
            {**valid_models, "asr_tree_sha256": "A" * 64},
        ]
        for models in invalid_models:
            pack = dict(self.native_pack)
            if models is None:
                pack.pop("models")
            else:
                pack["models"] = models
            with self.subTest(models=models):
                result = verify_native_audio(
                    self.native_request,
                    pack,
                    allowed_root=self.allowed_root,
                    asr=self._native_asr(),
                    accent=ExplodingAccent(),
                )

                self.assertFalse(result["language_verified"])
                self.assertFalse(result["checks"]["models"])


if __name__ == "__main__":
    unittest.main()
