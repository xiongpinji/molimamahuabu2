# Redraw source conditioning and voice binding plan

## Goal

Close the two product-chain gaps that currently prevent an evidence-grade claim that a Chinese short-drama shot can be recreated with foreign characters and English dialogue while preserving the source shot motion:

1. the exact source shot segment must reach a provider as a video-conditioning input, not merely remain local preview metadata;
2. a redraw character must be bindable to a provider-verified production voice through the public redraw API and UI.

This phase is local implementation and verification only. It does not authorize a production release, service restart, production database write, or another paid provider request.

## Confirmed baseline facts

- `redraw_shots.start_ms/end_ms` and `source_video_ref` already describe the source timeline, but `redrawGenerationService` currently persists only `reference_image_urls`.
- ID9 uses the `icreat_task` request body. Its provider payload contains text, image, and optional audio parts; it has no source-video field in the deployed adapter.
- ID14 uses `feituo_open`. Its verified model `sdas-my-seedance-2.0-fast-upscaled-1080p` supports both image and video references, and `reference_video_urls` maps to provider `videoUrls`.
- The provider must receive an exact shot segment. Passing the complete uploaded episode would ignore the shot boundary and disclose unrelated scenes.
- `/static/redraw-sources/*` requires user ownership in public-platform mode, so an unauthenticated provider cannot use the browser preview URL.
- `redrawVoiceService` already validates production voice evidence and writes a character voice snapshot, but redraw-specific list/bind routes and the frontend binding action are missing.
- The deployed configuration inventory contains text, image, TTS, and video services only. It has no STT/ASR/transcription service or audited local speech-language/accent model, so the current stack cannot honestly verify that a generated voice artifact is specifically `en-US`.

## Decisions

### Source video conditioning

- Add `video_generations.reference_video_urls` and `video_generations.source_conditioning_json`.
- Build or reuse an immutable H.264/AAC MP4 segment from the owned work source asset and the shot's exact `start_ms/end_ms` before credit reservation.
- Verify the segment with ffprobe and bind its SHA-256, duration, source fingerprint, source asset id, shot id, and timeline boundaries into the billing snapshot and stored audit metadata.
- Publish only the immutable segment through a short-lived HMAC-signed, read-only provider route. The token is scoped to a contained `redraw-conditioning/` path and expiry. HTTP, localhost, path traversal, invalid signatures, and expired tokens fail closed.
- Require a dedicated `REDRAW_PROVIDER_ASSET_HMAC_SECRET` of at least 32 characters. It must not fall back to or equal the platform JWT/admin secrets; production preflight blocks a missing or reused key.
- Refresh the signed URL immediately before the single provider submission and give it the existing 30-minute generation window. Never resubmit automatically when the submit result is ambiguous. A provider that fetches input after that window remains a supplier-contract risk and must be verified before production acceptance.
- Bound each Feituo submit/poll HTTP operation to 30 seconds and stream at most 1 MiB of response data. Timeout, interrupted/oversized/ambiguous responses, and submit-side 5xx become `needs_attention` with the reservation held; a known provider task is preserved and never resubmitted automatically.
- Permit source-video conditioning only when the exact verified model resolves to a provider protocol with declared video-reference capacity. The first supported path is Feituo ID14. ID9 must return `REDRAW_VIDEO_CONDITIONING_UNSUPPORTED` before reservation or provider submission; there is no silent image-only downgrade.
- Bind capability evidence to the exact active configuration id and configuration `updated_at`, and require the evidence provider/model to match that row. Persist the pin with the generation and revalidate it immediately before the network call and during recovery. A key, endpoint, protocol, model, or configuration-version change becomes `needs_attention`; it is never silently switched to another same-model configuration.
- A newly verified capability writer must atomically use one timestamp for both `settings.redraw_locale_capabilities[].evidence.video.config_updated_at` and the configuration row's `updated_at`. Existing unbound evidence is intentionally invalid and cannot enable a paid submission.
- Keep the existing approved foreign-character, clean-plate, and prop image references alongside the source video reference.

### Redraw voice binding

- Add redraw-specific handlers for listing production voices for an owned version and assigning one to an owned character asset.
- List and bind only `redraw_assets` from the same tenant, user, and version. Legacy `characters.seedance2_voice_asset` is not a redraw voice source.
- The client sends only `voice_asset_id` and optional `expected_updated_at`. Provider identity, model, evidence, audio asset/path, locale, and market are derived and revalidated server-side.
- Voice-clone consent must reference a readable, same-owner authorization asset with the dedicated `voice_authorization` category. An arbitrary owned image, audio file, or source episode is not consent; deletion or revocation invalidates list, bind, quote, and start.
- Revalidate clone consent immediately before provider submission. A revoked authorization after quote/reservation never reaches the provider, and orphan recovery treats any worker that may have submitted as `needs_attention` with credits held even when no provider task id was returned.
- Preserve the exact TTS configuration id and configuration version from capability evidence through generation, binding, dialogue quote, and provider submission. A different first-listed configuration for the same model is never an acceptable substitute.
- A single-asset quote returns a server-derived `quote_hash`; generation accepts that hash only as a compare-and-swap token. A price, capability, or exact-config change between quote and generation returns a conflict before reservation or provider work. The client still cannot submit model or credit values.
- A voice without complete provider invocation evidence, readable audio, matching locale/market, valid consent, and independently verified output language is `needs_attention` with its reservation held. It must not be marked generated/charged or automatically retried.
- Dialogue artifacts and shot-segment audit records preserve the server-derived voice snapshot and exact TTS provider/configuration id/version. Missing provider task evidence or any provider-completed local validation/storage failure is `needs_attention` with credits held and cannot be replayed automatically.
- Serve previews through an authenticated owner/version route, rather than exposing a raw `/static/redraw-assets/` URL that public-platform ownership middleware cannot authorize. The browser fetches the audio as an authenticated blob and plays a revocable object URL; credentials are never placed in the URL query.
- A repeated identical binding is idempotent. A stale timestamp or different existing binding returns a conflict and never overwrites implicitly.
- The voice tab shows a target-character selector, verified voice selector, bind action, and persisted bound state. A successful bind refreshes assets.

### Output-language verification blocker

- MiniMax's synchronous TTS response can provide a real trace id, completion result, actual voice id, and duration. It does not provide trustworthy `en-US` output-language detection, so the request locale must never be copied into evidence as if it were detected.
- MiniMax and OpenAI-compatible TTS calls use a bounded whole-request deadline and bounded response body (32 MiB default, hard-capped at 128 MiB). Network errors, response interruption/overflow, timeout, 5xx, malformed synchronous success, invalid or missing 2xx audio, and provider-completed local persistence failures are provider-status-unknown outcomes: hold credits, preserve only a real trace/request id, and never retry automatically. Deterministic 4xx or an explicit non-zero MiniMax business status remains a normal failure.
- Completing the approved `en-US` contract requires an audited output detector: multilingual ASR/language identification, an independently calibrated US-English accent classifier, transcript-to-request similarity, and audio/model hashes. Only the conjunction may produce `detected_locale=en-US` and `language_verified=true`; short, silent, low-confidence, missing-model, or non-US results fail closed.
- No approved detector weights, license, calibration set, or production deployment currently exists. Adding that model stack is a separate design/deployment decision, not something this implementation may fake or infer.

## Acceptance criteria

1. Migration is idempotent and preserves old video rows.
2. A Feituo generation row contains both the approved image references and exactly one signed source-segment video reference.
3. The Feituo HTTP body contains both `imageUrls` and `videoUrls`; the iCreat path rejects source conditioning before billing and network work.
4. The selected video capability is bound to the exact configuration id/version/provider/model. Mismatched or subsequently changed evidence/configuration fails before provider work and keeps any ambiguous reservation held.
5. Changing shot boundaries changes the segment identity and billing operation key, and each segment audit record includes the server-selected shot id.
6. Segment generation/publishing rejects unreadable sources, out-of-range boundaries, non-HTTPS public base URLs, traversal, expired/bad signatures, and escaped files without provider work or held credits.
7. A verified voice can be listed, securely previewed, and bound to a same-version redraw character; refresh preserves the binding.
8. Cross-owner, cross-version, wrong-kind, unreadable, unverified, locale/market-mismatched, clone-unauthorized, revoked-authorization, stale, and conflicting bindings fail closed.
9. Single generation rejects a stale quote hash before reservation/provider submission, and provider-ambiguous or provider-completed local failures remain held and non-replayable across restart.
10. Dialogue quote/start no longer reports `speaker_voice_missing` or `voice_not_verified` only after every speaker character has a valid, still-authorized, readable, exact-config-pinned binding; its completed asset and segment audit retain that exact pin, and legacy-only voice data remains insufficient.
11. Target backend/frontend tests and frontend production build pass. No result is labeled real 1:1 acceptance until a newly authorized paid ID14 source-conditioned run returns a readable video and passes visual/timeline review, and English dialogue has independently verified output-language evidence.

## Paid acceptance boundary

- The first authorized canary submitted text and one image, then stopped on the provider-native image-size mismatch. It must never be resumed or replayed from its existing state.
- Canary v2 fixes that local mismatch and has passed 37/37 tests plus two independent reviews, but rerunning its fixed ID9 plan would still not prove source-video conditioning.
- The next meaningful paid test must use ID14 with a real source segment and foreign-character image in one request. Production price is currently 1064 credits per request; any additional supporting-model calls and the final total require a new explicit approval immediately before execution.
- Before that request, a guarded production candidate must deploy the migrations/routes/services, provision a dedicated provider-asset HMAC secret, and write new configuration-bound ID14 evidence from a real successful generation. None of those actions is authorized by this local phase.

## Non-goals

- No automatic production deployment or current symlink switch.
- No automatic paid retry or failover.
- No cross-version voice library, voice replacement/unbind workflow, or legacy character migration in this phase.
- No claim of pixel-identical output; acceptance compares shot timing, camera/action continuity, character replacement, dialogue timing/language, readable artifacts, billing, and failure writeback.
