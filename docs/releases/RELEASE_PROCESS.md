# Release Process

Use this process for patch and minor releases. It requires only Git, Node/npm, and optional local secret scanning.

1. Inspect baseline state:

   ```bash
   git status --short
   git branch --show-current
   git log -20 --oneline --decorate
   git describe --tags --always
   ```

2. Bump the version without creating a tag:

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

3. Update release notes, source audit, changelog, release ledger, and current frontend asset cache keys
   (`?v=` in `public/index.html`, `public/status.html`, `public/404.html` and the icons of
   `public/site.webmanifest`), the JSON-LD `softwareVersion` in `public/index.html`, and `<lastmod>` in
   `public/sitemap.xml` (not older than the release date). Then regenerate the English page with
   `npm run seo:en`. `release:check` also fails when `public/.well-known/security.txt` expires within 30 days.

4. Install and verify:

   ```bash
   npm ci
   npm run lint
   npm test
   npm run build
   npm run evidence:check
   npm run release:check
   git diff --check
   ```

5. If available, run a local secret scan:

   ```bash
   gitleaks detect --source . --no-git
   ```

6. Review the final diff:

   ```bash
   git diff --stat
   git diff
   ```

7. Commit the verified release changes.

8. Create an annotated tag for the verified commit:

   ```bash
   git tag -a vX.Y.Z -m "Release X.Y.Z - <release title>"
   node scripts/check-release-consistency.js --tag vX.Y.Z
   ```

9. Push the commit and tag only after final review:

   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```

10. Create the GitHub Release from the checked-in release notes. Do not rely on generated notes for protocol policy.

11. Verify deployed asset versions after deployment by checking that static asset URLs use `?v=X.Y.Z`.

12. Search engines are notified through IndexNow (Bing, Yandex, Seznam, Naver, Yep) automatically:
    `.github/workflows/indexnow.yml` runs on every push to `main` that touches `public/`, waits until
    production serves the pushed commit (or a later commit containing it) and submits the sitemap
    URLs (see `deploy/CI_CD.md`). Check
    that the "IndexNow" workflow run of the release push succeeded.

    Fallback, only when that run failed or was skipped — run the workflow manually
    (`workflow_dispatch`) or from a checkout of the release commit:

   ```bash
   npm run indexnow -- --wait-revision "$(git rev-parse HEAD)" --since vPREVIOUS
   ```

## Historical metadata repair

Do not create missing historical tags from memory. For each missing release tag:

- identify the exact implementation commit;
- prove it from package metadata, release docs, source audit, and history;
- record the reasoning in `RELEASE_LEDGER.md`;
- ask for explicit owner approval before any remote mutation.
