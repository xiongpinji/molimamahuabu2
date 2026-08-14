# Redraw Reference Bundle Local Evidence

Date: 2026-08-15
Branch: codex/redraw-r12-merge-20260809
Evidence commit: 144e53db
Backend cwd: backend-node

## Scope

This report covers the provider-neutral local reference bundle gate only. It used synthetic fixture media and local SQLite migration data. It did not read supplier keys, call Fumin, call ToAPIs, upload user video, access production, write production data, deploy, or activate a release.

This is not Fumin full-character replacement acceptance, not an episode-level 1:1 redraw result, not paid model evidence, and not production deployment evidence.

## Local Artifacts

The local fixture command wrote these fixed output names:

- `redraw-reference-bundle-local-manifest.json`
- `redraw-reference-bundle-motion.mp4`
- `redraw-reference-bundle-contact-sheet.jpg`

Manifest checks:

- outer schema: `redraw-reference-bundle-local-manifest-v1`
- inner bundle schema: `redraw-reference-bundle-v1`
- reference gate: `ready`
- locale and market: `en-US` / `US`
- motion: H.264, 864x496, 5000 ms, audio stream count 0
- contact sheet: JPEG, 960x360
- motion SHA-256: `5755702549c3828533d7e3e3ae8cc662d88918c646dca5d0e96554637fc81d48`
- coverage SHA-256: `8bd4693a6b22b74873f374eec893532c5cdceee0750e4d88f76207d9ba7a82ad`

## Evidence Chain

`source fingerprint` -> `face coverage` -> `identity packs` -> `text coverage` -> `audio-free motion reference` -> `en-US dialogue/name map` -> `reference bundle hash` -> `provider projection gate`

Coverage details:

- two fictional AI-generated US adult target characters are bound to the two face tracks
- target names are `Ethan` and `Maya`
- different source characters do not share the same identity asset
- text coverage includes both `text_subtitle` and `text_screen`
- unresolved face count is 0
- unresolved text region count is 0
- motion reference has no audio streams
- generation projection tests prove the reference-bundle path does not use raw source conditioning

## Commands And Results

`node scripts/run-redraw-reference-bundle-local-case.js --fixture --output-dir <case-output>`

- exit code: 0
- stdout marker: `REDRAW_REFERENCE_BUNDLE_LOCAL_OK`

`node --test --test-concurrency=1 test/redrawMigration.test.js test/redrawCharacterIdentity.test.js test/redrawRoutes.test.js test/redrawMotionReference.test.js test/redrawReferenceBundle.test.js test/redrawReferenceBundleLocalCase.test.js test/redrawGeneration.test.js test/redrawReviewGate.test.js test/redrawAssets.test.js test/redrawTextCleanPlateLocalCase.test.js`

- exit code: 0
- tests: 344
- pass: 343
- fail: 0
- skipped: 1
- duration: 47024.6885 ms

`node --test --test-concurrency=1 test/redrawReferenceBundleLocalCase.test.js test/redrawReferenceBundle.test.js test/redrawMotionReference.test.js`

- exit code: 0
- tests: 56
- pass: 56
- fail: 0
- skipped: 0

`npm run verify:redraw-reference-bundle-local`

- exit code: 0
- stdout marker: `REDRAW_REFERENCE_BUNDLE_LOCAL_OK`

`node --check scripts/run-redraw-reference-bundle-local-case.js`

- exit code: 0

`node --check src/services/redrawReferenceBundleService.js`

- exit code: 0

`node --check src/services/redrawMotionReferenceService.js`

- exit code: 0

`node --check src/services/redrawGenerationService.js`

- exit code: 0

`git diff --check`

- exit code: 0

`REFERENCE_BUNDLE_MANIFEST_OK`

- exit code: 0

Source scan:

- command scanned `scripts/run-redraw-reference-bundle-local-case.js`, `src/services/redrawReferenceBundleService.js`, and `src/services/redrawMotionReferenceService.js`
- no `fetch`, `axios`, supplier key or token environment reads were found
- matches were limited to static URL whitelist checks, SVG namespace strings, and manifest redaction guards

## Boundary Statement

`reference_gate=ready` means the local provider-neutral contract can feed a later integration step. It does not prove that Fumin generated a correct result, that a complete episode was redrawn, or that production is ready.
