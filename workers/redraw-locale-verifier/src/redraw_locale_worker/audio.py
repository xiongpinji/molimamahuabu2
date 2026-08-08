import hashlib
import json
import subprocess
import tempfile
import time
from pathlib import Path

from .errors import AudioInputError

MAX_AUDIO_SECONDS = 60.0
DEADLINE_SECONDS = 30.0


def normalize_audio(audio_path, allowed_root, temp_root):
    start = time.monotonic()
    source = _resolve_inside_root(audio_path, allowed_root)
    temp_dir = Path(temp_root).resolve(strict=True)
    if not temp_dir.is_dir():
        raise AudioInputError("LOCALE_AUDIO_PATH_INVALID")

    temp_path = None
    try:
        probe = _probe_audio(source, _remaining(start))
        duration = _validated_duration(probe)
        with tempfile.NamedTemporaryFile(prefix="redraw-locale-", suffix=".wav", dir=temp_dir, delete=False) as handle:
            temp_path = Path(handle.name)
        _run_ffmpeg(source, temp_path, _remaining(start))
        normalized_probe = _probe_audio(temp_path, _remaining(start))
        _validated_duration(normalized_probe)
        return {
            "source_path": str(source),
            "duration_seconds": duration,
            "normalized_sha256": _file_sha256(temp_path),
            "sample_rate_hz": 16000,
            "channels": 1,
        }
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def _resolve_inside_root(audio_path, allowed_root):
    root = Path(allowed_root).resolve(strict=True)
    if not root.is_dir():
        raise AudioInputError("LOCALE_AUDIO_PATH_INVALID")
    path = Path(audio_path)
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise AudioInputError("LOCALE_AUDIO_PATH_INVALID") from exc
    if not resolved.is_file() or not _is_relative_to(resolved, root):
        raise AudioInputError("LOCALE_AUDIO_PATH_INVALID")
    return resolved


def _probe_audio(path, timeout):
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(path),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AudioInputError("LOCALE_AUDIO_PROBE_FAILED") from exc
    if completed.returncode != 0:
        raise AudioInputError("LOCALE_AUDIO_PROBE_FAILED")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise AudioInputError("LOCALE_AUDIO_PROBE_FAILED") from exc


def _validated_duration(probe):
    streams = [stream for stream in probe.get("streams", []) if stream.get("codec_type") == "audio"]
    if len(streams) != 1:
        raise AudioInputError("LOCALE_AUDIO_STREAM_INVALID")
    duration = probe.get("format", {}).get("duration") or streams[0].get("duration")
    try:
        seconds = float(duration)
    except (TypeError, ValueError) as exc:
        raise AudioInputError("LOCALE_AUDIO_DURATION_INVALID") from exc
    if seconds <= 0 or seconds > MAX_AUDIO_SECONDS:
        raise AudioInputError("LOCALE_AUDIO_DURATION_INVALID")
    return seconds


def _run_ffmpeg(source, target, timeout):
    command = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        str(source),
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        "16000",
        str(target),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AudioInputError("LOCALE_AUDIO_NORMALIZE_FAILED") from exc
    if completed.returncode != 0:
        raise AudioInputError("LOCALE_AUDIO_NORMALIZE_FAILED")


def _remaining(start):
    remaining = DEADLINE_SECONDS - (time.monotonic() - start)
    if remaining <= 0:
        raise AudioInputError("LOCALE_AUDIO_DEADLINE_EXCEEDED")
    return remaining


def _file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_relative_to(path, root):
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True
