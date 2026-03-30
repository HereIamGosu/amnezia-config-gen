const {
  expandPresetsToSites,
  listPresetsForApi,
  PRESET_GROUP_RF_POPULAR,
  parsePresetKeysFromRequest,
  listDnsPresetsForApi,
  DNS_DEFAULT_KEY,
} = require('./routePresets');
const { fetchCidrsForDomains } = require('./ipListFetch');

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

    const cidrs = await fetchCidrsForDomains(sites);
    res.status(200).json({
      success: true,
      presets: presetKeys,
      sitesQueried: sites.length,
      sites,
      count: cidrs.length,
      cidrs,
    });
  } catch (e) {
    console.error('iplist API:', e);
    res.status(502).json({
      success: false,
      message: e.message || 'Не удалось получить списки IP.',
    });
  }
};
