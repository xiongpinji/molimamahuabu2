import shutil
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

from redraw_locale_worker.audio import normalize_audio
from redraw_locale_worker.errors import AudioInputError
from redraw_locale_worker.manifest import validate_manifest
from redraw_locale_worker.normalization import score_text


class NormalizationTests(unittest.TestCase):
    def test_english_metrics_preserve_negation_names_and_numbers(self):
        metrics = score_text("Anna did not pay 50 dollars", "Anna paid fifty dollars")
        self.assertGreater(metrics["word_error_rate"], 0)
        self.assertGreater(metrics["character_error_rate"], 0)
        self.assertFalse(metrics["critical_tokens_match"])
        self.assertIn("not", metrics["critical_tokens"]["missing"])
        self.assertIn("Anna", metrics["critical_tokens"]["approved"])

    def test_score_text_normalizes_case_punctuation_and_number_words(self):
        metrics = score_text("Anna paid 50 dollars.", "anna paid fifty dollars")
        self.assertEqual(metrics["word_error_rate"], 0)
        self.assertEqual(metrics["character_error_rate"], 0)
        self.assertTrue(metrics["critical_tokens_match"])

    def test_critical_tokens_reject_digit_value_drift(self):
        metrics = score_text("Anna paid 50 dollars.", "Anna paid sixty dollars")
        self.assertFalse(metrics["critical_tokens_match"])
        self.assertIn("50", metrics["critical_tokens"]["missing"])

    def test_critical_tokens_reject_number_word_value_drift(self):
        metrics = score_text("Anna paid fifty dollars.", "Anna paid sixty dollars")
        self.assertFalse(metrics["critical_tokens_match"])
        self.assertIn("fifty", metrics["critical_tokens"]["missing"])

    def test_critical_tokens_match_number_words_to_digit_literals(self):
        metrics = score_text("Anna paid fifty dollars.", "Anna paid 50 dollars")
        self.assertTrue(metrics["critical_tokens_match"])

    def test_empty_approved_text_never_passes(self):
        metrics = score_text("", "")
        self.assertEqual(metrics["word_error_rate"], 1)
        self.assertEqual(metrics["character_error_rate"], 1)
        self.assertFalse(metrics["critical_tokens_match"])

    def test_manifest_schema_is_minimal_and_hash_strict(self):
        manifest = {
            "schema_version": 1,
            "locale_pack": "en-US@1",
            "model_manifest_sha256": "a" * 64,
            "calibration_manifest_sha256": "b" * 64,
        }
        self.assertEqual(validate_manifest(manifest), manifest)
        with self.assertRaisesRegex(ValueError, "LOCALE_MANIFEST_INVALID"):
            validate_manifest({**manifest, "extra": True})
        with self.assertRaisesRegex(ValueError, "LOCALE_MANIFEST_INVALID"):
            validate_manifest({**manifest, "model_manifest_sha256": "A" * 64})
        with self.assertRaisesRegex(ValueError, "LOCALE_MANIFEST_INVALID"):
            validate_manifest({**manifest, "schema_version": True})

    def test_audio_path_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            allowed_root = root / "allowed"
            temp_root = root / "temp"
            outside = root / "outside"
            allowed_root.mkdir()
            temp_root.mkdir()
            outside.mkdir()
            target = outside / "audio.wav"
            _write_wav(target, seconds=1)
            link = allowed_root / "escape.wav"
            try:
                link.symlink_to(target)
            except OSError as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")

            with self.assertRaisesRegex(AudioInputError, "LOCALE_AUDIO_PATH_INVALID"):
                normalize_audio(link, allowed_root, temp_root)

    def test_audio_path_rejects_parent_escape_without_symlink_support(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            allowed_root = root / "allowed"
            temp_root = root / "temp"
            outside = root / "outside"
            allowed_root.mkdir()
            temp_root.mkdir()
            outside.mkdir()
            target = outside / "audio.wav"
            _write_wav(target, seconds=1)

            with self.assertRaisesRegex(AudioInputError, "LOCALE_AUDIO_PATH_INVALID"):
                normalize_audio(allowed_root / ".." / "outside" / "audio.wav", allowed_root, temp_root)

    def test_audio_rejects_zero_duration_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            allowed_root = root / "allowed"
            temp_root = root / "temp"
            allowed_root.mkdir()
            temp_root.mkdir()
            audio_path = allowed_root / "zero.wav"
            _write_wav(audio_path, seconds=0)
            with self.assertRaisesRegex(AudioInputError, "LOCALE_AUDIO_DURATION_INVALID"):
                normalize_audio(audio_path, allowed_root, temp_root)
            self.assertEqual(list(temp_root.glob("*.wav")), [])

    def test_audio_rejects_input_without_audio_stream(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            allowed_root = root / "allowed"
            temp_root = root / "temp"
            allowed_root.mkdir()
            temp_root.mkdir()
            video_path = allowed_root / "video-only.mp4"
            _write_video_without_audio(video_path, self)

            with self.assertRaisesRegex(AudioInputError, "LOCALE_AUDIO_STREAM_INVALID"):
                normalize_audio(video_path, allowed_root, temp_root)
            self.assertEqual(list(temp_root.glob("*.wav")), [])

    def test_audio_rejects_input_with_multiple_audio_streams(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            allowed_root = root / "allowed"
            temp_root = root / "temp"
            allowed_root.mkdir()
            temp_root.mkdir()
            audio_path = allowed_root / "two-audio-streams.mkv"
            _write_two_audio_streams(audio_path, self)

            with self.assertRaisesRegex(AudioInputError, "LOCALE_AUDIO_STREAM_INVALID"):
                normalize_audio(audio_path, allowed_root, temp_root)
            self.assertEqual(list(temp_root.glob("*.wav")), [])

    def test_audio_rejects_input_longer_than_sixty_seconds(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            allowed_root = root / "allowed"
            temp_root = root / "temp"
            allowed_root.mkdir()
            temp_root.mkdir()
            audio_path = allowed_root / "too-long.wav"
            _write_wav(audio_path, seconds=61)

            with self.assertRaisesRegex(AudioInputError, "LOCALE_AUDIO_DURATION_INVALID"):
                normalize_audio(audio_path, allowed_root, temp_root)
            self.assertEqual(list(temp_root.glob("*.wav")), [])


def _write_wav(path, seconds):
    sample_rate = 16000
    frames = int(sample_rate * seconds)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\0\0" * frames)


def _write_video_without_audio(path, test_case):
    if shutil.which("ffmpeg") is None:
        test_case.skipTest("ffmpeg unavailable")
    command = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=16x16:d=1",
        "-an",
        str(path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
    if completed.returncode != 0:
        test_case.skipTest(f"ffmpeg video fixture unavailable: {completed.stderr}")


def _write_two_audio_streams(path, test_case):
    if shutil.which("ffmpeg") is None:
        test_case.skipTest("ffmpeg unavailable")
    command = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=1",
        "-map",
        "0:a:0",
        "-map",
        "1:a:0",
        str(path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
    if completed.returncode != 0:
        test_case.skipTest(f"ffmpeg two-audio fixture unavailable: {completed.stderr}")


if __name__ == "__main__":
    unittest.main()
