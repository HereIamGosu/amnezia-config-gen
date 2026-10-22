#!/usr/bin/env node
// One-off helper (not run in CI): extracts the accepted `[Interface]` and `[Peer]` keys of AmneziaWG Apple from a
// local clone and writes __tests__/fixtures/client-key-sets.json.
//
// Usage: node scripts/extract-client-keys.js <path to an amneziawg-apple clone> <tag> [<tag> ...]
// The clone is only read (`git show <tag>:<file>`); nothing from it is executed.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = 'amnezia-vpn/amneziawg-apple';
const FILE = 'Sources/Shared/Model/TunnelConfiguration+WgQuickConfig.swift';
const OUT = path.join(__dirname, '..', '__tests__', 'fixtures', 'client-key-sets.json');

const git = (clone, args) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' }).trim();

/** Quoted strings of the Swift `Set<String>` literal named `name`. */
const swiftSet = (source, name) => {
  const match = new RegExp(`let ${name}: Set<String> = \\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) throw new Error(`${name} not found in ${FILE}`);
  return [...match[1].matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
};

const main = () => {
  const [clone, ...tags] = process.argv.slice(2);
  if (!clone || !tags.length) {
    process.stderr.write('usage: node scripts/extract-client-keys.js <amneziawg-apple clone> <tag> [<tag> ...]\n');
    process.exit(2);
  }
  const extractedAt = new Date().toISOString().slice(0, 10);
  const entries = tags.map((tag) => {
    const source = git(clone, ['show', `${tag}:${FILE}`]);
    return {
      client: 'amneziawg-apple',
      version: tag,
      repo: REPO,
      tag,
      sha: git(clone, ['rev-parse', `${tag}^{commit}`]),
      file: FILE,
      extractedAt,
      caseSensitive: false,
      interfaceKeys: swiftSet(source, 'interfaceSectionKeys'),
      peerKeys: swiftSet(source, 'peerSectionKeys'),
    };
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(entries, null, 2)}\n`);
  for (const e of entries) process.stdout.write(`${e.version} ${e.sha.slice(0, 7)} interface=${e.interfaceKeys.length} peer=${e.peerKeys.length}\n`);
};

main();
