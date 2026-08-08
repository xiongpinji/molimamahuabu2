"""Local CommonAccent SpeechBrain interface.

Derived from the MIT-licensed
Jzuluaga/accent-id-commonaccent_xlsr-en-english custom_interface.py at
cc5dc6a56db647149d9e52856d6e55114c1045a8. This vendored interface keeps only
the audited local inference path needed by the verifier and does not load or
execute model-repository Python modules.
"""

import torch
from speechbrain.inference.interfaces import Pretrained


class CommonAccentClassifier(Pretrained):
    """Classifier for the pinned CommonAccent wav2vec2 runtime."""

    MODULES_NEEDED = ["wav2vec2", "avg_pool", "output_mlp"]
    HPARAMS_NEEDED = ["softmax", "label_encoder"]

    def encode_batch(self, wavs, wav_lens=None, normalize=False):
        del normalize
        if len(wavs.shape) == 1:
            wavs = wavs.unsqueeze(0)
        if wav_lens is None:
            wav_lens = torch.ones(wavs.shape[0], device=self.device)
        wavs = wavs.to(self.device).float()
        wav_lens = wav_lens.to(self.device)
        outputs = self.mods.wav2vec2(wavs)
        outputs = self.mods.avg_pool(outputs, wav_lens)
        return outputs.view(outputs.shape[0], -1)

    def classify_batch(self, wavs, wav_lens=None):
        outputs = self.encode_batch(wavs, wav_lens)
        outputs = self.mods.output_mlp(outputs)
        out_prob = self.hparams.softmax(outputs.squeeze(1))
        score, index = torch.max(out_prob, dim=-1)
        text_lab = self.hparams.label_encoder.decode_torch(index)
        return out_prob, score, index, text_lab

    def classify_file(self, path):
        waveform = self.load_audio(path)
        batch = waveform.unsqueeze(0)
        rel_length = torch.tensor([1.0], device=self.device)
        return self.classify_batch(batch, rel_length)

    def forward(self, wavs, wav_lens=None, normalize=False):
        return self.encode_batch(wavs=wavs, wav_lens=wav_lens, normalize=normalize)
