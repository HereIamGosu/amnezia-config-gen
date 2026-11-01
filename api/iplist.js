// api/iplist.js
// The preset catalogue and the routes of a preset set (3.2.0, spec 3.2.0 §5.1–§5.2). Without `presets`: the catalogue
// with the price of every preset (`routes4` on the AllowedIPs base, `precision`, `noData`, `source`), the categories,
// aliases, retired keys and the snapshot date. With `presets`: the fields of 3.1.9 keep their meaning — `cidrs`,
// `count4`, `count6`, `count` are the raw union of the sources, no cut and no merge between presets
// (.claude/rules/warp-api.md) — and `routes4`/`routes6` are what the config would carry after the WARP endpoint cut
// and the exact merge, the base of the UI counter (K15).

const {
  PRESET_CATEGORY_ORDER,
  PRESET_QUICK_PICK,
  PRESET_ALIASES,
  RETIRED_PRESETS,
  ROUTE_PRESETS,
  listPresetsForApi,
  parsePresetKeysFromRequest,
  listDnsPresetsForApi,
  DNS_DEFAULT_KEY,
} = require('../src/server/routePresets');
const { getCatalog } = require('../src/server/ipCatalog');

const pickQuery = (req, key) => {
  if (req.query && typeof req.query === 'object' && req.query[key] != null) {
    const v = req.query[key];
    return Array.isArray(v) ? String(v[0]) : String(v);
  }
  return undefined;
};

module.exports = async (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'GET') {
    res.status(405).json({ success: false, message: 'Метод не поддерживается.' });
    return;
  }

  try {
    const presetKeys = parsePresetKeysFromRequest(req);
    if (!presetKeys.length) {
      const prices = getCatalog().prices();
      res.status(200).json({
        success: true,
        presets: listPresetsForApi(prices),
        groupRfPopular: PRESET_QUICK_PICK,
        categories: PRESET_CATEGORY_ORDER,
        aliases: PRESET_ALIASES,
        retired: RETIRED_PRESETS,
        catalogBuiltAt: prices ? prices.builtAt : null,
        dnsPresets: listDnsPresetsForApi(),
        dnsDefault: DNS_DEFAULT_KEY,
      });
      return;
    }

    const catalog = getCatalog();
    const plan = catalog.plan(presetKeys);
    if (plan.unknown.length) {
      res.status(400).json({
        success: false,
        message: `Неизвестные пресеты: ${plan.unknown.join(', ')}`,
        unknown: plan.unknown,
      });
      return;
    }
    if (!plan.canonicalKeys.length && !plan.retired.length) {
      res.status(400).json({ success: false, message: 'Не выбрано ни одного домена для запроса.' });
      return;
    }

    const ipv6Param = pickQuery(req, 'ipv6');
    const includeIpv6 = ipv6Param === '1' || ipv6Param === 'true';
    const r = await catalog.resolve(plan, { includeIpv6 });
    const warnings = [...r.warnings];
    if (r.raw4.length && !r.after4) warnings.push('Empty after endpoint cut');
    const sites = Array.from(new Set(plan.canonicalKeys.flatMap((key) => ROUTE_PRESETS[key].domains || []))).sort();
    const cidrs = [...r.raw4, ...r.raw6].sort();

    res.status(200).json({
      success: true,
      presets: presetKeys,
      sitesQueried: sites.length,
      sites,
      count: cidrs.length,
      count4: r.raw4.length,
      count6: r.raw6.length,
      cidrs,
      cidrSource: r.cidrSource,
      routes4: r.after4,
      routes6: r.count6,
      presetStatus: r.presetStatus,
      warnings,
      catalogBuiltAt: plan.snapshot ? plan.snapshot.builtAt : null,
    });
  } catch (e) {
    console.error('iplist API:', e);
    // An unusable catalogue snapshot is a 503 with its fixed text; anything else stays the 502 of before.
    res.status(e.statusCode === 503 ? 503 : 502).json({
      success: false,
      message: e.statusCode === 503 ? e.message : (e.message || 'Не удалось получить списки IP.'),
    });
  }
};
