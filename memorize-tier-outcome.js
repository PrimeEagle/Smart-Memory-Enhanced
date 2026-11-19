import { immutableSerializableDomain } from './serializable-domain.js';

export const MEMORIZE_TIER_OUTCOME_KINDS = Object.freeze([
  'complete', 'complete_no_update', 'partial_recoverable',
  'malformed_recoverable', 'context_overflow_recoverable',
  'validation_recoverable', 'transport_retryable', 'policy_paused', 'blocked',
  'cancelled', 'terminal_failure',
]);

export function createMemorizeTierOutcome(input = {}) {
  if (!MEMORIZE_TIER_OUTCOME_KINDS.includes(input.kind)) {
    throw new TypeError(`Unknown Memorize tier outcome: ${input.kind ?? 'missing'}`);
  }
  const outcome = {
    schema_version: 1,
    kind: input.kind,
    reason_code: input.reason_code ?? input.kind,
    next_action: input.next_action ?? null,
    provider_call_required: input.provider_call_required === true,
    recovery_dimension: input.recovery_dimension ?? null,
    source_range: input.source_range ?? null,
    source_fingerprint: input.source_fingerprint ?? null,
    owner: input.owner ?? null,
    owner_subset: input.owner_subset ?? [],
    rejected_units: input.rejected_units ?? [],
    missing_units: input.missing_units ?? [],
    budget_state: input.budget_state ?? null,
    accepted_owners: input.accepted_owners ?? [],
    explicit_no_update_owners: input.explicit_no_update_owners ?? [],
    missing_owners: input.missing_owners ?? [],
    rejected_owners: input.rejected_owners ?? [],
    durable_receipts: input.durable_receipts ?? [],
    owner_coverage: input.owner_coverage ?? null,
    value: input.value ?? null,
    evidence: input.evidence ?? null,
  };
  return immutableSerializableDomain(outcome, {
    path: '$.tier_outcome', stage: 'tier_outcome_construction',
    operation_type: input.operation_type ?? null,
    obligation_id: input.obligation_id ?? input.evidence?.leaf_obligation_id ?? null,
  });
}

export function isMemorizeTierOutcome(value) {
  return value?.schema_version === 1
    && MEMORIZE_TIER_OUTCOME_KINDS.includes(value?.kind);
}
