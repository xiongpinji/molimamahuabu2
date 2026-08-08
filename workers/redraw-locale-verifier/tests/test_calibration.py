import csv
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "synthetic-index.json"


def load_script(name):
    path = ROOT / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(value):
    return f"{value:064x}"


class CalibrationTests(unittest.TestCase):
    def setUp(self):
        self.calibrate_mod = load_script("calibrate")
        self.benchmark_mod = load_script("benchmark")

    def tune_positive(self, index):
        return {
            "audio_path": f"audio/tune-good-{index}.wav",
            "audio_sha256": sha(index),
            "approved_text": f"Anna paid {index} dollars",
            "expected_language": "en",
            "expected_accent": "us",
            "split": "tune",
            "language_probability": "0.96",
            "word_error_rate": "0.02",
            "character_error_rate": "0.01",
            "us_accent_probability": "0.95",
        }

    def eval_positive(self, index):
        row = self.tune_positive(index)
        row["audio_path"] = f"audio/eval-good-{index}.wav"
        row["audio_sha256"] = sha(index + 1000)
        row["split"] = "eval"
        return row

    def eval_negative(self, index, accepted=False):
        return {
            "audio_path": f"audio/eval-bad-{index}.wav",
            "audio_sha256": sha(index + 2000),
            "approved_text": f"Anna paid {index} dollars",
            "expected_language": "es" if index % 2 else "en",
            "expected_accent": "england",
            "split": "eval",
            "language_probability": "0.97" if accepted else "0.40",
            "word_error_rate": "0.02" if accepted else "0.44",
            "character_error_rate": "0.01" if accepted else "0.30",
            "us_accent_probability": "0.96" if accepted else "0.20",
        }

    def valid_rows(self):
        rows = [self.tune_positive(i) for i in range(1, 5)]
        rows += [self.eval_positive(i) for i in range(1, 5)]
        rows += [self.eval_negative(i) for i in range(1, 101)]
        return rows

    def test_calibration_rejects_overlap_and_far_over_one_percent(self):
        duplicate = [self.tune_positive(1), self.eval_positive(2)]
        duplicate[1]["audio_sha256"] = duplicate[0]["audio_sha256"]
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_SPLIT_INVALID"):
            self.calibrate_mod.calibrate(duplicate)

        rows = [self.tune_positive(i) for i in range(1, 5)]
        rows += [self.eval_positive(i) for i in range(1, 5)]
        rows += [self.eval_negative(i, accepted=i <= 2) for i in range(1, 101)]
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_FALSE_ACCEPT_RATE_TOO_HIGH"):
            self.calibrate_mod.calibrate(rows)

    def test_manifest_thresholds_are_deterministic_and_eval_only_reports(self):
        first = self.calibrate_mod.calibrate(reversed(self.valid_rows()))
        second = self.calibrate_mod.calibrate(self.valid_rows())
        self.assertEqual(first, second)
        self.assertEqual(first["schema_version"], 1)
        self.assertEqual(first["locale_pack"], "en-US@1")
        self.assertEqual(first["normalization_version"], "english-text-v1")
        self.assertEqual(first["sample_counts"], {"tune": 4, "eval": 104, "eval_positive": 4, "eval_negative": 100})
        self.assertEqual(first["thresholds"]["language_probability_min"], 0.96)
        self.assertEqual(first["thresholds"]["word_error_rate_max"], 0.02)
        self.assertEqual(first["thresholds"]["character_error_rate_max"], 0.01)
        self.assertEqual(first["thresholds"]["us_accent_probability_min"], 0.95)
        self.assertEqual(first["eval"]["false_accept_rate"], 0.0)
        self.assertEqual(first["eval"]["false_reject_rate"], 0.0)
        self.assertEqual(set(first["models"]), {"asr", "accent", "wav2vec"})
        for model in first["models"].values():
            self.assertRegex(model["revision"], r"^[0-9a-f]{40}$")
            self.assertRegex(model["tree_sha256"], r"^[0-9a-f]{64}$")

    def test_invalid_csv_hash_and_empty_text_use_stable_errors(self):
        bad_hash = [self.tune_positive(1), self.eval_positive(1)]
        bad_hash[0]["audio_sha256"] = "not-a-hash"
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_AUDIO_HASH_INVALID"):
            self.calibrate_mod.calibrate(bad_hash)

        empty = [self.tune_positive(1), self.eval_positive(1)]
        empty[0]["approved_text"] = " "
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_TEXT_EMPTY"):
            self.calibrate_mod.calibrate(empty)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.csv"
            with path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=["audio_path", "audio_sha256"])
                writer.writeheader()
                writer.writerow({"audio_path": "a.wav", "audio_sha256": sha(1)})
            with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_CSV_INVALID"):
                self.calibrate_mod.load_rows(path)

    def test_benchmark_fixture_schema_and_percentiles(self):
        result = self.benchmark_mod.benchmark(FIXTURE)
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["sample_count"], 5)
        self.assertEqual(result["latency_ms"], {"p50": 70, "p95": 120, "max": 120})
        self.assertEqual(result["peak_rss_bytes"], 4096)
        self.assertEqual(result["cpu_seconds"], 0.52)
        self.assertEqual(result["failure_counts"], {"TIMEOUT": 1})

    def test_benchmark_cli_writes_output_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "result.json"
            self.benchmark_mod.main(["--fixture", str(FIXTURE), "--output", str(output)])
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), self.benchmark_mod.benchmark(FIXTURE))


if __name__ == "__main__":
    unittest.main()
