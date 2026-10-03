# Current AWG/WARP Protocol Evidence

This document is generated from the JavaScript evidence registries. Historical release notes describe their release snapshot; this page records current policy. Last checked: 2026-10-03.

## Evidence status

- **verified:** upstream semantics and parser support plus reproducible project interoperability evidence for the intended use; a unit test alone is insufficient.
- **source-confirmed:** primary upstream semantics and public parser contract are established; broad live WARP interoperability is not claimed.
- **experimental:** implementation exists, but interoperability evidence is insufficient.
- **peer-dependent-disabled:** compatible remote behaviour, matching configuration or shared state is required; WARP output blocks or fixes it.
- **unknown:** safe semantics are not established and defaults cannot enable it.

A community report can trigger research but cannot alone establish a peer-dependent protocol contract. Status describes evidence; the effective state of one generated config is separate.

## Source revisions

| ID | Kind | Revision or path | Checked | Link |
|---|---|---|---|---|
| amneziawg-go | primary-upstream | b5928efb6ca19f0153958460c3d141f04abc5c2e | 2026-10-03 | https://github.com/amnezia-vpn/amneziawg-go/tree/b5928efb6ca19f0153958460c3d141f04abc5c2e |
| amneziawg-tools | primary-upstream | ee0f0a9aa34ff0a0da4b3433b9512781cfe02843 | 2026-10-03 | https://github.com/amnezia-vpn/amneziawg-tools/tree/ee0f0a9aa34ff0a0da4b3433b9512781cfe02843 |
| amnezia-client | primary-upstream | 94b51df24790bf52427afe82d81c87a95460bdfd | 2026-10-03 | https://github.com/amnezia-vpn/amnezia-client/tree/94b51df24790bf52427afe82d81c87a95460bdfd |
| project-runtime | project-source | src/server/awg | 2026-10-03 | https://github.com/HereIamGosu/amnezia-config-gen/tree/main/src/server/awg |
| issue-4 | community-report | issues/4 | 2026-10-03 | https://github.com/HereIamGosu/amnezia-config-gen/issues/4 |

## AWG capability matrix

| Field | Modes | Evidence | Locality | Parser syntax | WARP policy | Sources |
|---|---|---|---|---|---|---|
| Jc | awg3, awg31 | source-confirmed | client-side | integer | default generated | amneziawg-go, amneziawg-tools |
| Jmin | awg3, awg31 | source-confirmed | client-side | integer | default generated | amneziawg-go, amneziawg-tools |
| Jmax | awg3, awg31 | source-confirmed | client-side | integer | default generated | amneziawg-go, amneziawg-tools |
| I1 | awg3, awg31 | source-confirmed | client-side | signature-string | default CPS-selected | amneziawg-go, amneziawg-tools |
| I2 | awg3, awg31 | source-confirmed | client-side | signature-string | opt-in | amneziawg-go, amneziawg-tools |
| I3 | awg3, awg31 | source-confirmed | client-side | signature-string | opt-in | amneziawg-go, amneziawg-tools |
| I4 | awg3, awg31 | source-confirmed | client-side | signature-string | opt-in | amneziawg-go, amneziawg-tools |
| I5 | awg3, awg31 | source-confirmed | client-side | signature-string | opt-in | amneziawg-go, amneziawg-tools |
| ContentPaddingAddition | awg3, awg31 | source-confirmed | client-side | integer-or-range | default 10-100 | amneziawg-go, amneziawg-tools |
| RekeyAfterTime | awg3, awg31 | source-confirmed | client-side | integer-or-range | default 100-120 | amneziawg-go, amneziawg-tools |
| RekeyTimeout | awg3, awg31 | source-confirmed | client-side | integer-or-range | default 3-7 | amneziawg-go, amneziawg-tools |
| RejectAfterTime | awg3, awg31 | source-confirmed | client-side | integer-or-range | default 150-180 | amneziawg-go, amneziawg-tools |
| KeepaliveTimeout | awg3, awg31 | source-confirmed | client-side | integer-or-range | default 5-15 | amneziawg-go, amneziawg-tools |
| MaxHandshakeAttempts | awg3, awg31 | source-confirmed | client-side | integer-or-range | default 15-20 | amneziawg-go, amneziawg-tools |
| PersistentKeepalive | awg3, awg31 | source-confirmed | client-side | integer-or-range | default 25-35 | amneziawg-go, amneziawg-tools |
| DisableCookies | awg31 | source-confirmed | client-side | on-or-off | default on | amneziawg-go, amneziawg-tools |
| RandomTrailers | awg31 | peer-dependent-disabled | both-peers | on-or-off | blocked | amneziawg-go, amneziawg-tools, issue-4 |
| HeaderProtectionKey | awg3, awg31 | peer-dependent-disabled | both-peers | base64-key | blocked | amneziawg-go, amneziawg-tools |
| S1 | awg3, awg31 | peer-dependent-disabled | both-peers | integer | fixed 0 | amneziawg-go, amneziawg-tools |
| S2 | awg3, awg31 | peer-dependent-disabled | both-peers | integer | fixed 0 | amneziawg-go, amneziawg-tools |
| S3 | awg3, awg31 | peer-dependent-disabled | both-peers | integer | fixed 0 | amneziawg-go, amneziawg-tools |
| S4 | awg3, awg31 | peer-dependent-disabled | both-peers | integer | fixed 0 | amneziawg-go, amneziawg-tools |
| H1 | awg3, awg31 | peer-dependent-disabled | both-peers | integer-or-range | fixed 1 | amneziawg-go, amneziawg-tools |
| H2 | awg3, awg31 | peer-dependent-disabled | both-peers | integer-or-range | fixed 2 | amneziawg-go, amneziawg-tools |
| H3 | awg3, awg31 | peer-dependent-disabled | both-peers | integer-or-range | fixed 3 | amneziawg-go, amneziawg-tools |
| H4 | awg3, awg31 | peer-dependent-disabled | both-peers | integer-or-range | fixed 4 | amneziawg-go, amneziawg-tools |

## CPS evidence

| Protocol | Runtime status | Evidence status | Auto |
|---|---|---|---|
| Static | stable | verified | yes |
| SIP | stable | verified | yes |
| STUN | stable | verified | yes |
| QUIC | experimental | experimental | no |
| DNS | experimental | experimental | no |
| DTLS | experimental | experimental | no |
| TLS | unsupported | unsupported | no |

Auto resolves only to stable, verified protocols. Unknown CPS is an API validation error. Specific CPS payload evidence is separate from the source-confirmed I1–I5 mechanism.

## Current WARP invariants

- AWG 3.0 and 3.1 default to `ContentPaddingAddition = 10-100`; `off`, `0`, and `0-0` disable it. It is local encrypted transport padding and may increase packet size.
- AWG 3.1 defaults to `DisableCookies = on`; `off` remains available. This suppresses the local under-load Cookie Reply branch, leaves incoming Cookie Reply processing available, and reduces local anti-DoS protection. It is an anti-fingerprinting trade-off, not a security improvement.
- `RandomTrailers=on` and `HeaderProtectionKey` are blocked for WARP. `S1..S4` are fixed to zero; `H1..H4` are fixed to 1, 2, 3, 4. The Cloudflare peer is stock WireGuard.
- Public `.conf` range inputs are constrained to 0..65535 even though the engine's internal numeric representation may be wider. The tools parser uses `u16_range_from_string`; this project's strict range avoids parser truncation.

## Conflicting and unverified evidence

- Issue #4 reports RandomTrailers working with WARP while failing with another peer. This is community evidence, not a documented Cloudflare receive contract. The WARP block remains.
- AWG 3.x source-confirmed capabilities are not claimed to work on every client, ISP or network. Live interoperability records should use `docs/manual-checks/protocol-evidence.md` and contain no keys, token, config or vpn link.
