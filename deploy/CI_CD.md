# CI and image delivery

Status: **CI + image publication + pull-based controller on the VPS.** Every push to `main` that
passes CI publishes the tested image to GHCR. The VPS controller `amnezia-deploy`
([CONTROLLER.md](CONTROLLER.md)) deploys it blue/green **when run by hand**; its timer is installed
disabled. `deploy/deploy.sh` is legacy/emergency only and refuses on the managed host.

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
| `publish` | after `image`, push to `main` only | `contents: read`, `packages: write` | downloads the tested archive, proves it is the tested image, pushes it to GHCR (`scripts/ci/publish-image.sh`), records `release.json` |

- Workflow-level `permissions: {}`; `ci` and `image` ask only for `contents: read`. The only write
  permission (`packages: write`) belongs to `publish`, which runs only for pushes to `main`, never
  builds, and logs in with the job's own `github.token`. No repository secrets are used.
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
| image ID | daemon image ID (`docker image inspect .Id`): the config digest with the classic store, a manifest digest with the containerd store | `image` job output and summary, `image-id.txt` |
| config digest | `sha256` of the image config, from the archive's `manifest.json` | `image` job output, `release.json`; what the registry manifest must reference |
| `image_digest` | registry manifest digest after push | `publish` job summary and `release-<sha>` artifact (`release.json`); VPS state (future) |

The config digest survives `docker save`/`load` and `docker push` unchanged — the pushed manifest
references it — which is what lets the publish job prove it pushes the tested image rather than a
rebuild.

## Publish to GHCR (`publish` job, `scripts/ci/publish-image.sh`)

1. Download `image-<sha>` (the archive the `image` job smoke-tested).
2. Prove identity against the `image` job **outputs** (`image_id`, `archive_sha256`,
   `config_digest`), which only that job's own steps can set. The artifact is not trusted on its
   own: any job of the run could replace it. The archive sha256, `image-id.txt`, the config named
   by the archive's `manifest.json`, the loaded image ID and the revision label must all match.
   Anything else fails before any registry call.
3. Treat `ghcr.io/hereiamgosu/amnezia-config-gen:<full-sha>` as immutable: if the tag exists with
   other content the job fails; if it already holds the tested image, nothing is pushed. Only the
   exact "tag not found" answer of the lookup allows a push; any other error fails the job.
4. Push, read the manifest back by digest and prove it references the tested config digest.
   (Registry checks use the config digest, not the daemon image ID: with the containerd image
   store, as on the VPS, the image ID is a manifest digest.)
5. Move the alias `:main` for humans, only if the commit is still the tip of `main` (a re-run of
   an older run leaves it alone). Deployment must never use it; `latest` is not published.
6. Write `release.json` — `source_sha`, `image`, `image_digest`, `image_ref` (`repo@sha256:…`),
   `image_id`, `published` (`pushed` | `already-present`), run id — to the job summary and the
   `release-<sha>` artifact (90 days).

No second `docker build` exists anywhere in the workflow (guarded by `__tests__/ci-workflows.test.js`);
the publish script's decisions are tested in `__tests__/publish-image.test.js` with a fake docker/git.

Re-runs: "Re-run failed jobs" (or re-running only `publish`) reuses the first attempt's outputs and
artifact, so an already published image is recognised and not pushed again. "Re-run all jobs"
rebuilds the image; the build is not byte-reproducible, so the new config digest differs and the job
fails with "refusing to overwrite" — by design, the published SHA tag stays as it was.

Notes:

- A package created by `GITHUB_TOKEN` may start **private**. If an anonymous pull is refused, the owner
  switches it to public once (GitHub → Packages → amnezia-config-gen → Package settings → Change
  visibility). Decision: public GHCR, so the VPS needs no registry credentials. The
  `org.opencontainers.image.source` label links it to this repository.
- Multi-arch is not needed (VPS is amd64); the runner builds amd64.
- Retention: the image artifact lives 7 days, `release.json` 90 days; GHCR versions are cleaned by
  a separate, explicit policy (none yet).

## VPS update

Implemented by `amnezia-deploy`; see [CONTROLLER.md](CONTROLLER.md). `:main` is a discovery pointer
only; containers always run from `image@sha256:…`, and the public `X-App-Revision` proves which
release answers after a switch. Automatic deployment (the timer) is a separate owner decision.
