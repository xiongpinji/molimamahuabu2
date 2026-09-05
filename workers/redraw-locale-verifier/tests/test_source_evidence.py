import hashlib
import io
import json
import math
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from redraw_locale_worker.engines import FasterWhisperEngine
from redraw_locale_worker.source_evidence import MfccSpeakerClusterer, analyze_source_audio


class FakeAsr:
    def __init__(self, segments, *, language="zh", probability=0.99):
        self.segments = segments
        self.language = language
        self.probability = probability

    def infer_source_audio_bytes(self, audio_bytes):
        self.audio_bytes = bytes(audio_bytes)
        return {
            "language": self.language,
            "probability": self.probability,
            "segments": self.segments,
        }


class FakeClusterer:
    def __init__(self, labels):
        self.labels = labels
        self.embedded_samples = []

    def embed(self, waveform, sample_rate):
        self.embedded_samples.append((len(waveform), sample_rate))
        return [float(len(waveform)), float(sample_rate)]

    def cluster(self, embeddings):
        self.embeddings = embeddings
        return self.labels


class SourceEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.wav_path = Path(self.temp_dir.name).resolve() / "source.wav"
        with wave.open(str(self.wav_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16_000)
            handle.writeframes(b"\x00\x00" * (16_000 * 3))

    def test_analyze_source_audio_returns_timed_transcript_and_stable_clusters(self):
        clusterer = FakeClusterer([1, 0])

        result = analyze_source_audio(
            self.wav_path,
            asr=FakeAsr([
                {"start": 0.1, "end": 1.2, "text": " 你回来了 "},
                {"start": 1.5, "end": 2.4, "text": "我回来了"},
            ]),
            clusterer=clusterer,
        )

        self.assertEqual(
            result["segments"],
            [
                {
                    "start": 0.1,
                    "end": 1.2,
                    "text": "你回来了",
                    "speaker_cluster_id": "speaker-cluster-2",
                },
                {
                    "start": 1.5,
                    "end": 2.4,
                    "text": "我回来了",
                    "speaker_cluster_id": "speaker-cluster-1",
                },
            ],
        )
        self.assertEqual(clusterer.embedded_samples, [(17_600, 16_000), (14_400, 16_000)])
        self.assertEqual(result["source_language"], "zh")
        self.assertEqual(result["language_probability"], 0.99)
        self.assertEqual(result["audio_sha256"], hashlib.sha256(self.wav_path.read_bytes()).hexdigest())
        self.assertRegex(result["audio_sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(result["transcript_sha256"], r"^[0-9a-f]{64}$")

    def test_same_raw_cluster_label_maps_to_the_same_stable_identifier(self):
        result = analyze_source_audio(
            self.wav_path,
            asr=FakeAsr([
                {"start": 0.0, "end": 0.5, "text": "第一句"},
                {"start": 0.5, "end": 1.0, "text": "第二句"},
            ]),
            clusterer=FakeClusterer([1, 1]),
        )

        self.assertEqual(
            [segment["speaker_cluster_id"] for segment in result["segments"]],
            ["speaker-cluster-2", "speaker-cluster-2"],
        )

    def test_empty_or_invalid_timed_segments_are_rejected(self):
        invalid_segments = [
            [],
            [{"start": -0.1, "end": 0.5, "text": "坏时间码"}],
            [{"start": 0.5, "end": 0.5, "text": "坏时间码"}],
            [{"start": 0.5, "end": 3.1, "text": "越界时间码"}],
            [{"start": math.nan, "end": 0.5, "text": "坏时间码"}],
            [{"start": 0.0, "end": 0.5, "text": "  "}],
        ]
        for segments in invalid_segments:
            with self.subTest(segments=segments), self.assertRaisesRegex(
                ValueError,
                "SOURCE_AUDIO_SEGMENTS_INVALID",
            ):
                analyze_source_audio(
                    self.wav_path,
                    asr=FakeAsr(segments),
                    clusterer=FakeClusterer([]),
                )

    def test_out_of_order_segments_are_rejected_instead_of_silently_sorted(self):
        with self.assertRaisesRegex(ValueError, "SOURCE_AUDIO_SEGMENTS_INVALID"):
            analyze_source_audio(
                self.wav_path,
                asr=FakeAsr([
                    {"start": 1.0, "end": 1.5, "text": "第二句"},
                    {"start": 0.0, "end": 0.5, "text": "第一句"},
                ]),
                clusterer=FakeClusterer([0, 1]),
            )

    def test_overlapping_segments_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "SOURCE_AUDIO_SEGMENTS_INVALID"):
            analyze_source_audio(
                self.wav_path,
                asr=FakeAsr([
                    {"start": 0.0, "end": 1.0, "text": "第一句"},
                    {"start": 0.5, "end": 1.2, "text": "重叠对白"},
                ]),
                clusterer=FakeClusterer([0, 1]),
            )

    def test_output_contract_does_not_leak_the_absolute_audio_path(self):
        result = analyze_source_audio(
            self.wav_path,
            asr=FakeAsr([{"start": 0.0, "end": 0.5, "text": "对白"}]),
            clusterer=FakeClusterer([0]),
        )

        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn(str(self.wav_path), serialized)
        self.assertEqual(
            set(result),
            {"source_language", "language_probability", "segments", "audio_sha256", "transcript_sha256"},
        )

    def test_asr_uses_validated_immutable_bytes_when_source_path_is_replaced(self):
        original_bytes = self.wav_path.read_bytes()
        replacement_path = Path(self.temp_dir.name).resolve() / "replacement.wav"
        with wave.open(str(replacement_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16_000)
            handle.writeframes(b"\x01\x00" * (16_000 * 3))
        replacement_bytes = replacement_path.read_bytes()

        class RacingAsr:
            def infer_source_audio(self, audio_path):
                self.wav_path.write_bytes(replacement_bytes)
                self.received_bytes = Path(audio_path).read_bytes()
                return self._result()

            def infer_source_audio_bytes(self, audio_bytes):
                self.wav_path.write_bytes(replacement_bytes)
                self.received_bytes = bytes(audio_bytes)
                return self._result()

            @staticmethod
            def _result():
                return {
                    "language": "zh",
                    "probability": 0.99,
                    "segments": [{"start": 0.0, "end": 0.5, "text": "旧音频"}],
                }

        asr = RacingAsr()
        asr.wav_path = self.wav_path

        result = analyze_source_audio(
            self.wav_path,
            asr=asr,
            clusterer=FakeClusterer([0]),
        )

        self.assertNotEqual(original_bytes, replacement_bytes)
        self.assertEqual(asr.received_bytes, original_bytes)
        self.assertEqual(result["audio_sha256"], hashlib.sha256(original_bytes).hexdigest())

    def test_faster_whisper_source_audio_transcribes_from_bytes_io(self):
        calls = []

        class FakeModel:
            def transcribe(self, audio_input, *, beam_size, vad_filter):
                calls.append((audio_input, beam_size, vad_filter))
                return (
                    [SimpleNamespace(start=0.0, end=0.5, text=" 字节音频 ")],
                    SimpleNamespace(language="zh", language_probability=0.99),
                )

        engine = FasterWhisperEngine.__new__(FasterWhisperEngine)
        engine.model = FakeModel()
        audio_bytes = self.wav_path.read_bytes()

        result = engine.infer_source_audio_bytes(audio_bytes)

        self.assertEqual(len(calls), 1)
        self.assertIsInstance(calls[0][0], io.BytesIO)
        self.assertEqual(calls[0][0].getvalue(), audio_bytes)
        self.assertEqual(calls[0][1:], (5, True))
        self.assertEqual(result["segments"], [{"start": 0.0, "end": 0.5, "text": "字节音频"}])

    def test_mfcc_clusterer_uses_deterministic_online_cosine_clusters(self):
        clusterer = MfccSpeakerClusterer(threshold=0.82)

        labels = clusterer.cluster([
            [1.0, 0.0],
            [0.99, 0.01],
            [0.0, 1.0],
            [0.0, 2.0],
        ])

        self.assertEqual(
            labels,
            ["speaker-cluster-1", "speaker-cluster-1", "speaker-cluster-2", "speaker-cluster-2"],
        )

    def test_mfcc_embedding_mixes_to_mono_and_uses_twenty_mean_std_features(self):
        calls = []

        class InputWaveform:
            def __bool__(self):
                raise RuntimeError("tensor truth value must not be evaluated")

        class Tensor:
            ndim = 2

            def numel(self):
                return 8

            def mean(self, *, dim, keepdim):
                calls.append(("mono", dim, keepdim))
                return "mono-waveform"

        class MfccValues:
            def mean(self, *, dim):
                calls.append(("mean", dim))
                return "means"

            def std(self, *, dim, unbiased):
                calls.append(("std", dim, unbiased))
                return "stddevs"

        class Combined:
            def squeeze(self, dim):
                calls.append(("squeeze", dim))
                return "embedding"

        class MfccTransform:
            def __init__(self, *, sample_rate, n_mfcc):
                calls.append(("mfcc", sample_rate, n_mfcc))

            def __call__(self, waveform):
                calls.append(("transform", waveform))
                return MfccValues()

        fake_torch = SimpleNamespace(
            float32="float32",
            as_tensor=lambda waveform, dtype: (
                calls.append(("as_tensor", waveform, dtype)) or Tensor()
            ),
            cat=lambda values, dim: (
                calls.append(("cat", values, dim)) or Combined()
            ),
        )
        fake_torchaudio = SimpleNamespace(
            transforms=SimpleNamespace(MFCC=MfccTransform),
        )
        with patch.dict(sys.modules, {"torch": fake_torch, "torchaudio": fake_torchaudio}):
            result = MfccSpeakerClusterer().embed(InputWaveform(), 16_000)

        self.assertEqual(result, "embedding")
        self.assertIn(("mono", 0, True), calls)
        self.assertIn(("mfcc", 16_000, 20), calls)
        self.assertIn(("std", -1, False), calls)
        self.assertIn(("cat", ("means", "stddevs"), -1), calls)


if __name__ == "__main__":
    unittest.main()
