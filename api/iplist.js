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

    const { sites, unknown } = expandPresetsToSites(presetKeys);
    if (unknown.length) {
      res.status(400).json({
        success: false,
        message: `Неизвестные пресеты: ${unknown.join(', ')}`,
        unknown,
      });
      return;
    }
    if (!sites.length) {
      res.status(400).json({ success: false, message: 'Не выбрано ни одного домена для запроса.' });
      return;
    }

    const ipv6Param = pickQuery(req, 'ipv6');
    const includeIpv6 = ipv6Param === '1' || ipv6Param === 'true';

    // Always fetch IPv4-only CIDRs for the counter (fast, fewer routes)
    const result4 = await fetchCidrsForDomains(sites, { includeIpv6: false });
    const cidrs4 = result4.cidrs;
    const count4 = cidrs4.length;
    const cidrSource = result4.source;

    let cidrs = cidrs4;
    let count6 = 0;

    if (includeIpv6) {
      const resultAll = await fetchCidrsForDomains(sites, { includeIpv6: true });
      count6 = resultAll.cidrs.length - count4;
      cidrs = resultAll.cidrs;
    }

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
