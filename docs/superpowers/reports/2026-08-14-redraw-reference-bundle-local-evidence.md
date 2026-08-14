# Redraw Reference Bundle Local Evidence

Date: 2026-08-15
Branch: codex/redraw-r12-merge-20260809
Evidence baseline commit: 57343ed1
Backend cwd: backend-node

## Scope

This report covers the provider-neutral local reference bundle gate only. It used synthetic fixture media and local SQLite migration data. It did not read supplier keys, call Fumin, call ToAPIs, upload user video, access production, write production data, deploy, push, or activate a release.

`reference_gate=ready` means the local contract can enter a later integration step. It does not prove Fumin full-character replacement, real paid generation, complete-episode redraw, or production readiness.

## Fixed Local Artifacts

The fixture command wrote exactly these fixed output names outside the repository:

- `redraw-reference-bundle-local-manifest.json`
- `redraw-reference-bundle-motion.mp4`
- `redraw-reference-bundle-contact-sheet.jpg`

Fresh artifact evidence:

- manifest: 8457 bytes, SHA-256 `443fd3b51bcb49d3345e7780a69ffa7593dc60afa62831f05dc48f2722a5841d`
- motion: 7132 bytes, SHA-256 `5755702549c3828533d7e3e3ae8cc662d88918c646dca5d0e96554637fc81d48`
- contact sheet: 29440 bytes, SHA-256 `643c339ce7d9437a446771c3cf148d071a00babfdd9e6ed663ab3fe6c7005716`

## Manifest Checks

- outer schema: `redraw-reference-bundle-local-manifest-v1`
- inner bundle schema: `redraw-reference-bundle-v1`
- reference gate: `ready`
- locale and market: `en-US` / `US`
- source fingerprint: `db8ea9891695045dfa636b28503b035eec584b263ac22621841df330109eb05e`
- reference bundle hash: `be52f7b8e93cffad3f7a69167b126f1c2ceaa550489a40c75131e099ec0bf083`
- coverage hash: `8bd4693a6b22b74873f374eec893532c5cdceee0750e4d88f76207d9ba7a82ad`
- face coverage hash: `efc006d024ec5f9638c8411da561921854d88b08a48eb9cd8122cb13f43505bb`
- text coverage hash: `e369c5ba6c05faa17cc8e12ff4e362bffadcfa1b51cffcbe367bf6544a7e50d3`
- manifest leak scan over serialized manifest: no Chinese characters, no URL, no Windows absolute path, no key/token/auth marker

## Evidence Chain

`source fingerprint` -> `face coverage` -> `identity packs` -> `text coverage` -> `audio-free motion reference` -> `en-US dialogue/name map` -> `reference bundle hash` -> `provider projection gate`

Fresh local evidence:

- face coverage: 2 recognizable faces, 2 mapped faces, 0 unresolved faces
- identities: 2 unique target identity assets; no shared identity across source characters
- identity policy: both target characters use `fictional_ai_generated`, `US`, `verified_18_plus`, and 3 required views
- target names: `Ethan` and `Maya`
- text coverage: 2 recognizable text regions, 2 mapped regions, 0 unresolved regions
- text kinds: `text_subtitle` and `text_screen`, covering 0-2500 ms and 2500-5000 ms
- localized dialogue/name map: en-US names and English lines are bound to `character-001` and `character-002`
- motion reference: manifest SHA exists, file SHA matches manifest, H.264, 864x496, 5000 ms, 0 audio streams
- contact sheet: actual JPEG, 960x360, file SHA matches manifest
- provider projection gate: `test/redrawGeneration.test.js` proves the reference-bundle path persists `generate_audio=true`, target locale `en-US`, names `Ethan`/`Maya`, English prompt text, `source_conditioning.mode=redraw_reference_bundle`, `audio_mode=strip`, and no raw source conditioning call

## Commands And Results

`node scripts/run-redraw-reference-bundle-local-case.js --fixture --output-dir <case-output>`

- exit code: 0
- stdout marker: `REDRAW_REFERENCE_BUNDLE_LOCAL_OK`
- stderr note: migration output included the existing local skip message for `48_video_resolution_pricing.sql` when `generation_cost_records` is absent in the fixture database

`node --test --test-concurrency=1 test/redrawMigration.test.js test/redrawCharacterIdentity.test.js test/redrawRoutes.test.js test/redrawMotionReference.test.js test/redrawReferenceBundle.test.js test/redrawReferenceBundleLocalCase.test.js test/redrawGeneration.test.js test/redrawReviewGate.test.js test/redrawAssets.test.js test/redrawTextCleanPlateLocalCase.test.js`

- exit code: 0
- tests: 351
- pass: 350
- fail: 0
- cancelled: 0
- skipped: 1
- todo: 0
- duration: 58606.3074 ms
- measured wall time: 58696 ms

Independent media and manifest verification:

- `ffprobe` exit code: 0
- `ffprobe` video stream: H.264, 864x496
- `ffprobe` duration: 5.000000 seconds
- `ffprobe` audio streams: 0
- image metadata: JPEG, 960x360
- manifest, motion, and contact sheet SHA checks: matched

Source scan:

- exit code: 0
- no `fetch(` match
- no `axios` match
- no `process.env` key/token match
- matches were limited to allowed URL validation, inline SVG namespace strings for local fixture images, and manifest redaction guards for URL/Auth text

Syntax checks:

- `node --check scripts/run-redraw-reference-bundle-local-case.js` -> exit code 0
- `node --check src/services/redrawReferenceBundleService.js` -> exit code 0
- `node --check src/services/redrawMotionReferenceService.js` -> exit code 0
- `node --check src/services/redrawGenerationService.js` -> exit code 0

Repository checks before editing this report:

- `git diff --check` -> exit code 0
- `git status --short` -> only pre-existing untracked local directories

## Boundary Statement

This is local contract evidence only. No supplier key was read. No network generation, paid submit, supplier upload, production database write, SSH access, deployment, release candidate, or activation happened in this evidence run.
