'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EVIDENCE_SOURCES } = require('../src/server/protocolEvidence');
const { AWG_CAPABILITIES, validateAwgEvidence } = require('../src/server/awg/evidence');
const { CPS_PROTOCOLS, AUTO_PROTOCOLS } = require('../src/server/cps/protocols');

const outputPath = path.join(__dirname, '..', 'docs', 'protocol-evidence.md');

const sourceLink = (source) => source.kind === 'project-source'
  ? `https://github.com/${source.repository}/tree/main/${source.revision}`
  : source.revision.startsWith('issues/')
    ? `https://github.com/${source.repository}/${source.revision}`
    : `https://github.com/${source.repository}/tree/${source.revision}`;
const render = () => {
  const errors = validateAwgEvidence();
  if (errors.length) throw new Error(`Invalid protocol evidence:\n${errors.join('\n')}`);
  const checkedAt = [...new Set(Object.values(EVIDENCE_SOURCES).map((source) => source.checkedAt))].sort().at(-1);
  const sources = Object.entries(EVIDENCE_SOURCES)
    .map(([id, source]) => `| ${id} | ${source.kind} | ${source.revision} | ${source.checkedAt} | ${sourceLink(source)} |`)
    .join('\n');
  const awg = AWG_CAPABILITIES.map((record) => {
    const policy = record.productPolicy.state === 'fixed'
      ? `fixed ${record.productPolicy.fixedValue}`
      : record.productPolicy.state === 'enabled-by-default'
        ? `default ${record.productPolicy.defaultValue}`
        : record.productPolicy.state;
    return `| ${record.fields.join(', ')} | ${record.modes.join(', ')} | ${record.evidenceStatus} | ${record.semantics.locality} | ${record.parserContract.syntax} | ${policy} | ${record.sources.join(', ')} |`;
  }).join('\n');
  const cps = Object.values(CPS_PROTOCOLS).map((record) =>
    `| ${record.label} | ${record.status} | ${record.evidenceStatus || (record.status === 'stable' ? 'verified' : record.status)} | ${AUTO_PROTOCOLS.includes(record.id) ? 'yes' : 'no'} |`
  ).join('\n');
  return `# Current AWG/WARP Protocol Evidence\n\nThis document is generated from the JavaScript evidence registries. Historical release notes describe their release snapshot; this page records current policy. Last checked: ${checkedAt}.\n\n## Evidence status\n\n- **verified:** upstream semantics and parser support plus reproducible project interoperability evidence for the intended use; a unit test alone is insufficient.\n- **source-confirmed:** primary upstream semantics and public parser contract are established; broad live WARP interoperability is not claimed.\n- **experimental:** implementation exists, but interoperability evidence is insufficient.\n- **peer-dependent-disabled:** compatible remote behaviour, matching configuration or shared state is required; WARP output blocks or fixes it.\n- **unknown:** safe semantics are not established and defaults cannot enable it.\n\nA community report can trigger research but cannot alone establish a peer-dependent protocol contract. Status describes evidence; the effective state of one generated config is separate.\n\n## Source revisions\n\n| ID | Kind | Revision or path | Checked | Link |\n|---|---|---|---|---|\n${sources}\n\n## AWG capability matrix\n\n| Field | Modes | Evidence | Locality | Parser syntax | WARP policy | Sources |\n|---|---|---|---|---|---|---|\n${awg}\n\n## CPS evidence\n\n| Protocol | Runtime status | Evidence status | Auto |\n|---|---|---|---|\n${cps}\n\nAuto resolves only to stable, verified protocols. Unknown CPS is an API validation error. Specific CPS payload evidence is separate from the source-confirmed I1–I5 mechanism.\n\n## Current WARP invariants\n\n- AWG 3.0 and 3.1 default to \`ContentPaddingAddition = 10-100\`; \`off\`, \`0\`, and \`0-0\` disable it. It is local encrypted transport padding and may increase packet size.\n- AWG 3.1 defaults to \`DisableCookies = on\`; \`off\` remains available. This suppresses the local under-load Cookie Reply branch, leaves incoming Cookie Reply processing available, and reduces local anti-DoS protection. It is an anti-fingerprinting trade-off, not a security improvement.\n- \`RandomTrailers=on\` and \`HeaderProtectionKey\` are blocked for WARP. \`S1..S4\` are fixed to zero; \`H1..H4\` are fixed to 1, 2, 3, 4. The Cloudflare peer is stock WireGuard.\n- Public \`.conf\` range inputs are constrained to 0..65535 even though the engine's internal numeric representation may be wider. The tools parser uses \`u16_range_from_string\`; this project's strict range avoids parser truncation.\n\n## Conflicting and unverified evidence\n\n- Issue #4 reports RandomTrailers working with WARP while failing with another peer. This is community evidence, not a documented Cloudflare receive contract. The WARP block remains.\n- AWG 3.x source-confirmed capabilities are not claimed to work on every client, ISP or network. Live interoperability records should use \`docs/manual-checks/protocol-evidence.md\` and contain no keys, token, config or vpn link.\n`;
};

if (require.main === module) {
  const expected = render();
  if (process.argv.includes('--check')) {
    const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (actual !== expected) {
      process.stderr.write('Protocol evidence document is out of sync. Run npm run evidence:generate.\n');
      process.exitCode = 1;
    }
  } else {
    fs.writeFileSync(outputPath, expected);
  }
}

module.exports = { render };
