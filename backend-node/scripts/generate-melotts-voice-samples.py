"""Generate the local MeloTTS catalog samples used by the voice picker.

Install MeloTTS in an isolated Python environment before running this script:
  python -m pip install git+https://github.com/myshell-ai/MeloTTS.git
  python -m pip install "setuptools<81" eunjeon
  python -m unidic download

The generated files are intentionally written under backend-node/data/storage,
which is local runtime data and is not committed to Git.
"""

import argparse
import os
import sys
from pathlib import Path


VOICES = {
    "melotts-zh": ("ZH", "ZH", "这是茉莉妈妈短剧制作平台的中文角色音色示例。"),
    "melotts-en-us": ("EN", "EN-US", "This is a sample character voice for the short drama platform."),
    "melotts-en-br": ("EN", "EN-BR", "This is a sample character voice for the short drama platform."),
    "melotts-jp": ("JP", "JP", "これはショートドラマ制作プラットフォームの音声サンプルです。"),
    "melotts-kr": ("KR", "KR", "숏드라마 제작 플랫폼의 캐릭터 음성 샘플입니다."),
}


def configure_stdio():
    """Keep MeloTTS logs printable on Windows consoles using a legacy code page."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="replace")


def default_output_dir() -> Path:
    explicit = os.getenv("MELOTTS_VOICE_DIR")
    if explicit:
        return Path(explicit)
    configured_storage = os.getenv("STORAGE_LOCAL_PATH")
    if configured_storage:
        storage = Path(configured_storage)
        if not storage.is_absolute():
            storage = Path.cwd() / storage
        return storage / "library" / "voices" / "melotts"
    return Path(__file__).resolve().parents[1] / "data" / "storage" / "library" / "voices" / "melotts"


def main():
    configure_stdio()
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=default_output_dir(),
    )
    args = parser.parse_args()

    from melo.api import TTS

    args.output.mkdir(parents=True, exist_ok=True)
    for catalog_id, (language, speaker_name, text) in VOICES.items():
        model = TTS(language=language, device="cpu")
        speaker_id = model.hps.data.spk2id[speaker_name]
        output = args.output / f"{catalog_id}.wav"
        model.tts_to_file(text, speaker_id, str(output), speed=1.0)
        print(f"generated {output}")


if __name__ == "__main__":
    main()
