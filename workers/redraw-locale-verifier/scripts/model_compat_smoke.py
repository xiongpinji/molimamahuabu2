#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import resource
import socket
import sys
import time
from pathlib import Path

from faster_whisper import WhisperModel
import psutil
from speechbrain.inference.interfaces import pretrained_from_hparams
from speechbrain.utils.fetching import FetchConfig


def _load_stage_models_module():
    import importlib.util

    path = Path(__file__).resolve().parent / "stage_models.py"
    spec = importlib.util.spec_from_file_location("stage_models", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stage_models = _load_stage_models_module()
SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))
from redraw_locale_worker.commonaccent_interface import CommonAccentClassifier


class NetworkBlocked(RuntimeError):
    pass


def block_network():
    def blocked(*args, **kwargs):
        raise NetworkBlocked("network access is blocked during offline smoke")

    socket.socket = blocked
    socket.create_connection = blocked
    socket.getaddrinfo = blocked


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_manifest(stage_dir, manifest):
    roots = {
        "asr": stage_dir / "models" / "asr",
        "accent": stage_dir / "models" / "accent",
        "wav2vec": stage_dir / "models" / "wav2vec",
    }
    rebuilt = stage_models.build_model_manifest(
        roots,
        revisions={name: manifest["models"][name]["revision"] for name in roots},
    )
    if rebuilt["models"] != manifest["models"]:
        raise RuntimeError("model manifest drift detected")
    runtime_root = stage_dir / "runtime" / "commonaccent"
    runtime_hash = stage_models.compute_tree_sha256(runtime_root)
    if runtime_hash != manifest["runtime"]["commonaccent"]["tree_sha256"]:
        raise RuntimeError("CommonAccent runtime drift detected")
    interface_path = SRC_ROOT / "redraw_locale_worker" / stage_models.COMMONACCENT_INTERFACE_FILE
    interface_hash = sha256_file(interface_path)
    manifest_hash = manifest["runtime"]["commonaccent"]["interface"]["sha256"]
    if interface_hash != manifest_hash:
        raise RuntimeError("CommonAccent vendored interface drift detected")


def current_peak_rss():
    rss = psutil.Process().memory_info().rss
    maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
    return max(rss, maxrss)


def timed(label, fn, timings):
    start = time.perf_counter()
    value = fn()
    timings[label] = round(time.perf_counter() - start, 6)
    return value


def main():
    parser = argparse.ArgumentParser(description="Offline model compatibility smoke.")
    parser.add_argument("--stage-dir", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--max-rss-bytes", type=int, required=True)
    args = parser.parse_args()

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    block_network()

    stage_dir = Path(args.stage_dir).resolve()
    audio_path = Path(args.audio).resolve()
    manifest = json.loads((stage_dir / "manifest.json").read_text(encoding="utf-8"))
    verify_manifest(stage_dir, manifest)
    timings = {}
    audio_hash = sha256_file(audio_path)

    asr_root = stage_dir / "models" / "asr"
    commonaccent_runtime = stage_dir / "runtime" / "commonaccent"

    def run_asr():
        model = WhisperModel(str(asr_root), device="cpu", compute_type="int8", local_files_only=True)
        segments, _ = model.transcribe(str(audio_path), beam_size=1, vad_filter=False)
        for _segment in segments:
            break

    def run_accent():
        classifier = pretrained_from_hparams(
            cls=CommonAccentClassifier,
            source=str(commonaccent_runtime),
            savedir=str(stage_dir / "smoke-cache" / "commonaccent"),
            fetch_config=FetchConfig(allow_network=False),
            run_opts={"device": "cpu"},
        )
        _out_prob, _score, index, text_lab = classifier.classify_file(str(audio_path))
        label = text_lab[0] if text_lab else None
        item = index[0] if hasattr(index, "__len__") else index
        return {"index": int(item.item()), "label": label}

    timed("faster_whisper_seconds", run_asr, timings)
    accent = timed("commonaccent_seconds", run_accent, timings)
    verify_manifest(stage_dir, manifest)

    peak_rss = current_peak_rss()
    result = {
        "python": sys.version.split()[0],
        "runtime": sys.platform,
        "offline": True,
        "network_block": "python_socket_dns_monkeypatch",
        "audio_sha256": audio_hash,
        "accent": accent,
        "commonaccent_interface_sha256": manifest["runtime"]["commonaccent"]["interface"]["sha256"],
        "models": {
            name: {
                "revision": model["revision"],
                "tree_sha256": model["tree_sha256"],
            }
            for name, model in manifest["models"].items()
        },
        "timings": timings,
        "peak_rss_bytes": peak_rss,
    }
    print(json.dumps(result, sort_keys=True))
    if peak_rss > args.max_rss_bytes:
        raise SystemExit(f"peak RSS exceeds limit: {peak_rss} > {args.max_rss_bytes}")


if __name__ == "__main__":
    main()
