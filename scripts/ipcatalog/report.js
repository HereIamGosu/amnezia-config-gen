// scripts/ipcatalog/report.js
// The build summary (spec 3.2.0 §9 p. 2–4), a Markdown file the maintainer keeps outside the repository: per preset
// the recipe, the price after the cut, addresses, precision, coverage against the reference (opencck ip4 ∪ ipnames,
// comparison only, K9), the 3.1.9 measurement, stale/noData; failed sources, the itdoginfo comparison, the ECS points,
// the quick pick total and the presets that must stay transitional.

'use strict';

const { aggregateCidrs } = require('../../src/server/cidrAggregate');
const { WARP_ENDPOINT_PREFIXES_V4 } = require('../../src/server/warpEndpointPrefixes');
const { coverageOf } = require('./sources/reconcile');

const COVERAGE_THRESHOLD = 0.9;
const ROUTE_LIMIT = 1000;
// Presets that took addresses from opencck in 3.1.9 (spec §9 p. 3): they go to the catalogue only with coverage ≥ 90 %.
// The first item names seventeen; Telegram falls under the second (an official/AS recipe, the same threshold).
const OPENCCK_ERA = Object.freeze(['tiktok', 'viber', 'notion', 'linkedin', 'itch_io', 'spotify', 'netflix', 'openai',
  'hdrezka', 'twitter', 'rutracker', 'rutor', 'nnmclub', 'kinozal', 'animego', 'bestchange', 'proton', 'telegram']);

const pct = (share) => (share == null ? '—' : `${(share * 100).toFixed(1)} %`);
const cutOf = (cidrs4) => aggregateCidrs(cidrs4, { exclude: WARP_ENDPOINT_PREFIXES_V4 }).cidrs;
const cell = (v) => String(v).replace(/\|/g, '\\|');

/**
 * Coverage verdicts of the presets (spec §9 p. 3): reference = opencck ip4 ∪ ipnames, against the snapshot after the cut.
 * @returns {Record<string, { share: number|null, reference: number, covered: number, verdict: string|null }>}
 */
const coverageVerdicts = (summary, reconcile = {}) => {
  const out = {};
  for (const [key, entry] of Object.entries(summary.presets)) {
    const r = reconcile[key] || {};
    const reference = [...(r.opencckIp4 || []), ...(r.ipnames || [])];
    const c = coverageOf(reference, cutOf(entry.set.cidrs4));
    let verdict = null;
    if (OPENCCK_ERA.includes(key)) {
      if (c.share == null) verdict = 'нет эталона — решает владелец';
      else verdict = c.share >= COVERAGE_THRESHOLD ? 'каталог' : 'переходный: покрытие < 90 %';
    }
    out[key] = { ...c, verdict, legacy: entry.legacy };
  }
  return out;
};

/**
 * @param {{ summary: object, reconcile?: object, measure?: object|null, quickPick?: string[], ecs: object[], reportPath?: string }} input
 * @returns {string}
 */
const renderReport = ({ summary, reconcile = {}, measure = null, quickPick = [], ecs = [] }) => {
  const verdicts = coverageVerdicts(summary, reconcile);
  const measured = new Map((measure && measure.rows ? measure.rows : []).map((row) => [row.name, row]));
  const lines = [];
  lines.push(`# Сборка каталога адресов пресетов: сводка (${summary.builtAt})`, '');
  lines.push('Сделано `npm run ipcatalog:build`. Числа маршрутов — IPv4-строки `AllowedIPs` после точной агрегации и выреза '
    + '`162.159.192/193/195/204.0/24`. Покрытие — доля адресов эталона (ip4 портала из API opencck ∪ резолв antonme/ipnames '
    + 'из Москвы и Петербурга), которые попадают в сети пресета после выреза; эталон — только сверка, в снапшот не идёт (K9). '
    + 'У переходных пресетов цена — `liveRoutes4` этой сборки, покрытие считается по запасу.', '');
  lines.push('| Пресет | Рецепт | routes4 | addrs4 | Точность | Покрытие (эталон) | Своё покрытие | 3.1.9: before4 → after4 | Итог | stale / noData |');
  lines.push('|---|---|---:|---:|---|---|---|---|---|---|');
  for (const [key, entry] of Object.entries(summary.presets)) {
    const v = verdicts[key];
    const own = entry.set.coverage;
    const m = measured.get(key);
    const price = entry.legacy ? `${entry.liveRoutes4} (live); запас ${entry.routes4}` : String(entry.routes4);
    const verdict = entry.legacy ? 'переходный' : (v.verdict === 'каталог' || !v.verdict ? 'каталог' : `НУЖЕН legacy: ${v.verdict}`);
    const flags = [entry.set.stale ? `stale ${entry.set.stale}` : '', entry.set.noData ? `noData ${entry.set.noData}` : '', ...entry.notes].filter(Boolean).join('; ');
    lines.push(`| ${key} | ${cell(entry.recipe || '—')} | ${price} | ${entry.set.addrs4} | ${entry.set.precision} | `
      + `${pct(v.share)} (${v.covered}/${v.reference}) | ${own ? `${own.covered}/${own.reference}` : '—'} | `
      + `${m ? `${m.before4} → ${m.after4} (${m.source})` : '—'} | ${verdict} | ${cell(flags || '—')} |`);
  }
  lines.push('');

  // §9 p. 3: a preset that took opencck addresses in 3.1.9 goes to the catalogue only with coverage ≥ 90 %.
  const era = Object.entries(verdicts).filter(([, v]) => v.verdict);
  const below = (legacy) => era.filter(([, v]) => v.verdict !== 'каталог' && v.legacy === legacy).map(([k, v]) => `${k} (${pct(v.share)})`);
  const passed = era.filter(([, v]) => v.verdict === 'каталог').map(([k, v]) => `${k} (${pct(v.share)})`);
  lines.push('## Пресеты эпохи opencck и порог покрытия 90 % (§9 п. 3)', '');
  lines.push(`- Ниже порога, переходные (\`legacy\` в routePresets.js): ${below(true).join(', ') || 'нет'}.`);
  lines.push(`- Ниже порога, но в каталоге — пометить \`legacy\` и пересобрать: ${below(false).join(', ') || 'нет'}.`);
  lines.push(`- Прошли порог: ${passed.join(', ') || 'нет'}.`, '');

  const picked = quickPick.filter((k) => summary.presets[k]);
  const catalogPart = picked.filter((k) => !summary.presets[k].legacy).flatMap((k) => summary.presets[k].set.cidrs4);
  const catalogRoutes = aggregateCidrs(catalogPart, { exclude: WARP_ENDPOINT_PREFIXES_V4 }).after4;
  const livePart = picked.filter((k) => summary.presets[k].legacy).reduce((sum, k) => sum + summary.presets[k].liveRoutes4, 0);
  lines.push('## Быстрый выбор (§9 п. 4)', '');
  lines.push(`Состав: ${picked.join(', ') || '—'}. Пресеты каталога вместе после агрегации и выреза: ${catalogRoutes}; `
    + `переходные по liveRoutes4: ${livePart}; верхняя оценка суммы: ${catalogRoutes + livePart} `
    + `(${catalogRoutes + livePart <= ROUTE_LIMIT ? 'не больше' : 'больше'} лимита ${ROUTE_LIMIT}).`, '');

  lines.push('## Упавшие источники и stale', '');
  lines.push(summary.failed.length ? summary.failed.map((f) => `- ${f.key}: ${cell(f.error)}`).join('\n') : 'Нет.', '');
  lines.push(summary.stale.length ? `stale: ${summary.stale.join(', ')} — релизная сборка их не допускает.` : 'stale: нет.', '');

  lines.push('## Сверка с itdoginfo', '');
  const itdog = Object.entries(reconcile).filter(([, r]) => r.itdoginfo);
  if (!itdog.length) lines.push('Нет данных.');
  for (const [key, r] of itdog) {
    const routed = summary.presets[key] ? cutOf(summary.presets[key].set.cidrs4) : [];
    const covered = r.itdoginfo.filter((c) => coverageOf([c.replace(/\/\d+$/, '')], routed).covered).length;
    lines.push(`- ${key}: ${r.itdoginfo.length} сетей itdoginfo, у ${covered} начальный адрес внутри сетей пресета.`);
  }
  lines.push('', '## Точки ECS', '');
  for (const p of ecs) lines.push(`- ${p.id}: \`${p.subnet}\`${p.ripe ? ` (RIPE: ${p.ripe})` : ''}`);
  lines.push('');
  return lines.join('\n');
};

module.exports = { renderReport, coverageVerdicts, OPENCCK_ERA, COVERAGE_THRESHOLD };
