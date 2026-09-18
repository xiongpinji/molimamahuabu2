# Deferred holds (P7)

Do not start without explicit user order:

1. Physical deletion of TTS implementation files (ttsService etc.) — product already defaults TTS off via ttsPolicy.
2. Full domain split of routes/redraw.js (~5k lines) — routes/redraw/index.js remains re-export only.
3. Billing stash@{0..2} backend rewrite — missing policy services; frozen under docs/verification/stash-freeze/.
