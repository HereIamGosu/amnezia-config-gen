// src/server/warpEndpointPrefixes.js
// WARP endpoint subnets that no split route may cover (3.1.9, decision No. 18: part (1) of the endpoint cut rule,
// IPv4 only). Public route lists bring Cloudflare networks that hold them: 162.158.0.0/15 of Discord, TikTok,
// OpenAI and others covers engage.cloudflareclient.com (162.159.192.1) and the Endpoint Lab pool, so a split config
// would route its own Endpoint into the tunnel. The cut is the same in every endpoint mode (I11: Lab Auto and
// hostname give the same AllowedIPs) and applies to preset routes only, never to the full tunnel.
// Not here yet (the endpoint cut patch): the IPv6 prefixes for ipv6=1, the 188.114.96.0/22 rule (shared with
// ordinary sites, solved by the Endpoint choice) and the /32 of a manual override.

'use strict';

const WARP_ENDPOINT_PREFIXES_V4 = Object.freeze(['162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24', '162.159.204.0/24']);

module.exports = { WARP_ENDPOINT_PREFIXES_V4 };
