# Protocol interoperability evidence record

Use this form for a reproducible manual check of one AWG capability or one CPS payload. Record each value as an observation, including failures. Do not paste a private key, preshared key, WARP token, full `.conf`, raw `I1`–`I5` payload, `vpn://` link, endpoint, or full `AllowedIPs` list. A unit test or client import alone does not prove live interoperability.

## Record template

| Field | Observation |
|---|---|
| Date (UTC) | |
| Recorder / evidence reference | |
| Client and exact version | |
| Platform and OS version | |
| AWG mode (`awg3` / `awg31`) | |
| Capability or CPS protocol | |
| Tested value or sanitized value class | |
| Baseline comparison (same setup, capability disabled) | |
| Network type (mobile, residential, public Wi-Fi, etc.) | |
| WARP port (number only) | |
| Config import (pass/fail/error code) | |
| Handshake (pass/fail/time or timeout) | |
| DNS (pass/fail and test method) | |
| Traffic (pass/fail, broad payload types) | |
| Idle and reconnect (duration/result) | |
| Rekey (duration/result) | |
| Result and repeat count | |
| Known limitations / confounders | |

Use a fresh baseline and the same network/client for the compared run. For a failure, record the error code and stage, not the raw configuration or secrets. An imported profile only shows parser acceptance. A successful handshake alone does not show working DNS, traffic, reconnect, or rekey.

## Evidence promotion

| Change | Minimum new evidence |
|---|---|
| `unknown` → `source-confirmed` | Pinned upstream implementation semantics and the applicable public parser contract. |
| `source-confirmed` → `verified` | Reproducible first-party live interoperability for the intended peer/use, with the record above and relevant failure/edge checks. |
| `experimental` → `verified` | Implementation correctness plus reproducible live interoperability. |
| `peer-dependent-disabled` → another status | Proof that the remote peer requirement changed or that the actual remote peer has the required capability; a single successful user report is insufficient. |

Community reports can trigger research or testing. They do not alone establish a stable WARP protocol contract or remove a hard peer-dependency policy. Re-evaluate status when new evidence arrives, not merely because time has passed. Keep the source revision and check date on every upstream-backed record.
