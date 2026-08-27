# Redraw Full Product Live Acceptance Report

Date:
Operator:
Project/work reference:

## Scope

- Entry: local product API only.
- Live gate: `REDRAW_LIVE_ACCEPTANCE=1`.
- Submit budget: one product submission only.
- No automatic retry, no direct supplier call, no secret capture.

## Submit Control

| Field | Evidence |
| --- | --- |
| 提交预算 | 1 |
| 实际提交次数 |  |
| Natural terminal only | yes/no |
| 自然终态 | completed / failed / needs_attention |
| Unknown result handling | product state shows needs_attention with held reservation: yes/no |

## Candidate Evidence

| Field | Evidence |
| --- | --- |
| 候选哈希 |  |
| Download response | 200 / other |
| File readable | yes/no |
| Media duration | about 5 seconds: yes/no |
| Resolution | 480p: yes/no |
| Audio track | present / absent |

## Acceptance Checks

| Check | Evidence |
| --- | --- |
| 媒体检查 | downloadable, readable, about 5 seconds, 480p, audio track present |
| 语言检查 | target-language dialogue exactly matches approved localized line |
| 身份检查 | character identity consistent; no original person; no original text |
| 口型检查 | evidence available and passed |
| 计费检查 | confirmed / held / refunded / needs_attention |

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
