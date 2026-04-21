const {
  expandPresetsToSites,
  listPresetsForApi,
  PRESET_GROUP_RF_POPULAR,
  parsePresetKeysFromRequest,
  listDnsPresetsForApi,
  DNS_DEFAULT_KEY,
} = require('./routePresets');
const { fetchCidrsForDomains } = require('./ipListFetch');

const pickQuery = (req, key) => {
  if (req.query && typeof req.query === 'object' && req.query[key] != null) {
    const v = req.query[key];
    return Array.isArray(v) ? String(v[0]) : String(v);
  }
  return undefined;
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, message: 'Метод не поддерживается.' });
    return;
  }

  try {
    const presetKeys = parsePresetKeysFromRequest(req);
    if (!presetKeys.length) {
      res.status(200).json({
        success: true,
        presets: listPresetsForApi(),
        groupRfPopular: PRESET_GROUP_RF_POPULAR,
        dnsPresets: listDnsPresetsForApi(),
        dnsDefault: DNS_DEFAULT_KEY,
      });
      return;
    }

    const { sites, staticCidrs, unknown } = expandPresetsToSites(presetKeys);
    if (unknown.length) {
      res.status(400).json({
        success: false,
        message: `Неизвестные пресеты: ${unknown.join(', ')}`,
        unknown,
      });
      return;
    }
    if (!sites.length && !staticCidrs.length) {
      res.status(400).json({ success: false, message: 'Не выбрано ни одного домена для запроса.' });
      return;
    }

    const ipv6Param = pickQuery(req, 'ipv6');
    const includeIpv6 = ipv6Param === '1' || ipv6Param === 'true';

    const { isIpv4Cidr } = require('./ipListFetch');

    let cidrs4 = [];
    let cidrSource = 'opencck';

    if (sites.length) {
      // Always fetch IPv4-only CIDRs for the counter (fast, fewer routes)
      const result4 = await fetchCidrsForDomains(sites, { includeIpv6: false });
      cidrs4 = result4.cidrs;
      cidrSource = result4.source;
    }

    // Merge static CIDRs (IPv4 only for the count4 counter)
    const staticV4 = staticCidrs.filter(isIpv4Cidr);
    const merged4 = Array.from(new Set([...cidrs4, ...staticV4])).sort();
    const count4 = merged4.length;

    let cidrs = merged4;
    let count6 = 0;

    if (includeIpv6 && sites.length) {
      const resultAll = await fetchCidrsForDomains(sites, { includeIpv6: true });
      const staticV6 = staticCidrs.filter((c) => !isIpv4Cidr(c));
      cidrs = Array.from(new Set([...resultAll.cidrs, ...staticV6])).sort();
      count6 = cidrs.length - count4;
    } else if (includeIpv6) {
      const staticV6 = staticCidrs.filter((c) => !isIpv4Cidr(c));
      if (staticV6.length) {
        cidrs = Array.from(new Set([...merged4, ...staticV6])).sort();
        count6 = staticV6.length;
      }
    }

    if (!sites.length) cidrSource = 'static';

    res.status(200).json({
      success: true,
      presets: presetKeys,
      sitesQueried: sites.length,
      sites,
      count: cidrs.length,
      count4,
      count6,
      cidrs,
      cidrSource,
    });
  } catch (e) {
    console.error('iplist API:', e);
    res.status(502).json({
      success: false,
      message: e.message || 'Не удалось получить списки IP.',
    });
  }
};
