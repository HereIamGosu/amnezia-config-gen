# endpoint-lab — WARP endpoint verification (Endpoint Lab)

`deploy/endpoint-lab/endpoint_lab.py`, installed as `/usr/local/sbin/endpoint-lab` by
`deploy/endpoint-lab/install.sh`. Python 3 standard library; kernel WireGuard + `wireguard-tools`.

Endpoint Lab is a **separate privileged host subsystem**. It proves that a WARP `IP:UDP-port` works
with stock WireGuard and keeps a small, fresh, secret-free pool of such endpoints. The public web
container (`amnezia-web-*`) is not involved: it stays non-root, read-only, `cap_drop ALL`, with no host
networking and no Docker socket. A later phase mounts only the public snapshot into it, read-only.

**Status (Phase B):** autonomous operation from systemd timers (refresh + bounded discovery), circuit
breaker, monitoring. The generator does **not** read the snapshot yet. `api/warp.js`, the deploy
controller, nginx, `/api/status`, Metrika and the UI are unchanged.

```text
candidates (seeds, /24 cursor, operator file) → endpoint-lab refresh/discovery → WG handshake → HTTPS via tunnel
                                                        │                                            │
                                                        └──── SQLite lab.db (root) ◄── observations ─┘
                                                                     │
                                                                     └── public/active-pool.json (atomic, 0644)
```

## ACTIVE means

1. a real WireGuard handshake with the Lab's own WARP identity (`wg show latest-handshakes` > 0 on a
   fresh interface), **and**
2. inside the probe namespace, an HTTPS request to one of the verification targets returns HTTP 200
   with TLS verification on (`ssl_verify_result=0`, never `-k`), **and**
3. WireGuard RX/TX counters grew during that request, **and**
4. the observation is fresh: `expires_at = last successful deep verify + 7 min`.

TCP connects, ICMP, interface-up or a handshake alone never make an endpoint ACTIVE. The trace field
`warp=on` and the colo are recorded as evidence, not as gates.

**Verification targets** (checked through a real tunnel with TLS verification on 2026-10-04, any one is
enough):

| Name | URL | Why |
| --- | --- | --- |
| `cf-1111` | `https://1.1.1.1/cdn-cgi/trace` | DNS-free, IP SAN in the certificate |
| `cf-1001` | `https://1.0.0.1/cdn-cgi/trace` | DNS-free, different anycast address |
| `cf-www` | `https://www.cloudflare.com/cdn-cgi/trace` via DoH `1.0.0.1` | different Cloudflare service |

The first target that answers moves to the front for the rest of the run. Each target is tried at
most once per session (max 4 s).

**Two tunnel sessions per probe.** Host data from the evening of 2026-10-04: about 30% of sessions
completed the handshake (often only after ~1 s) but carried no traffic to any target, while a fresh
session to the same endpoint worked. A deep probe therefore opens a second, fresh session only when the
first one handshook but no target answered. A first session with a slow handshake (≥ 900 ms) whose first
target timed out is abandoned at once. A real endpoint fault fails both sessions. Handshake failures are
never retried within a probe: the refresh timeout (8 s) already covers WireGuard's own 5 s re-initiation.
The number of sessions is stored per observation (`observation.sessions`).

## Probe topology (one throw-away namespace per session)

```text
host netns   ens3 · default route · production · SSH · Docker · awg0      (never modified)
   │  `ip link add aelXXXXXX type wireguard` here → its encrypted UDP socket lives here
   │  `ip link set aelXXXXXX netns ael-XXXXXX` moves only the cleartext side
   ▼
ael-XXXXXX   lo · aelXXXXXX (WARP client IPv4/32, MTU 1280) · `default dev aelXXXXXX`
```

The probe namespace has no veth, no NAT and no other route, and the Lab checks that before sending
anything (`links == {lo, aelXXXXXX}`, exactly one default route via the tunnel). So a successful HTTPS
request can only have crossed the WireGuard tunnel. Teardown is `ip netns delete` (destroys the moved
interface) plus `ip link delete` for the not-yet-moved case, in `finally`, also on SIGTERM. Names come
from `secrets.token_hex(3)`: `ael-[0-9a-f]{6}` / `ael[0-9a-f]{6}`. `endpoint-lab cleanup` and the startup
sweep touch only these exact patterns. The startup sweep removes namespaces older than 10 min and every
not-yet-moved `ael……` link. Both run under the global lock, so no probe is in progress.

Under the systemd units (`ProtectSystem=strict`) the service has a private mount namespace: the netns
bind mount exists only inside the service. While a probe runs, `ip netns list` on the host shows the name
with "Peer netns reference is invalid". When the service ends, the namespace disappears with it.

## Paths and permissions

| Path | Mode | Content |
| --- | --- | --- |
| `/usr/local/sbin/endpoint-lab` | 0755 | the CLI (atomically replaced by install.sh) |
| `/usr/local/share/amnezia-endpoint-lab/REVISION` | 0644 | installed commit + sha256 of the CLI |
| `/etc/wireguard/amnezia-endpoint-lab/wg.key` | 0600 | WireGuard private key only |
| `/etc/amnezia-endpoint-lab/identity.json` | 0600 | registration state, public key, peer key, WARP addresses, registration id/token |
| `/etc/amnezia-endpoint-lab/candidates.json` | 0600 | optional operator candidate list |
| `/etc/amnezia-endpoint-lab/config.json` | 0600 | optional test knobs (see below); absent in normal operation |
| `/var/lib/amnezia-endpoint-lab/lab.db` (+`-wal`, `-shm`) | 0600 | SQLite (WAL), no secrets |
| `/var/lib/amnezia-endpoint-lab/backups/` | 0700 | DB copies taken automatically before each migration |
| `/var/lib/amnezia-endpoint-lab/public/active-pool.json` | 0644 | snapshot for the future read-only mount |

`/var/lib/amnezia-endpoint-lab` is 0700 and `public/` is 0755. A future bind mount of `public/` alone
works, because the mount source is resolved by root (dockerd). The DB never becomes readable for it.

The key lives under `/etc/wireguard` because Ubuntu's AppArmor profile for `/usr/bin/wg` lets it read
key files only below `/etc/wireguard/**`. The AppArmor policy is not changed. `wg` reads the key itself
(`wg set … private-key <path>`), so the key is never in argv, the environment, the database, logs or the
snapshot. Anything key-shaped in error text is redacted before it is printed or stored.

## Commands

```text
endpoint-lab status | list | stats | report [--hours 24]
endpoint-lab refresh                      # timer: re-verify the pool (circuit breaker), snapshot
endpoint-lab discovery                    # timer: bounded candidate checks; yields to refresh
endpoint-lab maintenance                  # retention + WAL checkpoint (also run after each timer job)
endpoint-lab verify ID | verify-all       # operator: deep verify (with circuit breaker)
endpoint-lab probe ID                     # operator: handshake only (never creates ACTIVE)
endpoint-lab blacklist ID [reason] | unblacklist ID
endpoint-lab quarantine ID [minutes] [reason] | unquarantine ID
endpoint-lab import-candidates FILE | seed  # operator file / the generator's legacy seed list
endpoint-lab register-probe-identity | identity-reset --confirm
endpoint-lab snapshot | cleanup | bench ID [--repeat N]
```

`ID` is the `IP:port` of an endpoint already in the database. There is no CIDR, range or port-range
argument anywhere. Candidates must be IPv4, use one of the official ports 2408/500/1701/4500, and sit in
the WARP research prefixes coded in `ALLOWED_PREFIXES`, plus RFC 5737 TEST-NET-1 for negative controls.
At most 64 endpoints per file. IPv6 is unsupported on this node (`disable_ipv6=1`). Operator reasons are
1–200 plain characters. Operator actions are stored in `operator_event`, not in journald.

`config.json` exists only for tests: `{"simulate_targets_unreachable": true}` replaces every target with an
unreachable TEST-NET address (global target outage). `{"simulate_failing_targets": ["cf-1111"]}` breaks
one target. `{"disabled_targets": [...]}` removes targets. Unknown names are rejected.

## Probe identity

Registration lifecycle of the single Lab identity: `ABSENT → PENDING → READY`, or `AMBIGUOUS` / `INVALID`.

1. `wg genkey` / `wg pubkey` (via stdin); the key file is written (0600).
2. `identity.json` is written with `PENDING`, an operation id and the public key. From here on, a crash
   reads as `AMBIGUOUS`, never as "try again".
3. **Exactly one** `POST reg`, never retried:
   - valid 2xx → registration stored (still `PENDING`) → `PATCH warp_enabled` (bounded retries) → `READY`;
   - the request provably never left (DNS/TCP/TLS connect failed) or a 4xx/429 rejection → the key and
     metadata are removed (`ABSENT`), because nothing was registered;
   - timeout/EOF/reset after sending, a 5xx, or a 2xx with an unusable body → `AMBIGUOUS`.
4. `PENDING` with a stored registration only resumes the `PATCH`.

In `AMBIGUOUS` every probe is refused with `PROBE_IDENTITY_AMBIGUOUS` (a Lab failure: no endpoint is
penalised), and `register-probe-identity` refuses to POST again. **Reconcile is not possible:** the
consumer API finds a device only by registration id plus token (`GET reg/{id}`), and both are unknown
when the response was lost. Manual recovery: check how many devices the account has, then
`identity-reset --confirm`. It renames, never deletes, the files (`*.retired-<UTC>`) and refuses a
`READY` identity. After that, `register-probe-identity` starts again. Phase A identities (no state field,
`warp_enabled: true`) read as `READY` without any API call.

Identity health: when both control endpoints are silent, the Lab checks `GET reg/{id}` with the stored
token, at most every 30 min. The outcome is `valid` / `invalid` / `unknown`, stored in `lab_meta` and shown
by `status`. Rotation stays manual: register the replacement into a staging directory, `verify` a
known-good endpoint, atomically swap `identity.json` + `wg.key`, `DELETE reg/{old id}` later. Never
delete the working identity for experiments.

**Backup (manual, optional):** the identity can be re-registered, so losing it costs only a new device on
Cloudflare's side. To keep a copy: `tar -C / -czf - etc/amnezia-endpoint-lab/identity.json
etc/wireguard/amnezia-endpoint-lab/wg.key | gpg --symmetric --cipher-algo AES256 > lab-identity.tgz.gpg`,
moved off-host by the operator. Never Git, Telegram or automatic cloud uploads.

## States

```text
DISCOVERED ──deep ok──► ACTIVE ──fail──► SUSPECT ──fail──► QUARANTINE(15 → 30 → 60 min, capped)
     ▲                    ▲  ▲              │ ok               │ ok          │ 10 more failures
     │                    │  └──────────────┘                  │             ▼
  re-import / discovery   └────────────────────────────────────┘           DEAD ──after 6 h──► re-probed by discovery
VERIFYING (Phase A rows, unblacklisted, unquarantined): ok → ACTIVE, fail → SUSPECT
```

- The first endpoint-specific failure removes the endpoint from the pool at once (`SUSPECT`). The next
  refresh, about 3 min later, re-verifies it. A second consecutive failure → `QUARANTINE`.
- `QUARANTINE` backoff is 15, 30, 60 min, capped at 60. Ten failures after entering `QUARANTINE` → `DEAD`
  (rule unchanged from Phase A). `DEAD` is kept. Discovery re-probes it after 6 h, at most 2 per run, and a
  success makes it `ACTIVE` again.
- Never-verified candidates that fail just count failures and stay `DISCOVERED`. Discovery revisits
  them on its next pass.
- **Hard cap:** after every run, eligible endpoints beyond `MAX_ACTIVE` (48) are parked as `VERIFIED`
  ("verified, waiting for a slot"; cause `pool_cap`), least stable first. Control endpoints are never parked.
  Parked endpoints are neither refreshed nor published. When the pool falls below `TARGET_ACTIVE` (24),
  refresh re-verifies the best parked endpoints, and a success makes them `ACTIVE` again. (First timer
  hour, 2026-10-04: one elevated discovery run found 31 working addresses in `162.159.192.0/24`, the pool
  reached 58, and refresh then filled its 150 s budget. This rule caps that.)
- A handshake-only `probe` advances only `DISCOVERED`.
- `manual_blacklist` outranks everything. Blacklisted endpoints are never probed by the scheduler, are
  refused by `verify`, and leave the snapshot immediately. An operator `quarantine` is never lifted by a
  success, a failure or a timer. `unblacklist` / `unquarantine` put the endpoint into `VERIFYING`.
- Eligibility (snapshot): `state = ACTIVE ∧ ¬blacklist ∧ expires_at > now`.

Every state change is stored in `transition` (from, to, cause, operation).

## Lab health and the circuit breaker

The Lab health (`OK` / `DEGRADED` / `UNAVAILABLE`) is separate from endpoint states, is owned by refresh
runs, and is published as `lab_status` in the snapshot. **Lab failure ≠ endpoint failure.** When the Lab
cannot prove anything, endpoints keep their history and only age out by TTL.

- Lab failure codes (`LOCAL_RESOURCE_ERROR`, `TUNNEL_SETUP_FAILED`, `ROUTE_SETUP_FAILED`,
  `PROBE_IDENTITY_INVALID`, `PROBE_IDENTITY_AMBIGUOUS`, `RATE_LIMITED`, `CANCELLED`, `UNKNOWN`) never
  touch an endpoint. A handshake wait during which not a single byte entered the tunnel (for example,
  the trigger could not send) is `LOCAL_RESOURCE_ERROR`, not `HANDSHAKE_NO_RESPONSE`.
- Inconclusive: handshake ok, every target failed in both sessions (`TARGETS_UNREACHABLE`). On its own,
  it is never an endpoint failure.
- **Control endpoints:** two recent known-good endpoints with distinct IPs (and ports, when possible),
  chosen from `ACTIVE` by consecutive successes. They are kept while they stay `ACTIVE` and replaced
  automatically otherwise (`controls`, `control_selected_at`, `control_reason` in `lab_meta`). They are
  never hardcoded.
- **Breaker triggers:** any inconclusive result, three previously-ACTIVE endpoints failing in a row
  (checked during the run, which stops early when the controls fail too), a mass failure of previously
  ACTIVE endpoints (≥ 3 and ≥ 50%), or every probe of a batch failing. The breaker then deep-verifies
  control #1, and control #2 if #1 fails:
  - a control passes → the path works. Inconclusive endpoints become `TRAFFIC_FAILED` (endpoint failure).
    A mass failure is re-verified once instead of booked (`DEGRADED: TRANSIENT_ANOMALY_RECHECKED`). A
    failed control #1 is booked as its own failure;
  - both controls fail → no penalties this run, `UNAVAILABLE` with the reason
    `VERIFICATION_TARGETS_UNAVAILABLE` (controls handshook, targets dead) or, after the identity API
    check, `PROBE_IDENTITY_INVALID` / `WARP_UDP_UNREACHABLE` / `VPS_NETWORK_OR_API_UNREACHABLE`;
  - no controls yet (bootstrap) and everything failed → no penalties (`UNAVAILABLE: NO_CONTROLS_ALL_FAILED`).
- Snapshot: `DEGRADED` still publishes fresh endpoints. In an `UNAVAILABLE` run, only probes that fully
  passed in that same run count. Nothing is inferred for the others; their existing entries simply expire.

## Scheduler

systemd oneshot services + timers, no daemon. Both jobs share one `flock`. Refresh waits up to 130 s
for it; discovery skips when it is held, so refresh always wins.

| Job | Timer | Budget | Probes |
| --- | --- | --- | --- |
| refresh | every 3 min ± 20 s | 150 s wall, ≤ 64 endpoints | `ACTIVE`, `SUSPECT`, `VERIFYING`, due `QUARANTINE`; 8 s handshake timeout |
| discovery | every 30 min ± 5 min | 60 s wall (120 s below the soft floor) | seeds, DEAD resurrection, the /24 cursor; 3 s handshake timeout |

Freshness model: one full deep verify of the pool per refresh (model B). Measured on the host: a
successful deep verify costs ~0.4–0.6 s wall and ~0.14 s CPU. A pool of ~30 endpoints refreshes in
~50 s. A separate handshake-only loop would add complexity without saving anything.

Discovery budget follows the pool: `ACTIVE ≥ 48` → none, `≥ 24` → 4 endpoints (one IP × 4 ports),
`≥ 12` → 16, below 12 → 32 (still bounded). Order:

1. never-probed seeds (operator file, `seed` = the generator's legacy list), except Cloudflare One;
2. up to 2 DEAD endpoints older than 6 h;
3. the next slice of a deterministic shuffled walk over **all 256** addresses of `162.159.192.0/24`
   (`(167·i + 89) mod 256`, no LAN network/broadcast exclusions on an anycast range), all four ports;
4. one Cloudflare One (`162.159.193.0/24`) observation every 4th run.

The cursor advances only after the slice has been probed and committed. A crash repeats a slice and never
skips one. Legacy ranges (`162.159.195.*`, `188.114.*`) are re-checked as known addresses and never expanded
automatically.

Resource guards: discovery skips when MemAvailable < 200 MB, load > 2 per CPU, or free disk < 512 MB.
Refresh switches to `ACTIVE`-only below 100 MB MemAvailable or 128 MB free disk. Skips are recorded in `run`.

Source classes (provenance, never health): `phase_a_verified`, `consumer_official_seed`, `legacy_builtin`,
`cloudflare_one_observation`, `community`, `experimental`, `negative_control` (never scheduled, never in
the snapshot).

## Measurements behind the constants (host, 2026-10-04)

- Handshake detection: median ~80 ms, max ~1.07 s at every polling interval. Polling every 250 ms costs
  half the CPU of 100 ms on a silent endpoint (464 vs 856 ms per 8 s wait) without slower detection.
- Timeouts: 2/3/5/8 s gave the same success rate on good endpoints (one random non-answer per ~50
  handshakes, independent of the timeout). Refresh uses 8 s (covers WireGuard's 5 s re-initiation).
  Discovery uses 3 s: a miss only delays discovery to the next pass.
- A burst of ~90 handshakes in 4 min slowed HTTPS through this identity to 6–10 s for a while. Isolated
  probes were back at 30–60 ms after a pause. The scheduler keeps a steady low rate: ~10 handshakes per
  minute in refresh, a handful per discovery run.

## Snapshot contract (schema 2)

```json
{ "schema_version": 2, "generated_at": "…Z", "expires_at": "…Z", "lab_status": "ok|degraded|unavailable",
  "active_count": 1,
  "endpoints": [ { "ip": "162.159.192.1", "port": 2408, "family": 4, "state": "active",
                   "lab_verified_at": "…Z", "expires_at": "…Z", "source_class": "phase_a_verified",
                   "probe_completion_ms": 70, "traffic_total_ms": 55 } ] }
```

The snapshot is built only from committed DB state, as temp file → fsync → `os.replace` → directory
fsync. Top-level `expires_at` = min(now + 5 min, earliest endpoint expiry): a stopped timer makes the file
stale even before endpoints expire. A consumer must check both expiries and fail closed (`validate_snapshot`):
unknown schema, future `generated_at`, unexpected top-level or endpoint fields, unknown `lab_status`,
`active_count` ≠ number of endpoints, or an invalid endpoint → reject the file.

## Database

- Schema 3 (versioned migrations, each in one transaction, with a copy in `backups/` first). A failed or
  newer-than-code migration stops the Lab and never recreates the DB. Phase A rows and observations are
  kept; previously verified endpoints restart as `VERIFYING`.
- Tables: `endpoint`, `observation` (per probe: result, duration, error, bytes, sessions, run kind),
  `transition`, `target_result`, `run` (per job: duration, health, counts, active after, CPU, RSS,
  memory/swap, bytes), `operator_event`, `lab_meta`.
- Retention: observations and target results 14 days; transitions, runs and operator events 90 days.
  Pruned hourly. A passive WAL checkpoint runs after every job, `TRUNCATE` daily, `journal_size_limit`
  4 MB. `PRAGMA quick_check` runs once a day: a corrupt DB stops the jobs (left untouched; the snapshot
  ages out). `status` reports DB size including WAL/SHM.
- DB write failure (e.g. `ENOSPC`) → the run fails (`DB_WRITE_FAILED`) and no snapshot is written.
  Snapshot write failure → `SNAPSHOT_WRITE_FAILED` in `lab_meta`, Lab `DEGRADED`, the old file ages out.

## systemd hardening (tested on the host)

Both services run as root with `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, `ProtectSystem=strict`
(writable: `/var/lib/amnezia-endpoint-lab`, `/run`), `UMask=0077`, `RestrictAddressFamilies=AF_UNIX AF_INET
AF_INET6 AF_NETLINK`, `LockPersonality`, `RestrictRealtime`, `SystemCallArchitectures=native`,
`ProtectClock`, `ProtectKernelLogs`, `ProtectControlGroups`, `MemoryMax=128M`, `TasksMax=64`, `Nice`, and
`TimeoutStartSec=300`. `systemd-analyze security`: 5.7 MEDIUM, expected for a root service with
`CAP_SYS_ADMIN`/`CAP_NET_ADMIN`. `PrivateNetwork` is deliberately off: the encrypted UDP socket must live
in the host namespace.

Capabilities, determined by experiment (one verify per bounding set):

- `CAP_NET_ADMIN` (link/addr/route) and `CAP_SYS_ADMIN` (`ip netns add` mounts) are required.
- `CAP_NET_RAW` is required by the ping trigger. Without it, no initiation is sent, which is now classified
  as a Lab failure.
- `CAP_SYS_MODULE` is not needed while the module is loaded. It is kept so that `modprobe wireguard` in
  the preflight works after a reboot.

Peak RSS ~34 MB per job.

## Failure matrix

| Event | Endpoint states | Lab health | Future generator | Alert (Phase B: warning) | Recovery |
| --- | --- | --- | --- | --- | --- |
| Registration API down while registering | — | identity `ABSENT` (proven) or `AMBIGUOUS` | n/a | — | operator |
| Probe identity invalid / revoked | unchanged | `UNAVAILABLE` (identity API check) | pool drains in ≤ 7 min | identity invalid | manual rotation |
| Identity `AMBIGUOUS` | unchanged | `UNAVAILABLE: PROBE_IDENTITY_AMBIGUOUS` | pool drains | identity | manual recovery |
| One endpoint fails | ACTIVE → SUSPECT | OK | leaves pool at once | none | next refresh |
| All handshakes fail suddenly | unchanged | `UNAVAILABLE` (controls silent) | pool drains | Lab unavailable | automatic when the cause ends |
| Handshake ok, no traffic (both sessions) | after a passing control: `TRAFFIC_FAILED` | OK | leaves pool | none | next refresh |
| All verification targets down | unchanged | `UNAVAILABLE: VERIFICATION_TARGETS_UNAVAILABLE` | pool drains | Lab unavailable | automatic |
| One target down | unchanged (quorum) | OK / `DEGRADED: TARGET_FAILING` | none | none | automatic |
| `wg` missing / module unavailable / netns fails | unchanged | `UNAVAILABLE` (`LOCAL_RESOURCE_ERROR`) | pool drains | Lab unavailable | operator |
| Trigger cannot send | unchanged | `UNAVAILABLE`/`DEGRADED` (`LOCAL_RESOURCE_ERROR`) | pool drains | Lab unavailable | operator |
| Cleanup fails / process killed mid-probe | unchanged, nothing recorded | — | none | none | startup sweep, `cleanup` |
| SQLite locked | job aborts (10 s busy timeout) | unchanged | snapshot ages out | stale snapshot | next run |
| SQLite corrupt / newer schema | job refuses, DB untouched | — | snapshot ages out | timer failed | restore from `backups/` |
| Disk full | DB write fails, no snapshot | — | snapshot ages out | stale snapshot | free disk |
| Snapshot write fails | DB committed | `DEGRADED: SNAPSHOT_WRITE_FAILED` | old snapshot ages out | stale snapshot | automatic |
| Timer stops | unchanged | unchanged | snapshot stale in ≤ 5 min | timer stopped | operator |
| VPS loses Internet | unchanged | `UNAVAILABLE` | pool drains | Lab unavailable | automatic |
| `awg0` fine, Lab broken | — | independent: the Lab never reads or changes `awg0` | — | — | — |

## Reboot

`wireguard-tools` persists. The `wireguard` module is loaded on demand (`modprobe` in every preflight,
`CAP_SYS_MODULE` kept for it, no `/etc/modules` entry). Credentials, DB and snapshot are on persistent
paths. Probe namespaces cannot survive a reboot, and the startup sweep removes leftover names. Timers are
`WantedBy=timers.target`. Refresh first runs 3 min after boot, discovery after 10 min. Until the first
refresh, the old snapshot is already stale (top-level TTL 5 min).

## Install, upgrade and rollback

Install or upgrade (root, from `git archive <commit> deploy/endpoint-lab`):
`sh deploy/endpoint-lab/install.sh <full-commit-sha>`. It is idempotent: it creates directories, replaces
the CLI atomically (a running oneshot keeps the code it already loaded), writes `REVISION`, installs the
units, runs `daemon-reload`, and **never** enables or starts timers, installs packages or touches the
identity. `status` shows the installed commit and whether the running file matches it. First-time setup
also needs `apt-get install --no-install-recommends wireguard-tools`, `endpoint-lab register-probe-identity`
and `endpoint-lab seed`.

Rollback (never touches amneziawg/`awg0` or the identity):

1. `systemctl disable --now amnezia-endpoint-lab-refresh.timer amnezia-endpoint-lab-discovery.timer`.
2. Reinstall a previous commit with `install.sh`, or remove the units and the CLI.
3. Restore `lab.db` from `backups/` if a migration has to be undone.
4. Run `endpoint-lab cleanup`.

## Alerts during Phase B

The generator does not depend on the Lab yet, so Lab problems are **warnings**, never "site down": timer
stopped, snapshot stale, identity invalid/ambiguous, Lab `UNAVAILABLE`, pool below the soft floor for a
long time. Individual endpoint flaps are never alerted. Severity can rise after the generator cutover
(Phase D).

## Level of evidence

The Lab records observations about exact endpoints and never extrapolates them to a range.

- Cloudflare's documentation separates consumer WARP (`162.159.192.0/24`) from Cloudflare One WireGuard
  ingress (`162.159.193.0/24`). That boundary comes from the documentation, not from the Lab.
- Phase A (2026-10-04): the single endpoint `162.159.193.1:2408` did not answer the consumer probe
  identity. This is one observation of one endpoint and says nothing about the rest of that /24.
- Specific addresses outside the documented consumer range (`162.159.195.1`, `188.114.97.1`) passed full
  verification. "Not documented as consumer" does not mean "does not work", and "documented" does not
  mean "works". Both are decided per endpoint by observation.
- The Phase A candidate set was hand-picked (24/24 passed), so it does not estimate the yield of any range.
- All latencies are VPS → WARP. None of them is a user latency.

## Future product semantics (design only, not implemented)

After the generator cutover, the official site offers two explicit endpoint modes:

- **Auto — Lab verified:** only fresh `ACTIVE` endpoints from the snapshot. With no fresh pool, this mode
  returns a controlled error (503 in the API, a clear UI message), never a silent switch to an unverified
  endpoint.
- **Cloudflare hostname (compatibility):** `engage.cloudflareclient.com:<port>`, chosen by the user,
  independent of the Lab and never labelled "lab verified".

Forks, Vercel and local runs keep the built-in/hostname behaviour.
