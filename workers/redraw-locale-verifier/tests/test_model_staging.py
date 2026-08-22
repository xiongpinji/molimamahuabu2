import asyncio
import hashlib
import importlib.util
import json
import socket
import ssl
import sys
import tempfile
import types
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


COMMONACCENT_TEST_HYPERPARAMS = (
    'wav2vec2_hub: "facebook/wav2vec2-large-xlsr-53"\n'
    "pretrained_path: Jzuluaga/accent-id-commonaccent_xlsr-en-english\n"
    "encoder_dim: !ref <output_neurons>\n"
    "wav2vec2: !new:speechbrain.lobes.models.huggingface_transformers.wav2vec2.Wav2Vec2\n"
    "avg_pool: !new:speechbrain.nnet.pooling.StatisticsPooling\n"
    "output_mlp: !new:speechbrain.nnet.linear.Linear\n"
    "model: !new:torch.nn.ModuleList\n"
    "softmax: !new:speechbrain.nnet.activations.Softmax\n"
    "label_encoder: !new:speechbrain.dataio.encoder.CategoricalEncoder\n"
    "pretrainer: !new:speechbrain.utils.parameter_transfer.Pretrainer\n"
)


def load_smoke_module_with_fakes():
    names = [
        "faster_whisper",
        "psutil",
        "speechbrain",
        "speechbrain.inference",
        "speechbrain.inference.interfaces",
        "speechbrain.utils",
        "speechbrain.utils.fetching",
        "torch",
        "resource",
    ]
    previous = {name: sys.modules.get(name) for name in names}
    try:
        faster_whisper = types.ModuleType("faster_whisper")
        faster_whisper.WhisperModel = object
        psutil = types.ModuleType("psutil")
        psutil.Process = lambda: types.SimpleNamespace(memory_info=lambda: types.SimpleNamespace(rss=1))
        speechbrain = types.ModuleType("speechbrain")
        inference = types.ModuleType("speechbrain.inference")
        interfaces = types.ModuleType("speechbrain.inference.interfaces")
        interfaces.Pretrained = object
        interfaces.pretrained_from_hparams = lambda **_kwargs: None
        utils = types.ModuleType("speechbrain.utils")
        fetching = types.ModuleType("speechbrain.utils.fetching")
        fetching.FetchConfig = lambda **kwargs: kwargs
        torch = types.ModuleType("torch")
        torch.ones = lambda *_args, **_kwargs: None
        torch.tensor = lambda *_args, **_kwargs: None
        torch.max = lambda *_args, **_kwargs: (None, None)
        resource = types.ModuleType("resource")
        resource.RUSAGE_SELF = 0
        resource.getrusage = lambda _who: types.SimpleNamespace(ru_maxrss=1)

        replacements = {
            "faster_whisper": faster_whisper,
            "psutil": psutil,
            "speechbrain": speechbrain,
            "speechbrain.inference": inference,
            "speechbrain.inference.interfaces": interfaces,
            "speechbrain.utils": utils,
            "speechbrain.utils.fetching": fetching,
            "torch": torch,
            "resource": resource,
        }
        sys.modules.update(replacements)
        spec = importlib.util.spec_from_file_location("model_compat_smoke_test", SMOKE_PATH)
        smoke = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(smoke)
        return smoke
    finally:
        for name, module in previous.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


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
                "encoder_dim: !ref <output_neurons>\n"
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

            for tag in ("!apply:os.system", "!module:os", "!!python/name:os.system", "!new:unexpected.RemoteClass"):
                bad_source = root / tag.replace("!", "bang").replace(":", "_").replace("/", "_")
                bad_runtime = root / f"{bad_source.name}-runtime"
                bad_source.mkdir()
                (bad_source / "hyperparams.yaml").write_text(
                    'wav2vec2_hub: "facebook/wav2vec2-large-xlsr-53"\n'
                    "pretrained_path: Jzuluaga/accent-id-commonaccent_xlsr-en-english\n"
                    f"bad: {tag}\n"
                    "wav2vec2: !new:speechbrain.lobes.models.huggingface_transformers.wav2vec2.Wav2Vec2\n"
                    "avg_pool: !new:speechbrain.nnet.pooling.StatisticsPooling\n"
                    "output_mlp: !new:speechbrain.nnet.linear.Linear\n"
                    "model: !new:torch.nn.ModuleList\n"
                    "softmax: !new:speechbrain.nnet.activations.Softmax\n"
                    "label_encoder: !new:speechbrain.dataio.encoder.CategoricalEncoder\n"
                    "pretrainer: !new:speechbrain.utils.parameter_transfer.Pretrainer\n",
                    encoding="utf-8",
                )
                with self.assertRaises(ValueError):
                    prepare_commonaccent_runtime(bad_source, bad_runtime, wav2vec)

            angle_source = root / "angle"
            angle_runtime = root / "angle-runtime"
            angle_source.mkdir()
            (angle_source / "hyperparams.yaml").write_text(
                COMMONACCENT_TEST_HYPERPARAMS
                + "bad: !<tag:yaml.org,2002:python/object/apply:os.system> []\n",
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                prepare_commonaccent_runtime(angle_source, angle_runtime, wav2vec)

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

    def test_smoke_imports_provider_dependencies_only_after_offline_block(self):
        smoke_source = SMOKE_PATH.read_text(encoding="utf-8")
        top_level = smoke_source[: smoke_source.index("def _load_stage_models_module")]
        network_block_definition = smoke_source.index("def block_network()")
        self.assertIn("import ssl", smoke_source)
        self.assertIn("import asyncio", smoke_source)
        self.assertLess(smoke_source.index("import ssl"), network_block_definition)
        self.assertLess(smoke_source.index("import asyncio"), network_block_definition)
        self.assertNotIn("from faster_whisper import WhisperModel", top_level)
        self.assertNotIn("import psutil", top_level)
        self.assertNotIn("from speechbrain.inference.interfaces import pretrained_from_hparams", top_level)
        self.assertNotIn("from redraw_locale_worker.commonaccent_interface import CommonAccentClassifier", top_level)
        self.assertIn("def run_asr(", smoke_source)
        self.assertIn("from faster_whisper import WhisperModel", smoke_source[smoke_source.index("def run_asr("):])
        self.assertIn("from speechbrain.inference.interfaces import pretrained_from_hparams", smoke_source[smoke_source.index("def run_accent("):])
        self.assertIn("from redraw_locale_worker.commonaccent_interface import CommonAccentClassifier", smoke_source[smoke_source.index("def run_accent("):])

    def test_smoke_network_block_is_safe_after_ssl_asyncio_import_and_still_blocks_network(self):
        smoke = load_smoke_module_with_fakes()
        original_socket = socket.socket
        original_create_connection = socket.create_connection
        original_getaddrinfo = socket.getaddrinfo
        try:
            self.assertIsNotNone(ssl.SSLSocket)
            self.assertIsNotNone(asyncio.get_event_loop_policy())

            smoke.block_network()

            self.assertTrue(issubclass(ssl.SSLSocket, original_socket))
            with self.assertRaises(smoke.NetworkBlocked):
                socket.getaddrinfo("example.invalid", 443)
            with self.assertRaises(smoke.NetworkBlocked):
                socket.create_connection(("example.invalid", 443))
        finally:
            socket.socket = original_socket
            socket.create_connection = original_create_connection
            socket.getaddrinfo = original_getaddrinfo

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

    def test_smoke_forces_offline_env_rejects_relative_stage_dir_and_reports_runtime_hash(self):
        smoke = load_smoke_module_with_fakes()
        smoke_source = SMOKE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("setdefault", smoke_source)
        self.assertIn('parser.add_argument("--stage-dir", "--models", dest="stage_dir", required=True)', smoke_source)
        self.assertIn('os.environ["HF_HUB_OFFLINE"] = "1"', smoke_source)
        self.assertIn('os.environ["TRANSFORMERS_OFFLINE"] = "1"', smoke_source)
        self.assertIn('os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"', smoke_source)
        self.assertIn("stage_dir = resolve_stage_dir(args.stage_dir)", smoke_source)
        self.assertIn("stage_arg = Path(stage_dir)", smoke_source)
        self.assertIn("if not stage_arg.is_absolute()", smoke_source)
        self.assertIn('"runtime_tree_sha256"', smoke_source)
        self.assertEqual(smoke.parse_args(["--models", "/tmp/models", "--audio", "/tmp/a.wav", "--max-rss-bytes", "1"]).stage_dir, "/tmp/models")
        with self.assertRaises(SystemExit):
            smoke.resolve_stage_dir("relative-stage")

    def test_smoke_rejects_relative_missing_directory_and_symlink_audio(self):
        smoke = load_smoke_module_with_fakes()
        with self.assertRaises(SystemExit):
            smoke.resolve_audio_path("relative.wav")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "audio-dir"
            directory.mkdir()
            missing = root / "missing.wav"
            regular = root / "audio.wav"
            regular.write_bytes(b"RIFF")
            with self.assertRaises(SystemExit):
                smoke.resolve_audio_path(str(missing))
            with self.assertRaises(SystemExit):
                smoke.resolve_audio_path(str(directory))
            self.assertEqual(smoke.resolve_audio_path(str(regular)), regular.resolve())
            link = root / "audio-link.wav"
            try:
                link.symlink_to(regular)
            except OSError as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")
            with self.assertRaises(SystemExit):
                smoke.resolve_audio_path(str(link))

    def test_smoke_rejects_symlink_stage_dir_before_resolve(self):
        smoke = load_smoke_module_with_fakes()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "target"
            target.mkdir()
            link = root / "link"
            try:
                link.symlink_to(target, target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")

            with self.assertRaises(SystemExit):
                smoke.resolve_stage_dir(str(link))

    def test_asr_evidence_fails_closed_for_no_segment_and_non_english(self):
        smoke = load_smoke_module_with_fakes()
        info = types.SimpleNamespace(language="en", language_probability=0.98)
        with self.assertRaises(RuntimeError):
            smoke.build_asr_evidence([], info)
        with self.assertRaises(RuntimeError):
            smoke.build_asr_evidence([types.SimpleNamespace(start=0.0, end=1.0, text="hello")], types.SimpleNamespace(language="es", language_probability=0.9))

        evidence = smoke.build_asr_evidence([types.SimpleNamespace(start=0.0, end=1.2, text="hello")], info)
        self.assertEqual(evidence["language"], "en")
        self.assertEqual(evidence["segments"][0]["text"], "hello")

    def _build_smoke_manifest_fixture(self, root, hyperparams_manifest="runtime/commonaccent/hyperparams.yaml", secondary_yaml=None):
        models = {
            "asr": root / "models" / "asr",
            "accent": root / "models" / "accent",
            "wav2vec": root / "models" / "wav2vec",
        }
        for name, model_root in models.items():
            model_root.mkdir(parents=True, exist_ok=True)
            (model_root / "config.json").write_text(f'{{"name":"{name}"}}\n', encoding="utf-8")
        runtime = root / "runtime" / "commonaccent"
        runtime.mkdir(parents=True, exist_ok=True)
        (runtime / "hyperparams.yaml").write_text(COMMONACCENT_TEST_HYPERPARAMS, encoding="utf-8")
        if secondary_yaml is not None:
            (runtime / "secondary.yaml").write_text(secondary_yaml, encoding="utf-8")
        manifest = build_model_manifest(
            models,
            revisions={
                "asr": ASR_REVISION,
                "accent": ACCENT_REVISION,
                "wav2vec": WAV2VEC_REVISION,
            },
        )
        manifest["runtime"] = {
            "commonaccent": {
                "hyperparams": hyperparams_manifest,
                "tree_sha256": compute_tree_sha256(runtime),
                "interface": {"sha256": compute_file_sha256(INTERFACE_PATH)},
            }
        }
        return manifest

    def test_prepare_and_manifest_verify_reject_all_secondary_yaml_dangerous_tags(self):
        smoke = load_smoke_module_with_fakes()
        for tag in ("!apply:os.system", "!!python/object/apply:os.system", "!new:unexpected.RemoteClass", "!<tag:yaml.org,2002:python/object/apply:os.system>"):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source = root / "source"
                runtime = root / "runtime"
                wav2vec = root / "wav2vec"
                source.mkdir()
                wav2vec.mkdir()
                (source / "hyperparams.yaml").write_text(COMMONACCENT_TEST_HYPERPARAMS, encoding="utf-8")
                (source / "secondary.yaml").write_text(f"bad: {tag}\n", encoding="utf-8")
                with self.assertRaises(ValueError):
                    prepare_commonaccent_runtime(source, runtime, wav2vec)

                stage_dir = root / "stage"
                manifest = self._build_smoke_manifest_fixture(stage_dir, secondary_yaml=f"bad: {tag}\n")
                with self.assertRaises(RuntimeError):
                    smoke.verify_manifest(stage_dir, manifest)

    def test_yaml_tag_scanner_covers_angle_and_core_tag_forms(self):
        tags = stage_models._extract_yaml_tags(
            "safe: !ref <x>\n"
            "local: !local value\n"
            "new: !new:unexpected.RemoteClass {}\n"
            "core: !!python/object/apply:os.system []\n"
            "angle: !<tag:yaml.org,2002:python/object/apply:os.system> []\n"
        )
        self.assertIn("!ref", tags)
        self.assertIn("!local", tags)
        self.assertIn("!new:unexpected.RemoteClass", tags)
        self.assertIn("!!python/object/apply:os.system", tags)
        self.assertIn("!<tag:yaml.org,2002:python/object/apply:os.system>", tags)

    def test_manifest_hyperparams_path_must_stay_inside_runtime_commonaccent(self):
        smoke = load_smoke_module_with_fakes()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage_dir = root / "stage"
            absolute = root / "outside.yaml"
            absolute.write_text(COMMONACCENT_TEST_HYPERPARAMS, encoding="utf-8")
            for unsafe in (str(absolute), "../outside.yaml", "runtime/../commonaccent/hyperparams.yaml"):
                manifest = self._build_smoke_manifest_fixture(stage_dir, hyperparams_manifest=unsafe)
                if unsafe == "../outside.yaml":
                    (stage_dir.parent / "outside.yaml").write_text(COMMONACCENT_TEST_HYPERPARAMS, encoding="utf-8")
                with self.assertRaises(RuntimeError):
                    smoke.verify_manifest(stage_dir, manifest)

    def test_manifest_hyperparams_path_must_exist_and_be_regular_file(self):
        smoke = load_smoke_module_with_fakes()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage_dir = root / "stage"
            missing_manifest = self._build_smoke_manifest_fixture(stage_dir, hyperparams_manifest="runtime/commonaccent/missing.yaml")
            with self.assertRaises(RuntimeError):
                smoke.verify_manifest(stage_dir, missing_manifest)

            directory_manifest = self._build_smoke_manifest_fixture(stage_dir, hyperparams_manifest="runtime/commonaccent/subdir")
            (stage_dir / "runtime" / "commonaccent" / "subdir").mkdir(exist_ok=True)
            with self.assertRaises(RuntimeError):
                smoke.verify_manifest(stage_dir, directory_manifest)

    @unittest.skipIf(not hasattr(Path, "symlink_to"), "symlinks are not supported")
    def test_stage_output_rejects_symlink_before_resolve(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "target"
            target.mkdir()
            link = root / "link"
            try:
                link.symlink_to(target, target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")

            with self.assertRaises(ValueError):
                stage_models._resolve_output_path(link)

    def test_tree_hash_and_listing_reject_nested_symlink_before_file_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nested = root / "nested"
            nested.mkdir()
            target = root / "target.txt"
            target.write_text("target", encoding="utf-8")
            link = nested / "link.txt"
            try:
                link.symlink_to(target)
            except OSError as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")

            with self.assertRaises(ValueError):
                compute_tree_sha256(root)
            with self.assertRaises(ValueError):
                stage_models.list_file_hashes(root)


if __name__ == "__main__":
    unittest.main()
