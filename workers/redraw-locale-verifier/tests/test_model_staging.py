import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


STAGE_MODELS_PATH = Path(__file__).resolve().parents[1] / "scripts" / "stage_models.py"
SMOKE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "model_compat_smoke.py"
INTERFACE_PATH = Path(__file__).resolve().parents[1] / "src" / "redraw_locale_worker" / "commonaccent_interface.py"
spec = importlib.util.spec_from_file_location("stage_models", STAGE_MODELS_PATH)
stage_models = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage_models)

ACCENT_REVISION = stage_models.ACCENT_REVISION
ASR_REVISION = stage_models.ASR_REVISION
WAV2VEC_REVISION = stage_models.WAV2VEC_REVISION
build_model_manifest = stage_models.build_model_manifest
compute_tree_sha256 = stage_models.compute_tree_sha256
prepare_commonaccent_runtime = stage_models.prepare_commonaccent_runtime
build_commonaccent_runtime_manifest = stage_models.build_commonaccent_runtime_manifest
compute_file_sha256 = stage_models.compute_file_sha256


class ModelStagingTests(unittest.TestCase):
    def test_worker_package_path_has_no_legacy_package(self):
        worker_root = Path(__file__).resolve().parents[1]
        self.assertTrue((worker_root / "src" / "redraw_locale_worker").is_dir())
        self.assertFalse((worker_root / "src" / "redraw_locale_verifier").exists())

    def test_build_model_manifest_requires_exact_revisions_and_stable_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            models = {
                "asr": root / "asr",
                "accent": root / "accent",
                "wav2vec": root / "wav2vec",
            }
            for name, model_root in models.items():
                model_root.mkdir()
                (model_root / "config.json").write_text(f'{{"name":"{name}"}}\n', encoding="utf-8")

            manifest = build_model_manifest(
                {
                    "asr": models["asr"],
                    "accent": models["accent"],
                    "wav2vec": models["wav2vec"],
                },
                revisions={
                    "asr": ASR_REVISION,
                    "accent": ACCENT_REVISION,
                    "wav2vec": WAV2VEC_REVISION,
                },
            )

            self.assertEqual(manifest["schema_version"], 1)
            self.assertEqual(manifest["models"]["asr"]["revision"], ASR_REVISION)
            self.assertEqual(manifest["models"]["accent"]["revision"], ACCENT_REVISION)
            self.assertEqual(manifest["models"]["wav2vec"]["revision"], WAV2VEC_REVISION)
            for model in manifest["models"].values():
                self.assertRegex(model["tree_sha256"], r"^[0-9a-f]{64}$")
            serialized = json.dumps(manifest, sort_keys=True)
            self.assertNotIn("main", serialized)
            self.assertNotIn("latest", serialized)

            with self.assertRaises(ValueError):
                build_model_manifest(models, revisions={"asr": "main", "accent": ACCENT_REVISION, "wav2vec": WAV2VEC_REVISION})

    def test_tree_sha256_is_path_sorted_content_addressed_and_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "b").mkdir()
            (root / "a.txt").write_text("alpha", encoding="utf-8")
            (root / "b" / "z.txt").write_text("zulu", encoding="utf-8")

            digest = hashlib.sha256()
            for relative, content in [
                ("a.txt", b"alpha"),
                ("b/z.txt", b"zulu"),
            ]:
                digest.update(relative.encode("utf-8"))
                digest.update(b"\0")
                digest.update(hashlib.sha256(content).digest())

            first = compute_tree_sha256(root)
            self.assertEqual(first, digest.hexdigest())
            self.assertEqual(compute_tree_sha256(root), first)

            (root / "b" / "z.txt").write_text("changed", encoding="utf-8")
            self.assertNotEqual(compute_tree_sha256(root), first)

            (root / "b" / "z.txt").write_text("zulu", encoding="utf-8")
            (root / "renamed.txt").write_text("alpha", encoding="utf-8")
            (root / "a.txt").unlink()
            self.assertNotEqual(compute_tree_sha256(root), first)

    def test_commonaccent_runtime_rewrite_is_exact_and_drift_sensitive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "commonaccent"
            runtime = root / "runtime"
            wav2vec = root / "wav2vec"
            source.mkdir()
            wav2vec.mkdir()
            (source / "hyperparams.yaml").write_text(
                'wav2vec2_hub: "facebook/wav2vec2-large-xlsr-53"\n'
                "pretrained_path: Jzuluaga/accent-id-commonaccent_xlsr-en-english\n"
                "wav2vec2: !new:speechbrain.lobes.models.huggingface_transformers.wav2vec2.Wav2Vec2\n"
                "avg_pool: !new:speechbrain.nnet.pooling.StatisticsPooling\n"
                "output_mlp: !new:speechbrain.nnet.linear.Linear\n"
                "model: !new:torch.nn.ModuleList\n"
                "softmax: !new:speechbrain.nnet.activations.Softmax\n"
                "label_encoder: !new:speechbrain.dataio.encoder.CategoricalEncoder\n"
                "pretrainer: !new:speechbrain.utils.parameter_transfer.Pretrainer\n",
                encoding="utf-8",
            )

            prepare_commonaccent_runtime(source, runtime, wav2vec)

            rewritten = (runtime / "hyperparams.yaml").read_text(encoding="utf-8")
            self.assertIn(f"wav2vec2_hub: {wav2vec.as_posix()}", rewritten)
            self.assertIn(f"pretrained_path: {runtime.as_posix()}", rewritten)

            drift_source = root / "drift"
            drift_runtime = root / "drift-runtime"
            drift_source.mkdir()
            (drift_source / "hyperparams.yaml").write_text(
                "wav2vec2_hub: main\n"
                "pretrained_path: Jzuluaga/accent-id-commonaccent_xlsr-en-english\n",
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                prepare_commonaccent_runtime(drift_source, drift_runtime, wav2vec)

    def test_smoke_uses_vendored_commonaccent_classifier_and_forbids_remote_code(self):
        smoke_source = SMOKE_PATH.read_text(encoding="utf-8")
        self.assertIn("CommonAccentClassifier", smoke_source)
        self.assertNotIn("EncoderClassifier", smoke_source)
        self.assertNotIn("foreign_class", smoke_source)
        self.assertNotIn("trust_remote_code", smoke_source)
        self.assertIn('savedir=str(stage_dir / "smoke-cache" / "commonaccent")', smoke_source)
        self.assertNotIn("savedir=str(commonaccent_runtime)", smoke_source)

        interface_source = INTERFACE_PATH.read_text(encoding="utf-8")
        self.assertIn("class CommonAccentClassifier", interface_source)
        self.assertNotIn("foreign_class", interface_source)
        self.assertNotIn("trust_remote_code", interface_source)

    def test_commonaccent_runtime_manifest_binds_vendored_interface_sha_and_allowlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "commonaccent"
            runtime = root / "runtime"
            wav2vec = root / "wav2vec"
            source.mkdir()
            wav2vec.mkdir()
            (source / "custom_interface.py").write_text("raise RuntimeError('sentinel')\n", encoding="utf-8")
            (source / "hyperparams.yaml").write_text(
                'wav2vec2_hub: "facebook/wav2vec2-large-xlsr-53"\n'
                "pretrained_path: Jzuluaga/accent-id-commonaccent_xlsr-en-english\n"
                "wav2vec2: !new:speechbrain.lobes.models.huggingface_transformers.wav2vec2.Wav2Vec2\n"
                "avg_pool: !new:speechbrain.nnet.pooling.StatisticsPooling\n"
                "output_mlp: !new:speechbrain.nnet.linear.Linear\n"
                "model: !new:torch.nn.ModuleList\n"
                "softmax: !new:speechbrain.nnet.activations.Softmax\n"
                "label_encoder: !new:speechbrain.dataio.encoder.CategoricalEncoder\n"
                "pretrainer: !new:speechbrain.utils.parameter_transfer.Pretrainer\n",
                encoding="utf-8",
            )

            prepare_commonaccent_runtime(source, runtime, wav2vec)
            manifest = build_commonaccent_runtime_manifest(runtime, INTERFACE_PATH)

            self.assertEqual(manifest["interface"]["file"], "commonaccent_interface.py")
            self.assertEqual(manifest["interface"]["sha256"], compute_file_sha256(INTERFACE_PATH))
            self.assertEqual(manifest["interface"]["source_revision"], ACCENT_REVISION)
            self.assertRegex(manifest["tree_sha256"], r"^[0-9a-f]{64}$")

            (source / "drift.yaml").write_text(
                'wav2vec2_hub: "facebook/wav2vec2-large-xlsr-53"\n'
                "pretrained_path: Jzuluaga/accent-id-commonaccent_xlsr-en-english\n"
                "bad: !new:unexpected.RemoteClass\n",
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                prepare_commonaccent_runtime(source, root / "drift-runtime", wav2vec)


if __name__ == "__main__":
    unittest.main()
