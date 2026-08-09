# Third-Party Notices

This verifier pins all runtime dependencies and model snapshots. License metadata below is a staging inventory, not a legal conclusion; each item still needs manual legal review before production use.

## Python Dependencies

- `faster-whisper==1.2.1` - PyPI package for Whisper inference. License requires manual review against its package metadata and bundled dependency notices.
- `ctranslate2==4.8.1` - PyPI package used by faster-whisper. License requires manual review against its package metadata and bundled dependency notices.
- `huggingface-hub==0.36.2` - PyPI package used only for explicit model staging. License requires manual review.
- `jiwer==4.0.0` - PyPI package for speech metrics support. License requires manual review.
- `psutil==7.2.2` - PyPI package for RSS measurement. License requires manual review.
- `PyYAML==6.0.3` - PyPI package for hyperparameter YAML validation. License requires manual review.
- `soundfile==0.14.0` - PyPI package for audio file support. License requires manual review.
- `speechbrain==1.1.0` - PyPI package for CommonAccent classifier loading. License requires manual review.
- `torch==2.11.0` - PyTorch CPU runtime. License requires manual review, including bundled binary components.
- `torchaudio==2.11.0` - PyTorch audio runtime. License requires manual review, including bundled binary components.
- `transformers==4.57.6` - PyPI package for local transformer model loading. License requires manual review.

## Model Snapshots

- `Systran/faster-whisper-small` at `2ec96c5472da50d38d40c0cfe0602af2e94b4c8a` - ASR model snapshot staged from Hugging Face. Model license and provenance require manual review before production use.
- `Jzuluaga/accent-id-commonaccent_xlsr-en-english` at `cc5dc6a56db647149d9e52856d6e55114c1045a8` - Accent classifier snapshot staged from Hugging Face. Model license, dataset rights, and intended-use constraints require manual review before production use.
- `facebook/wav2vec2-large-xlsr-53` at `b61310a3ecdfdc01af29ef1c203d708047a51184` - Wav2Vec backbone snapshot staged from Hugging Face. Model license, dataset rights, and intended-use constraints require manual review before production use.

## Operational Review Points

- Confirm all downloaded artifacts match the committed manifest tree hashes before any release candidate uses them.
- Confirm no production secret, token, absolute local path, or user audio is copied into model staging manifests or smoke output.
- Confirm the CommonAccent runtime copy only rewrites `wav2vec2_hub` and `pretrained_path` from the pinned original lines to local absolute staging paths.
