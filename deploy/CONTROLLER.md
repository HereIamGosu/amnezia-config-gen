# amnezia-deploy — pull-based blue/green controller

`deploy/controller/amnezia_deploy.py`, installed as `/usr/local/sbin/amnezia-deploy` by
`deploy/controller/install.sh`. Python 3 standard library only.

The VPS **pulls**; nothing pushes to it. There is no webhook, no SSH access for GitHub, no
self-hosted runner, no deployment API and no new listening port. GHCR is public, so no secret is
needed to pull.

```text
GitHub main → CI (build once, smoke the exact image) → GHCR :<full-sha> + :main
                                                                     │ discovery only
VPS amnezia-deploy ── resolve digest ── verify sha ↔ digest ↔ image ─┘
   → inactive slot (loopback) → health + smoke → nginx upstream switch → public smoke
   → OK: keep the old slot 5 min (grace), then stop it   /  FAIL: switch back automatically
```

## Commands

| Command | Does |
| --- | --- |
| `amnezia-deploy status` | State, evidence (public revision, upstream file, containers), verdict. Read-only. |
| `amnezia-deploy check` | Discovery only: what `:main` resolves to and whether it differs from the active digest. |
| `amnezia-deploy candidate [SHA]` | Pull + start in the inactive slot + health + smoke, then remove. No switch. |
| `amnezia-deploy deploy` | Deploy the channel artifact (`:main` → digest). No-op if that digest is active. |
| `amnezia-deploy deploy <full-sha>` | Deploy that SHA's image from the trusted package only. |
| `amnezia-deploy rollback` | Switch back to the previous known-good (restarts it if it was stopped). |
| `amnezia-deploy finalize` | After the grace period: stop the old slot if production is healthy; prune images. |
| `amnezia-deploy reconcile` | Compare reality with state and apply only safe fixes (also runs at boot). |
| `amnezia-deploy pause [reason]` / `resume` | Maintenance switch (`/etc/amnezia-deploy/paused`). |
| `amnezia-deploy drill` | Broken-candidate drill with the local fixture `amnezia-deploy-drill:broken`. |
| `journalctl -t amnezia-deploy` | One JSON line per stage: ts, operation_id, op, stage, target_sha, target_digest, slot, duration_s, result. |

Rate limiting: the public smoke goes through nginx from 127.0.0.1, which shares the `amnezia_api`
limit (30 r/min) with other local tools. A 429 proves nothing about the release, so it is waited
out (up to 90 s); if the revision still cannot be proven, traffic goes back. Reconcile reads the
revision from `/`, which has no request limit.

Pause semantics: while paused, `deploy --automatic` (the timer) never deploys; a manual `deploy` or
`rollback` needs `--force`. `status` and `check` always work.

## Discovery: why `:main` is never deployed

`:main` is a moving channel pointer. If commit B fails CI after A was published, `origin/main` is B
but `:main` still points to A — the controller follows `:main`, never `origin/main`, and is never
stuck on an unpublished commit. But a container is never started from `:main`:

1. `GET manifests/main` → manifest bytes; digest **D** = sha256 of those bytes (must equal the
   announced `Docker-Content-Digest`); only a single-platform image manifest is accepted.
2. `GET blobs/<config>` → its sha256 must equal the config digest; then: revision label **S** is a
   full SHA, `APP_REVISION == S`, source label is this repository, `linux/amd64`, user `node`.
3. `GET manifests/S` must resolve to the same **D**.
4. The candidate is `ghcr.io/hereiamgosu/amnezia-config-gen@D`. The repository is fixed in code;
   no image or registry is ever taken from input. Identity = digest: an identical digest is a
   no-op even if reached through another tag.

## Slots and nginx

| Slot | Container | Host binding |
| --- | --- | --- |
| blue | `amnezia-web-blue` (bootstrap: the deploy.sh-era `amnezia-web`) | `127.0.0.1:13100` |
| green | `amnezia-web-green` | `127.0.0.1:13101` |

Both slots run with production hardening: read-only rootfs, `/tmp` tmpfs, `cap_drop ALL`,
`no-new-privileges`, 256 MB, 1 CPU, 128 pids, json-file logs 10m×3, image HEALTHCHECK,
`NODE_ENV=production`, `APP_REVISION=<sha>`, restart `unless-stopped`. The controller verifies
these on the running container before it is used.

`/etc/nginx/sites-available/amnezia-web` includes `/etc/nginx/amnezia-deploy/upstream.conf`
(`upstream amnezia_backend { server 127.0.0.1:<port>; }`). That file is the only nginx file the
controller writes: tmp → fsync → rename, `nginx -t`, `systemctl reload nginx`. If the test fails,
the previous file is restored (the running nginx never saw the bad one); if the reload fails, the
previous file is restored, tested and reloaded. nginx is never stopped or restarted.

Public proof: every response carries `X-App-Revision`; after a switch the controller fetches `/`,
`/api/status`, `/api/healthcheck` through `127.0.0.1:443` with TLS/SNI/Host `awgconfig.com` and
requires the target revision, otherwise it switches back and re-checks the old release. The
bootstrap release (`cacd3e0`, built by deploy.sh) predates the header; it is identified by its
absence plus its container — a documented bootstrap exception.

Gates are `/`, `/api/status`, `/api/healthcheck` (status, Content-Type, JSON, `no-store`,
latency ≤ 5 s, revision). `/api/iplist` and WARP registration are not gates: they depend on
external upstreams, and the image already passed the CI smoke.

## State and events (`/var/lib/amnezia-deploy`, root:root 0750)

- `state.json` — `schema_version`, `active_slot`, `source_sha`, `image_digest`, `previous_*`,
  `deployed_at`, `last_success`, `pending_stop` (grace), `known_good` (last 4), `bootstrap*`.
- `last-attempt.json` — operation id, type, target, stage reached, start/end, result,
  `error_category`.
- `last-event.json` — contract for the VPS telemetry collector / Telegram bot (no secrets):
  `type`, `result`, `stage`, `source_sha`, `previous_sha`, `digest`, `slot`, `duration_s`,
  `timestamp`, `operation_id`, and `error_category`/`error` on failure.

- `active-revision` — plain SHA of the served release; the VPS telemetry collector reads it
  (`/etc/vps-telemetry/config.json` → `amnezia.revision_file`).

All writes are atomic. `flock` on `lock` allows one discovery/deploy/rollback at a time; a second
invocation exits 0 without changes; a leftover lock file is harmless (the lock dies with its
process).

## Reboot model

- Containers use `unless-stopped`: running slots come back, a slot stopped after the grace period
  stays stopped.
- `upstream.conf` is on disk, so nginx comes back pointing at the active slot; if both slots come
  up, nginx still targets exactly one.
- `amnezia-deploy-reconcile.service` (enabled, oneshot, 30 s after boot) runs `reconcile`: if the
  active container is not running while upstream and state point at it, it is started and
  health-checked. It never deploys and never switches.

## Crash consistency

Evidence order: what nginx serves (public `X-App-Revision`) and the upstream file → running,
healthy containers → image revision/digest labels → `state.json`. `state.json` is not trusted
blindly.

| Crash point | What the next run sees | Outcome |
| --- | --- | --- |
| after pull / after candidate start / after health | candidate in the inactive slot, nothing switched | replaced by the next deploy; production untouched |
| after writing upstream, before reload | file → new slot, public revision → old slot | file rewritten to the served slot (no traffic change) |
| after reload, before state commit | public revision → new slot, state → old | state adopts the served slot, previous = old |
| after state commit / during grace | consistent; `pending_stop` set | `finalize` stops the old slot when due |
| anything unexplained (revision matching no healthy slot, public endpoint down, corrupt state) | contradiction | `NEEDS_RECONCILIATION`: nothing is switched; production keeps running |

## Old slot after the grace period

`finalize` (scheduled once per deploy/rollback with `systemd-run`, grace + 30 s) stops the old slot
only if the active slot is healthy and the public check passes. While
`/etc/amnezia-deploy/keep-old-slot` exists it keeps the old slot running instead: the Telegram ops
bot still watches the fixed container name `amnezia-web`, so stopping or replacing a slot would
raise a false critical alert. The flag goes away when the bot follows the active slot (Phase 7).

## Images and the bootstrap exception

Kept: active, previous, the last known-good digests and any slot container's image. The
bootstrap image (`amnezia-web:cacd3e0882a7`, local, no GHCR digest) is never pruned by the
controller (it only prunes `ghcr.io/hereiamgosu/amnezia-config-gen@sha256:…` references) and stays
until at least two GHCR releases have been confirmed known-good. Never `docker system prune -a`.

## Automatic deployment

`amnezia-deploy-check.timer` is installed **disabled**. Enabling it is an explicit owner decision
(`systemctl enable --now amnezia-deploy-check.timer`); it runs `deploy --automatic`.
