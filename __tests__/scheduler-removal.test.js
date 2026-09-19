'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Windows scheduler assets and client entry points are absent', () => {
  assert.equal(fs.existsSync(path.join(root, 'public/static/SchedulerAmnezia-15.bat')), false);
  assert.equal(fs.existsSync(path.join(root, 'public/static/SchedulerAmnezia-20.bat')), false);

  const clientSurface = [
    read('public/index.html'),
    read('public/static/script.js'),
    read('public/static/styles.css'),
    read('public/locales/ru.json'),
    read('public/locales/en.json'),
    read('vercel.json'),
  ].join('\n');

  assert.doesNotMatch(clientSurface, /SchedulerAmnezia|schedulerButton|scheduler_|button--scheduler|buttons__scheduler-row/);
});
