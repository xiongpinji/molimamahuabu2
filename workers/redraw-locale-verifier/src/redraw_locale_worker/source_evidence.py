import hashlib
import io
import json
import math
import re
import struct
import wave
from pathlib import Path


SPEAKER_CLUSTER_RE = re.compile(r"speaker-cluster-([1-9][0-9]*)")


def analyze_source_audio(audio_path=None, *, audio_bytes=None, asr, clusterer):
    if audio_bytes is None:
        try:
            audio_bytes = Path(audio_path).read_bytes()
        except (OSError, TypeError) as exc:
            raise ValueError("SOURCE_AUDIO_FORMAT_INVALID") from exc
    if not isinstance(audio_bytes, bytes):
        raise ValueError("SOURCE_AUDIO_FORMAT_INVALID")
    waveform, sample_rate = _read_mono_pcm16_wav(audio_bytes)
    asr_result = _infer_source_audio(asr, audio_bytes)
    segments = _normalize_segments(asr_result)
    duration_seconds = len(waveform) / sample_rate
    _validate_segment_bounds(segments, duration_seconds)

    embeddings = []
    for segment in segments:
        start_sample = int(segment["start"] * sample_rate)
        end_sample = int(segment["end"] * sample_rate)
        if end_sample <= start_sample or end_sample > len(waveform):
            raise ValueError("SOURCE_AUDIO_SEGMENTS_INVALID")
        embeddings.append(clusterer.embed(waveform[start_sample:end_sample], sample_rate))

    labels = _normalize_cluster_labels(clusterer.cluster(embeddings), len(segments))
    evidence_segments = [
        {**segment, "speaker_cluster_id": label}
        for segment, label in zip(segments, labels)
    ]
    transcript_bytes = json.dumps(
        segments,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "source_language": _source_language(asr_result),
        "language_probability": _language_probability(asr_result),
        "segments": evidence_segments,
        "audio_sha256": hashlib.sha256(audio_bytes).hexdigest(),
        "transcript_sha256": hashlib.sha256(transcript_bytes).hexdigest(),
    }


class MfccSpeakerClusterer:
    def __init__(self, threshold=0.82):
        if type(threshold) not in (int, float) or not math.isfinite(float(threshold)) or not -1.0 <= float(threshold) <= 1.0:
            raise ValueError("SOURCE_AUDIO_CLUSTER_THRESHOLD_INVALID")
        self.threshold = float(threshold)

    def embed(self, waveform, sample_rate):
        if type(sample_rate) is not int or sample_rate <= 0 or waveform is None:
            raise ValueError("SOURCE_AUDIO_FORMAT_INVALID")
        import torch
        import torchaudio

        samples = torch.as_tensor(waveform, dtype=torch.float32)
        if samples.ndim == 1:
            samples = samples.unsqueeze(0)
        if samples.ndim != 2 or samples.numel() == 0:
            raise ValueError("SOURCE_AUDIO_FORMAT_INVALID")
        mono = samples.mean(dim=0, keepdim=True)
        mfcc = torchaudio.transforms.MFCC(sample_rate=sample_rate, n_mfcc=20)(mono)
        return torch.cat(
            (mfcc.mean(dim=-1), mfcc.std(dim=-1, unbiased=False)),
            dim=-1,
        ).squeeze(0)

    def cluster(self, embeddings):
        centroids = []
        raw_labels = []
        for embedding in embeddings:
            vector = _vector_values(embedding)
            similarities = [_cosine_similarity(vector, centroid) for centroid in centroids]
            if not similarities or max(similarities) < self.threshold:
                centroids.append(vector)
                raw_labels.append(len(centroids) - 1)
            else:
                raw_labels.append(max(range(len(similarities)), key=similarities.__getitem__))
        return _first_seen_cluster_ids(raw_labels)


def _infer_source_audio(asr, audio_bytes):
    infer = getattr(asr, "infer_source_audio_bytes", None)
    if not callable(infer):
        raise ValueError("SOURCE_AUDIO_ASR_INVALID")
    result = infer(audio_bytes)
    if not isinstance(result, dict):
        raise ValueError("SOURCE_AUDIO_ASR_INVALID")
    return result


def _normalize_segments(asr_result):
    raw_segments = asr_result.get("segments")
    if not isinstance(raw_segments, (list, tuple)) or not raw_segments:
        raise ValueError("SOURCE_AUDIO_SEGMENTS_INVALID")
    segments = []
    previous_end = 0.0
    for raw in raw_segments:
        if not isinstance(raw, dict):
            raise ValueError("SOURCE_AUDIO_SEGMENTS_INVALID")
        start = raw.get("start")
        end = raw.get("end")
        text = raw.get("text")
        if (
            type(start) not in (int, float)
            or type(end) not in (int, float)
            or not math.isfinite(float(start))
            or not math.isfinite(float(end))
            or float(start) < 0.0
            or float(end) <= float(start)
            or float(start) < previous_end
            or not isinstance(text, str)
            or not text.strip()
        ):
            raise ValueError("SOURCE_AUDIO_SEGMENTS_INVALID")
        segments.append({"start": float(start), "end": float(end), "text": text.strip()})
        previous_end = float(end)
    return segments


def _validate_segment_bounds(segments, duration_seconds):
    if not math.isfinite(duration_seconds) or duration_seconds <= 0.0:
        raise ValueError("SOURCE_AUDIO_FORMAT_INVALID")
    for segment in segments:
        if segment["end"] > duration_seconds:
            raise ValueError("SOURCE_AUDIO_SEGMENTS_INVALID")


def _read_mono_pcm16_wav(audio_bytes):
    try:
        data_bytes = _wav_data_payload_size(audio_bytes)
        with wave.open(io.BytesIO(audio_bytes), "rb") as handle:
            channels = handle.getnchannels()
            sample_width = handle.getsampwidth()
            sample_rate = handle.getframerate()
            compression_type = handle.getcomptype()
            frame_count = handle.getnframes()
            frames = handle.readframes(frame_count)
    except (EOFError, OSError, struct.error, wave.Error) as exc:
        raise ValueError("SOURCE_AUDIO_FORMAT_INVALID") from exc
    if (
        channels != 1
        or sample_width != 2
        or sample_rate != 16_000
        or compression_type != "NONE"
        or frame_count <= 0
    ):
        raise ValueError("SOURCE_AUDIO_FORMAT_INVALID")
    expected_bytes = frame_count * 2
    if data_bytes != expected_bytes or len(frames) != expected_bytes:
        raise ValueError("SOURCE_AUDIO_FORMAT_INVALID")
    samples = struct.unpack(f"<{frame_count}h", frames)
    return [sample / 32768.0 for sample in samples], sample_rate


def _wav_data_payload_size(audio_bytes):
    if (
        not isinstance(audio_bytes, bytes)
        or len(audio_bytes) < 12
        or audio_bytes[:4] != b"RIFF"
        or audio_bytes[8:12] != b"WAVE"
        or struct.unpack_from("<I", audio_bytes, 4)[0] + 8 != len(audio_bytes)
    ):
        raise ValueError("SOURCE_AUDIO_FORMAT_INVALID")
    offset = 12
    data_sizes = []
    while offset < len(audio_bytes):
        if offset + 8 > len(audio_bytes):
            raise ValueError("SOURCE_AUDIO_FORMAT_INVALID")
        chunk_id = audio_bytes[offset:offset + 4]
        chunk_size = struct.unpack_from("<I", audio_bytes, offset + 4)[0]
        chunk_end = offset + 8 + chunk_size
        padded_end = chunk_end + (chunk_size % 2)
        if padded_end > len(audio_bytes):
            raise ValueError("SOURCE_AUDIO_FORMAT_INVALID")
        if chunk_id == b"data":
            data_sizes.append(chunk_size)
        offset = padded_end
    if len(data_sizes) != 1:
        raise ValueError("SOURCE_AUDIO_FORMAT_INVALID")
    return data_sizes[0]


def _source_language(asr_result):
    value = asr_result.get("language")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("SOURCE_AUDIO_ASR_INVALID")
    return value.strip().casefold()


def _language_probability(asr_result):
    value = asr_result.get("language_probability", asr_result.get("probability"))
    if type(value) not in (int, float) or not math.isfinite(float(value)) or not 0.0 <= float(value) <= 1.0:
        raise ValueError("SOURCE_AUDIO_ASR_INVALID")
    return float(value)


def _normalize_cluster_labels(labels, expected_count):
    if not isinstance(labels, (list, tuple)) or len(labels) != expected_count:
        raise ValueError("SOURCE_AUDIO_CLUSTERS_INVALID")
    normalized = []
    for label in labels:
        if isinstance(label, str) and SPEAKER_CLUSTER_RE.fullmatch(label):
            normalized.append(label)
        elif type(label) is int and label >= 0:
            normalized.append(f"speaker-cluster-{label + 1}")
        else:
            raise ValueError("SOURCE_AUDIO_CLUSTERS_INVALID")
    return normalized


def _first_seen_cluster_ids(labels):
    canonical = {}
    result = []
    for label in labels:
        if label not in canonical:
            canonical[label] = f"speaker-cluster-{len(canonical) + 1}"
        result.append(canonical[label])
    return result


def _vector_values(embedding):
    value = embedding
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, (list, tuple)) or not value:
        raise ValueError("SOURCE_AUDIO_EMBEDDING_INVALID")
    vector = []
    for item in value:
        if type(item) not in (int, float) or not math.isfinite(float(item)):
            raise ValueError("SOURCE_AUDIO_EMBEDDING_INVALID")
        vector.append(float(item))
    return vector


def _cosine_similarity(left, right):
    if len(left) != len(right):
        raise ValueError("SOURCE_AUDIO_EMBEDDING_INVALID")
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return -1.0
    return sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)
