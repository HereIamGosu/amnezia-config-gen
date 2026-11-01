// src/server/warpEndpointPrefixes.js
// WARP endpoint subnets that no split route may cover (3.1.9, decision No. 18: part (1) of the endpoint cut rule;
// IPv6 from 3.2.0, spec 3.2.0 §5.4 p. 1). Public route lists bring Cloudflare networks that hold them:
// 162.158.0.0/15 of Discord, TikTok, OpenAI and others covers engage.cloudflareclient.com (162.159.192.1) and the
// Endpoint Lab pool, and 2606:4700::/32 of Cloudflare covers engage's 2606:4700:d0::a29f:c001, so a split config
// would route its own Endpoint into the tunnel. The cut is the same in every endpoint mode (I11: Lab Auto and
// hostname give the same AllowedIPs) and applies to preset routes only, never to the full tunnel; the IPv6 part
// only with ipv6=1. 188.114.96.0/22 is shared with ordinary sites and is not cut: the Endpoint choice skips the
// candidates the routes cover, and a manual override's /32 (/128) is cut per request (I15).

'use strict';

const WARP_ENDPOINT_PREFIXES_V4 = Object.freeze(['162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24', '162.159.204.0/24']);
const WARP_ENDPOINT_PREFIXES_V6 = Object.freeze(['2606:4700:d0::/48', '2606:4700:d1::/48']);

module.exports = { WARP_ENDPOINT_PREFIXES_V4, WARP_ENDPOINT_PREFIXES_V6 };
