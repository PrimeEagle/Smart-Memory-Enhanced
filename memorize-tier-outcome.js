export const MEMORIZE_TIER_OUTCOME_KINDS = Object.freeze([
  'complete', 'complete_no_update', 'partial_recoverable',
  'malformed_recoverable', 'context_overflow_recoverable',
  'validation_recoverable', 'policy_paused', 'blocked',
  'cancelled', 'terminal_failure',
]);

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

const immutableClone = (value) => {
  if (value == null) return value;
  const copy = typeof structuredClone === 'function'
    ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  return freeze(copy);
};

export function createMemorizeTierOutcome(input = {}) {
  if (!MEMORIZE_TIER_OUTCOME_KINDS.includes(input.kind)) {
    throw new TypeError(`Unknown Memorize tier outcome: ${input.kind ?? 'missing'}`);
  }
  return Object.freeze({
    schema_version: 1,
    kind: input.kind,
    reason_code: input.reason_code ?? input.kind,
    next_action: input.next_action ?? null,
    provider_call_required: input.provider_call_required === true,
    recovery_dimension: input.recovery_dimension ?? null,
    accepted_owners: immutableClone(input.accepted_owners ?? []),
    explicit_no_update_owners: immutableClone(input.explicit_no_update_owners ?? []),
    missing_owners: immutableClone(input.missing_owners ?? []),
    rejected_owners: immutableClone(input.rejected_owners ?? []),
    durable_receipts: immutableClone(input.durable_receipts ?? []),
    owner_coverage: immutableClone(input.owner_coverage ?? null),
    value: immutableClone(input.value),
    evidence: immutableClone(input.evidence ?? null),
  });
}

export function isMemorizeTierOutcome(value) {
  return value?.schema_version === 1
    && MEMORIZE_TIER_OUTCOME_KINDS.includes(value?.kind);
}
