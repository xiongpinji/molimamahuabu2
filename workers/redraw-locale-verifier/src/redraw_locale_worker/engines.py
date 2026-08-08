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
        text = " ".join(segment.text.strip() for segment in segments if getattr(segment, "text", "").strip()).strip()
        return {
            "language": getattr(info, "language", None),
            "probability": float(getattr(info, "language_probability", 0.0)),
            "text": text,
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
    value = float(value)
    if value <= 0.0:
        return float(math.exp(value))
    return value
