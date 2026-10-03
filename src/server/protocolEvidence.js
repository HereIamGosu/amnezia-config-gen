'use strict';

const EVIDENCE_MODEL_VERSION = 1;
const EVIDENCE_STATUSES = Object.freeze([
  'verified',
  'source-confirmed',
  'experimental',
  'peer-dependent-disabled',
  'unknown',
]);

// Revisions identify evidence, not necessarily the latest upstream tip.
const EVIDENCE_SOURCES = Object.freeze({
  'amneziawg-go': Object.freeze({
    repository: 'amnezia-vpn/amneziawg-go',
    revision: 'b5928efb6ca19f0153958460c3d141f04abc5c2e',
    checkedAt: '2026-10-03',
    kind: 'primary-upstream',
  }),
  'amneziawg-tools': Object.freeze({
    repository: 'amnezia-vpn/amneziawg-tools',
    revision: 'ee0f0a9aa34ff0a0da4b3433b9512781cfe02843',
    checkedAt: '2026-10-03',
    kind: 'primary-upstream',
  }),
  'amnezia-client': Object.freeze({
    repository: 'amnezia-vpn/amnezia-client',
    revision: '94b51df24790bf52427afe82d81c87a95460bdfd',
    checkedAt: '2026-10-03',
    kind: 'primary-upstream',
  }),
  'project-runtime': Object.freeze({
    repository: 'HereIamGosu/amnezia-config-gen',
    revision: 'src/server/awg',
    checkedAt: '2026-10-03',
    kind: 'project-source',
  }),
  'issue-4': Object.freeze({
    repository: 'HereIamGosu/amnezia-config-gen',
    revision: 'issues/4',
    checkedAt: '2026-10-03',
    kind: 'community-report',
  }),
});

const VALID_MODES = new Set(['awg3', 'awg31']);
const VALID_POLICIES = new Set(['enabled-by-default', 'opt-in', 'fixed', 'blocked']);

const validateProtocolEvidence = (capabilities, sources = EVIDENCE_SOURCES) => {
  const errors = [];
  const ids = new Set();
  const fields = new Map();
  for (const record of capabilities) {
    if (!record || typeof record !== 'object') { errors.push('Invalid capability record'); continue; }
    if (!record.id || ids.has(record.id)) errors.push(`Duplicate or missing capability ID: ${record.id}`);
    ids.add(record.id);
    if (!EVIDENCE_STATUSES.includes(record.evidenceStatus)) errors.push(`${record.id}: invalid evidence status`);
    if (!Array.isArray(record.modes) || !record.modes.length || record.modes.some((mode) => !VALID_MODES.has(mode))) {
      errors.push(`${record.id}: invalid mode assignment`);
    }
    if (!Array.isArray(record.fields) || !record.fields.length) errors.push(`${record.id}: missing fields`);
    for (const field of record.fields || []) {
      if (fields.has(field)) errors.push(`${record.id}: field ${field} already belongs to ${fields.get(field)}`);
      fields.set(field, record.id);
    }
    if (!Array.isArray(record.sources) || !record.sources.length) errors.push(`${record.id}: missing source references`);
    for (const sourceId of record.sources || []) {
      const source = sources[sourceId];
      if (!source) errors.push(`${record.id}: unknown source ${sourceId}`);
      else if (record.evidenceStatus === 'source-confirmed' && source.kind === 'primary-upstream'
        && (!source.revision || !source.checkedAt)) errors.push(`${record.id}: incomplete primary source ${sourceId}`);
    }
    if (record.evidenceStatus === 'source-confirmed' && !(record.sources || []).some((id) => sources[id]?.kind === 'primary-upstream')) {
      errors.push(`${record.id}: source-confirmed without primary evidence`);
    }
    if (!record.productPolicy || !VALID_POLICIES.has(record.productPolicy.state)) errors.push(`${record.id}: invalid product policy`);
    if (record.productPolicy?.state === 'enabled-by-default'
      && ['unknown', 'experimental', 'peer-dependent-disabled'].includes(record.evidenceStatus)) {
      errors.push(`${record.id}: unsafe enabled default`);
    }
    if (record.productPolicy?.state === 'fixed' && record.productPolicy.fixedValue == null) errors.push(`${record.id}: fixed value missing`);
    if (record.evidenceStatus === 'peer-dependent-disabled' && !['blocked', 'fixed'].includes(record.productPolicy?.state)) {
      errors.push(`${record.id}: peer-dependent capability is not blocked/fixed`);
    }
    if (!record.semantics || !record.parserContract || !record.interoperability || !Array.isArray(record.caveats)) {
      errors.push(`${record.id}: incomplete evidence dimensions`);
    }
  }
  return errors;
};

module.exports = { EVIDENCE_MODEL_VERSION, EVIDENCE_STATUSES, EVIDENCE_SOURCES, validateProtocolEvidence };
