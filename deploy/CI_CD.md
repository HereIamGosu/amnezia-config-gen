# CI and image delivery

Status: **CI only.** Nothing in this repository deploys anything. Production is still updated
by hand with `deploy/deploy.sh <sha>` (see `deploy/README.md`). The publish and VPS stages below
are designs for later phases and are not active.

## Decision (ADR, accepted)

GitHub-hosted CI builds the image **once**, tests **that** image, and later publishes the same
image to public GHCR as `ghcr.io/hereiamgosu/amnezia-config-gen:<full-sha>`. The VPS pulls by
digest. GitHub never gets SSH access to the VPS, no self-hosted runner runs public PR code, the
VPS holds no secrets, nginx/SSH/UFW are never changed by a push, and `latest` is never deployed.
Production state records both `source_sha` and `image_digest`.

## What runs now (`.github/workflows/ci.yml`)

| Job | Trigger | Permissions | Does |
| --- | --- | --- | --- |
| `ci` | push to `main`, tags `v*`, PRs to `main`, manual | `contents: read` | `npm ci`, lint, tests, protocol evidence, release consistency (+ tag check), presets drift, coverage summary |
| `image` | after `ci` | `contents: read` | builds `deploy/Dockerfile` once (`APP_REVISION=<sha>`), records the image ID, runs `scripts/ci/smoke-image.sh` against it, and on `main` uploads the tested image as an artifact |

- Workflow-level `permissions: {}`; each job asks only for `contents: read`. No secrets are used.
- `actions/checkout` runs with `persist-credentials: false`.
- Every action is pinned to a full commit SHA with the version in a comment. Dependabot
  (`github-actions` ecosystem) proposes updates; the Docker base image is pinned by digest and
  updated the same way (`docker` ecosystem, no Node major upgrades).
- PRs from forks get the same jobs with a read-only token and no artifact upload.
  build-push-action's implicit build-record artifact is disabled (`DOCKER_BUILD_RECORD_UPLOAD: false`).
- The job id `ci` is kept on purpose: it is the status check name branch protection may require.

### Image smoke (`scripts/ci/smoke-image.sh`)

Runs the image with the production hardening from `deploy/docker-compose.yml` (read-only rootfs,
`/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`, 256 MB, 1 CPU, 128 pids) and checks:

- revision label and `APP_REVISION` equal the commit; user `node`, uid ≠ 0; HEALTHCHECK present and healthy;
- no devDependencies, tests, docs, `.git`, `.github` or `deploy/` inside the image;
- `/`, `/status.html`, `/static/live-status.js`, `/api/status`, `/api/healthcheck`, `/api/iplist`
  answer correctly, APIs with `Cache-Control: no-store`, CSP present, assets carry `?v=<version>`;
- `/api/warp` handler is loaded (unsupported CPS → 400) without registering a WARP device;
- `package.json`, `server.js`, `.git/config`, traversal paths and `/status.json` → 404.

It needs only docker, curl and python3 on the host, and makes no outbound calls of its own (`/api/healthcheck` probes Cloudflare/iplist from the
runner; its result does not fail the smoke, only the HTTP contract does).

## Identity

| Name | Meaning | Where it is known |
| --- | --- | --- |
| `source_sha` | full commit SHA (`github.sha`) | everywhere; image label `org.opencontainers.image.revision` |
| image ID | `sha256` of the image config | CI job summary, `image-id.txt` in the artifact |
| `image_digest` | registry manifest digest after push | publish job (future), VPS state (future) |

The image ID survives `docker save`/`load` and `docker push` unchanged (it is the config digest
referenced by the pushed manifest), which is what lets the publish job prove it pushes the tested
image rather than a rebuild.

## Publish to GHCR — design, not enabled (Phase 4)

A third job, `publish`, only for `push` to `main`, `needs: image`:

```yaml
publish:
  needs: image
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  runs-on: ubuntu-24.04
  permissions:
    contents: read
    packages: write        # push to ghcr.io/hereiamgosu/*
    # id-token: write + attestations: write if build provenance is attested
  steps:
    - download artifact image-<sha>            # actions/download-artifact, pinned SHA
    - docker load < image.tar.gz
    - verify: docker image inspect -f '{{.Id}}' == image-id.txt, revision label == github.sha
    - refuse if ghcr.io/hereiamgosu/amnezia-config-gen:<sha> already exists with another digest
    - docker login ghcr.io with GITHUB_TOKEN    # docker/login-action, pinned SHA
    - docker tag + docker push ghcr.io/hereiamgosu/amnezia-config-gen:<full-sha>   # no `latest`
    - read the pushed manifest; verify its config digest == tested image ID
    - write release.json {source_sha, image, image_digest, image_id, run_id} as artifact + summary
```

Notes for enabling it:

- The first push creates the package as **private**; switch it to public once in the GitHub UI
  (decision: public GHCR, so the VPS needs no registry credentials). The `org.opencontainers.image.source`
  label links it to this repository.
- Tags are per commit and never reused; `latest` is not pushed.
- Multi-arch is not needed (VPS is amd64); the runner builds amd64.
- Retention: the CI artifact lives 7 days; GHCR versions are cleaned by a separate, explicit policy.

## VPS update — design reference only (Phase 5, not enabled)

A systemd timer on the VPS polls `git ls-remote https://github.com/HereIamGosu/amnezia-config-gen refs/heads/main`.
For a new SHA it resolves `ghcr.io/hereiamgosu/amnezia-config-gen:<sha>` to a digest, accepts it only
if the CI run for that SHA succeeded, pulls **by digest**, starts the new container next to the old one
(blue/green on a second loopback port), health-checks it, switches traffic, and keeps the previous
container for instant rollback. How traffic is switched (a one-line upstream include owned by this
process vs. re-binding the fixed port) is an open Phase 5 decision, because the rule "nginx is never
changed by a push" must hold. State file:
`{source_sha, image_digest, previous_*}`. It never runs `git pull` in a live directory and never runs
`docker system prune -a`.
