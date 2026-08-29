# Redraw Full Product Live Acceptance Report

Date:
Operator:
Project/work reference:

## Scope

- Entry: local product API only.
- Live gate: `REDRAW_LIVE_ACCEPTANCE=1`.
- Submit budget: one product submission only.
- Generation body: `duration=5`, `resolution=480p`; capability selection resolved by server verified registry.
- No automatic retry, no direct supplier call, no secret capture.

## Submit Control

| Field | Evidence |
| --- | --- |
| 提交预算 | 1 |
| 实际提交次数 |  |
| Natural terminal only | yes/no |
| 自然终态 | completed / failed / needs_attention |
| Unknown result handling | product state shows needs_attention with held reservation: yes/no |
| Expected dialogue |  |
| Expected language |  |

## Candidate Evidence

| Field | Evidence |
| --- | --- |
| 候选哈希 |  |
| Download response | 200 / other |
| File readable | yes/no |
| Media duration | about 5 seconds: yes/no |
| Resolution | 480p: yes/no |
| Audio track | present / absent |
| ffprobe duration |  |
| ffprobe dimensions |  |
| Download SHA matches current candidate SHA | yes/no |

## Acceptance Checks

| Check | Evidence |
| --- | --- |
| 媒体检查 | downloadable, readable, about 5 seconds, 480p, audio track present |
| 语言检查 | target-language dialogue exactly matches approved localized line |
| 身份检查 | character identity consistent; no original person; no original text |
| 口型检查 | evidence available and passed |
| 计费检查 | confirmed / held / refunded / needs_attention |

## Server QA Metrics

| Group | Required evidence |
| --- | --- |
| media | readable, duration_matches, dimensions_match, hash_matches |
| dialogue | has_audio, language, language_matches, exact_target_text, speaker_voice_matches |
| identity | all_bound, stable, person_count_matches, relationships_match |
| residuals | original_person_absent, original_text_absent |
| lip_sync | evidence_available, passed |

## Skipped gates

- Supplier console or supplier-owned status page:
- Hosted CI:
- Production deployment:
- Production database write:
- Manual customer acceptance:

## Redaction Checklist

- No credential values.
- No auth header values.
- No supplier endpoint or supplier dashboard URL.
- No local absolute file path.
- No raw provider request or response body.
