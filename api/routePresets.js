/**
 * Curated hostname lists per preset (resolved to AllowedIPs CIDRs on the server). Each preset has id and category for UI.
 */
const ROUTE_PRESETS = {
  youtube: {
    label: 'YouTube',
    category: 'social',
    sites: [
      'youtube.com',
      'youtu.be',
      'googlevideo.com',
      'ytimg.com',
      'ggpht.com',
      'youtubei.googleapis.com',
    ],
  },
  discord: {
    label: 'Discord',
    category: 'social',
    sites: [
      'discord.com',
      'discord.gg',
      'discord.media',
      'discordapp.com',
      'discordapp.net',
    ],
  },
  whatsapp: {
    label: 'WhatsApp',
    category: 'social',
    sites: [
      'whatsapp.com',
      'web.whatsapp.com',
      'cdn.whatsapp.net',
      'graph.whatsapp.com',
    ],
  },
  telegram: {
    label: 'Telegram',
    category: 'social',
    sites: [
      'telegram.org',
      't.me',
      'web.telegram.org',
      'core.telegram.org',
      'telegra.ph',
    ],
  },
  twitter: {
    label: 'X (Twitter)',
    category: 'social',
    sites: ['twitter.com', 'x.com', 'twimg.com', 't.co', 'pbs.twimg.com'],
  },
  instagram: {
    label: 'Instagram',
    category: 'social',
    sites: ['instagram.com', 'cdninstagram.com', 'fbcdn.net'],
  },
  facebook: {
    label: 'Facebook',
    category: 'social',
    sites: ['facebook.com', 'fb.com', 'fbsbx.com'],
  },
  viber: {
    label: 'Viber',
    category: 'social',
    sites: [
      'viber.com',
      'account.viber.com',
      'media.cdn.viber.com',
      'activate.viber.com',
    ],
  },
  tiktok: {
    label: 'TikTok',
    category: 'social',
    sites: ['tiktok.com', 'tiktokcdn.com', 'ttlivecdn.com'],
  },
  itch_io: {
    label: 'Itch.io',
    category: 'gaming',
    sites: ['itch.io', 'html.itch.zone', 'static.itch.io'],
  },
  steam: {
    label: 'Steam',
    category: 'gaming',
    sites: [
      'steampowered.com',
      'steamcommunity.com',
      'steamstatic.com',
      'steamusercontent.com',
    ],
  },
  epic_games: {
    label: 'Epic Games Store',
    category: 'gaming',
    sites: [
      'epicgames.com',
      'launcher.store.epicgames.com',
      'cdn1.unrealengine.com',
    ],
  },
  battle_net: {
    label: 'Battle.net (Blizzard)',
    category: 'gaming',
    sites: ['battle.net', 'blizzard.com', 'bnetcmsus-a.akamaihd.net'],
  },
  rutracker: {
    label: 'RuTracker',
    category: 'torrent',
    sites: ['rutracker.org', 'rutracker.net', 'bt.t-ru.org', 'rutracker.cc'],
  },
  rutor: {
    label: 'Rutor',
    category: 'torrent',
    sites: ['rutor.org', 'rutor.info', 'rutor.is', 'rutor.lib'],
  },
  nnmclub: {
    label: 'NNM-Club',
    category: 'torrent',
    sites: ['nnmclub.to', 'nnm-club.me', 'nnmclub.ro', 'nnm-club.info'],
  },
  kinozal: {
    label: 'Kinozal',
    category: 'torrent',
    sites: ['kinozal.tv', 'kinozal.me', 'kinozal.guru'],
  },
  tapochek: {
    label: 'Tapochek',
    category: 'torrent',
    sites: ['tapochek.net', 'tapochek.club'],
  },
  rutracker_local: {
    label: 'RuTracker (зеркала .me/.nl)',
    category: 'torrent',
    sites: ['rutracker.me', 'rutracker.nl'],
  },
  bestchange: {
    label: 'BestChange',
    category: 'more',
    popular: true,
    sites: ['bestchange.ru', 'bestchange.com', 'www.bestchange.ru'],
  },
  animego: {
    label: 'AnimeGo',
    category: 'more',
    popular: true,
    sites: ['animego.ru', 'animego.org', 'animego.me', 'animego.la'],
  },
  roblox: {
    label: 'Roblox',
    category: 'more',
    sites: ['roblox.com'],
  },
  hdrezka: {
    label: 'HDrezka',
    category: 'more',
    popular: true,
    sites: [
      'hdrezka.ag',
      'hdrezka.me',
      'rezka.ag',
      'voidboost.net',
      'rezka.cc',
    ],
  },
  spotify: {
    label: 'Spotify',
    category: 'more',
    popular: true,
    sites: ['spotify.com', 'scdn.co', 'spotifycdn.com'],
  },
  openai: {
    label: 'ChatGPT / OpenAI',
    category: 'more',
    popular: true,
    sites: ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com'],
  },
  notion: {
    label: 'Notion',
    category: 'more',
    popular: true,
    sites: ['notion.so', 'notionusercontent.com'],
  },
  linkedin: {
    label: 'LinkedIn',
    category: 'more',
    popular: true,
    sites: ['linkedin.com', 'licdn.com'],
  },
  vk: {
    label: 'ВКонтакте',
    category: 'more',
    sites: ['vk.com', 'vk-portal.net', 'userapi.com', 'vkuseraudio.net'],
  },
  ok: {
    label: 'Одноклассники',
    category: 'more',
    sites: ['ok.ru', 'odnoklassniki.ru'],
  },
  yandex: {
    label: 'Яндекс',
    category: 'more',
    sites: ['yandex.ru', 'yandex.net', 'ya.ru', 'yastatic.net'],
  },
  dzen: {
    label: 'Дзен',
    category: 'more',
    sites: ['dzen.ru', 'zen.yandex.ru', 'zen.yandex.net'],
  },
  rutube: {
    label: 'Rutube',
    category: 'more',
    sites: ['rutube.ru', 'static.rutube.ru', 'pic.rutubelist.ru'],
  },
  mailru: {
    label: 'Mail.ru',
    category: 'more',
    sites: ['mail.ru', 'e.mail.ru', 'imgsmail.ru', 'attachmail.ru'],
  },
  wildberries: {
    label: 'Wildberries',
    category: 'more',
    sites: [
      'wildberries.ru',
      'wbbasket.ru',
      'wbcontent.net',
      'wbx-content-v2.wbstatic.net',
    ],
  },
  ozon: {
    label: 'Ozon',
    category: 'more',
    sites: ['ozon.ru', 'ozonusercontent.com', 'cdn1.ozone.ru'],
  },
  avito: {
    label: 'Avito',
    category: 'more',
    sites: ['avito.ru', 'avito.st', 'www.avito.st'],
  },
  kinopoisk: {
    label: 'Кинопоиск',
    category: 'more',
    sites: ['kinopoisk.ru', 'hd.kinopoisk.ru'],
  },
  twogis: {
    label: '2ГИС',
    category: 'more',
    sites: ['2gis.ru', '2gis.com', 'map.2gis.com', 'api.2gis.com'],
  },
  max_messenger: {
    label: 'MAX (мессенджер)',
    category: 'more',
    sites: ['max.ru', 'web.max.ru', 'api.max.ru'],
  },
  reddit: {
    label: 'Reddit',
    category: 'more',
    sites: ['reddit.com', 'redditmedia.com', 'redd.it'],
  },
  github: {
    label: 'GitHub',
    category: 'more',
    sites: ['github.com', 'githubusercontent.com', 'raw.githubusercontent.com'],
  },
  netflix: {
    label: 'Netflix',
    category: 'more',
    sites: ['netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxso.net'],
  },
  twitch: {
    label: 'Twitch',
    category: 'more',
    sites: ['twitch.tv', 'ttvnw.net', 'jtvnw.net'],
  },
  google: {
    label: 'Google (общий)',
    category: 'more',
    sites: [
      'google.com',
      'gstatic.com',
      'googleapis.com',
      'gmail.com',
      'googleusercontent.com',
    ],
  },
  cloudflare: {
    label: 'Cloudflare',
    category: 'more',
    sites: ['cloudflare.com', 'one.one.one.one'],
  },
  microsoft: {
    label: 'Microsoft / Outlook',
    category: 'more',
    sites: [
      'microsoft.com',
      'live.com',
      'outlook.com',
      'office.com',
      'office365.com',
    ],
  },
  zoom: {
    label: 'Zoom',
    category: 'more',
    sites: ['zoom.us', 'zoomgov.com', 'zoom.com'],
  },
  proton: {
    label: 'Proton',
    category: 'more',
    sites: ['proton.me', 'protonmail.com', 'pm.me'],
  },
  control4: {
    label: 'Control4 (умный дом)',
    category: 'more',
    sites: [
      'control4.com',
      'my.control4.com',
      'customer.control4.com',
      'api.control4.com',
      'snapav.com',
      'snapone.com',
      'ovrc.com',
    ],
  },
};

const PRESET_CATEGORY_ORDER = ['social', 'gaming', 'torrent', 'more'];

/** Быстрый выбор: все пресеты вне «more», плюс записи more с popular: true. */
const PRESET_GROUP_RF_POPULAR = Object.entries(ROUTE_PRESETS)
  .filter(([, v]) => v.category !== 'more' || v.popular === true)
  .map(([id]) => id);

const normalizePresetKey = (raw) =>
  String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');

const expandPresetsToSites = (presetKeys) => {
  const seenSites = new Set();
  const unknown = [];
  for (const key of presetKeys) {
    const k = normalizePresetKey(key);
    if (!k) continue;
    const def = ROUTE_PRESETS[k];
    if (!def) {
      unknown.push(k);
      continue;
    }
    for (const s of def.sites) {
      seenSites.add(s.trim().toLowerCase());
    }
  }
  return { sites: Array.from(seenSites).sort(), unknown };
};

const listPresetsForApi = () => {
  const out = [];
  for (const category of PRESET_CATEGORY_ORDER) {
    for (const [id, v] of Object.entries(ROUTE_PRESETS)) {
      if (v.category !== category) continue;
      out.push({
        id,
        label: v.label,
        sitesCount: v.sites.length,
        category,
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
  PRESET_GROUP_RF_POPULAR,
  PRESET_CATEGORY_ORDER,
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
