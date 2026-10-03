#!/usr/bin/env node
// Fails when an immutable browser asset changed against a base commit while the package
// version did not. Files under public/static/ are served with
// `Cache-Control: max-age=31536000, immutable` and referenced as `?v=<package version>`
// (vercel.json, enforced by check-release-consistency.js). A changed file behind an
// unchanged version would stay stale in browsers for a year.
//
// Usage: node scripts/check-asset-version-bump.js <base-commit> [head-commit=HEAD]

const { execFileSync } = require('node:child_process');

const IMMUTABLE_PREFIX = 'public/static/';
// Served with `max-age=0, must-revalidate`: its vercel.json rule comes after /static/(.*), and
// the last matching rule wins (server.js; asserted by __tests__/cache-headers.test.js).
const REVALIDATED = new Set(['public/static/presets-fallback.json']);

const isImmutableAsset = (file) => file.startsWith(IMMUTABLE_PREFIX) && !REVALIDATED.has(file);

/** Pure decision: which immutable assets changed, and is that allowed. */
const evaluate = ({ changedFiles, baseVersion, headVersion }) => {
  const assets = changedFiles.filter(isImmutableAsset);
  return { ok: assets.length === 0 || baseVersion !== headVersion, assets };
};

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const versionAt = (ref, cwd) => JSON.parse(git(['show', `${ref}:package.json`], cwd)).version;

const run = ({ base, head = 'HEAD', cwd = process.cwd() }) => {
  // Deleted files cannot be served stale; added and modified ones can (a re-added path may be cached).
  const changedFiles = git(['diff', '--name-only', '--no-renames', '--diff-filter=d', base, head], cwd)
    .split('\n').filter(Boolean);
  const baseVersion = versionAt(base, cwd);
  const headVersion = versionAt(head, cwd);
  return { ...evaluate({ changedFiles, baseVersion, headVersion }), baseVersion, headVersion };
};

if (require.main === module) {
  const [base, head] = process.argv.slice(2);
  if (!base) {
    process.stderr.write('usage: check-asset-version-bump.js <base-commit> [head-commit]\n');
    process.exit(2);
  }
  const result = run({ base, head });
  if (result.ok) {
    process.stdout.write(result.assets.length
      ? `Immutable assets changed and version moved ${result.baseVersion} -> ${result.headVersion}: ok\n`
      : 'No immutable browser assets changed.\n');
    process.exit(0);
  }
  process.stderr.write([
    `Immutable browser assets changed but package.json version is still ${result.headVersion}:`,
    ...result.assets.map((file) => `  - ${file}`),
    'Browsers cache these for a year under ?v=<version>. Bump the version (npm version X.Y.Z',
    '--no-git-tag-version), update the ?v= cache keys and the release docs (npm run release:check).',
    '',
  ].join('\n'));
  process.exit(1);
}

module.exports = { evaluate, isImmutableAsset, run, IMMUTABLE_PREFIX, REVALIDATED };
