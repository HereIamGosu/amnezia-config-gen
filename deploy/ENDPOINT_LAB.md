# endpoint-lab — WARP endpoint verification (Endpoint Lab, Phase A)

`deploy/endpoint-lab/endpoint_lab.py`, installed as `/usr/local/sbin/endpoint-lab` by
`deploy/endpoint-lab/install.sh`. Python 3 standard library; kernel WireGuard + `wireguard-tools`.

Endpoint Lab is a **separate privileged host subsystem**. It proves that a WARP `IP:UDP-port` works
with stock WireGuard and publishes a small, fresh, secret-free pool. The public web container
(`amnezia-web-*`) is not involved: it stays non-root, read-only, `cap_drop ALL`, without host
networking or Docker socket. Later phases mount only the public snapshot into it, read-only.

**Phase A status:** manual CLI only. No timers, no discovery, no generator integration, no change to
`api/warp.js`, the deploy controller, nginx or `/api/status`.

```text
operator candidates.json ──> endpoint-lab ──> real WG handshake ──> HTTPS through the tunnel
                                  │                                        │
                                  └── SQLite lab.db (root) <── observation ┘
                                                 │
                                                 └── public/active-pool.json (atomic, 0644)
```

## ACTIVE means

1. a real WireGuard handshake with the Lab's own WARP identity (`wg show latest-handshakes` > 0 on a
   fresh interface), **and**
2. `curl https://1.1.1.1/cdn-cgi/trace` inside the probe namespace returns HTTP 200 with TLS
   verification on (`ssl_verify_result=0`, never `-k`), **and**
3. WireGuard RX/TX counters grew during the probe, **and**
4. the observation is fresh: `expires_at = last successful deep verify + 7 min`.

TCP connects, ICMP, interface-up or a handshake alone never make an endpoint ACTIVE. The trace field
`warp=on` and the DNS check (`--doh-url https://1.1.1.1/dns-query`) are recorded as extra evidence,
not as gates.

## Probe topology (one throw-away namespace per probe)

```text
host netns   ens3 · default route · production · SSH · Docker · awg0      (never modified)
   │  `ip link add aelXXXXXX type wireguard` here → its encrypted UDP socket lives here
   │  `ip link set aelXXXXXX netns ael-XXXXXX` moves only the cleartext side
   ▼
ael-XXXXXX   lo · aelXXXXXX (WARP client IPv4/32, MTU 1280) · `default dev aelXXXXXX`
```

The probe namespace has no veth, no NAT and no other route, and the Lab checks that before sending
anything (`links == {lo, aelXXXXXX}`, exactly one default route via the tunnel). So a successful
HTTPS request can only have crossed the WireGuard tunnel. Teardown is `ip netns delete` (destroys the
moved interface) plus `ip link delete` for the not-yet-moved case, in `finally`, also on SIGTERM.
Names come from `secrets.token_hex(3)`: `ael-[0-9a-f]{6}` / `ael[0-9a-f]{6}`. `endpoint-lab cleanup`
and the startup sweep touch only these exact patterns. The startup sweep removes namespaces older than
10 min and every not-yet-moved `ael……` link (such links exist only during setup). Both run under the
global lock, so no probe can be in progress at that moment.

## Paths and permissions

| Path | Mode | Content |
| --- | --- | --- |
| `/usr/local/sbin/endpoint-lab` | 0755 | the CLI |
| `/etc/wireguard/amnezia-endpoint-lab/wg.key` | 0600 | WireGuard private key only |
| `/etc/amnezia-endpoint-lab/identity.json` | 0600 | public key, peer key, WARP addresses, registration id/token |
| `/etc/amnezia-endpoint-lab/candidates.json` | 0600 | operator-controlled candidate list |
| `/var/lib/amnezia-endpoint-lab/lab.db` | 0600 | SQLite (WAL), no secrets |
| `/var/lib/amnezia-endpoint-lab/public/active-pool.json` | 0644 | snapshot for the future read-only mount |

The key lives under `/etc/wireguard` because Ubuntu's AppArmor profile for `/usr/bin/wg` lets it read
key files only below `/etc/wireguard/**`. The AppArmor policy is not changed. `wg` reads the key
itself (`wg set … private-key <path>`), so the key is never in argv, the environment, the database,
logs or the snapshot. Anything key-shaped in error text is redacted before it is printed or stored.

## Commands

```text
endpoint-lab register-probe-identity     # one-time; refuses to register twice
endpoint-lab import-candidates FILE      # individual IPs × official ports, from the operator file
endpoint-lab probe ID                    # handshake only (never creates ACTIVE)
endpoint-lab verify ID                   # handshake + tunnel + HTTPS
endpoint-lab verify-all                  # every known, non-blacklisted endpoint, sequentially
endpoint-lab list | status | snapshot | cleanup
```

`ID` is `IP:port` of an endpoint that is already in the database. There is no CIDR, range or
port-range argument. Candidates must be IPv4, use one of the official ports 2408/500/1701/4500, and
sit in the WARP research prefixes coded in `ALLOWED_PREFIXES` (plus RFC 5737 TEST-NET-1 for negative
controls). At most 64 endpoints per file. IPv6 is unsupported on this node (`disable_ipv6=1`).

## Probe identity

One dedicated consumer-WARP registration, created by `register-probe-identity`:
`wg genkey` → `wg pubkey` (via stdin) → `POST reg` (single attempt: a lost reply must never become a second registration) →
validated response persisted atomically with `warp_enabled=false` → `PATCH warp_enabled` →
persisted `true`. If the PATCH fails, the next run only retries the PATCH. Probes refuse an identity
that is missing, malformed, half-enabled or whose key file is group/other-readable
(`PROBE_IDENTITY_INVALID`, a Lab failure that never penalises endpoints).

Rotation (designed, not automated):

1. register the replacement into a staging directory (same code, different paths);
2. `verify` a known-good endpoint with it;
3. atomically replace `identity.json` + `wg.key`;
4. after a few healthy runs, `DELETE reg/{old id}` with the old token, then shred the old files.

Never delete the working identity for experiments. Lifecycle questions (expiry, behaviour after
`DELETE`) are researched on a disposable identity.

## States

`DISCOVERED → (probe) HANDSHAKE_OK → (verify) ACTIVE`. `manual_blacklist` outranks every automatic
state: `probe`, `verify` and `verify-all` refuse blacklisted endpoints, and the pure transition maps a
blacklisted success to `VERIFIED` (never `ACTIVE`). Phase A has no blacklist command: the column is set
by hand in SQLite until Phase B adds one. Endpoint failures: `ACTIVE → SUSPECT`, which
leaves the pool at once. A good verify brings it back to `ACTIVE`. Three consecutive failures →
`QUARANTINE`: `verify-all` skips it for 30 min, after which it is probed again and a good verify
returns it to `ACTIVE`. Ten more consecutive failures (13 in total) → `DEAD`, kept, not deleted, and
skipped by `verify-all`. A DEAD endpoint that shows up again in an imported candidates file after the
30-minute cooldown restarts as `DISCOVERED`. An explicit `verify ID` is an operator action and is not
held back by the quarantine or DEAD rules (blacklisted endpoints are still refused). A handshake-only
`probe` advances only `DISCOVERED`. `SUSPECT`, `QUARANTINE` and `DEAD` keep their state and failure
count until a deep verify succeeds (or, for DEAD, the endpoint is re-imported). Generator eligibility:
`state = ACTIVE ∧ ¬blacklist ∧ expires_at > now ∧ traffic fresh`.

**Lab failure ≠ endpoint failure.** `LOCAL_RESOURCE_ERROR`, `TUNNEL_SETUP_FAILED`,
`ROUTE_SETUP_FAILED`, `PROBE_IDENTITY_INVALID`, `RATE_LIMITED`, `CANCELLED` and `UNKNOWN` leave
endpoints untouched. If every endpoint of a batch of ≥3 is silent at once (`HANDSHAKE_NO_RESPONSE`),
the batch is recorded as `suspect_global` without transitions. Endpoint failures are
`HANDSHAKE_NO_RESPONSE`, `HTTPS_TIMEOUT`, `HTTPS_TLS_FAILED`, `TRAFFIC_FAILED`, `TIMEOUT`.
`HANDSHAKE_INVALID_OR_UNEXPECTED` is reserved for a raw-handshake engine: the kernel silently drops
invalid replies.

Metrics: `probe_completion_ms` is "trigger → the Lab saw a handshake" (the kernel timestamp has
1-second resolution), **not** a protocol RTT. `traffic_total_ms` is curl's `time_total` over the tunnel
(TLS + HTTP included). Both are RTT from the VPS, not from users.

## Level of evidence

The Lab records observations about exact endpoints and never extrapolates them to a range.

- Cloudflare's documentation separates consumer WARP (`162.159.192.0/24`) from Cloudflare One WireGuard
  ingress (`162.159.193.0/24`). That boundary comes from the documentation, not from the Lab.
- Phase A (2026-10-04): the single endpoint `162.159.193.1:2408` did not answer the consumer probe
  identity. This is one observation of one endpoint. It says nothing about the rest of that /24.
- Phase A: specific addresses outside the documented consumer range (`162.159.195.1`, `188.114.97.1`)
  passed full verification. "Not documented as consumer" does not mean "does not work", and "documented"
  does not mean "works". Both questions are decided per endpoint by observation.
- The Phase A candidate set was hand-picked (24/24 passed), so it does not estimate the real yield of
  any range.

## Snapshot contract

```json
{ "schema_version": 1, "generated_at": "…Z", "expires_at": "…Z", "lab_status": "ok|empty|degraded",
  "endpoints": [ { "ip": "162.159.192.1", "port": 2408, "family": 4, "state": "active",
                   "lab_verified_at": "…Z", "expires_at": "…Z", "source_class": "engage_dns",
                   "probe_completion_ms": 70, "traffic_total_ms": 55 } ] }
```

The file is written as temp file → fsync → `os.replace` → directory fsync. A consumer must
fail closed (see `validate_snapshot`): unknown schema, future `generated_at`, unexpected top-level or
endpoint fields, an unknown `lab_status` or an invalid endpoint → reject the file. Past top-level `expires_at` → empty pool. If the Lab stops, the
pool drains within 7 minutes. Stale state is never served.

## Failure matrix

| Event | Endpoint states | Lab state | Future generator | Alert (Phase B) | Recovery |
| --- | --- | --- | --- | --- | --- |
| WARP registration API down | unchanged | identity creation fails (POST once, PATCH at most twice) | n/a | — | operator reruns |
| Probe identity invalid/revoked | unchanged (Lab failure) | `lab_failure` | pool drains in 7 min → 503 in Lab mode | critical if pool empty | rotate identity |
| One endpoint silent | ACTIVE→SUSPECT | ok | endpoint leaves pool | none | next verify |
| All endpoints silent at once | unchanged (`suspect_global`) | suspect_global | pool drains | warning → critical | fix host/uplink |
| Handshake ok, traffic fails | failure counted | ok | endpoint leaves pool | none | next verify |
| HTTPS target down for all | counted as traffic failures (batch ≥3 silent guard does not apply) | needs a control target (Phase B) | pool drains | warning | — |
| DNS fails | none (not a gate) | `dns_ok=false` evidence | none | none | — |
| `wg` missing / module unavailable | unchanged | `lab_failure` (LOCAL_RESOURCE_ERROR) | pool drains | critical | reinstall / modprobe |
| netns creation fails | unchanged | `lab_failure` | pool drains | critical | inspect host |
| Cleanup fails | unchanged | stale `ael-*` objects | none | warning | `endpoint-lab cleanup` |
| SQLite locked | run aborts (10 s busy timeout) | error exit | snapshot ages out | warning on stale snapshot | next run |
| SQLite corrupt / newer schema | run refuses | error exit | snapshot ages out | warning | restore or recreate DB (rebuildable) |
| Disk full | snapshot write fails, old file kept | error exit | old snapshot ages out | warning | free disk |
| Process killed mid-probe | nothing recorded | stale `ael-*` namespace | none | none | startup sweep / `cleanup` |
| VPS loses Internet | silent batch → `suspect_global` | suspect_global | pool drains | critical | — |
| `awg0` fine, Lab broken | — | independent: the Lab never reads or changes `awg0` | — | — | — |

## Backup and reboot

- Probe identity is the only valuable secret. It can be re-registered, so an off-host copy is
  optional. If it is kept, store it encrypted and never automatically.
- `lab.db` holds history, not truth: a lost DB is rebuilt by re-importing candidates and verifying.
- `active-pool.json`, namespaces and interfaces are transient. Do not back them up.
- Reboot: `wireguard-tools` persists, and the `wireguard` module is loaded on demand (`modprobe` in
  every preflight, no `/etc/modules` entry). Credentials and state live on persistent paths, stale
  `ael-*` objects cannot survive a reboot, and timers do not exist yet.

## Install and rollback

Install (root, from an extracted archive): `apt-get install --no-install-recommends wireguard-tools`,
`sh deploy/endpoint-lab/install.sh`, copy a candidates file to `/etc/amnezia-endpoint-lab/`,
`endpoint-lab register-probe-identity`, `endpoint-lab import-candidates …`.

Rollback (never touches amneziawg/`awg0`): `endpoint-lab cleanup`; remove `/usr/local/sbin/endpoint-lab`,
`/var/lib/amnezia-endpoint-lab`, `/etc/amnezia-endpoint-lab`, `/etc/wireguard/amnezia-endpoint-lab`;
`modprobe -r wireguard` only when `ip -o link show type wireguard` is empty; optionally
`apt-get remove wireguard-tools`.

`systemd/` holds Phase B unit/timer templates. They are not installed, and their hardening must be
proven on the host first.
