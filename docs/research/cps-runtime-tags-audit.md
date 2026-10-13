# CPS runtime tags in I2–I5: source audit

Checked 2026-10-13. Used for `src/server/cpsExtraPackets.js` (`cps5=1`). No upstream code was copied; only the tag
semantics below were taken from the sources.

## Sources

| Repository | Revision | Files |
|---|---|---|
| amnezia-vpn/amneziawg-go | master = `b5928efb6ca19f0153958460c3d141f04abc5c2e` | `device/obf.go`, `device/obf_bytes.go`, `device/obf_rand.go`, `device/obf_randchars.go`, `device/obf_randdigits.go`, `device/obf_timestamp.go`, `device/send.go`, `device/uapi.go` |
| amnezia-vpn/amneziawg-go | v0.2.16 = `730d6c39d0c4e348a3d080bebe496664215e5c99` | `device/uapi.go` |
| amnezia-vpn/amneziawg-go | v0.2.15 = `f6542209f40f3f8f9e3dc9403d331ad2881fd7e3` | `device/awg/tag_parser.go`, `device/uapi.go` |
| amnezia-vpn/amneziawg-go | v0.2.13 = `1abd24b5b9ca89609d26af1f43743d8a9dc940da` | `device/awg/tag_parser.go`, `device/awg/tag_generator.go`, `device/uapi.go` |

Files were read from raw.githubusercontent.com; revisions were resolved with `git ls-remote`. A v0.2.14 tag was not
found. The amneziawg-go versions pinned by client releases are under "Client releases" below.

## Tag semantics (master)

| Tag | Bytes | Evaluated |
|---|---|---|
| `<b 0x…>` | the given hex; prefix must be lowercase `0x`, even length | once, when the config is parsed |
| `<r N>` | N bytes from `crypto/rand` | on every send |
| `<rc N>` | N ASCII letters `a-zA-Z` | on every send |
| `<rd N>` | N ASCII digits `0-9` | on every send |
| `<t>` | `uint32(time.Now().Unix())`, big-endian, 4 bytes | on every send |

Master also has `d`, `ds`, `dz`. The tag name is case-sensitive; an unknown tag fails parsing and `uapi.go` aborts
applying the configuration. Master sets no upper bound on N.

`send.go`, `SendHandshakeInitiation`: every non-empty I1..I5 is obfuscated (runtime tags filled) and sent before the
Jc junk packets and the initiation, on every initiation attempt including retries; only the handshake rate limit
applies.

## Older versions

- v0.2.13: tags `b c t r wt wr`. `<rc>`/`<rd>` give `invalid tag`. `<r N>` rejects N > 1000. `<t>` and `<c>` are 8
  bytes and may appear once per field. `<b>` accepts `0x` or `0X`. `<r>` bytes come from a ChaCha8 stream and are
  regenerated on each `Generate()`. `uapi.go` already accepts `s3`, `s4` and `i1`..`i5`, so a v0.2.13 client
  accepts the AWG 2.0 configs this project generates, without `<rc>`/`<rd>`.
- v0.2.15: adds `rc` (alphabet `A-Za-z0-9`, 62 characters) and `rd`; N ≤ 1000 for `r`, `rc`, `rd`; `<t>` still 8 bytes.
- v0.2.16: new parser (`device/obf.go`); `c` and `wt` removed, no N limit.

## Project policy

Confirmed by source: the semantics and version differences above.

Project choice (owner decision 2026-10-13): I2–I5 use only `<b>`, `<r>` and `<t>`, `<r N>` stays ≤ 1000 and each
field has at most one `<t>`. This is the intersection that v0.2.13 through master parse. `<rc>`/`<rd>` would make
configs fail to import on clients built on amneziawg-go before v0.2.15.

The I1 protocol choice, CPS maturity statuses and WARP safety fields are unchanged.

## Verification against the upstream engine (2026-10-13)

Go 1.27.2, amneziawg-go built from the revisions above plus `v0.2.13-beta-awg-1.5-fix6` (`45c748f`),
`v0.2.14-beta-awg-1.5-1` (`15d7259`), `v0.2.19` (`1cc9427`), `v3.0.3` (`cf9d2dd`) and `v3.1.20260814` (`1b86b2a`). A small harness created a
device per case (`tun/tuntest`, `conn.NewStdNetBind`) and applied it with `Device.IpcSet`, the entry point that
`awg setconf` and the client apps use. `.conf` was converted to UAPI the way amneziawg-tools `ee0f0a9` does
(`RandomTrailers`/`DisableCookies` on/off → 1/0, ranges as text, Address/DNS/MTU dropped).

- 3000 `generateI2I5()` sets (I1 = `<b 0xdeadbeef>`): accepted by all nine revisions.
- Controls in I2: `<rd 5>` and `<rc 5>` rejected by v0.2.13 and the v0.2.14 beta (`invalid tag`), accepted from
  v0.2.15; `<r 1001>` and two `<t>` rejected up to v0.2.15, accepted from v0.2.16; `<zz 1>` rejected everywhere.
- 504 full configs from the production handler (`/api/warp` with mocked WARP registration; awg2/awg3/awg31 ×
  seven CPS protocols × plain/mobile/router/mobile+router × cps5 on/off): AWG 2.0 accepted by all revisions; AWG 3.0
  from v3.0.3; AWG 3.1 from v3.1.20260814. Older engines reject AWG 3.x keys (`content_padding_addition`, `random_trailers`)
  with or without cps5; cps5 never changed the result.

Live run on master `b5928ef`: userspace device (`tun/netstack`) per real config from the handler (awg2, awg3, awg31,
cps5 on and off, CPS static), three fresh handshakes each with Cloudflare WARP `162.159.192.1:4500`;
`http://1.1.1.1/cdn-cgi/trace` through the tunnel returned `warp=on` in all 18 rounds. Captured handshake bursts:
every I2–I5 datagram had the template length (`<t>` = 4 bytes), the `<b>` bytes were identical in every burst, `<t>`
held the current unix time, and the `<r>`/`<t>` part differed in each of the three handshakes.

Client releases: the latest tags of amneziawg-windows, amneziawg-android and amneziawg-apple (`v3.1.20260814`) pin
`github.com/amnezia-vpn/amneziawg-go/v3 v3.1.20260814` in `go.mod`; the harness gives
the same result on that revision as on master, including AWG 3.1. Current client builds would therefore also accept `<rc>`/`<rd>`; the
b/r/t restriction protects users who have not updated since the v0.2.13/v0.2.14 era (mid-2025).

Not verified: the installed client apps themselves (AmneziaVPN, AmneziaWG for Windows/Android/iOS, WG Tunnel),
amnezia-client's own embedding, and networks with DPI.
