import { getMemorizeReason, normalizeMemorizeReasonCode } from './memorize-reasons.js';

export const MEMORIZE_OUTCOME_KINDS = Object.freeze([
  'completed', 'paused', 'blocked', 'cancelled', 'failed',
]);

export function createMemorizeOutcome(input = {}) {
  const kind = MEMORIZE_OUTCOME_KINDS.includes(input.kind) ? input.kind : 'failed';
  const reason = getMemorizeReason(input.reason_code ?? (kind === 'completed' ? 'completed' : 'internal_exception'));
  const resumable = input.resumable ?? (kind === 'paused' ? reason.resumable : false);
  return Object.freeze({
    schema_version: 1,
    kind,
    reason_code: reason.code,
    reason_category: reason.category,
    resumable: resumable === true,
    next_action: input.next_action ?? (resumable ? reason.next_action : null),
    obligation_id: input.obligation_id ?? null,
    provider_call_required: input.provider_call_required === true,
    evidence: input.evidence == null ? null : structuredClone(input.evidence),
    value: input.value,
  });
}

export function isMemorizeOutcome(value) {
  return value?.schema_version === 1 && MEMORIZE_OUTCOME_KINDS.includes(value?.kind)
    && typeof value?.reason_code === 'string';
}

/** Converts one current execution exception into the canonical run outcome. */
export function memorizeOutcomeFromException(error, overrides = {}) {
  if (isMemorizeOutcome(error)) return error;
  const diagnostics = error?.sme_request_diagnostics ?? {};
  const reasonCode = normalizeMemorizeReasonCode(
    overrides.reason_code ?? diagnostics.pause_reason ?? diagnostics.reason_code
      ?? error?.sme_reason_code ?? error?.code,
    'internal_exception',
  );
  const expectedPause = error?.sme_operational_pause === true;
  const expectedBlock = error?.sme_recovery_blocked === true;
  const kind = overrides.kind ?? (expectedPause ? 'paused' : expectedBlock ? 'blocked' : 'failed');
  return createMemorizeOutcome({
    kind,
    reason_code: reasonCode,
    resumable: overrides.resumable ?? (kind === 'paused'),
    next_action: overrides.next_action ?? diagnostics.next_eligible_recovery_action
      ?? diagnostics.recovery_intent,
    obligation_id: overrides.obligation_id ?? diagnostics.root_obligation_id
      ?? error?.sme_obligation_id,
    provider_call_required: overrides.provider_call_required
      ?? diagnostics.provider_call_required,
    evidence: overrides.evidence ?? {
      normalized_exception_class: error?.name ?? 'Error',
      bounded_message: String(error?.message ?? error ?? 'Unknown failure').replace(/\s+/g, ' ').slice(0, 300),
      request_diagnostics: diagnostics,
    },
  });
}

export function completedMemorizeOutcome(value, evidence = null) {
  return createMemorizeOutcome({ kind: 'completed', reason_code: 'completed', value, evidence });
}

