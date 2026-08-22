import math
from pathlib import Path


class FasterWhisperEngine:
    def __init__(self, model_dir):
        model_path = Path(model_dir).resolve(strict=True)
        if not model_path.is_dir():
            raise ValueError("LOCALE_ASR_MODEL_DIR_INVALID")
        from faster_whisper import WhisperModel

        self.model = WhisperModel(str(model_path), device="cpu", compute_type="int8", local_files_only=True)

    def infer(self, audio_path):
        segments, info = self.model.transcribe(str(Path(audio_path)), beam_size=5, vad_filter=True)
        evidence_segments = []
        for segment in segments:
            text = getattr(segment, "text", "").strip()
            if not text:
                continue
            evidence_segments.append(
                {
                    "start": float(getattr(segment, "start")),
                    "end": float(getattr(segment, "end")),
                    "text": text,
                }
            )
        return {
            "language": getattr(info, "language", None),
            "probability": _raw_probability(getattr(info, "language_probability", None)),
            "text": " ".join(segment["text"] for segment in evidence_segments).strip(),
            "segments": evidence_segments,
        }


class CommonAccentEngine:
    def __init__(self, runtime_dir, savedir=None):
        runtime_path = Path(runtime_dir).resolve(strict=True)
        if not runtime_path.is_dir():
            raise ValueError("LOCALE_ACCENT_RUNTIME_DIR_INVALID")
        from speechbrain.inference.interfaces import pretrained_from_hparams
        from speechbrain.utils.fetching import FetchConfig

        from .commonaccent_interface import CommonAccentClassifier

        cache_dir = Path(savedir).resolve() if savedir is not None else runtime_path.parent / "commonaccent-cache"
        self.classifier = pretrained_from_hparams(
            cls=CommonAccentClassifier,
            source=str(runtime_path),
            savedir=str(cache_dir),
            fetch_config=FetchConfig(allow_network=False),
        )

    def infer(self, audio_path):
        _out_prob, score, _index, labels = self.classifier.classify_file(str(Path(audio_path)))
        label = labels[0] if isinstance(labels, (list, tuple)) else labels
        return {
            "label": str(label),
            "probability": _score_to_probability(score),
        }


def _score_to_probability(score):
    value = score[0] if hasattr(score, "__getitem__") else score
    if hasattr(value, "item"):
        value = value.item()
    if type(value) not in (int, float):
        return None
    value = float(value)
    if not math.isfinite(value):
        return None
    if value <= 0.0:
        value = float(math.exp(value))
    return _raw_probability(value)


def _raw_probability(value):
    if type(value) not in (int, float):
        return None
    value = float(value)
    if not math.isfinite(value):
        return None
    if not math.isfinite(value) or value < 0.0 or value > 1.0:
        return None
    return value
