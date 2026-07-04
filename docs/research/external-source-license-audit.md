# External Source License Audit

> **Disclaimer:** This is an **engineering audit, not legal advice.** It records
> what license each referenced repository declares (as detected via the GitHub
> License API and, where needed, the raw `LICENSE` file) so the team can make
> conservative, traceable decisions about reusing ideas or code. When in doubt,
> reimplement independently and consult a qualified lawyer before shipping copied
> third-party code.

- **Release:** 2.6.2 — License & Source Attribution Audit
- **Prompt pack:** `P3-06 License and source attribution audit`
- **This project's own license:** `AGPL-3.0-only`
- **Checked at:** 2026-07-04 (GitHub License API + raw `LICENSE` inspection)

---

## Scope

This audit covers the external open-source projects referenced by the roadmap and
the Claude Code / Codex prompt pack. These projects will be studied for
**architecture ideas, input/output formats, compatibility notes, endpoint
intelligence patterns, diagnostics, and UI references** in future releases
(`2.7.0`–`2.17.0`). No code from any of them is imported by this release.

The audit answers, per project: what license applies, whether code may be copied,
whether ideas may be reused, whether attribution is required, how compatible the
license is with this project's `AGPL-3.0-only` model, the risk level, and which
roadmap area the project informs.

---

## General policy

> This is the binding source-usage policy for every future Claude Code / Codex
> task in this repository. Prompts that touch external sources must reference it.

- **Do not copy external code mechanically.** First verify license, applicability,
  and architectural fit.
- If a license is **missing, unclear (`NOASSERTION` / `not found`), or
  incompatible**, do **not** copy code. Reimplement the mechanism independently
  and reuse only the **idea, behaviour, and input/output format**.
- If a project's license **requires attribution** (MIT, BSD, Apache-2.0, and all
  copyleft licenses), add attribution to `NOTICE` / documentation when any code or
  substantial expression is reused.
- **`AGPL-3.0-only` is this project's license.** Permissive licenses (MIT, BSD,
  Apache-2.0) are one-way compatible *into* AGPL-3.0 with attribution. Copyleft
  code (GPL-3.0 / AGPL-3.0) may be combinable but keeps its own copyleft and
  network-source obligations — prefer independent reimplementation.
- **Never expose external IPs, feeds, proxies, nodes, or unvetted payloads
  directly in generated user configs.** They may only enter the internal
  **candidate pipeline** and must pass health checks first.
- **Conservative default:** unknown ⇒ *do not copy, use ideas only, reimplement.*

---

## Summary table

| Repository | License | Can copy code | Can use ideas | Attribution required | Risk | Notes |
|---|---|---|---|---|---|---|
| alienwaregf/Cloudflare-Country-Specific-IP-Filter | not found | no | yes | unclear | high | No LICENSE file — all rights reserved by default. |
| tayden1990/CF-IP-Scanner | not found | no | yes | unclear | high | No LICENSE file detected. |
| gslege/CloudflareIP | not found | no | yes | unclear | high | No LICENSE file detected. |
| GuangYu-yu/CFnat | AGPL-3.0 | with review | yes | yes | medium | Same copyleft as this project; reuse must stay AGPL + attribution. |
| crow1874/CF-DNS-Clone | not found | no | yes | unclear | high | No LICENSE file detected. |
| lyc8503/UptimeFlare | Apache-2.0 | with review | yes | yes | low | Permissive, compatible into AGPL-3.0; keep NOTICE. |
| nezhahq/nezha | Apache-2.0 | with review | yes | yes | low | Permissive; large project, check per-file headers. |
| komari-monitor/komari | MIT | with review | yes | yes | low | Permissive; keep copyright notice. |
| gethomepage/homepage | GPL-3.0 | no (prefer reimpl) | yes | yes | medium | Copyleft; UI ideas only, reimplement. |
| throneproj/Throne | GPL-3.0 | no (prefer reimpl) | yes | yes | medium | Copyleft client; ideas only. |
| AnyPortal/AnyPortal | not found | no | yes | unclear | high | No LICENSE file detected. |
| OneOhCloud/OneBox | Apache-2.0 | with review | yes | yes | low | Permissive; compatible into AGPL-3.0. |
| sxueck/lvory | not found | no | yes | unclear | high | No LICENSE file detected. |
| bobbyunknown/OpenClash-lite | MIT | with review | yes | yes | low | LICENSE is MIT (© 2024 BobbyUnknown); GitHub SPDX = NOASSERTION. |
| kenzok8/openwrt-clashoo | GPL-3.0 | no (prefer reimpl) | yes | yes | medium | Copyleft; OpenWrt packaging ideas only. |
| Panchajanya1999/pingerr | Apache-2.0 | with review | yes | yes | low | Permissive; keep NOTICE. |
| Control-D-Inc/ctrld | MIT | with review | yes | yes | low | Permissive DNS proxy; keep copyright notice. |
| cmliu/CF-Workers-DoH | BSD-2-Clause | with review | yes | yes | low | Permissive; keep copyright notice. |
| hagezi/dns-blocklists | GPL-3.0 | no (data, prefer reference) | yes | yes | medium | Blocklist **data** under GPL-3.0; reference, don't vendor. |
| divan/txqr | MIT | with review | yes | yes | low | Permissive; animated/chunked QR reference. |
| w0rng/amnezia-wg-easy | CC BY-NC-SA 4.0 | no | yes (non-commercial idea only) | yes | high | **NonCommercial + non-software license.** Do not copy code. |

Legend for *Can copy code*: **no** = do not copy; **with review** = permissive
license permits reuse, but only after per-file license-header and dependency
review plus attribution — independent reimplementation still preferred.

---

## Detailed notes

### alienwaregf/Cloudflare-Country-Specific-IP-Filter
- Repository: https://github.com/alienwaregf/Cloudflare-Country-Specific-IP-Filter
- License: not found (no `LICENSE`/`COPYING`; GitHub License API → 404)
- License file: —
- Can copy code: **no**
- Can use ideas: yes (country-specific CF IP filtering behaviour, I/O format)
- Requires attribution: unclear
- Risk level: **high**
- Used for: External Candidate Importer (2.10.2)
- Notes: No license ⇒ default "all rights reserved."
- Decision: Do not copy code. Reimplement independently if needed.

### tayden1990/CF-IP-Scanner
- Repository: https://github.com/tayden1990/CF-IP-Scanner
- License: not found (GitHub License API → 404; no LICENSE in default branch)
- Can copy code: **no**
- Can use ideas: yes (CF IP scanning / latency ranking approach)
- Requires attribution: unclear
- Risk level: **high**
- Used for: External Candidate Importer (2.10.2)
- Decision: Do not copy code. Reimplement independently if needed.

### gslege/CloudflareIP
- Repository: https://github.com/gslege/CloudflareIP
- License: not found (GitHub License API → 404)
- Can copy code: **no**
- Can use ideas: yes (CF IP list curation)
- Requires attribution: unclear
- Risk level: **high**
- Used for: External Candidate Importer (2.10.2)
- Decision: Do not copy code. Reimplement independently if needed.

### GuangYu-yu/CFnat
- Repository: https://github.com/GuangYu-yu/CFnat
- License: **AGPL-3.0** (`LICENSE`)
- Can copy code: with explicit compatibility review (same copyleft family)
- Can use ideas: yes (CF NAT / endpoint optimization)
- Requires attribution: yes
- Risk level: **medium**
- Used for: External Candidate Importer (2.10.2)
- Notes: License matches this project (`AGPL-3.0-only`), so combination is the most
  legally straightforward of the copyleft options, but network-copyleft obligations
  travel with any copied code.
- Decision: Prefer independent reimplementation; if code is reused, preserve AGPL-3.0
  and attribution.

### crow1874/CF-DNS-Clone
- Repository: https://github.com/crow1874/CF-DNS-Clone
- License: not found (GitHub License API → 404)
- Can copy code: **no**
- Can use ideas: yes (CF DNS record cloning workflow)
- Requires attribution: unclear
- Risk level: **high**
- Used for: DNS Advisor (2.12.0) / External Candidate Importer (2.10.2)
- Decision: Do not copy code. Reimplement independently if needed.

### lyc8503/UptimeFlare
- Repository: https://github.com/lyc8503/UptimeFlare
- License: **Apache-2.0** (`LICENSE`)
- Can copy code: with review (permissive, one-way compatible into AGPL-3.0)
- Can use ideas: yes (serverless uptime monitoring on Cloudflare Workers)
- Requires attribution: yes (retain NOTICE / license headers)
- Risk level: **low**
- Used for: Endpoint & Status Center (2.10.0)
- Decision: Reuse possible with attribution; prefer independent implementation.

### nezhahq/nezha
- Repository: https://github.com/nezhahq/nezha
- License: **Apache-2.0** (`LICENSE`)
- Can copy code: with review (large codebase — verify per-file headers/deps)
- Can use ideas: yes (server/agent monitoring model, status UX)
- Requires attribution: yes
- Risk level: **low**
- Used for: Endpoint & Status Center (2.10.0)
- Decision: Reuse possible with attribution; prefer independent implementation.

### komari-monitor/komari
- Repository: https://github.com/komari-monitor/komari
- License: **MIT** (`LICENSE`)
- Can copy code: with review
- Can use ideas: yes (lightweight monitoring dashboard)
- Requires attribution: yes (retain copyright notice)
- Risk level: **low**
- Used for: Endpoint & Status Center (2.10.0)
- Decision: Reuse possible with attribution; prefer independent implementation.

### gethomepage/homepage
- Repository: https://github.com/gethomepage/homepage
- License: **GPL-3.0** (`LICENSE`)
- Can copy code: **no** (prefer reimplementation; copyleft)
- Can use ideas: yes (dashboard layout / service tiles UX)
- Requires attribution: yes
- Risk level: **medium**
- Used for: Endpoint & Status Center (2.10.0) — UI references
- Decision: Do not copy code without explicit compatibility review; use UI ideas only.

### throneproj/Throne
- Repository: https://github.com/throneproj/Throne
- License: **GPL-3.0** (`LICENSE`)
- Can copy code: **no** (prefer reimplementation; copyleft)
- Can use ideas: yes (client compatibility, config import UX)
- Requires attribution: yes
- Risk level: **medium**
- Used for: Compatibility & Onboarding Clarity (2.7.0)
- Decision: Do not copy code without explicit compatibility review; ideas only.

### AnyPortal/AnyPortal
- Repository: https://github.com/AnyPortal/AnyPortal
- License: not found (GitHub License API → 404; no LICENSE in default branch)
- Can copy code: **no**
- Can use ideas: yes (cross-platform client/portal patterns)
- Requires attribution: unclear
- Risk level: **high**
- Used for: Compatibility & Onboarding Clarity (2.7.0)
- Decision: Do not copy code. Reimplement independently if needed.

### OneOhCloud/OneBox
- Repository: https://github.com/OneOhCloud/OneBox
- License: **Apache-2.0** (`LICENSE`)
- Can copy code: with review (permissive, compatible into AGPL-3.0)
- Can use ideas: yes (client packaging / compatibility)
- Requires attribution: yes
- Risk level: **low**
- Used for: Compatibility & Onboarding Clarity (2.7.0)
- Decision: Reuse possible with attribution; prefer independent implementation.

### sxueck/lvory
- Repository: https://github.com/sxueck/lvory
- License: not found (GitHub License API → 404)
- Can copy code: **no**
- Can use ideas: yes (client GUI / proxy management patterns)
- Requires attribution: unclear
- Risk level: **high**
- Used for: Compatibility & Onboarding Clarity (2.7.0)
- Decision: Do not copy code. Reimplement independently if needed.

### bobbyunknown/OpenClash-lite
- Repository: https://github.com/bobbyunknown/OpenClash-lite
- License: **MIT** (`LICENSE`; text = "MIT License … © 2024 BobbyUnknown").
  GitHub SPDX detection returns `NOASSERTION`, but the file is standard MIT.
- Can copy code: with review (permissive)
- Can use ideas: yes (OpenWrt / OpenClash router integration)
- Requires attribution: yes (retain copyright notice)
- Risk level: **low**
- Used for: Router Profile Pack (2.8.0)
- Decision: Reuse possible with attribution; prefer independent implementation.
  Re-verify the MIT text before any direct reuse, since GitHub could not auto-map it.

### kenzok8/openwrt-clashoo
- Repository: https://github.com/kenzok8/openwrt-clashoo
- License: **GPL-3.0** (`LICENSE`)
- Can copy code: **no** (prefer reimplementation; copyleft, aggregated OpenWrt feed)
- Can use ideas: yes (OpenWrt package feed structure)
- Requires attribution: yes
- Risk level: **medium**
- Used for: Router Profile Pack (2.8.0)
- Notes: Aggregator repo bundling many third-party packages — sub-package licenses
  vary and must be checked individually before any reuse.
- Decision: Do not copy code without explicit compatibility review; ideas only.

### Panchajanya1999/pingerr
- Repository: https://github.com/Panchajanya1999/pingerr
- License: **Apache-2.0** (`LICENSE`)
- Can copy code: with review (permissive)
- Can use ideas: yes (endpoint ping / reachability checks)
- Requires attribution: yes
- Risk level: **low**
- Used for: Endpoint & Status Center (2.10.0)
- Decision: Reuse possible with attribution; prefer independent implementation.

### Control-D-Inc/ctrld
- Repository: https://github.com/Control-D-Inc/ctrld
- License: **MIT** (`LICENSE`)
- Can copy code: with review (permissive)
- Can use ideas: yes (DNS proxy / policy routing)
- Requires attribution: yes (retain copyright notice)
- Risk level: **low**
- Used for: DNS Advisor (2.12.0)
- Decision: Reuse possible with attribution; prefer independent implementation.

### cmliu/CF-Workers-DoH
- Repository: https://github.com/cmliu/CF-Workers-DoH
- License: **BSD-2-Clause** (`LICENSE`)
- Can copy code: with review (permissive)
- Can use ideas: yes (DoH proxy on Cloudflare Workers)
- Requires attribution: yes (retain copyright + disclaimer)
- Risk level: **low**
- Used for: DNS Advisor (2.12.0)
- Decision: Reuse possible with attribution; prefer independent implementation.

### hagezi/dns-blocklists
- Repository: https://github.com/hagezi/dns-blocklists
- License: **GPL-3.0** (`LICENSE`)
- Can copy code: **no** — this is blocklist **data**, not application code; do not
  vendor the lists. Reference by URL / attribution instead.
- Can use ideas: yes (blocklist categories, DNS filtering guidance)
- Requires attribution: yes
- Risk level: **medium**
- Used for: DNS Advisor (2.12.0)
- Decision: Reference upstream; do not copy/redistribute the lists without review.

### divan/txqr
- Repository: https://github.com/divan/txqr
- License: **MIT** (`LICENSE`)
- Can copy code: with review (permissive)
- Can use ideas: yes (animated / chunked QR data transfer protocol)
- Requires attribution: yes (retain copyright notice)
- Risk level: **low**
- Used for: Export & QR Experiments (2.14.0)
- Decision: Reuse possible with attribution; prefer independent implementation.

### w0rng/amnezia-wg-easy
- Repository: https://github.com/w0rng/amnezia-wg-easy
- License: **CC BY-NC-SA 4.0** (`LICENSE` — Attribution-NonCommercial-ShareAlike 4.0)
- Can copy code: **no**
- Can use ideas: yes, but only for non-commercial reference — Creative Commons is
  **not a software license** and the **NonCommercial** clause restricts use.
- Requires attribution: yes (BY) + ShareAlike if adapted
- Risk level: **high**
- Used for: Self-host Docker Edition (2.16.0)
- Notes: CC BY-NC-SA is unsuitable for source code and its NonCommercial term is
  incompatible with a freely reusable AGPL-3.0 project.
- Decision: **Do not copy code.** Reimplement independently; treat only the UX/idea
  as a reference and confirm non-commercial context before any reference use.

---

## Decisions

- Every **`not found`** and **`unclear`/`NOASSERTION`** repository is treated as
  **restricted: do not copy code, reimplement independently, use ideas only.**
- Every **permissive** repository (MIT, BSD-2-Clause, Apache-2.0) allows reuse
  *with attribution*, but independent reimplementation remains the default.
- Every **copyleft** repository (GPL-3.0, AGPL-3.0) requires explicit compatibility
  review before any code reuse; ideas may be used freely.
- **CC BY-NC-SA 4.0** (`amnezia-wg-easy`) is hard-blocked for code reuse.
- External IP/feed/endpoint sources from any of these projects may **only** enter
  the internal candidate pipeline + health checks, never the generated user config.

---

## Do not copy list

Code from these repositories **must not be copied** (missing/unclear license,
NonCommercial, or copyleft requiring review). Use ideas/behaviour only and
reimplement independently:

- alienwaregf/Cloudflare-Country-Specific-IP-Filter — *not found*
- tayden1990/CF-IP-Scanner — *not found*
- gslege/CloudflareIP — *not found*
- crow1874/CF-DNS-Clone — *not found*
- AnyPortal/AnyPortal — *not found*
- sxueck/lvory — *not found*
- w0rng/amnezia-wg-easy — *CC BY-NC-SA 4.0 (NonCommercial)*
- gethomepage/homepage — *GPL-3.0, review required*
- throneproj/Throne — *GPL-3.0, review required*
- kenzok8/openwrt-clashoo — *GPL-3.0 aggregator, review required*
- hagezi/dns-blocklists — *GPL-3.0 data, reference only*
- GuangYu-yu/CFnat — *AGPL-3.0, review required*

The remaining permissive projects (UptimeFlare, nezha, komari, OneBox,
OpenClash-lite, pingerr, ctrld, CF-Workers-DoH, txqr) are **not** hard-blocked but
still require the attribution and per-file review described below before any reuse.

## Attribution requirements

When any code or substantial expression from a permissive or copyleft project is
reused (after the review above), record attribution:

1. Add a `NOTICE` file (or an "Attributions" section in `README`) listing the
   repository, its license, and the copyright holder.
2. Retain original copyright headers and license text for copied files.
3. For Apache-2.0 sources, preserve any upstream `NOTICE` content.
4. For copyleft (GPL-3.0 / AGPL-3.0) sources, keep the source's license terms with
   the reused code and honour the network-source-availability obligation.
5. For `OpenClash-lite`, re-confirm the MIT text (GitHub SPDX = `NOASSERTION`)
   before relying on it.

Attribution is **not** required merely to reuse an **idea, behaviour, or I/O
format** that is independently reimplemented.

---

## Follow-up

- Re-run this audit before starting each dependent release (`2.7.0`, `2.8.0`,
  `2.10.0`, `2.10.2`, `2.12.0`, `2.14.0`, `2.16.0`, `2.17.0`) — upstream licenses
  can change.
- Extend the scope table if the Prompt Pack or roadmap adds new external sources.
- If any repository later adds/changes a `LICENSE`, update its row and decision.
- Consider a lightweight automated SPDX check in CI only if/when direct code reuse
  is actually planned (out of scope for this release).

### Relation to future releases

| Future release | Why the audit is needed |
|---|---|
| 2.7.0 Compatibility & Onboarding Clarity | client/export project ideas (Throne, AnyPortal, OneBox, lvory) |
| 2.8.0 Router Profile Pack | OpenWrt/router ideas (OpenClash-lite, openwrt-clashoo) |
| 2.10.0 Endpoint & Status Center | status/monitoring ideas (UptimeFlare, nezha, komari, homepage, pingerr) |
| 2.10.2 External Cloudflare Candidate Importer | feed/scanner projects (CF-IP-Scanner, CloudflareIP, CFnat, CF filter) |
| 2.12.0 DNS Advisor | DNS tools & blocklists (ctrld, CF-Workers-DoH, hagezi, CF-DNS-Clone) |
| 2.14.0 Export & QR Experiments | QR references (txqr) |
| 2.16.0 Self-host Docker Edition | self-host references (amnezia-wg-easy) |
| 2.17.0 Telegram Bot Thin Client | bot/admin UX references (studied case-by-case; add rows as sources appear) |
