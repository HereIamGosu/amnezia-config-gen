# Release Ledger

Checked at: 2026-10-03 (updated for 2.7.4).

This ledger records release metadata state without fabricating historical tags or GitHub Releases.

| Version | Implementation commit | Tag | GitHub Release | Release docs | Source audit | Consistency state | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2.7.0 | `481d6bbd3f34153838c68b6fce1a11961e7a7b3e` | `v2.7.0` | Present (`v2.7.0`) | `docs/releases/2.7.0.md` | `docs/releases/2.7.0-source-audit.md` | Published metadata present; changelog drift | Public tag dated 2026-09-12 is titled for AWG 3.0/3.1. An earlier 2026-07-05 commit also used "Release 2.7.0" for Compatibility & Onboarding Clarity, and the CHANGELOG retains that older date/content. Do not move the tag or rewrite history. |
| 2.7.1 | `a24a67c9a8d9d3fc17a8be575db8458e9f1eaf82` | Missing | Missing | `docs/releases/2.7.1.md` | `docs/releases/2.7.1-source-audit.md` | Repository docs only | Candidate commit identified from package version and commit subject, but no historical tag/release exists. Do not create without owner approval and final proof. |
| 2.7.2 | `be0bdccdc8fe25b5a5c9413e3b15a8a225b07ef5` | Missing | Missing | `docs/releases/2.7.2.md` | `docs/releases/2.7.2-cps-source-audit.md` | Repository docs only | Candidate commit identified from package version and CPS release commit, but no historical tag/release exists. Do not create without owner approval and final proof. |
| 2.7.3 | `b32f95afd` (release commit), merged to `main` in `45c881934491ea1ef2a165f15a88efe176ac066b` | Missing | Missing | `docs/releases/2.7.3.md` | `docs/releases/2.7.3-source-audit.md` | Deployed, metadata incomplete | Deployed to self-hosted production on 2026-10-03 from `45c8819`; production then ran post-release `main` commits up to `c0e91ec` still at package version 2.7.3 (live status UI, KV removal, CI hardening — versioned by 2.7.4). No tag was created; create `v2.7.3` only with owner approval. |
| 2.7.4 | Release commit `release: 2.7.4` | Pending at commit time — `v2.7.4` is created on this commit after CI passes (verify with `git ls-remote --tags origin v2.7.4`) | Pending (owner creates from `docs/releases/2.7.4.md`) | `docs/releases/2.7.4.md` | `docs/releases/2.7.4-source-audit.md` | Release prepared | Bugfix release: status semantics, KV label, cache keys and headers, asset version guard. |

## Remote state observed

- `git ls-remote --tags origin 'refs/tags/v2.7*'` returned only `v2.7.0` when 2.7.4 was prepared.
- GitHub Releases API returned `v2.7.0` and `v2.2.0` in the latest 20 releases.

## Reconciliation rule

Historical tags must only be created when the exact release commit is proven from package metadata, release docs, source audits, and history. Missing metadata is recorded here until the owner explicitly approves remote repair.
