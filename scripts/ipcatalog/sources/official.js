// scripts/ipcatalog/sources/official.js
// Official address lists (spec 3.2.0 §4.2, `{ from: 'official', list }`): what a service publishes about its own
// networks. Each list is one or more URLs and a parser to { cidrs4, cidrs6 }; the builder filters the result.

'use strict';

/** Lines of CIDRs; empty lines and `#` comments skipped. */
const parseCidrText = (text) => {
  const cidrs4 = [];
  const cidrs6 = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    (line.includes(':') ? cidrs6 : cidrs4).push(line);
  }
  return { cidrs4, cidrs6 };
};

/** Google `goog.json` / `cloud.json`: `prefixes[].ipv4Prefix | ipv6Prefix`. */
const parseGoogleRanges = (text) => {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.prefixes)) throw new Error('no prefixes');
  const cidrs4 = [];
  const cidrs6 = [];
  for (const p of doc.prefixes) {
    if (typeof p.ipv4Prefix === 'string') cidrs4.push(p.ipv4Prefix);
    if (typeof p.ipv6Prefix === 'string') cidrs6.push(p.ipv6Prefix);
  }
  return { cidrs4, cidrs6 };
};

// GitHub `meta`: the networks of github.com itself. `actions` (and the other runner/Codespaces roles) are Azure
// addresses of runners, not needed to reach GitHub (01-ip-sources.md, «GitHub»).
const GITHUB_ROLES = Object.freeze(['web', 'api', 'git', 'pages']);

const parseGithubMeta = (text) => {
  const doc = JSON.parse(text);
  const all = [];
  for (const role of GITHUB_ROLES) {
    if (!Array.isArray(doc[role])) throw new Error(`no ${role}`);
    all.push(...doc[role]);
  }
  return parseCidrText(all.join('\n'));
};

/** Official lists by recipe name: the URLs fetched (one source id each) and how to read them. */
const OFFICIAL_LISTS = Object.freeze({
  'google-goog': [{ id: 'google-goog', url: 'https://www.gstatic.com/ipranges/goog.json', parse: parseGoogleRanges }],
  'google-cloud': [{ id: 'google-cloud', url: 'https://www.gstatic.com/ipranges/cloud.json', parse: parseGoogleRanges }],
  telegram: [{ id: 'telegram', url: 'https://core.telegram.org/resources/cidr.txt', parse: parseCidrText }],
  cloudflare: [
    { id: 'cloudflare-v4', url: 'https://www.cloudflare.com/ips-v4', parse: parseCidrText },
    { id: 'cloudflare-v6', url: 'https://www.cloudflare.com/ips-v6', parse: parseCidrText },
  ],
  github: [{ id: 'github-meta', url: 'https://api.github.com/meta', parse: parseGithubMeta }],
  zoom: [{ id: 'zoom', url: 'https://assets.zoom.us/docs/ipranges/Zoom.txt', parse: parseCidrText }],
});

module.exports = { OFFICIAL_LISTS, GITHUB_ROLES, parseCidrText, parseGoogleRanges, parseGithubMeta };
