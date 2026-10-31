// __tests__/discord-link.test.js
// One Discord invite everywhere (owner decision of 2026-10-31): the one the site already links. The old invite
// stayed in the READMEs, SECURITY.md, CODE_OF_CONDUCT.md, the issue template and security.txt.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const INVITE = 'https://discord.gg/sZTgtD7SyB';
const OLD_CODE = ['XGNtYy', 'GbmM'].join(''); // split, so that this file does not carry it either

test('no file of the repository carries the old Discord invite', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  assert.ok(files.length > 100, `only ${files.length} files listed`);
  const hits = files.filter((file) => {
    const full = path.join(ROOT, file);
    return fs.existsSync(full) && fs.statSync(full).isFile() && fs.readFileSync(full, 'latin1').includes(OLD_CODE);
  });
  assert.deepEqual(hits, []);
});

test('every page and document that names the project Discord uses the site invite', () => {
  const files = [
    'README.md',
    'README.ru.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    '.github/ISSUE_TEMPLATE/config.yml',
    'public/.well-known/security.txt',
    'public/index.html',
    'public/en/index.html',
  ];
  for (const file of files) assert.ok(fs.readFileSync(path.join(ROOT, file), 'utf8').includes(INVITE), file);
});
