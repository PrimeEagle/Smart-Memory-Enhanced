export const MEMORIZE_ERROR_CATEGORIES = Object.freeze([
  'provider_transport_failure', 'provider_output_failure', 'validation_failure',
  'persistence_failure', 'internal_invariant_failure', 'stale_callback_notice',
  'cancellation', 'operational_pause', 'blocked_external_condition',
  'diagnostic_observer_failure',
]);

const categorySet = new Set(MEMORIZE_ERROR_CATEGORIES);
const originCategory = Object.freeze({
  provider_transport: 'provider_transport_failure',
  provider_output: 'provider_output_failure',
  validation: 'validation_failure',
  persistence: 'persistence_failure',
  internal_invariant: 'internal_invariant_failure',
  programming_error: 'internal_invariant_failure',
  stale_callback: 'stale_callback_notice',
  cancellation: 'cancellation',
  policy_pause: 'operational_pause',
  operational_pause: 'operational_pause',
  external_blocker: 'blocked_external_condition',
  diagnostic_observer: 'diagnostic_observer_failure',
});

/** Categorization is based only on typed origin/evidence, never message substrings. */
export function classifyMemorizeErrorRecord(value = {}) {
  if (categorySet.has(value.category)) return value.category;
  if (['SME_MALFORMED_PROVIDER_OUTPUT', 'SME_RECOVERY_PATH_EXHAUSTED',
    'recovery_request_budget_reached_with_pending_children']
    .includes(value.code)) return value.sme_operational_pause === true
      ? 'operational_pause' : 'provider_output_failure';
  if (originCategory[value.sme_origin ?? value.origin]) {
    return originCategory[value.sme_origin ?? value.origin];
  }
  if (value.name === 'ReferenceError' || value.normalized_exception_class === 'ReferenceError') {
    return 'internal_invariant_failure';
  }
  if (value.sme_operational_pause === true) return 'operational_pause';
  if (value.persistence === true) return 'persistence_failure';
  if (value.provider_fault_attribution === false) return 'internal_invariant_failure';
  if (value.transport_started === true && value.transport_completed === false) {
    return 'provider_transport_failure';
  }
  return 'internal_invariant_failure';
}

export function attachMemorizeErrorOrigin(error, origin) {
  if (error && typeof error === 'object') error.sme_origin ??= origin;
  return error;
}
