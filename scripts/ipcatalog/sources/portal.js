// scripts/ipcatalog/sources/portal.js
// Domains of opencck portals (spec 3.2.0 §4.2, `{ from: 'portal', portals }`): the `domains` of
// `config/<group>/<portal>.json` in the rekryt/iplist repository (MIT), pinned to one commit per build. Only the
// domains are taken and resolved by the builder itself; the `ip4`/`ip6`/`cidr4` fields of the configs are not (K9).

'use strict';

const { cleanHostname } = require('./doh');

const REPO = 'rekryt/iplist';
const BRANCH = 'master';
const commitUrl = () => `https://api.github.com/repos/${REPO}/commits/${BRANCH}`;
const treeUrl = (sha) => `https://api.github.com/repos/${REPO}/git/trees/${sha}?recursive=1`;
const rawUrl = (sha, path) => `https://raw.githubusercontent.com/${REPO}/${sha}/${path}`;

/** GitHub tree → portal name → path of its config (`config/<group>/<portal>.json`). */
const parsePortalTree = (text) => {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.tree)) throw new Error('no tree');
  const out = new Map();
  for (const entry of doc.tree) {
    const m = entry.type === 'blob' && /^config\/[^/]+\/(.+)\.json$/.exec(entry.path);
    if (m) out.set(m[1].toLowerCase(), entry.path);
  }
  return out;
};

/** A portal config → its domains: plain hostnames, lower case, unique, sorted. */
const parsePortalConfig = (text) => {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.domains)) throw new Error('no domains');
  return Array.from(new Set(doc.domains.map(cleanHostname).filter(Boolean))).sort();
};

/** Reader of portal domains over one commit of rekryt/iplist; every request at most once per build. */
const createPortalReader = (get) => {
  let pinned = null;
  const configs = new Map();
  const pin = () => {
    if (!pinned) {
      pinned = (async () => {
        const sha = JSON.parse(await get(commitUrl())).sha;
        if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error('no commit sha');
        return { sha, tree: parsePortalTree(await get(treeUrl(sha))) };
      })();
    }
    return pinned;
  };
  return {
    commit: async () => (await pin()).sha,
    domainsOf: async (portal) => {
      const { sha, tree } = await pin();
      const path = tree.get(String(portal).toLowerCase());
      if (!path) throw new Error(`portal ${portal} is not in ${REPO}@${sha}`);
      if (!configs.has(path)) configs.set(path, get(rawUrl(sha, path)).then(parsePortalConfig));
      return configs.get(path);
    },
  };
};

module.exports = { REPO, commitUrl, treeUrl, rawUrl, parsePortalTree, parsePortalConfig, createPortalReader };
