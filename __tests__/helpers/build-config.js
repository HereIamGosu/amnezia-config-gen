const { __internals } = require('../../api/warp');

const FAKE_PRIV = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const FAKE_PUB = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=';
const FAKE_IPV4 = '172.16.0.2';
const FAKE_IPV6 = '2606:4700:110:858d:e797:4e97:24f7:f7c6';
const FAKE_DNS = '1.1.1.1, 1.0.0.1';
const FAKE_ENDPOINT = 'engage.cloudflareclient.com:4500';

const SAMPLE_I1 = '<b 0xce000000010897a297ecc34cd6dd>';

const buildAwg2WarpConf = ({ i1 = SAMPLE_I1, extraCps = null, mobileJunk = null } = {}) => {
  const obf = __internals.buildAwg2WarpSafeObfuscation();
  return __internals.buildFullConfig(
    'awg2',
    FAKE_PRIV,
    FAKE_PUB,
    FAKE_IPV4,
    FAKE_IPV6,
    FAKE_ENDPOINT,
    obf,
    null,
    FAKE_DNS,
    { i1, awg2WarpSafe: true, plainAddress: true, extraCps, mobileJunk },
  );
};

const buildLegacyConf = ({ i1 = SAMPLE_I1, mobileJunk = null, extraCps = null } = {}) =>
  __internals.buildFullConfig(
    'legacy',
    FAKE_PRIV,
    FAKE_PUB,
    FAKE_IPV4,
    // mobile mode forces IPv4-only end-to-end (mirrors generateWarpConfig in api/warp.js)
    mobileJunk ? null : FAKE_IPV6,
    FAKE_ENDPOINT,
    null,
    null,
    FAKE_DNS,
    { i1, plainAddress: true, mobileJunk, extraCps },
  );

const buildAwg2SelfHostedConf = ({ i1 = '', extraCps = null } = {}) => {
  const obf = __internals.buildAwg2Obfuscation();
  return __internals.buildFullConfig(
    'awg2',
    FAKE_PRIV,
    FAKE_PUB,
    FAKE_IPV4,
    FAKE_IPV6,
    FAKE_ENDPOINT,
    obf,
    null,
    FAKE_DNS,
    { i1, awg2WarpSafe: false, plainAddress: false, extraCps },
  );
};

module.exports = {
  buildAwg2WarpConf,
  buildLegacyConf,
  buildAwg2SelfHostedConf,
  __internals,
  FAKE_DNS,
  FAKE_ENDPOINT,
  SAMPLE_I1,
};
