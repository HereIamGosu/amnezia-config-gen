/**
 * Route presets: the single source of truth of the catalogue (3.2.0, spec 3.2.0 §3–§4.1). A preset has a Russian
 * `label` for the API (the UI shows `preset_<key>` from the locales), a `category` of PRESET_CATEGORY_ORDER, its
 * `domains` and an `ip` recipe that `npm run ipcatalog:build` turns into src/server/ipCatalog/snapshot.json:
 *   { from: 'official', list, allowWide? }  an official list (scripts/ipcatalog/sources/official.js)
 *   { from: 'asn', asns, minus? }           announced prefixes (ipverse, iptoasn); minus 'google-cloud' = cloud.json
 *   { from: 'resolve', domains? }           own DoH resolution of the preset's domains
 *   { from: 'portal', portals }             own resolution of the domains of opencck portals (rekryt/iplist, MIT)
 *   { from: 'static', cidrs4, cidrs6?, source, date }
 * A transitional preset (`legacy`, spec §4.5) takes its routes from opencck and itdoginfo at request time, each on its
 * own call; its recipe builds the reserve used when that call gives no IPv4. Transitional in 3.2.0: youtube, the
 * three Meta presets and discord (K1), and every preset that took opencck addresses in 3.1.9 and whose recipe covered
 * less than 90 % of the reference addresses in the first build (spec §9 p. 3; the build summary names them).
 */
const ROUTE_PRESETS = {
  youtube: {
    label: 'YouTube',
    category: 'video',
    domains: ['youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtubei.googleapis.com'],
    legacy: {},
    ip: [{ from: 'asn', asns: [15169, 36040, 43515, 19527, 16550, 36384, 139070, 139190, 41264], minus: 'google-cloud' }],
  },
  twitch: {
    label: 'Twitch',
    category: 'video',
    domains: ['twitch.tv', 'ttvnw.net', 'jtvnw.net'],
    ip: [{ from: 'resolve' }],
  },
  telegram: {
    label: 'Telegram',
    category: 'messengers',
    domains: ['telegram.org'],
    // Transitional (owner, 2026-11-01): the recipe covered 5.1 % of the reference, below the 90 % of spec §9 p. 3 for
    // official/AS recipes. The live path is that of 3.1.9: the lists plus these nine networks of cidr.txt.
    legacy: {
      cidrs4: ['91.108.4.0/22', '91.108.8.0/22', '91.108.12.0/22', '91.108.16.0/22', '91.108.20.0/22', '91.108.56.0/22',
        '91.105.192.0/23', '149.154.160.0/20', '185.76.151.0/24'],
    },
    // cidr.txt has not changed since 2021-10-01 and lacks 95.161.64.0/20: the announcements of the AS fill it.
    ip: [{ from: 'official', list: 'telegram' }, { from: 'asn', asns: [62041, 62014, 59930, 44907, 211157] }],
  },
  discord: {
    label: 'Discord',
    category: 'messengers',
    domains: ['discord.com', 'discord.gg', 'discord.media', 'discordapp.com', 'discordapp.net'],
    legacy: { communityLists: ['Discord'] },
    ip: [
      { from: 'static', cidrs4: ['66.22.192.0/18'], source: 'Discord network announced by i3D.net and Google (03-service-footprints.md)', date: '2026-10-31' },
      { from: 'portal', portals: ['discord.com'] },
    ],
  },
  whatsapp: {
    label: 'WhatsApp',
    category: 'messengers',
    domains: ['whatsapp.com', 'web.whatsapp.com', 'cdn.whatsapp.net', 'graph.whatsapp.com'],
    legacy: { communityLists: ['Meta'] },
    ip: [{ from: 'asn', asns: [32934, 63293, 54115] }],
  },
  viber: {
    label: 'Viber',
    category: 'messengers',
    domains: ['viber.com', 'account.viber.com', 'media.cdn.viber.com', 'activate.viber.com'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['viber.com'] }],
  },
  signal: {
    label: 'Signal',
    category: 'messengers',
    domains: ['signal.org'],
    ip: [{ from: 'portal', portals: ['signal.org'] }],
  },
  instagram: {
    label: 'Instagram',
    category: 'social',
    domains: ['instagram.com', 'cdninstagram.com', 'fbcdn.net'],
    legacy: { communityLists: ['Meta'] },
    ip: [{ from: 'asn', asns: [32934, 63293, 54115] }],
  },
  facebook: {
    label: 'Facebook',
    category: 'social',
    domains: ['facebook.com', 'fb.com', 'fbsbx.com'],
    legacy: { communityLists: ['Meta'] },
    ip: [{ from: 'asn', asns: [32934, 63293, 54115] }],
  },
  twitter: {
    label: 'X (Twitter)',
    category: 'social',
    domains: ['twitter.com', 'x.com', 'twimg.com', 't.co', 'pbs.twimg.com'],
    legacy: { communityLists: ['Twitter'] },
    ip: [{ from: 'portal', portals: ['x.com'] }, { from: 'asn', asns: [13414, 35995, 63179] }],
  },
  linkedin: {
    label: 'LinkedIn',
    category: 'social',
    domains: ['linkedin.com', 'licdn.com'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['linkedin.com'] }],
  },
  snapchat: {
    label: 'Snapchat',
    category: 'social',
    domains: ['snapchat.com'],
    ip: [{ from: 'portal', portals: ['snapchat.com'] }],
  },
  reddit: {
    label: 'Reddit',
    category: 'social',
    domains: ['reddit.com', 'redditmedia.com', 'redd.it'],
    ip: [{ from: 'resolve' }],
  },
  tiktok: {
    label: 'TikTok',
    category: 'social',
    domains: ['tiktok.com', 'tiktokcdn.com', 'ttlivecdn.com'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['tiktok.com'] }],
  },
  rutracker: {
    label: 'RuTracker',
    category: 'torrent',
    // .me and .nl were the separate preset rutracker_local before 3.2.0 (now its alias).
    domains: ['rutracker.org', 'rutracker.net', 'bt.t-ru.org', 'rutracker.cc', 'rutracker.me', 'rutracker.nl'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['rutracker.org'] }, { from: 'resolve' }],
  },
  rutor: {
    label: 'Rutor',
    category: 'torrent',
    domains: ['rutor.org', 'rutor.info', 'rutor.is', 'rutor.lib'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['rutor.info'] }],
  },
  nnmclub: {
    label: 'NNM-Club',
    category: 'torrent',
    domains: ['nnmclub.to', 'nnm-club.me', 'nnmclub.ro', 'nnm-club.info'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['nnmclub.to'] }],
  },
  kinozal: {
    label: 'Kinozal',
    category: 'torrent',
    domains: ['kinozal.tv', 'kinozal.me', 'kinozal.guru'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['kinozal.tv', 'kinozal.me'] }],
  },
  tapochek: {
    label: 'Tapochek',
    category: 'torrent',
    domains: ['tapochek.net', 'tapochek.club'],
    ip: [{ from: 'resolve' }],
  },
  torrent_more: {
    label: 'Другие трекеры',
    category: 'torrent',
    domains: ['1337x.to', 'thepiratebay.org', 'rustorka.com', 'newstudio.tv', 'booktracker.org', 'nyaa.si'],
    ip: [{ from: 'portal', portals: ['1337x.to', 'thepiratebay.org', 'rustorka.com', 'newstudio.tv', 'booktracker.org', 'nyaa.si'] }],
  },
  hdrezka: {
    label: 'HDrezka',
    category: 'media',
    domains: ['hdrezka.ag', 'hdrezka.me', 'rezka.ag', 'voidboost.net', 'rezka.cc'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['hdrezka.ag'] }],
  },
  animego: {
    label: 'AnimeGo',
    category: 'media',
    domains: ['animego.ru', 'animego.org', 'animego.me', 'animego.la'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['animego.org'] }],
  },
  netflix: {
    label: 'Netflix',
    category: 'media',
    domains: ['netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxso.net'],
    legacy: {},
    ip: [{ from: 'asn', asns: [2906] }, { from: 'portal', portals: ['netflix.com'] }],
  },
  spotify: {
    label: 'Spotify',
    category: 'media',
    domains: ['spotify.com', 'scdn.co', 'spotifycdn.com'],
    // AS8403 of Spotify announces nothing (03-service-footprints.md): resolution only.
    legacy: {},
    ip: [{ from: 'portal', portals: ['spotify.com'] }],
  },
  cinema_more: {
    label: 'Другие кинотеатры и аниме',
    category: 'media',
    domains: ['filmix.fm', 'lostfilm.tv', 'seasonvar.ru', 'kinobase.org', 'jut.su', 'anilibria.tv', 'animevost.org', 'shikimori.one', 'crunchyroll.com'],
    ip: [{ from: 'portal', portals: ['filmix.fm', 'lostfilm.tv', 'seasonvar.ru', 'kinobase.org', 'jut.su', 'anilibria.tv', 'animevost.org', 'shikimori.one', 'crunchyroll.com'] }],
  },
  steam: {
    label: 'Steam',
    category: 'gaming',
    domains: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamusercontent.com'],
    ip: [{ from: 'asn', asns: [32590] }],
  },
  roblox: {
    label: 'Roblox',
    category: 'gaming',
    domains: ['roblox.com'],
    ip: [{ from: 'asn', asns: [22697, 11281] }, { from: 'resolve' }],
  },
  itch_io: {
    label: 'Itch.io',
    category: 'gaming',
    domains: ['itch.io', 'html.itch.zone', 'static.itch.io'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['itch.io'] }],
  },
  epic_games: {
    label: 'Epic Games Store',
    category: 'gaming',
    domains: ['epicgames.com', 'launcher.store.epicgames.com', 'cdn1.unrealengine.com'],
    ip: [{ from: 'resolve' }],
  },
  battle_net: {
    label: 'Battle.net',
    category: 'gaming',
    domains: ['battle.net', 'blizzard.com', 'bnetcmsus-a.akamaihd.net'],
    ip: [{ from: 'asn', asns: [57976] }, { from: 'resolve' }],
  },
  openai: {
    label: 'ChatGPT',
    category: 'ai',
    domains: ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['chatgpt.com'] }],
  },
  google: {
    label: 'Google (поиск, почта, Play)',
    category: 'work',
    domains: ['google.com', 'gstatic.com', 'googleapis.com', 'gmail.com', 'googleusercontent.com'],
    // Google's own AS without the addresses of Google Cloud customers (cloud.json), as Google asks.
    ip: [{ from: 'asn', asns: [15169, 36040, 43515, 19527, 16550, 36384, 139070, 139190, 41264], minus: 'google-cloud' }],
  },
  github: {
    label: 'GitHub',
    category: 'work',
    domains: ['github.com', 'githubusercontent.com', 'raw.githubusercontent.com'],
    ip: [{ from: 'official', list: 'github' }, { from: 'asn', asns: [36459] }],
  },
  proton: {
    label: 'Proton',
    category: 'work',
    domains: ['proton.me', 'protonmail.com', 'pm.me'],
    legacy: {},
    ip: [{ from: 'asn', asns: [62371, 209103, 199218] }, { from: 'portal', portals: ['proton.me'] }],
  },
  notion: {
    label: 'Notion',
    category: 'work',
    domains: ['notion.so', 'notionusercontent.com'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['notion.so'] }],
  },
  zoom: {
    label: 'Zoom',
    category: 'work',
    domains: ['zoom.us', 'zoomgov.com', 'zoom.com'],
    ip: [{ from: 'official', list: 'zoom' }],
  },
  microsoft: {
    label: 'Microsoft / Outlook',
    category: 'work',
    domains: ['microsoft.com', 'live.com', 'outlook.com', 'office.com', 'office365.com'],
    ip: [{ from: 'resolve' }],
  },
  cloudflare: {
    label: 'Cloudflare (сайты за ним)',
    category: 'infra',
    domains: ['cloudflare.com', 'one.one.one.one'],
    // The WARP endpoint subnets inside these networks are cut per request (I14), never in the snapshot.
    ip: [{ from: 'official', list: 'cloudflare' }],
  },
  bestchange: {
    label: 'BestChange',
    category: 'other',
    domains: ['bestchange.ru', 'bestchange.com', 'www.bestchange.ru'],
    legacy: {},
    ip: [{ from: 'portal', portals: ['bestchange.ru'] }],
  },
  control4: {
    label: 'Control4',
    category: 'other',
    domains: [],
    ip: [{
      from: 'static',
      // AWS Global Accelerator anycast 75.2.70.75, 99.83.190.102 (control4.com, snapone.com, ovrc.com); AWS us-east-2
      // 13.59.205.187 (api.control4.com); Cloudflare 104.18.14.48, 104.18.15.48, 104.18.30.8, 104.18.31.8
      // (my/customer.control4.com, snapav.com).
      cidrs4: ['75.2.70.75/32', '99.83.190.102/32', '13.59.205.187/32', '104.18.14.48/32', '104.18.15.48/32', '104.18.30.8/32', '104.18.31.8/32'],
      source: 'DNS resolution of the Control4 domains (commit 2f2eb54)',
      date: '2026-06-05',
    }],
  },
  misc_blocked: {
    label: 'SoundCloud, Medium, Patreon и др.',
    category: 'other',
    domains: ['soundcloud.com', 'medium.com', 'patreon.com', 'grammarly.com', 'myanimelist.net'],
    ip: [{ from: 'portal', portals: ['soundcloud.com', 'medium.com', 'patreon.com', 'grammarly.com', 'myanimelist.net'] }],
  },
};

/** Category blocks of the catalogue, in display order; the UI titles them with `section_<key>`. */
const PRESET_CATEGORY_ORDER = Object.freeze(['video', 'messengers', 'social', 'torrent', 'media', 'gaming', 'ai', 'work', 'infra', 'other']);

/** The «Основной набор» button (K12); the API field keeps its old name `groupRfPopular`. */
const PRESET_QUICK_PICK = Object.freeze(['youtube', 'telegram', 'discord', 'cloudflare', 'twitter', 'github', 'rutracker']);

/** Old keys that resolve to another preset: links and API calls of earlier versions keep working. */
const PRESET_ALIASES = Object.freeze({ rutracker_local: 'rutracker' });

/**
 * Russian services taken out of the catalogue in 3.2.0 (K3): reachable directly in Russia, and some refuse visitors
 * through VPN. The server skips them with a warning; a set made only of them is refused before registration.
 */
const RETIRED_PRESETS = Object.freeze(['vk', 'ok', 'yandex', 'dzen', 'rutube', 'mailru', 'wildberries', 'ozon', 'avito', 'kinopoisk', 'twogis', 'max_messenger']);

/** Kept for the API field `groupRfPopular` and older callers: the quick pick. */
const PRESET_GROUP_RF_POPULAR = PRESET_QUICK_PICK;

const normalizePresetKey = (raw) =>
  String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');

/**
 * Domains, static networks and itdoginfo lists of a set of presets (aliases applied). Retired and unknown keys are
 * listed in `unknown`. The request path resolves presets through src/server/ipCatalog; this stays for tools.
 */
const expandPresetsToSites = (presetKeys) => {
  const seenSites = new Set();
  const seenCidrs = new Set();
  const seenCommunity = new Set();
  const unknown = [];
  for (const key of presetKeys) {
    const raw = normalizePresetKey(key);
    if (!raw) continue;
    const k = PRESET_ALIASES[raw] || raw;
    const def = ROUTE_PRESETS[k];
    if (!def) {
      unknown.push(raw);
      continue;
    }
    for (const s of (def.domains || [])) {
      seenSites.add(s.trim().toLowerCase());
    }
    for (const step of (def.ip || [])) {
      if (step.from === 'static') for (const c of [...step.cidrs4, ...(step.cidrs6 || [])]) seenCidrs.add(c.trim());
    }
    for (const l of ((def.legacy && def.legacy.communityLists) || [])) {
      seenCommunity.add(String(l).trim());
    }
  }
  return {
    sites: Array.from(seenSites).sort(),
    staticCidrs: Array.from(seenCidrs),
    communityLists: Array.from(seenCommunity),
    unknown,
  };
};

/**
 * The catalogue for /api/iplist and presets-fallback.json, by category order. With `prices` (the snapshot prices of
 * src/server/ipCatalog) every preset also carries `routes4`, `precision`, `noData` and `source` (catalog | live).
 * @param {{ presets: Record<string, { routes4: number, precision: string|null, noData: string|null, source: string }> } | null} [prices]
 */
const listPresetsForApi = (prices = null) => {
  const out = [];
  for (const category of PRESET_CATEGORY_ORDER) {
    for (const [id, v] of Object.entries(ROUTE_PRESETS)) {
      if (v.category !== category) continue;
      const price = prices && prices.presets[id];
      out.push({
        id,
        label: v.label,
        sitesCount: (v.domains || []).length,
        category,
        ...(price ? { routes4: price.routes4, precision: price.precision, noData: price.noData, source: price.source } : {}),
      });
    }
  }
  return out;
};

/**
 * @param {import('http').IncomingMessage} req
 * @returns {string[]}
 */
const parsePresetKeysFromRequest = (req) => {
  const out = [];
  const add = (s) => {
    const t = String(s).trim();
    if (t) out.push(t);
  };
  if (req.query && typeof req.query === 'object') {
    const single = req.query.presets || req.query.preset;
    if (typeof single === 'string') {
      single.split(/[,;]+/).forEach(add);
    } else if (Array.isArray(single)) {
      single.forEach((x) => String(x).split(/[,;]+/).forEach(add));
    }
    const many = req.query.p;
    if (Array.isArray(many)) many.forEach(add);
    else if (typeof many === 'string') add(many);
  }
  if (!out.length && req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const p = u.searchParams.get('presets') || u.searchParams.get('preset');
      if (p) p.split(/[,;]+/).forEach(add);
      u.searchParams.getAll('p').forEach(add);
    } catch {
      /* ignore */
    }
  }
  const seen = new Set();
  return out
    .map((x) => x.trim().toLowerCase())
    .filter((x) => {
      if (!x || seen.has(x)) return false;
      seen.add(x);
      return true;
    });
};

const DNS_PRESETS = {
  cloudflare: {
    label: 'Cloudflare',
    // Order matches typical WARP / 1.1.1.1 app export: IPv4 primary, IPv4 secondary, then IPv6 pair.
    dns: '1.1.1.1, 1.0.0.1, 2606:4700:4700::1111, 2606:4700:4700::1001',
  },
  google: {
    label: 'Google',
    dns: '8.8.8.8, 2001:4860:4860::8888, 8.8.4.4, 2001:4860:4860::8844',
  },
  yandex: {
    label: 'Яндекс',
    dns: '77.88.8.8, 2a02:6b8::feed:0ff, 77.88.8.1, 2a02:6b8:0:1::feed:0ff',
  },
  yandex_safe: {
    label: 'Яндекс Безопасный',
    dns: '77.88.8.88, 2a02:6b8::feed:bad, 77.88.8.2, 2a02:6b8:0:1::feed:bad',
  },
  adguard: {
    label: 'AdGuard',
    dns: '94.140.14.14, 2a10:50c0::ad1:ff, 94.140.15.15, 2a10:50c0::ad2:ff',
  },
  quad9: {
    label: 'Quad9',
    dns: '9.9.9.9, 2620:fe::fe, 149.112.112.112, 2620:fe::9',
  },
  comss_one: {
    label: 'Comss.one',
    // IPv6 не публикуются провайдером. Источник: comss.ru/page.php?id=7315
    dns: '83.220.169.155, 212.109.195.93',
  },
  malw_link: {
    label: 'malw.link',
    dns: '80.253.249.40, 193.23.209.189, 2a12:bec4:1460:5b7::2, 2a01:ecc0:680:120::2',
  },
};

const DNS_DEFAULT_KEY = 'cloudflare';

const listDnsPresetsForApi = () =>
  Object.entries(DNS_PRESETS).map(([id, v]) => ({
    id,
    label: id === DNS_DEFAULT_KEY ? `${v.label} (по умолчанию)` : v.label,
  }));

const getDnsString = (key) => {
  const k = normalizePresetKey(key);
  const def = DNS_PRESETS[k];
  return def ? def.dns : DNS_PRESETS[DNS_DEFAULT_KEY].dns;
};

const parseDnsKeyFromRequest = (req) => {
  let raw = '';
  if (req.query && typeof req.query === 'object') {
    raw = String(req.query.dns || '');
  }
  if (!raw && req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      raw = u.searchParams.get('dns') || '';
    } catch {
      /* ignore */
    }
  }
  const k = normalizePresetKey(raw);
  return k && DNS_PRESETS[k] ? k : '';
};

module.exports = {
  ROUTE_PRESETS,
  PRESET_CATEGORY_ORDER,
  PRESET_QUICK_PICK,
  PRESET_ALIASES,
  RETIRED_PRESETS,
  PRESET_GROUP_RF_POPULAR,
  expandPresetsToSites,
  listPresetsForApi,
  normalizePresetKey,
  parsePresetKeysFromRequest,
  DNS_PRESETS,
  DNS_DEFAULT_KEY,
  listDnsPresetsForApi,
  getDnsString,
  parseDnsKeyFromRequest,
};
