// __tests__/build-assets.test.js
// Production asset build (scripts/build-assets.js, run in the Docker builder stage): minified
// classic scripts keep their shared top-level names, precompressed siblings decode to the exact
// file, the sources in git are never touched, and the Dockerfile really runs the build.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { test } = require('node:test');

const { build, minify, isInsideGitWorkTree } = require('../scripts/build-assets');

const root = path.resolve(__dirname, '..');
const staticDir = path.join(root, 'public', 'static');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'awg-build-assets-'));

const write = (dir, rel, content) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

// Top-level declarations at column 0 of a readable source file.
const topLevelNames = (source) => [...source.matchAll(
  /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
)].map((m) => m[1] || m[2]);

const declares = (code, name) => {
  const id = name.replace(/\$/g, '\\$');
  return new RegExp(`(?:function\\*?\\s*${id}\\s*\\(|class ${id}\\b|(?:const|let|var)\\s+${id}\\s*=|,${id}\\s*=)`).test(code);
};

test('classic scripts still share top-level const/let/function after minification', async () => {
  // Browser semantics: separate <script> files share one global lexical scope.
  const a = [
    '\'use strict\';',
    'const SHARED_LIMIT = 3;',
    'let sharedCounter = 0;',
    'function bump(step) {\n  sharedCounter += step;\n  return sharedCounter;\n}',
    'class Box {\n  constructor(v) { this.v = v; }\n}',
  ].join('\n');
  const b = 'const result = (() => {\n  const box = new Box(bump(SHARED_LIMIT));\n  return box.v + sharedCounter;\n})();\n';
  const context = vm.createContext({});
  for (const [name, source] of [['a.js', a], ['b.js', b]]) {
    const { code } = await minify(source, '.js', name);
    new vm.Script(code, { filename: name }).runInContext(context);
  }
  assert.equal(new vm.Script('result').runInContext(context), 6);
  assert.equal(new vm.Script('typeof bump').runInContext(context), 'function');
});

test('every public/static script keeps each top-level declaration and stays valid', async () => {
  const files = fs.readdirSync(staticDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('script.js'));
  for (const file of files) {
    const source = fs.readFileSync(path.join(staticDir, file), 'utf8');
    const { code } = await minify(source, '.js', file); // also compiles it as a classic script
    assert.ok(code.length < source.length, `${file} got smaller`);
    for (const name of topLevelNames(source)) {
      assert.ok(declares(code, name), `${file}: top-level "${name}" must survive minification`);
    }
  }
});

test('minification keeps non-ASCII text as UTF-8 and leaves no wrapper', async () => {
  const { code } = await minify('const GREETING = \'Привет\';\nwindow.greet = () => GREETING;\n', '.js', 'x.js');
  assert.match(code, /Привет/);
  assert.match(code, /^const GREETING=/);
  const css = await minify('.a {\n  color: #ff0000;\n  content: "→";\n}\n', '.css', 'x.css');
  assert.match(css.code, /^\.a\{color:red;content:"→"\}/);
});

test('a broken script fails the build', async () => {
  await assert.rejects(minify('const = 1;', '.js', 'broken.js'));
});

test('build minifies static JS/CSS recursively and writes .br/.gz siblings that decode to the file', async () => {
  const dir = tmpDir();
  try {
    const items = Array.from({ length: 200 }, (_, i) => `'item-${i}'`).join(', ');
    const js = `/* readable comment */\nfunction hello(name) {\n  return 'Hello, ' + name;\n}\nconst LIST = [${items}];\n`;
    write(dir, 'static/app.js', js);
    // Distinct rules: esbuild drops duplicate ones.
    write(dir, 'static/nested/extra.css', Array.from({ length: 60 }, (_, i) => `.card-${i} {\n  padding: 0px;\n  margin: ${i}px;\n}\n`).join(''));
    write(dir, 'index.html', `<!doctype html><html><body>${'<p>text</p>\n'.repeat(200)}</body></html>`);
    write(dir, 'locales/en.json', JSON.stringify({ a: 'x'.repeat(500), b: 'y'.repeat(500) }, null, 2));
    write(dir, 'static/logo.png', Buffer.alloc(2048, 7));
    write(dir, 'key.txt', 'abc');

    const { stats, compressed } = await build(dir, { force: true });
    assert.deepEqual(stats.map((s) => s.file).sort(), ['static/app.js', 'static/nested/extra.css']);
    for (const s of stats) assert.ok(s.raw[1] < s.raw[0], `${s.file} minified`);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'static/app.js'), 'utf8'), /readable comment|\n {2}/);

    for (const rel of ['static/app.js', 'static/nested/extra.css', 'index.html', 'locales/en.json']) {
      const plain = fs.readFileSync(path.join(dir, rel));
      assert.ok(compressed.includes(`${rel}.br`) && compressed.includes(`${rel}.gz`), rel);
      assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, `${rel}.br`))), plain, `${rel}.br`);
      assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(dir, `${rel}.gz`))), plain, `${rel}.gz`);
    }
    // Binary formats are not recompressed; a sibling that is not smaller is not written.
    for (const rel of ['static/logo.png', 'key.txt']) {
      assert.ok(!fs.existsSync(path.join(dir, `${rel}.br`)) && !fs.existsSync(path.join(dir, `${rel}.gz`)), rel);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the readable sources in git are protected', async () => {
  assert.equal(isInsideGitWorkTree(path.join(root, 'public')), fs.existsSync(path.join(root, '.git')));
  if (!fs.existsSync(path.join(root, '.git'))) return;
  const before = fs.readFileSync(path.join(staticDir, 'script.js'));
  await assert.rejects(build(path.join(root, 'public')), /inside a git work tree/);
  assert.deepEqual(fs.readFileSync(path.join(staticDir, 'script.js')), before);
  assert.ok(!fs.existsSync(path.join(staticDir, 'script.js.br')));
});

test('esbuild is a pinned devDependency and never a runtime dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.devDependencies.esbuild, /^\d+\.\d+\.\d+$/, 'exact version');
  assert.equal(pkg.dependencies.esbuild, undefined);
});

test('the Docker image is built from minified, precompressed assets', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'deploy', 'Dockerfile'), 'utf8');
  const stages = dockerfile.split(/^FROM\s/m).slice(1);
  assert.equal(stages.length, 2, 'builder + runtime');
  const [builder, runtime] = stages;
  assert.match(builder, /\bAS builder\b/);
  assert.match(builder, /^RUN npm ci --ignore-scripts\b/m, 'builder installs dev dependencies (esbuild)');
  assert.match(builder, /^RUN node scripts\/build-assets\.js public$/m);
  assert.match(runtime, /^RUN npm ci --omit=dev --ignore-scripts\b/m, 'runtime has no dev dependencies');
  assert.match(runtime, /^COPY --from=builder \/build\/public \.\/public$/m);
  assert.doesNotMatch(runtime, /^COPY public\b/m, 'runtime never ships the unbuilt public/');
});
