import { immutableSerializableDomain } from './serializable-domain.js';

const OUTCOMES = new Set([
  'clean', 'contradictions_found', 'empty_response',
  'malformed_or_unusable_response', 'prevented', 'provider_failure',
]);

/** Canonical plain-data result shared by manual and automatic Continuity Check. */
export function createContinuityOutcome(input = {}) {
  if (!OUTCOMES.has(input.outcome)) {
    const error = new TypeError(`Unknown Continuity Check outcome: ${input.outcome ?? 'missing'}`);
    error.code = 'SME_INVALID_CONTINUITY_OUTCOME';
    error.sme_failure_stage = 'continuity_outcome_construction';
    error.sme_serialization_path = '$.continuity_outcome.outcome';
    throw error;
  }
  const contradictions = Array.isArray(input.contradictions)
    ? input.contradictions.filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
    : [];
  return immutableSerializableDomain({
    schema_version: 1,
    outcome: input.outcome,
    contradictions,
    attention: input.attention === true,
    event_id: input.event_id == null ? null : String(input.event_id),
    diagnostic_error: input.diagnostic_error ?? null,
  }, {
    path: '$.continuity_outcome',
    stage: 'continuity_outcome_construction',
    operation_type: 'continuity_check',
  });
}
