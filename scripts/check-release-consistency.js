#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function parseArgs(argv) {
  const args = { version: null, tag: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--version') {
      args.version = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--version=')) {
      args.version = arg.slice('--version='.length);
      continue;
    }

    if (arg === '--tag') {
      args.tag = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--tag=')) {
      args.tag = arg.slice('--tag='.length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Any reference to a cache-keyed /static/ asset: relative, root-relative or absolute (og:image, JSON-LD).
function collectVersionedAssetUrls(html) {
  const pattern = /(?<![\w./-])((?:https:\/\/awgconfig\.com)?\/?static\/[^"'\s?#<>]+\?v=([^"'&\s#<>]+))/g;
  return [...html.matchAll(pattern)].map((match) => ({ url: match[1], version: match[2] }));
}

// Every page that loads static/* assets: each needs ?v=<package version> on all of them.
const HTML_ENTRY_POINTS = ['public/index.html', 'public/en/index.html', 'public/status.html', 'public/404.html'];

function checkManifestIconVersions(manifest, packageVersion) {
  const failures = [];
  for (const icon of manifest.icons || []) {
    const version = /\?v=([^&]+)/.exec(icon.src || '')?.[1];
    if (version !== packageVersion) {
      failures.push(`public/site.webmanifest icon ${icon.src} must use ?v=${packageVersion}`);
    }
  }
  return failures;
}

function releaseDateOf(changelog, packageVersion) {
  const match = new RegExp(`^## \\[${escapeRegExp(packageVersion)}\\] - (\\d{4}-\\d{2}-\\d{2})$`, 'm').exec(changelog);
  return match ? match[1] : null;
}

// A lastmod older than the release it ships with teaches search engines to ignore it.
function checkSitemapFreshness(sitemap, releaseDate) {
  const dates = [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((match) => match[1]);
  if (dates.length === 0) return ['public/sitemap.xml has no <lastmod>'];
  return dates
    .filter((date) => !releaseDate || date.slice(0, 10) < releaseDate)
    .map((date) => `public/sitemap.xml lastmod ${date} is older than the release date ${releaseDate}`);
}

function checkSoftwareVersion(html, packageVersion) {
  const versions = [...html.matchAll(/"softwareVersion":\s*"([^"]*)"/g)].map((match) => match[1]);
  if (versions.length !== 1) return [`public/index.html must declare exactly one JSON-LD softwareVersion, found ${versions.length}`];
  return versions[0] === packageVersion ? [] : [`public/index.html JSON-LD softwareVersion ${versions[0]}, expected ${packageVersion}`];
}

// RFC 9116: Expires is mandatory; renew well before it lapses.
function checkSecurityTxtExpiry(text, now = new Date(), minDaysLeft = 30) {
  const value = /^Expires:\s*(\S+)\s*$/m.exec(text)?.[1];
  const expires = value ? new Date(value) : null;
  if (!expires || Number.isNaN(expires.getTime())) return ['public/.well-known/security.txt has no valid Expires'];
  const daysLeft = (expires.getTime() - now.getTime()) / 86_400_000;
  return daysLeft < minDaysLeft
    ? [`public/.well-known/security.txt expires ${value}: renew Expires (less than ${minDaysLeft} days left)`]
    : [];
}

function checkHtmlAssetVersions(htmlByFile, packageVersion) {
  const failures = [];
  for (const [file, html] of Object.entries(htmlByFile)) {
    const assets = collectVersionedAssetUrls(html);
    if (assets.length === 0) {
      failures.push(`${file} has no versioned static assets`);
    }
    for (const asset of assets) {
      if (asset.version !== packageVersion) {
        failures.push(`${file} asset ${asset.url} uses ${asset.version}, expected ${packageVersion}`);
      }
    }
  }
  return failures;
}

function findStaleCurrentVersionClaims(relativePath, packageVersion) {
  if (!exists(relativePath)) {
    return [];
  }

  const claimPattern = /(?:\b(?:current|latest|actual)\b|\u0430\u043a\u0442\u0443\u0430\u043b\u044c\u043d|\u0442\u0435\u043a\u0443\u0449|\u043f\u043e\u0441\u043b\u0435\u0434)/i;
  const versionPattern = /\b\d+\.\d+\.\d+\b/g;

  return readText(relativePath)
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => claimPattern.test(line))
    .flatMap(({ line, lineNumber }) => {
      const versions = line.match(versionPattern) || [];
      return versions
        .filter((version) => version !== packageVersion)
        .map((version) => `${relativePath}:${lineNumber} claims current/latest version ${version}, expected ${packageVersion}`);
    });
}

function runCheckScript(script, label) {
  const result = spawnSync(process.execPath, [script, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });

  if (result.status === 0) {
    return [];
  }

  const output = `${result.stderr || ''}${result.stdout || ''}`.trim();
  return [output || `${label} check failed`];
}

function main() {
  const failures = [];
  const packageJson = readJson('package.json');
  const packageVersion = packageJson.version;
  const args = parseArgs(process.argv.slice(2));
  const targetVersion = args.version || packageVersion;

  if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
    failures.push(`Target version must be semver x.y.z, got: ${targetVersion}`);
  }

  if (packageVersion !== targetVersion) {
    failures.push(`package.json version ${packageVersion} does not match target ${targetVersion}`);
  }

  if (args.tag) {
    const tagVersion = args.tag.startsWith('v') ? args.tag.slice(1) : args.tag;
    if (tagVersion !== packageVersion) {
      failures.push(`tag ${args.tag} does not match package.json version ${packageVersion}`);
    }
  }

  const packageLock = readJson('package-lock.json');
  if (packageLock.version !== packageVersion) {
    failures.push(`package-lock.json root version ${packageLock.version} does not match ${packageVersion}`);
  }

  const lockRoot = packageLock.packages && packageLock.packages[''];
  if (!lockRoot) {
    failures.push('package-lock.json is missing packages[""] root metadata');
  } else if (lockRoot.version !== packageVersion) {
    failures.push(`package-lock.json packages[""].version ${lockRoot.version} does not match ${packageVersion}`);
  }

  const changelog = readText('CHANGELOG.md');
  const releaseHeadingPattern = new RegExp(`^## \\[${escapeRegExp(packageVersion)}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'gm');
  const changelogHeadings = changelog.match(releaseHeadingPattern) || [];
  if (changelogHeadings.length !== 1) {
    failures.push(`CHANGELOG.md must contain exactly one release heading for ${packageVersion}; found ${changelogHeadings.length}`);
  }

  const releaseNotePath = `docs/releases/${packageVersion}.md`;
  if (!exists(releaseNotePath)) {
    failures.push(`${releaseNotePath} is missing`);
  }

  const sourceAuditPath = `docs/releases/${packageVersion}-source-audit.md`;
  if (!exists(sourceAuditPath)) {
    failures.push(`${sourceAuditPath} is missing`);
  }

  failures.push(...checkHtmlAssetVersions(
    Object.fromEntries(HTML_ENTRY_POINTS.map((file) => [file, readText(file)])),
    packageVersion,
  ));
  failures.push(...checkManifestIconVersions(readJson('public/site.webmanifest'), packageVersion));
  failures.push(...checkSoftwareVersion(readText('public/index.html'), packageVersion));
  failures.push(...checkSitemapFreshness(readText('public/sitemap.xml'), releaseDateOf(changelog, packageVersion)));
  failures.push(...checkSecurityTxtExpiry(readText('public/.well-known/security.txt')));

  failures.push(...findStaleCurrentVersionClaims('README.md', packageVersion));
  failures.push(...findStaleCurrentVersionClaims('README.ru.md', packageVersion));
  failures.push(...runCheckScript('scripts/generate-protocol-evidence.js', 'Protocol evidence'));
  failures.push(...runCheckScript('scripts/build-en-page.js', 'English page'));

  if (!exists('docs/releases/RELEASE_LEDGER.md')) {
    failures.push('docs/releases/RELEASE_LEDGER.md is missing');
  } else if (!readText('docs/releases/RELEASE_LEDGER.md').includes(packageVersion)) {
    failures.push(`docs/releases/RELEASE_LEDGER.md does not mention ${packageVersion}`);
  }

  if (!exists('docs/releases/RELEASE_PROCESS.md')) {
    failures.push('docs/releases/RELEASE_PROCESS.md is missing');
  }

  if (failures.length > 0) {
    process.stderr.write('Release consistency check failed:\n');
    for (const failure of failures) {
      process.stderr.write(`- ${failure}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`Release consistency check passed for ${packageVersion}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  checkHtmlAssetVersions,
  checkManifestIconVersions,
  checkSecurityTxtExpiry,
  checkSitemapFreshness,
  checkSoftwareVersion,
  collectVersionedAssetUrls,
  releaseDateOf,
  HTML_ENTRY_POINTS,
};
