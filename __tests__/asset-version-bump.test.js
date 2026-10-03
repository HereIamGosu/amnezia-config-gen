const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const { evaluate, isImmutableAsset, run } = require('../scripts/check-asset-version-bump');

const root = path.resolve(__dirname, '..');

test('classification of immutable browser assets', () => {
  assert.equal(isImmutableAsset('public/static/script.js'), true);
  assert.equal(isImmutableAsset('public/static/styles.css'), true);
  assert.equal(isImmutableAsset('public/static/icon-192.png'), true);
  assert.equal(isImmutableAsset('public/static/presets-fallback.json'), false, 'must-revalidate, not immutable');
  assert.equal(isImmutableAsset('public/index.html'), false);
  assert.equal(isImmutableAsset('public/status.html'), false);
  assert.equal(isImmutableAsset('public/locales/ru.json'), false);
  assert.equal(isImmutableAsset('api/status.js'), false);
});

test('decision: changed immutable asset requires a version change', () => {
  assert.equal(evaluate({ changedFiles: ['public/static/script.js'], baseVersion: '2.7.3', headVersion: '2.7.3' }).ok, false);
  assert.equal(evaluate({ changedFiles: ['public/static/script.js'], baseVersion: '2.7.3', headVersion: '2.7.4' }).ok, true);
  assert.equal(evaluate({ changedFiles: ['README.md', 'api/warp.js'], baseVersion: '2.7.3', headVersion: '2.7.3' }).ok, true);
  assert.equal(evaluate({ changedFiles: ['public/static/presets-fallback.json'], baseVersion: '2.7.3', headVersion: '2.7.3' }).ok, true);
  assert.deepEqual(
    evaluate({ changedFiles: ['public/static/a.js', 'docs/x.md', 'public/static/b.css'], baseVersion: '1', headVersion: '1' }).assets,
    ['public/static/a.js', 'public/static/b.css'],
  );
});

test('the classification matches the cache rules in vercel.json', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers;
  const cacheOf = (source) => rules.find((r) => r.source === source)?.headers.find((h) => h.key === 'Cache-Control')?.value;
  assert.match(cacheOf('/static/(.*)'), /immutable/);
  assert.match(cacheOf('/static/presets-fallback.json'), /must-revalidate/);
  const order = rules.map((r) => r.source);
  assert.ok(order.indexOf('/static/presets-fallback.json') > order.indexOf('/static/(.*)'),
    'the last matching rule wins, so the exception must come after /static/(.*)');
  const otherStatic = rules.filter((r) => r.source.startsWith('/static/') && !['/static/(.*)', '/static/presets-fallback.json'].includes(r.source));
  assert.deepEqual(otherStatic, [], 'a new /static rule must be reflected in check-asset-version-bump.js');
});

test('CLI against a real git history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-bump-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const commit = (message) => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q');
    write('package.json', JSON.stringify({ version: '1.0.0' }));
    write('public/static/script.js', 'v1');
    write('public/static/presets-fallback.json', '{}');
    const base = commit('base');

    write('README.md', 'docs');
    write('public/static/presets-fallback.json', '{"a":1}');
    const docsOnly = commit('docs and revalidated json');
    assert.equal(run({ base, head: docsOnly, cwd: dir }).ok, true);

    write('public/static/script.js', 'v2');
    const noBump = commit('asset without bump');
    const failed = run({ base, head: noBump, cwd: dir });
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.assets, ['public/static/script.js']);

    write('package.json', JSON.stringify({ version: '1.0.1' }));
    const bumped = commit('bump');
    assert.equal(run({ base, head: bumped, cwd: dir }).ok, true, 'the push as a whole moved the version');

    git('rm', '-q', 'public/static/script.js');
    const deleted = commit('delete asset');
    assert.equal(run({ base: bumped, head: deleted, cwd: dir }).ok, true, 'a deleted file cannot be served stale');
    write('public/static/new.svg', '<svg/>');
    const added = commit('add asset');
    assert.equal(run({ base: deleted, head: added, cwd: dir }).ok, false, 'an added path may have been cached before');

    const cli = (args) => {
      try {
        execFileSync(process.execPath, [path.join(root, 'scripts', 'check-asset-version-bump.js'), ...args], { cwd: dir, stdio: 'pipe' });
        return 0;
      } catch (err) {
        return err.status;
      }
    };
    assert.equal(cli([base, noBump]), 1);
    assert.equal(cli([base, bumped]), 0);
    assert.equal(cli([]), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CI runs the guard against the PR base or the previous main commit', () => {
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /node scripts\/check-asset-version-bump\.js "\$BASE_SHA" HEAD/);
  assert.match(ci, /github\.event\.pull_request\.base\.sha/);
  assert.match(ci, /github\.event\.before/);
});
