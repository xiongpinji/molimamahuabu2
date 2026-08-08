#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path


ASR_REPO = "Systran/faster-whisper-small"
ASR_REVISION = "2ec96c5472da50d38d40c0cfe0602af2e94b4c8a"
ACCENT_REPO = "Jzuluaga/accent-id-commonaccent_xlsr-en-english"
ACCENT_REVISION = "cc5dc6a56db647149d9e52856d6e55114c1045a8"
WAV2VEC_REPO = "facebook/wav2vec2-large-xlsr-53"
WAV2VEC_REVISION = "b61310a3ecdfdc01af29ef1c203d708047a51184"

EXPECTED_REVISIONS = {
    "asr": ASR_REVISION,
    "accent": ACCENT_REVISION,
    "wav2vec": WAV2VEC_REVISION,
}

MODEL_SPECS = {
    "asr": (ASR_REPO, ASR_REVISION),
    "accent": (ACCENT_REPO, ACCENT_REVISION),
    "wav2vec": (WAV2VEC_REPO, WAV2VEC_REVISION),
}

COMMONACCENT_WAV2VEC_LINE = f'wav2vec2_hub: "{WAV2VEC_REPO}"'
COMMONACCENT_PRETRAINED_LINE = f"pretrained_path: {ACCENT_REPO}"
COMMONACCENT_INTERFACE_FILE = "commonaccent_interface.py"
COMMONACCENT_INTERFACE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "redraw_locale_worker"
    / COMMONACCENT_INTERFACE_FILE
)
COMMONACCENT_ALLOWED_CLASS_TAGS = {
    "!new:speechbrain.lobes.models.huggingface_transformers.wav2vec2.Wav2Vec2",
    "!new:speechbrain.nnet.pooling.StatisticsPooling",
    "!new:speechbrain.nnet.linear.Linear",
    "!new:torch.nn.ModuleList",
    "!new:speechbrain.nnet.activations.Softmax",
    "!new:speechbrain.dataio.encoder.CategoricalEncoder",
    "!new:speechbrain.utils.parameter_transfer.Pretrainer",
}


def _require_exact_revision(revision):
    if not isinstance(revision, str) or not revision:
        raise ValueError("revision must be a non-empty string")
    if revision in {"main", "master", "latest"} or len(revision) != 40:
        raise ValueError(f"floating or non-commit revision rejected: {revision}")
    int(revision, 16)


def _safe_resolve(path):
    return Path(path).expanduser().resolve()


def _ensure_empty_output(path):
    if path.exists() and any(path.iterdir()):
        raise ValueError(f"output directory already exists and is not empty: {path}")
    path.mkdir(parents=True, exist_ok=True)


def _ensure_no_symlinks(root):
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"symlink rejected: {path}")


def _copytree_regular_files(source, destination):
    source = _safe_resolve(source)
    destination = _safe_resolve(destination)
    if destination.exists():
        if any(destination.iterdir()):
            raise ValueError(f"runtime directory already exists and is not empty: {destination}")
    destination.mkdir(parents=True, exist_ok=True)
    for item in source.rglob("*"):
        if item.is_symlink():
            raise ValueError(f"symlink rejected: {item}")
        relative = item.relative_to(source)
        target = (destination / relative).resolve()
        if not str(target).startswith(str(destination)):
            raise ValueError(f"path escape rejected: {item}")
        if item.is_dir():
            target.mkdir(exist_ok=True)
        elif item.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)


def compute_file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compute_tree_sha256(root):
    root = _safe_resolve(root)
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        if path.is_symlink():
            raise ValueError(f"symlink rejected: {path}")
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(compute_file_sha256(path)))
    return digest.hexdigest()


def list_file_hashes(root):
    root = _safe_resolve(root)
    files = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        if path.is_symlink():
            raise ValueError(f"symlink rejected: {path}")
        files.append(
            {
                "path": path.relative_to(root).as_posix(),
                "sha256": compute_file_sha256(path),
                "size": path.stat().st_size,
            }
        )
    return files


def _find_commonaccent_hyperparams(root):
    candidates = sorted(root.rglob("*.yaml")) + sorted(root.rglob("*.yml"))
    for path in candidates:
        text = path.read_text(encoding="utf-8")
        if COMMONACCENT_WAV2VEC_LINE in text and COMMONACCENT_PRETRAINED_LINE in text:
            return path
    raise ValueError("CommonAccent hyperparams with expected original lines not found")


def _iter_yaml_tags(node):
    yield node.tag
    for child in getattr(node, "value", []):
        if isinstance(child, tuple):
            for item in child:
                yield from _iter_yaml_tags(item)
        else:
            yield from _iter_yaml_tags(child)


def _validate_commonaccent_yaml_tags(hyperparams):
    text = hyperparams.read_text(encoding="utf-8")
    class_tags = set(re.findall(r"!(?:new|name):[A-Za-z0-9_.]+", text))
    extra = class_tags - COMMONACCENT_ALLOWED_CLASS_TAGS
    missing = COMMONACCENT_ALLOWED_CLASS_TAGS - class_tags
    if extra:
        raise ValueError(f"CommonAccent hyperparams class tag drifted: {sorted(extra)}")
    if missing:
        raise ValueError(f"CommonAccent hyperparams missing expected class tags: {sorted(missing)}")


def prepare_commonaccent_runtime(source_dir, runtime_dir, wav2vec_dir):
    source_dir = _safe_resolve(source_dir)
    runtime_dir = _safe_resolve(runtime_dir)
    wav2vec_dir = _safe_resolve(wav2vec_dir)
    _copytree_regular_files(source_dir, runtime_dir)
    hyperparams = _find_commonaccent_hyperparams(runtime_dir)
    text = hyperparams.read_text(encoding="utf-8")
    if text.count(COMMONACCENT_WAV2VEC_LINE) != 1:
        raise ValueError("CommonAccent wav2vec2_hub original line drifted")
    if text.count(COMMONACCENT_PRETRAINED_LINE) != 1:
        raise ValueError("CommonAccent pretrained_path original line drifted")
    text = text.replace(COMMONACCENT_WAV2VEC_LINE, f"wav2vec2_hub: {wav2vec_dir.as_posix()}")
    text = text.replace(COMMONACCENT_PRETRAINED_LINE, f"pretrained_path: {runtime_dir.as_posix()}")
    hyperparams.write_text(text, encoding="utf-8")
    _validate_commonaccent_yaml_tags(hyperparams)
    return hyperparams


def build_commonaccent_runtime_manifest(runtime_dir, interface_path=COMMONACCENT_INTERFACE_PATH):
    runtime_dir = _safe_resolve(runtime_dir)
    interface_path = _safe_resolve(interface_path)
    return {
        "hyperparams": "runtime/commonaccent/hyperparams.yaml",
        "tree_sha256": compute_tree_sha256(runtime_dir),
        "files": list_file_hashes(runtime_dir),
        "interface": {
            "file": COMMONACCENT_INTERFACE_FILE,
            "sha256": compute_file_sha256(interface_path),
            "source_repo_id": ACCENT_REPO,
            "source_revision": ACCENT_REVISION,
            "license": "MIT",
        },
        "allowed_class_tags": sorted(COMMONACCENT_ALLOWED_CLASS_TAGS),
    }


def build_model_manifest(model_roots, revisions=None):
    revisions = revisions or EXPECTED_REVISIONS
    manifest = {"schema_version": 1, "models": {}}
    for name, expected_revision in EXPECTED_REVISIONS.items():
        revision = revisions.get(name)
        _require_exact_revision(revision)
        if revision != expected_revision:
            raise ValueError(f"{name} revision mismatch: {revision}")
        root = _safe_resolve(model_roots[name])
        manifest["models"][name] = {
            "repo_id": MODEL_SPECS[name][0],
            "revision": revision,
            "tree_sha256": compute_tree_sha256(root),
            "files": list_file_hashes(root),
        }
    return manifest


def _download_model(name, output):
    from huggingface_hub import snapshot_download

    repo_id, revision = MODEL_SPECS[name]
    _require_exact_revision(revision)
    target = output / "models" / name
    if target.exists() and any(target.iterdir()):
        raise ValueError(f"model output already exists and is not empty: {target}")
    target.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=repo_id,
        revision=revision,
        local_dir=target,
        local_dir_use_symlinks=False,
    )
    _ensure_no_symlinks(target)
    return target


def stage_models(output):
    output = _safe_resolve(output)
    _ensure_empty_output(output)
    roots = {name: _download_model(name, output) for name in ("asr", "accent", "wav2vec")}
    runtime_dir = output / "runtime" / "commonaccent"
    hyperparams = prepare_commonaccent_runtime(roots["accent"], runtime_dir, roots["wav2vec"])
    manifest = build_model_manifest(roots, EXPECTED_REVISIONS)
    manifest["runtime"] = {
        "commonaccent": {
            **build_commonaccent_runtime_manifest(runtime_dir),
            "hyperparams": hyperparams.relative_to(output).as_posix(),
        }
    }
    manifest_path = output / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description="Stage fixed locale verifier models.")
    parser.add_argument("--output", required=True, help="Empty isolated output directory")
    args = parser.parse_args()
    manifest = stage_models(args.output)
    print(json.dumps({"manifest": manifest}, sort_keys=True))


if __name__ == "__main__":
    main()
