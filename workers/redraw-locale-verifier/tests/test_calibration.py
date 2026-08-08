import csv
import hashlib
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


def staged_model_manifest_payload():
    asr_files = [
        {
            "path": "config.json",
            "sha256": "3456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef012",
            "size": 17,
        }
    ]
    accent_files = [
        {
            "path": "hyperparams.yaml",
            "sha256": "456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123",
            "size": 23,
        }
    ]
    wav2vec_files = [
        {
            "path": "preprocessor_config.json",
            "sha256": "56789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234",
            "size": 31,
        }
    ]
    manifest = {
        "schema_version": 1,
        "models": {
            "asr": {
                "repo_id": "Systran/faster-whisper-small",
                "revision": "2ec96c5472da50d38d40c0cfe0602af2e94b4c8a",
                "tree_sha256": staged_tree_sha256(asr_files),
                "files": asr_files,
            },
            "accent": {
                "repo_id": "Jzuluaga/accent-id-commonaccent_xlsr-en-english",
                "revision": "cc5dc6a56db647149d9e52856d6e55114c1045a8",
                "tree_sha256": staged_tree_sha256(accent_files),
                "files": accent_files,
            },
            "wav2vec": {
                "repo_id": "facebook/wav2vec2-large-xlsr-53",
                "revision": "b61310a3ecdfdc01af29ef1c203d708047a51184",
                "tree_sha256": staged_tree_sha256(wav2vec_files),
                "files": wav2vec_files,
            },
        },
    }
    return manifest


def staged_tree_sha256(files):
    digest = hashlib.sha256()
    for item in sorted(files, key=lambda value: value["path"]):
        digest.update(item["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(item["sha256"]))
    return digest.hexdigest()


def staged_model_manifest():
    payload = staged_model_manifest_payload()
    raw = json.dumps(payload, sort_keys=True).encode("utf-8")
    return {"manifest": payload, "sha256": hashlib.sha256(raw).hexdigest()}


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

    def search_rows(self):
        positive_strict = self.tune_positive(1)
        positive_strict.update({"word_error_rate": "0.01", "character_error_rate": "0.01"})
        positive_loose = self.tune_positive(2)
        positive_loose.update({"word_error_rate": "0.30", "character_error_rate": "0.30"})
        negatives = []
        for index in range(1, 101):
            row = self.eval_negative(index, accepted=True)
            row["split"] = "tune"
            row["audio_sha256"] = sha(index + 3000)
            row["word_error_rate"] = "0.20"
            row["character_error_rate"] = "0.20"
            negatives.append(row)
        eval_positive = self.eval_positive(1)
        eval_positive.update({"word_error_rate": "0.01", "character_error_rate": "0.01"})
        eval_rows = [eval_positive, self.eval_negative(1)]
        return [positive_strict, positive_loose] + negatives + eval_rows

    def test_calibration_rejects_overlap_and_far_over_one_percent(self):
        model_manifest = staged_model_manifest()
        duplicate = [self.tune_positive(1), self.eval_positive(2)]
        duplicate[1]["audio_sha256"] = duplicate[0]["audio_sha256"]
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_SPLIT_INVALID"):
            self.calibrate_mod.calibrate(duplicate, model_manifest=model_manifest)

        rows = [self.tune_positive(i) for i in range(1, 5)]
        rows += [self.eval_positive(i) for i in range(1, 5)]
        rows += [self.eval_negative(i, accepted=i <= 2) for i in range(1, 101)]
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_FALSE_ACCEPT_RATE_TOO_HIGH"):
            self.calibrate_mod.calibrate(rows, model_manifest=model_manifest)

    def test_manifest_thresholds_are_deterministic_and_eval_only_reports(self):
        model_manifest = staged_model_manifest()
        first = self.calibrate_mod.calibrate(reversed(self.valid_rows()), model_manifest=model_manifest)
        second = self.calibrate_mod.calibrate(self.valid_rows(), model_manifest=model_manifest)
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
        self.assertEqual(
            first["models"],
            {
                "asr_revision": model_manifest["manifest"]["models"]["asr"]["revision"],
                "accent_revision": model_manifest["manifest"]["models"]["accent"]["revision"],
                "wav2vec_revision": model_manifest["manifest"]["models"]["wav2vec"]["revision"],
                "asr_tree_sha256": model_manifest["manifest"]["models"]["asr"]["tree_sha256"],
                "accent_tree_sha256": model_manifest["manifest"]["models"]["accent"]["tree_sha256"],
                "wav2vec_tree_sha256": model_manifest["manifest"]["models"]["wav2vec"]["tree_sha256"],
            },
        )
        self.assertEqual(first["model_manifest_sha256"], model_manifest["sha256"])

    def test_threshold_search_reduces_false_accepts_instead_of_using_positive_max(self):
        result = self.calibrate_mod.calibrate(self.search_rows(), model_manifest=staged_model_manifest())
        self.assertEqual(result["thresholds"]["word_error_rate_max"], 0.01)
        self.assertEqual(result["thresholds"]["character_error_rate_max"], 0.01)

    def test_tune_operating_point_rejects_no_feasible_nonzero_recall(self):
        positive = self.tune_positive(1)
        negatives = []
        for index in range(1, 101):
            row = self.eval_negative(index, accepted=True)
            row["split"] = "tune"
            row["audio_sha256"] = sha(index + 5000)
            row["expected_language"] = "es"
            row["expected_accent"] = "england"
            negatives.append(row)
        rows = [positive] + negatives + [self.eval_positive(1), self.eval_negative(1)]
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_TUNE_OPERATING_POINT_INVALID"):
            self.calibrate_mod.calibrate(rows, model_manifest=staged_model_manifest())

    def test_eval_all_positive_false_reject_rate_one_is_rejected(self):
        rows = [self.tune_positive(i) for i in range(1, 5)]
        for index in range(1, 5):
            row = self.eval_positive(index)
            row["language_probability"] = "0.10"
            rows.append(row)
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_FALSE_REJECT_RATE_TOO_HIGH"):
            self.calibrate_mod.calibrate(rows, model_manifest=staged_model_manifest())

    def test_model_manifest_missing_mismatch_and_placeholders_are_rejected(self):
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_MODEL_MANIFEST_INVALID"):
            self.calibrate_mod.calibrate(self.valid_rows())

        missing = staged_model_manifest()
        del missing["manifest"]["models"]["wav2vec"]
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_MODEL_MANIFEST_INVALID"):
            self.calibrate_mod.calibrate(self.valid_rows(), model_manifest=missing)

        mismatch = staged_model_manifest()
        mismatch["manifest"]["models"]["asr"]["revision"] = "f" * 40
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_MODEL_MANIFEST_INVALID"):
            self.calibrate_mod.calibrate(self.valid_rows(), model_manifest=mismatch)

        placeholder = staged_model_manifest()
        placeholder["manifest"]["models"]["accent"]["tree_sha256"] = "1" * 64
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_MODEL_MANIFEST_INVALID"):
            self.calibrate_mod.calibrate(self.valid_rows(), model_manifest=placeholder)

        empty_files = staged_model_manifest()
        empty_files["manifest"]["models"]["asr"]["files"] = []
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_MODEL_MANIFEST_INVALID"):
            self.calibrate_mod.calibrate(self.valid_rows(), model_manifest=empty_files)

        duplicate_path = staged_model_manifest()
        duplicate_path["manifest"]["models"]["asr"]["files"].append(dict(duplicate_path["manifest"]["models"]["asr"]["files"][0]))
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_MODEL_MANIFEST_INVALID"):
            self.calibrate_mod.calibrate(self.valid_rows(), model_manifest=duplicate_path)

        tampered_tree = staged_model_manifest()
        tampered_tree["manifest"]["models"]["accent"]["files"][0]["sha256"] = "6789abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345"
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_MODEL_MANIFEST_INVALID"):
            self.calibrate_mod.calibrate(self.valid_rows(), model_manifest=tampered_tree)

        missing_hash = {"manifest": staged_model_manifest_payload()}
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_MODEL_MANIFEST_INVALID"):
            self.calibrate_mod.calibrate(self.valid_rows(), model_manifest=missing_hash)

    def test_calibration_cli_requires_model_manifest_and_copies_real_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            input_path = root / "rows.json"
            manifest_path = root / "model-manifest.json"
            output_path = root / "calibration.json"
            model_manifest = staged_model_manifest_payload()
            raw_manifest = json.dumps(model_manifest, sort_keys=True).encode("utf-8")
            input_path.write_text(json.dumps(self.valid_rows()), encoding="utf-8")
            manifest_path.write_bytes(raw_manifest)

            self.calibrate_mod.main([
                "--input",
                str(input_path),
                "--model-manifest",
                str(manifest_path),
                "--output",
                str(output_path),
            ])

            result = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(result["models"]["asr_tree_sha256"], model_manifest["models"]["asr"]["tree_sha256"])
            self.assertEqual(result["models"]["accent_tree_sha256"], model_manifest["models"]["accent"]["tree_sha256"])
            self.assertEqual(result["models"]["wav2vec_tree_sha256"], model_manifest["models"]["wav2vec"]["tree_sha256"])
            self.assertEqual(result["model_manifest_sha256"], hashlib.sha256(raw_manifest).hexdigest())

    def test_invalid_csv_hash_and_empty_text_use_stable_errors(self):
        model_manifest = staged_model_manifest()
        bad_hash = [self.tune_positive(1), self.eval_positive(1)]
        bad_hash[0]["audio_sha256"] = "not-a-hash"
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_AUDIO_HASH_INVALID"):
            self.calibrate_mod.calibrate(bad_hash, model_manifest=model_manifest)

        empty = [self.tune_positive(1), self.eval_positive(1)]
        empty[0]["approved_text"] = " "
        with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_TEXT_EMPTY"):
            self.calibrate_mod.calibrate(empty, model_manifest=model_manifest)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.csv"
            with path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=["audio_path", "audio_sha256"])
                writer.writeheader()
                writer.writerow({"audio_path": "a.wav", "audio_sha256": sha(1)})
            with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_CSV_INVALID"):
                self.calibrate_mod.load_rows(path)

    def test_non_finite_calibration_metrics_are_rejected(self):
        for value in ("NaN", "Infinity", "-Infinity"):
            rows = [self.tune_positive(1), self.eval_positive(1)]
            rows[0]["language_probability"] = value
            with self.subTest(value=value):
                with self.assertRaisesRegex(self.calibrate_mod.CalibrationError, "CALIBRATION_METRIC_INVALID"):
                    self.calibrate_mod.calibrate(rows, model_manifest=staged_model_manifest())

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

    def test_benchmark_rejects_non_finite_cpu_seconds(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nan.json"
            path.write_text(
                '{"schema_version":1,"samples":[{"id":"bad","latency_ms":1,"peak_rss_bytes":1,"cpu_seconds":NaN,"status":"ok"}]}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(self.benchmark_mod.BenchmarkError, "BENCHMARK_SAMPLE_INVALID"):
                self.benchmark_mod.benchmark(path)


if __name__ == "__main__":
    unittest.main()
