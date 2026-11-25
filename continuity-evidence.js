import { immutableSerializableDomain } from './serializable-domain.js';

const SOURCES = new Set(['character_card', 'persona', 'summary', 'longterm', 'session']);

const required = (value, field, index) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized) return normalized;
  const error = new TypeError(`Continuity evidence ${field} is required.`);
  error.code = 'SME_INVALID_CONTINUITY_EVIDENCE';
  error.sme_failure_stage = 'continuity_evidence_construction';
  error.sme_serialization_path = `$.continuity_evidence[${index}].${field}`;
  throw error;
};

/** Canonical established-fact records consumed by Continuity Check. */
export function createContinuityEvidenceSet(items = []) {
  if (!Array.isArray(items)) {
    const error = new TypeError('Continuity evidence must be an array.');
    error.code = 'SME_INVALID_CONTINUITY_EVIDENCE';
    error.sme_failure_stage = 'continuity_evidence_construction';
    error.sme_serialization_path = '$.continuity_evidence';
    throw error;
  }
  const identities = new Set();
  const evidence = items.map((item, index) => {
    const source = required(item?.source, 'source', index);
    if (!SOURCES.has(source)) {
      const error = new TypeError(`Unknown Continuity evidence source: ${source}.`);
      error.code = 'SME_INVALID_CONTINUITY_EVIDENCE';
      error.sme_failure_stage = 'continuity_evidence_construction';
      error.sme_serialization_path = `$.continuity_evidence[${index}].source`;
      throw error;
    }
    const evidenceId = required(item?.evidence_id, 'evidence_id', index);
    if (identities.has(evidenceId)) {
      const error = new TypeError(`Duplicate Continuity evidence identity: ${evidenceId}.`);
      error.code = 'SME_DUPLICATE_CONTINUITY_EVIDENCE';
      error.sme_failure_stage = 'continuity_evidence_construction';
      error.sme_serialization_path = `$.continuity_evidence[${index}].evidence_id`;
      throw error;
    }
    identities.add(evidenceId);
    const text = required(item?.text, 'text', index);
    const count = Number(item?.count ?? 1);
    if (!Number.isInteger(count) || count < 1) {
      const error = new TypeError('Continuity evidence count must be a positive integer.');
      error.code = 'SME_INVALID_CONTINUITY_EVIDENCE';
      error.sme_failure_stage = 'continuity_evidence_construction';
      error.sme_serialization_path = `$.continuity_evidence[${index}].count`;
      throw error;
    }
    return {
      schema_version: 1,
      evidence_id: evidenceId,
      source,
      source_identity: required(item?.source_identity, 'source_identity', index),
      record_type: item?.record_type == null ? null : String(item.record_type).trim() || null,
      count,
      text,
    };
  });
  return immutableSerializableDomain(evidence, {
    path: '$.continuity_evidence',
    stage: 'continuity_evidence_construction',
    operation_type: 'continuity_check',
  });
}

/** Content-free identity projection for diagnostics and health telemetry. */
export function projectContinuityEvidenceSelection(items = [], estimateTokens = () => 0) {
  const evidence = createContinuityEvidenceSet(items);
  return immutableSerializableDomain(evidence.map((item) => ({
    evidence_id: item.evidence_id,
    source: item.source,
    source_identity: item.source_identity,
    record_type: item.record_type,
    count: item.count,
    estimated_tokens: Math.max(0, Math.floor(Number(estimateTokens(item.text)) || 0)),
  })), {
    path: '$.continuity_evidence_projection',
    stage: 'continuity_evidence_projection',
    operation_type: 'continuity_check',
  });
}
